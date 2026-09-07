import { afterAll, describe, expect, it } from 'vitest';
import bcrypt from 'bcryptjs';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { pool } from '../src/db/client';
import { QUOTA_TIERS } from '../src/services/quotaTiers';

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
// 本次测试直插创建的商家用户 id（afterAll 统一清理）
const createdUserIds: string[] = [];

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

/** 直插一个商家用户（随机手机号），返回 id；由 afterAll 统一清理 */
async function createUserRow(phone: string): Promise<string> {
  const rows = await pool.query<{ id: string }>(
    `INSERT INTO users (phone, nickname) VALUES ($1, $2) RETURNING id`,
    [phone, `测试商家-${Date.now().toString(36)}`],
  );
  const id = rows.rows[0]?.id;
  if (!id) {
    throw new Error('创建测试商家用户失败');
  }
  createdUserIds.push(id);
  return id;
}

/** 直插一张 pending 订阅订单，返回 { id, orderNo } */
async function createPendingOrder(userId: string, amountCents = 9900) {
  const orderNo = `ord-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const rows = await pool.query<{ id: string; order_no: string }>(
    `INSERT INTO orders (user_id, order_no, plan, amount_cents, status)
     VALUES ($1, $2, 'monthly', $3, 'pending') RETURNING id, order_no`,
    [userId, orderNo, amountCents],
  );
  const row = rows.rows[0];
  if (!row) {
    throw new Error('创建测试订单失败');
  }
  return { id: row.id, orderNo: row.order_no };
}

/** 读取测试商家当前月额度行（无则返回 undefined） */
async function readQuotaRow(userId: string, period: string) {
  const rows = await pool.query(
    `SELECT * FROM quotas WHERE user_id = $1 AND period = $2`,
    [userId, period],
  );
  return rows.rows[0];
}

afterAll(async () => {
  if (createdUserIds.length > 0) {
    await pool.query('DELETE FROM users WHERE id = ANY($1)', [createdUserIds]);
  }
  if (createdAdminIds.length > 0) {
    await pool.query('DELETE FROM audit_logs WHERE admin_user_id = ANY($1)', [createdAdminIds]);
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

describe('M2 额度调整（PUT /api/admin/quotas/:userId）', () => {
  dbIt('未登录调整额度返回 401', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/admin/quotas/00000000-0000-4000-8000-000000000000',
      payload: { ttsCharsQuota: 100 },
    });
    expect(res.statusCode).toBe(401);
  });

  dbIt('非 uuid 用户返回 400 USER_ID_INVALID', async () => {
    const username = `admtest-qbadid-${Date.now().toString(36)}`;
    await createAdmin(username, 'quota-password-1');
    const login = await adminLogin(username, 'quota-password-1');
    const headers = { authorization: `Bearer ${login.json().token as string}` };
    const res = await app.inject({
      method: 'PUT',
      url: '/api/admin/quotas/not-a-uuid',
      headers,
      payload: { ttsCharsQuota: 100 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'USER_ID_INVALID' });
  });

  dbIt('商家不存在返回 404 USER_NOT_FOUND', async () => {
    const username = `admtest-qnofind-${Date.now().toString(36)}`;
    await createAdmin(username, 'quota-password-1');
    const login = await adminLogin(username, 'quota-password-1');
    const headers = { authorization: `Bearer ${login.json().token as string}` };
    const res = await app.inject({
      method: 'PUT',
      url: '/api/admin/quotas/5c3b6f1e-2c8a-4f1a-9e7b-0a1b2c3d4e5f',
      headers,
      payload: { ttsCharsQuota: 100 },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: 'USER_NOT_FOUND' });
  });

  dbIt('非法请求体返回 400 BODY_INVALID', async () => {
    const username = `admtest-qbadbody-${Date.now().toString(36)}`;
    await createAdmin(username, 'quota-password-1');
    const login = await adminLogin(username, 'quota-password-1');
    const headers = { authorization: `Bearer ${login.json().token as string}` };
    const cases = [
      {},
      { ttsCharsQuota: -1 },
      { scriptGenerationsQuota: 1.5 },
      { period: '2026-13', liveMinutesQuota: 10 },
    ];
    for (const payload of cases) {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/admin/quotas/5c3b6f1e-2c8a-4f1a-9e7b-0a1b2c3d4e5f',
        headers,
        payload,
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: 'BODY_INVALID' });
    }
  });

  dbIt('成功新建当月额度行并留审计日志', async () => {
    const username = `admtest-qok-${Date.now().toString(36)}`;
    await createAdmin(username, 'quota-password-1');
    const login = await adminLogin(username, 'quota-password-1');
    const headers = { authorization: `Bearer ${login.json().token as string}` };
    const userId = await createUserRow(`139${String(Math.floor(Math.random() * 90000000) + 10000000)}`);
    const periodRows = await pool.query<{ period: string }>(
      `SELECT to_char(now(), 'YYYY-MM') AS period`,
    );
    const period = periodRows.rows[0]?.period ?? '';
    const payload = { ttsCharsQuota: 123456, scriptGenerationsQuota: 88, liveMinutesQuota: 77 };
    const res = await app.inject({
      method: 'PUT',
      url: `/api/admin/quotas/${userId}`,
      headers,
      payload,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      quota: {
        userId,
        period,
        ttsCharsQuota: 123456,
        scriptGenerationsQuota: 88,
        liveMinutesQuota: 77,
        ttsCharsUsed: 0,
        scriptGenerationsUsed: 0,
        liveMinutesUsed: 0,
      },
    });
    const list = await app.inject({
      method: 'GET',
      url: `/api/admin/quotas?userId=${userId}&pageSize=50`,
      headers,
    });
    const listBody = list.json();
    expect(list.statusCode).toBe(200);
    expect(listBody.items).toContainEqual(
      expect.objectContaining({ user_id: userId, period, tts_chars_quota: 123456 }),
    );
    const audit = await app.inject({
      method: 'GET',
      url: '/api/admin/audit/logs?pageSize=50',
      headers,
    });
    const auditItems = audit.json().items as Array<Record<string, unknown>>;
    expect(
      auditItems.some(
        (item) =>
          item.action === 'quota.adjust' &&
          item.detail !== null &&
          typeof item.detail === 'object' &&
          (item.detail as Record<string, unknown>).period === period &&
          item.adminUsername === username,
      ),
    ).toBe(true);
  });

  dbIt('局部调整只改目标列、used 不变；历史月无行时新建', async () => {
    const username = `admtest-qpart-${Date.now().toString(36)}`;
    await createAdmin(username, 'quota-password-1');
    const login = await adminLogin(username, 'quota-password-1');
    const headers = { authorization: `Bearer ${login.json().token as string}` };
    const userId = await createUserRow(`139${String(Math.floor(Math.random() * 90000000) + 10000000)}`);
    const periodRows = await pool.query<{ period: string }>(
      `SELECT to_char(now(), 'YYYY-MM') AS period`,
    );
    const period = periodRows.rows[0]?.period ?? '';
    await pool.query(
      `INSERT INTO quotas (user_id, period, tts_chars_quota, tts_chars_used, script_generations_quota,
         script_generations_used, live_minutes_quota, live_minutes_used)
       VALUES ($1, $2, 10, 5, 20, 9, 30, 3)`,
      [userId, period],
    );
    const res = await app.inject({
      method: 'PUT',
      url: `/api/admin/quotas/${userId}`,
      headers,
      payload: { scriptGenerationsQuota: 200 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().quota).toMatchObject({
      period,
      ttsCharsQuota: 10,
      scriptGenerationsQuota: 200,
      liveMinutesQuota: 30,
      ttsCharsUsed: 5,
      scriptGenerationsUsed: 9,
      liveMinutesUsed: 3,
    });
    const history = await app.inject({
      method: 'PUT',
      url: `/api/admin/quotas/${userId}`,
      headers,
      payload: { period: '2025-01', ttsCharsQuota: 999 },
    });
    expect(history.statusCode).toBe(200);
    expect(history.json().quota).toMatchObject({
      period: '2025-01',
      ttsCharsQuota: 999,
      scriptGenerationsQuota: 0,
      liveMinutesQuota: 0,
    });
    const row = await readQuotaRow(userId, '2025-01');
    expect(row).toMatchObject({ user_id: userId, tts_chars_quota: 999 });
  });
});

describe('M2 订单人工确权（POST /api/admin/orders/:id/confirm）', () => {
  /** 时间断言：返回值距 now 的偏移应约等于 N 天（容差 ±90 秒） */
  function expectExpiryAround(value: unknown, days: number) {
    const t = new Date(value as string).getTime();
    const center = Date.now() + days * 86_400_000;
    expect(Math.abs(t - center)).toBeLessThan(90_000);
  }

  dbIt('未登录确权返回 401', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/orders/00000000-0000-4000-8000-000000000000/confirm',
    });
    expect(res.statusCode).toBe(401);
  });

  dbIt('非 uuid 订单返回 400 ORDER_ID_INVALID', async () => {
    const username = `admtest-cbadid-${Date.now().toString(36)}`;
    await createAdmin(username, 'confirm-password-1');
    const login = await adminLogin(username, 'confirm-password-1');
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/orders/not-a-uuid/confirm',
      headers: { authorization: `Bearer ${login.json().token as string}` },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'ORDER_ID_INVALID' });
  });

  dbIt('订单不存在返回 404 ORDER_NOT_FOUND', async () => {
    const username = `admtest-cnofind-${Date.now().toString(36)}`;
    await createAdmin(username, 'confirm-password-1');
    const login = await adminLogin(username, 'confirm-password-1');
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/orders/5c3b6f1e-2c8a-4f1a-9e7b-0a1b2c3d4e5f/confirm',
      headers: { authorization: `Bearer ${login.json().token as string}` },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: 'ORDER_NOT_FOUND' });
  });

  dbIt('pending 确权成功：订单置 paid、订阅顺延 30 天、当月额度按付费档刷新、留审计', async () => {
    const username = `admtest-cok-${Date.now().toString(36)}`;
    await createAdmin(username, 'confirm-password-1');
    const login = await adminLogin(username, 'confirm-password-1');
    const headers = { authorization: `Bearer ${login.json().token as string}` };
    const userId = await createUserRow(`139${String(Math.floor(Math.random() * 90000000) + 10000000)}`);
    const order = await createPendingOrder(userId);
    const periodRows = await pool.query<{ period: string }>(
      `SELECT to_char(now(), 'YYYY-MM') AS period`,
    );
    const period = periodRows.rows[0]?.period ?? '';
    const res = await app.inject({
      method: 'POST',
      url: `/api/admin/orders/${order.id}/confirm`,
      headers,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.order).toMatchObject({ id: order.id, orderNo: order.orderNo, status: 'paid' });
    expect(body.subscription).toMatchObject({ status: 'paid' });
    expectExpiryAround(body.subscription.expiresAt, 30);
    expect(body.quota).toMatchObject({
      period,
      ttsCharsQuota: QUOTA_TIERS.paid.ttsCharsQuota,
      scriptGenerationsQuota: QUOTA_TIERS.paid.scriptGenerationsQuota,
      liveMinutesQuota: QUOTA_TIERS.paid.liveMinutesQuota,
    });
    const orderRows = await pool.query(
      `SELECT status, paid_at FROM orders WHERE id = $1`,
      [order.id],
    );
    expect(orderRows.rows[0]).toMatchObject({ status: 'paid' });
    expect(orderRows.rows[0]?.paid_at).toBeTruthy();
    const userRows = await pool.query(
      `SELECT subscription_status AS status FROM users WHERE id = $1`,
      [userId],
    );
    expect(userRows.rows[0]).toMatchObject({ status: 'paid' });
    const quotaRow = await readQuotaRow(userId, period);
    expect(quotaRow).toMatchObject({
      tts_chars_quota: QUOTA_TIERS.paid.ttsCharsQuota,
      script_generations_quota: QUOTA_TIERS.paid.scriptGenerationsQuota,
      live_minutes_quota: QUOTA_TIERS.paid.liveMinutesQuota,
      tts_chars_used: 0,
    });
    const audit = await app.inject({
      method: 'GET',
      url: '/api/admin/audit/logs?pageSize=50',
      headers,
    });
    const auditItems = audit.json().items as Array<Record<string, unknown>>;
    expect(
      auditItems.some(
        (item) =>
          item.action === 'order.confirm' &&
          item.resourceId === order.id &&
          item.adminUsername === username,
      ),
    ).toBe(true);
  });

  dbIt('重复确权返回 409 ALREADY_CONFIRMED 且订阅不再顺延', async () => {
    const username = `admtest-cdup-${Date.now().toString(36)}`;
    await createAdmin(username, 'confirm-password-1');
    const login = await adminLogin(username, 'confirm-password-1');
    const headers = { authorization: `Bearer ${login.json().token as string}` };
    const userId = await createUserRow(`139${String(Math.floor(Math.random() * 90000000) + 10000000)}`);
    const order = await createPendingOrder(userId);
    const first = await app.inject({
      method: 'POST',
      url: `/api/admin/orders/${order.id}/confirm`,
      headers,
    });
    expect(first.statusCode).toBe(200);
    const expiresAfterFirst = first.json().subscription.expiresAt as string;
    const second = await app.inject({
      method: 'POST',
      url: `/api/admin/orders/${order.id}/confirm`,
      headers,
    });
    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({ error: 'ALREADY_CONFIRMED' });
    const userRows = await pool.query(
      `SELECT subscription_expires_at AS "expiresAt" FROM users WHERE id = $1`,
      [userId],
    );
    expect(new Date(userRows.rows[0]?.expiresAt as string).getTime()).toBe(
      new Date(expiresAfterFirst).getTime(),
    );
  });

  dbIt('refunded/closed 订单确权返回 409 CANNOT_CONFIRM', async () => {
    const username = `admtest-cref-${Date.now().toString(36)}`;
    await createAdmin(username, 'confirm-password-1');
    const login = await adminLogin(username, 'confirm-password-1');
    const headers = { authorization: `Bearer ${login.json().token as string}` };
    const userId = await createUserRow(`139${String(Math.floor(Math.random() * 90000000) + 10000000)}`);
    const order = await createPendingOrder(userId);
    await pool.query(`UPDATE orders SET status = 'refunded' WHERE id = $1`, [order.id]);
    const res = await app.inject({
      method: 'POST',
      url: `/api/admin/orders/${order.id}/confirm`,
      headers,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'CANNOT_CONFIRM' });
  });

  dbIt('已有未来到期日时顺延 30 天（30+10=40 天口径）', async () => {
    const username = `admtest-cext-${Date.now().toString(36)}`;
    await createAdmin(username, 'confirm-password-1');
    const login = await adminLogin(username, 'confirm-password-1');
    const headers = { authorization: `Bearer ${login.json().token as string}` };
    const userId = await createUserRow(`139${String(Math.floor(Math.random() * 90000000) + 10000000)}`);
    await pool.query(
      `UPDATE users SET subscription_status = 'paid',
         subscription_expires_at = now() + interval '10 days'
       WHERE id = $1`,
      [userId],
    );
    const order = await createPendingOrder(userId);
    const res = await app.inject({
      method: 'POST',
      url: `/api/admin/orders/${order.id}/confirm`,
      headers,
    });
    expect(res.statusCode).toBe(200);
    expectExpiryAround(res.json().subscription.expiresAt, 40);
  });
});
