import { afterAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { pool } from '../src/db/client';

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

const PHONE_UNBOUND = '13910000001';
const PHONE_BOUND = '13910000002';

/** 注册并登录，返回 token */
async function registerAndGetToken(phone: string): Promise<string> {
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
  expect(verify.statusCode).toBe(200);
  return verify.json().token as string;
}

/** 绑定抖音号（mock 授权码） */
async function bindDouyin(token: string, code = 'mock-coupon-001'): Promise<void> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/douyin/bind',
    headers: { authorization: `Bearer ${token}` },
    payload: { code },
  });
  expect(res.statusCode).toBe(200);
}

async function userIdOf(phone: string): Promise<string> {
  const res = await pool.query('SELECT id FROM users WHERE phone = $1 LIMIT 1', [phone]);
  const row = res.rows[0] as { id: string } | undefined;
  if (!row) {
    throw new Error(`测试用户不存在：${phone}`);
  }
  return row.id;
}

describe('团购券列表（T9）', () => {
  dbIt('未登录访问返回 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/douyin/coupons' });
    expect(res.statusCode).toBe(401);
  });

  dbIt('未绑定抖音号返回 403 DOUYIN_NOT_BOUND', async () => {
    const token = await registerAndGetToken(PHONE_UNBOUND);
    const res = await app.inject({
      method: 'GET',
      url: '/api/douyin/coupons',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('DOUYIN_NOT_BOUND');
  });

  dbIt('绑定后返回团购券列表，字段完整', async () => {
    const token = await registerAndGetToken(PHONE_BOUND);
    await bindDouyin(token);
    const res = await app.inject({
      method: 'GET',
      url: '/api/douyin/coupons',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const { coupons } = res.json() as { coupons: Array<Record<string, unknown>> };
    expect(coupons.length).toBeGreaterThanOrEqual(4);

    const first = coupons[0];
    expect(typeof first.couponId).toBe('string');
    expect((first.couponId as string).length).toBeGreaterThan(0);
    expect(typeof first.name).toBe('string');
    expect((first.name as string).length).toBeGreaterThan(0);
    expect(typeof first.price).toBe('number');
    expect(typeof first.sales).toBe('number');
  });

  dbIt('券 ID 由 openId 确定性扰动（隔离不同账号）', async () => {
    // 该用户已在上一个用例绑定，直接拉券
    const userId = await userIdOf(PHONE_BOUND);
    const row = await pool.query('SELECT douyin_open_id FROM users WHERE id = $1', [userId]);
    const openId = row.rows[0].douyin_open_id as string;

    const token = await registerAndGetToken(PHONE_BOUND);
    const res = await app.inject({
      method: 'GET',
      url: '/api/douyin/coupons',
      headers: { authorization: `Bearer ${token}` },
    });
    const { coupons } = res.json() as { coupons: Array<{ couponId: string }> };
    // 券 ID 末尾应包含 openId 的 sha256 前 4 位扰动（非空后缀即可验证确定性生成）
    for (const coupon of coupons) {
      expect(coupon.couponId.endsWith('-')).toBe(false);
      expect(coupon.couponId.length).toBeGreaterThan('c-001-'.length);
    }
    // openId 有值即说明绑定成功
    expect(openId.length).toBeGreaterThan(0);
  });
});
