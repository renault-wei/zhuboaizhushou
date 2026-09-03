import { afterAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { pool } from '../src/db/client';

/**
 * 登录接口集成测试（fastify.inject）：
 * - 发送验证码 / 重发限制 / 错误验证码等用例只依赖内存，不依赖数据库；
 * - 涉及自动注册用户 / 查询用户的用例在数据库不可用时整体跳过。
 */

const app: FastifyInstance = buildApp();

// 提前探测数据库连通性，决定依赖数据库的用例是否执行
let dbAvailable = false;
try {
  await pool.query('SELECT 1');
  dbAvailable = true;
} catch {
  dbAvailable = false;
}
const dbIt = dbAvailable ? it : it.skip;

afterAll(async () => {
  await app.close();
  await pool.end().catch(() => undefined);
});

// ---------- 发送验证码 ----------

describe('POST /api/auth/send-code', () => {
  it('手机号格式不正确时返回 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/send-code',
      payload: { phone: '12345' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'PHONE_INVALID' });
  });

  it('合法手机号发送成功，开发模式在响应里返回验证码', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/send-code',
      payload: { phone: '13800000001' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({
      message: '验证码已发送',
      resendAfterSeconds: 60,
      expiresInSeconds: 300,
    });
    expect(typeof body.requestId).toBe('string');

    // 生产环境禁止返回验证码明文
    if (process.env.NODE_ENV === 'production') {
      expect(body.code).toBeUndefined();
    } else {
      expect(body.code).toMatch(/^\d{6}$/);
    }
  });

  it('60 秒内重复发送同一手机号返回 429', async () => {
    const phone = '13800000002';
    await app.inject({
      method: 'POST',
      url: '/api/auth/send-code',
      payload: { phone },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/send-code',
      payload: { phone },
    });
    expect(res.statusCode).toBe(429);
    const body = res.json();
    expect(body.error).toBe('SEND_TOO_FREQUENT');
    expect(body.retryAfterSeconds).toBeGreaterThan(0);
    expect(body.retryAfterSeconds).toBeLessThanOrEqual(60);
  });
});

// ---------- 校验验证码（错误路径不依赖数据库）----------

describe('POST /api/auth/verify-code 错误路径', () => {
  it('手机号格式不正确时返回 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/verify-code',
      payload: { phone: 'abc', code: '123456' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'PHONE_INVALID' });
  });

  it('验证码格式不正确时返回 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/verify-code',
      payload: { phone: '13800000001', code: '12ab' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'CODE_INVALID' });
  });

  it('验证码错误时返回 400', async () => {
    const phone = '13800000003';
    const send = await app.inject({
      method: 'POST',
      url: '/api/auth/send-code',
      payload: { phone },
    });
    const sentCode = send.json().code as string | undefined;
    // 生产拿不到明文时用固定错码兜底，开发环境保证与真实码不同
    const wrongCode = sentCode
      ? String((Number(sentCode) + 1) % 1_000_000).padStart(6, '0')
      : '000000';
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/verify-code',
      payload: { phone, code: wrongCode },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'CODE_INVALID' });
  });
});

// ---------- 校验通过 + 自动注册 + JWT（依赖数据库）----------

dbIt('校验通过后新用户自动注册并签发 JWT', async () => {
  const phone = '13500000001';
  const send = await app.inject({
    method: 'POST',
    url: '/api/auth/send-code',
    payload: { phone },
  });
  const code = send.json().code as string;
  expect(code).toMatch(/^\d{6}$/);

  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/verify-code',
    payload: { phone, code },
  });
  expect(res.statusCode).toBe(200);
  const body = res.json();
  expect(typeof body.token).toBe('string');
  expect(body.tokenType).toBe('Bearer');
  expect(body.expiresInSeconds).toBe(7 * 24 * 60 * 60);
  expect(body.user).toMatchObject({ phone, subscriptionStatus: 'free' });
  // 登录响应不得携带抖音绑定凭据
  expect(body.user.douyinAccessToken).toBeUndefined();
  expect(body.user.douyinRefreshToken).toBeUndefined();
});

dbIt('验证码一次性使用：再次校验同一验证码返回 400', async () => {
  const phone = '13500000002';
  const send = await app.inject({
    method: 'POST',
    url: '/api/auth/send-code',
    payload: { phone },
  });
  const code = send.json().code as string;
  await app.inject({
    method: 'POST',
    url: '/api/auth/verify-code',
    payload: { phone, code },
  });

  const again = await app.inject({
    method: 'POST',
    url: '/api/auth/verify-code',
    payload: { phone, code },
  });
  expect(again.statusCode).toBe(400);
  expect(again.json()).toMatchObject({ error: 'CODE_INVALID' });
});

// ---------- 当前用户信息 ----------

describe('GET /api/auth/me', () => {
  it('无 token 或非法 token 返回 401', async () => {
    const noToken = await app.inject({ method: 'GET', url: '/api/auth/me' });
    expect(noToken.statusCode).toBe(401);
    expect(noToken.json()).toMatchObject({ error: 'UNAUTHORIZED' });

    const badToken = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { authorization: 'Bearer not-a-valid-jwt' },
    });
    expect(badToken.statusCode).toBe(401);
  });

  dbIt('返回当前用户信息且不含抖音凭据', async () => {
    const phone = '13500000003';
    const send = await app.inject({
      method: 'POST',
      url: '/api/auth/send-code',
      payload: { phone },
    });
    const code = send.json().code as string;
    const verify = await app.inject({
      method: 'POST',
      url: '/api/auth/verify-code',
      payload: { phone, code },
    });
    const token = verify.json().token as string;

    const res = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const user = res.json().user;
    expect(user).toMatchObject({ phone, subscriptionStatus: 'free' });
    expect(typeof user.id).toBe('string');
    // 不得返回抖音 OAuth 绑定凭据
    expect(user.douyinOpenId).toBeUndefined();
    expect(user.douyinAccessToken).toBeUndefined();
    expect(user.douyinRefreshToken).toBeUndefined();
  });
});
