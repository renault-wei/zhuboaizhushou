import { afterAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { pool } from '../src/db/client';

/**
 * 抖音 OAuth 绑定接口集成测试（fastify.inject，mock 模式）：
 * - 401 用例只依赖 JWT 插件，不依赖数据库；
 * - 绑定/解绑用例落在 users 表，数据库不可用时整体跳过。
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

/** 各场景固定手机号（复用已有用户、测试前先解绑复位，避免历史数据影响断言） */
const PHONE_A = '13600000001';
const PHONE_B = '13600000002';
const PHONE_C = '13600000003';
const PHONE_D = '13600000004';
const PHONE_E = '13600000005';

/** 场景固定 mock 授权码：每个用户各用各的 code，open_id 由 code 确定性派生，便于断言 */
const CODE_BIND = 'mock-bind-status-code-a';
const CODE_FIRST_B = 'mock-bind-first-code-b';
const CODE_OTHER_B = 'mock-bind-second-code-b';
const CODE_CONFLICT = 'mock-openid-conflict-owner';
const CODE_REBIND = 'mock-rebind-code-f';

async function registerAndGetToken(phone: string): Promise<string> {
  const send = await app.inject({
    method: 'POST',
    url: '/api/auth/send-code',
    payload: { phone },
  });
  const code = send.json().code as string;
  expect(code).toMatch(/^\d{6}$/);

  const verify = await app.inject({
    method: 'POST',
    url: '/api/auth/verify-code',
    payload: { phone, code },
  });
  expect(verify.statusCode).toBe(200);
  return verify.json().token as string;
}

async function unbindIfBound(token: string): Promise<void> {
  await app.inject({
    method: 'POST',
    url: '/api/douyin/unbind',
    headers: { authorization: `Bearer ${token}` },
  });
}

function mockOpenId(code: string): string {
  const hash = createHash('sha256').update(code).digest('hex').slice(0, 8);
  return `mock-openid-${hash}`;
}

function bearer(token: string): { authorization: string } {
  return { authorization: `Bearer ${token}` };
}

// ---------- 未登录 401 ----------

describe('抖音绑定接口鉴权', () => {
  it('未带 token 访问绑定三个接口均返回 401', async () => {
    const status = await app.inject({ method: 'GET', url: '/api/douyin/bind-status' });
    expect(status.statusCode).toBe(401);
    expect(status.json()).toMatchObject({ error: 'UNAUTHORIZED' });

    const bind = await app.inject({
      method: 'POST',
      url: '/api/douyin/bind',
      payload: { code: 'mock-anything' },
    });
    expect(bind.statusCode).toBe(401);

    const unbind = await app.inject({ method: 'POST', url: '/api/douyin/unbind' });
    expect(unbind.statusCode).toBe(401);
  });

  it('非法 token 访问返回 401', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/douyin/bind-status',
      headers: { authorization: 'Bearer not-a-valid-jwt' },
    });
    expect(res.statusCode).toBe(401);
  });
});

// ---------- 绑定成功 + bind-status 字段 ----------

dbIt('绑定成功返回绑定信息，bind-status 字段与绑定响应一致且不含凭据', async () => {
  const token = await registerAndGetToken(PHONE_A);
  await unbindIfBound(token);

  const bind = await app.inject({
    method: 'POST',
    url: '/api/douyin/bind',
    headers: bearer(token),
    payload: { code: CODE_BIND },
  });
  expect(bind.statusCode).toBe(200);
  const body = bind.json();
  // open_id 由 mock 规则确定性派生
  expect(body).toMatchObject({
    bound: true,
    openId: mockOpenId(CODE_BIND),
    boundAt: expect.any(String),
  });
  expect(typeof body.nickname).toBe('string');
  expect(body.nickname).toBe(`抖音用户${body.openId.slice(-4)}`);
  expect(typeof body.avatarUrl).toBe('string');
  expect(body.boundAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  // 不得回传抖音 token 凭据
  expect(body.douyinAccessToken).toBeUndefined();
  expect(body.douyinRefreshToken).toBeUndefined();

  const status = await app.inject({
    method: 'GET',
    url: '/api/douyin/bind-status',
    headers: bearer(token),
  });
  expect(status.statusCode).toBe(200);
  expect(status.json()).toEqual(body);
});

// ---------- 重复绑定其他抖音号 409 ----------

dbIt('已绑定抖音号后绑定其他号返回 409 ALREADY_BOUND 并附当前绑定信息', async () => {
  const token = await registerAndGetToken(PHONE_B);
  await unbindIfBound(token);

  await app.inject({
    method: 'POST',
    url: '/api/douyin/bind',
    headers: bearer(token),
    payload: { code: CODE_FIRST_B },
  });

  const res = await app.inject({
    method: 'POST',
    url: '/api/douyin/bind',
    headers: bearer(token),
    payload: { code: CODE_OTHER_B },
  });
  expect(res.statusCode).toBe(409);
  const body = res.json();
  expect(body.error).toBe('ALREADY_BOUND');
  // 409 响应携带当前绑定信息，供客户端引导先解绑
  expect(body).toMatchObject({ bound: true, openId: mockOpenId(CODE_FIRST_B) });
  expect(typeof body.nickname).toBe('string');
  expect(typeof body.boundAt).toBe('string');
});

// ---------- open_id 冲突 409 ----------

dbIt('该抖音号已被其他用户绑定时返回 409 OPENID_CONFLICT', async () => {
  const tokenOwner = await registerAndGetToken(PHONE_C);
  await unbindIfBound(tokenOwner);
  const owner = await app.inject({
    method: 'POST',
    url: '/api/douyin/bind',
    headers: bearer(tokenOwner),
    payload: { code: CODE_CONFLICT },
  });
  expect(owner.statusCode).toBe(200);

  const tokenOther = await registerAndGetToken(PHONE_D);
  await unbindIfBound(tokenOther);
  const res = await app.inject({
    method: 'POST',
    url: '/api/douyin/bind',
    headers: bearer(tokenOther),
    payload: { code: CODE_CONFLICT },
  });
  expect(res.statusCode).toBe(409);
  expect(res.json()).toMatchObject({ error: 'OPENID_CONFLICT' });
});

// ---------- 非法 code 400 ----------

dbIt('空授权码或非 mock 授权码返回 400 CODE_INVALID', async () => {
  const token = await registerAndGetToken(PHONE_E);
  await unbindIfBound(token);

  const empty = await app.inject({
    method: 'POST',
    url: '/api/douyin/bind',
    headers: bearer(token),
    payload: { code: '' },
  });
  expect(empty.statusCode).toBe(400);
  expect(empty.json()).toMatchObject({ error: 'CODE_INVALID' });

  const noCode = await app.inject({
    method: 'POST',
    url: '/api/douyin/bind',
    headers: bearer(token),
    payload: {},
  });
  expect(noCode.statusCode).toBe(400);

  const invalid = await app.inject({
    method: 'POST',
    url: '/api/douyin/bind',
    headers: bearer(token),
    payload: { code: 'not-a-mock-code' },
  });
  expect(invalid.statusCode).toBe(400);
  expect(invalid.json()).toMatchObject({ error: 'CODE_INVALID' });
});

// ---------- 解绑后可重绑 ----------

dbIt('解绑返回 bound:false，随后可用同一抖音号重新绑定', async () => {
  const token = await registerAndGetToken('13600000006');
  await unbindIfBound(token);

  const bind = await app.inject({
    method: 'POST',
    url: '/api/douyin/bind',
    headers: bearer(token),
    payload: { code: CODE_REBIND },
  });
  expect(bind.statusCode).toBe(200);
  expect(bind.json()).toMatchObject({ bound: true, openId: mockOpenId(CODE_REBIND) });

  const unbind = await app.inject({
    method: 'POST',
    url: '/api/douyin/unbind',
    headers: bearer(token),
  });
  expect(unbind.statusCode).toBe(200);
  expect(unbind.json()).toEqual({ bound: false });

  const statusAfter = await app.inject({
    method: 'GET',
    url: '/api/douyin/bind-status',
    headers: bearer(token),
  });
  expect(statusAfter.json()).toEqual({ bound: false });

  // 解绑后同一抖音号可重新绑定
  const rebind = await app.inject({
    method: 'POST',
    url: '/api/douyin/bind',
    headers: bearer(token),
    payload: { code: CODE_REBIND },
  });
  expect(rebind.statusCode).toBe(200);
  expect(rebind.json()).toMatchObject({ bound: true, openId: mockOpenId(CODE_REBIND) });

  // 幂等：解绑后再解绑仍返回 200 bound:false
  await app.inject({
    method: 'POST',
    url: '/api/douyin/unbind',
    headers: bearer(token),
  });
  const unbindAgain = await app.inject({
    method: 'POST',
    url: '/api/douyin/unbind',
    headers: bearer(token),
  });
  expect(unbindAgain.statusCode).toBe(200);
  expect(unbindAgain.json()).toEqual({ bound: false });
});
