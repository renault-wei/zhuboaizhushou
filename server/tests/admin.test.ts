import { afterAll, describe, expect, it } from 'vitest';
import bcrypt from 'bcryptjs';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { pool } from '../src/db/client';

const app: FastifyInstance = buildApp();

// 数据库连通探测：依赖 DB 的用例不可用时整体跳过（与既有测试范式一致）
let dbAvailable = false;
try {
  await pool.query('SELECT 1');
  dbAvailable = true;
} catch {
  dbAvailable = false;
}
const dbIt = dbAvailable ? it : it.skip;

// 本次测试创建的后台账号 id（afterAll 统一清理，避免污染开发库）
const createdAdminIds: string[] = [];

async function registerMerchantToken(phone: string): Promise<string> {
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

/** 直接落一条后台账号（bcrypt 哈希），返回 id；isActive 默认在岗 */
async function createAdmin(username: string, password: string, isActive = true): Promise<string> {
  const hash = await bcrypt.hash(password, 4);
  const rows = await pool.query<{ id: string }>(
    `INSERT INTO admin_users (username, password_hash, role, is_active)
     VALUES ($1, $2, 'super_admin', $3) RETURNING id`,
    [username, hash, isActive],
  );
  const id = rows.rows[0]?.id;
  if (!id) {
    throw new Error('创建测试后台账号失败');
  }
  createdAdminIds.push(id);
  return id;
}

async function adminLogin(username: string, password: string) {
  return app.inject({
    method: 'POST',
    url: '/api/admin/login',
    payload: { username, password },
  });
}

afterAll(async () => {
  if (createdAdminIds.length > 0) {
    await pool.query('DELETE FROM admin_users WHERE id = ANY($1)', [createdAdminIds]);
  }
  await app.close();
  await pool.end().catch(() => undefined);
});

describe('后台登录（POST /api/admin/login）', () => {
  it('空账号/口令返回 400', async () => {
    const res = await adminLogin('', '');
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'LOGIN_INVALID' });
  });

  dbIt('口令错误返回 401 LOGIN_FAILED', async () => {
    const username = `admtest-badpw-${Date.now().toString(36)}`;
    await createAdmin(username, 'correct-password-123');
    const res = await adminLogin(username, 'wrong-password-456');
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: 'LOGIN_FAILED' });
  });

  dbIt('账号不存在返回 401 LOGIN_FAILED（不暴露账号是否存在）', async () => {
    const res = await adminLogin(`nobody-${Date.now().toString(36)}`, 'whatever-password-1');
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: 'LOGIN_FAILED' });
  });

  dbIt('停用账号即使口令正确也拒绝', async () => {
    const username = `admtest-disabled-${Date.now().toString(36)}`;
    await createAdmin(username, 'disabled-password-1', false);
    const res = await adminLogin(username, 'disabled-password-1');
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: 'LOGIN_FAILED' });
  });

  dbIt('登录成功：返回 token 与后台信息（不含口令哈希）', async () => {
    const username = `admtest-ok-${Date.now().toString(36)}`;
    await createAdmin(username, 'strong-password-1');
    const res = await adminLogin(username, 'strong-password-1');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(typeof body.token).toBe('string');
    expect(body.expiresInSeconds).toBeGreaterThan(0);
    expect(body.admin).toMatchObject({ username, role: 'super_admin' });
    expect(JSON.stringify(body)).not.toContain('passwordHash');
  });
});

describe('后台只读接口与鉴权隔离', () => {
  dbIt('无 token 访问看板返回 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/admin/dashboard' });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: 'UNAUTHORIZED' });
  });

  dbIt('商家 token 不能访问后台（admin 命名空间隔离）', async () => {
    const merchantToken = await registerMerchantToken('13900000071');
    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/dashboard',
      headers: { authorization: `Bearer ${merchantToken}` },
    });
    expect(res.statusCode).toBe(401);
  });

  dbIt('后台 token 不能访问商家接口（反向隔离）', async () => {
    const username = `admtest-isol-${Date.now().toString(36)}`;
    await createAdmin(username, 'isolate-password-1');
    const login = await adminLogin(username, 'isolate-password-1');
    const adminToken = login.json().token as string;
    const res = await app.inject({
      method: 'GET',
      url: '/api/scripts',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(401);
  });

  dbIt('后台 token 依次访问全部只读端点返回 200', async () => {
    const username = `admtest-read-${Date.now().toString(36)}`;
    await createAdmin(username, 'read-password-1');
    const login = await adminLogin(username, 'read-password-1');
    const adminToken = login.json().token as string;
    const headers = { authorization: `Bearer ${adminToken}` };
    const urls = [
      '/api/admin/me',
      '/api/admin/dashboard',
      '/api/admin/merchants',
      '/api/admin/quotas',
      '/api/admin/usage',
      '/api/admin/orders',
      '/api/admin/audit/scripts',
      '/api/admin/audit/agreements',
      '/api/admin/audit/logs',
    ];
    for (const url of urls) {
      const res = await app.inject({ method: 'GET', url, headers });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      if (url === '/api/admin/me') {
        expect(body.admin).toMatchObject({ username });
        continue;
      }
      if (url === '/api/admin/dashboard') {
        continue;
      }
      expect(body).toMatchObject({ items: expect.any(Array), total: expect.any(Number) });
    }
  });

  dbIt('看板返回北极星指标分组', async () => {
    const username = `admtest-dash-${Date.now().toString(36)}`;
    await createAdmin(username, 'dashboard-password-1');
    const login = await adminLogin(username, 'dashboard-password-1');
    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/dashboard',
      headers: { authorization: `Bearer ${login.json().token as string}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      merchants: { total: expect.any(Number), newThisMonth: expect.any(Number), paid: expect.any(Number) },
      orders: {
        thisMonth: { count: expect.any(Number), revenueCents: expect.any(Number) },
        total: { count: expect.any(Number), revenueCents: expect.any(Number) },
      },
      usage: {
        today: { calls: expect.any(Number), chars: expect.any(Number) },
        thisMonth: { calls: expect.any(Number), chars: expect.any(Number) },
      },
      lives: { active: expect.any(Number), total: expect.any(Number) },
    });
  });

  dbIt('非法 userId 过滤参数返回 400 QUERY_INVALID', async () => {
    const username = `admtest-badq-${Date.now().toString(36)}`;
    await createAdmin(username, 'query-password-1');
    const login = await adminLogin(username, 'query-password-1');
    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/usage?userId=not-a-uuid',
      headers: { authorization: `Bearer ${login.json().token as string}` },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'QUERY_INVALID' });
  });
});
