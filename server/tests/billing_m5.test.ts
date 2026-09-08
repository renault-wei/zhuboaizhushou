import { afterAll, describe, expect, it } from 'vitest';
import bcrypt from 'bcryptjs';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { pool } from '../src/db/client';
import { deductLiveMinutes } from '../src/services/ledger';

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

// 本次测试创建的 id（afterAll 统一清理，避免污染开发库）
const createdAdminIds: string[] = [];
const createdUserIds: string[] = [];
const createdBatchIds: string[] = [];
const createdConfigKeys: string[] = [];

function randomPhone(): string {
  return `138${String(Math.floor(Math.random() * 90000000) + 10000000)}`;
}

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

/** 注册一个新商家，返回 token + userId（userId 纳入 afterAll 清理） */
async function registerMerchant(phone: string): Promise<{ token: string; userId: string }> {
  const token = await registerMerchantToken(phone);
  const rows = await pool.query<{ id: string }>('SELECT id FROM users WHERE phone = $1', [phone]);
  const userId = rows.rows[0]?.id;
  if (!userId) {
    throw new Error('注册商家后查询用户失败');
  }
  createdUserIds.push(userId);
  return { token, userId };
}

/** 直接落一条后台账号（bcrypt 哈希），返回 id；由 afterAll 统一清理 */
async function createAdmin(username: string, password = 'confirm-password-1'): Promise<string> {
  const hash = await bcrypt.hash(password, 4);
  const rows = await pool.query<{ id: string }>(
    `INSERT INTO admin_users (username, password_hash, role, is_active)
     VALUES ($1, $2, 'super_admin', true) RETURNING id`,
    [username, hash],
  );
  const id = rows.rows[0]?.id;
  if (!id) {
    throw new Error('创建测试后台账号失败');
  }
  createdAdminIds.push(id);
  return id;
}

async function adminHeaders(username: string, password = 'confirm-password-1') {
  const login = await app.inject({
    method: 'POST',
    url: '/api/admin/login',
    payload: { username, password },
  });
  expect(login.statusCode).toBe(200);
  return { authorization: `Bearer ${login.json().token as string}` };
}

async function createCardBatch(headers: Record<string, string>) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/admin/card-batches',
    headers,
    payload: {
      name: `测试批次-${Date.now().toString(36)}`,
      count: 2,
      minutesPerCard: 90,
      remark: 'M5 测试批次',
    },
  });
  expect(res.statusCode).toBe(200);
  const body = res.json() as {
    batch: Record<string, unknown>;
    codes: Array<{ code: string; displayCode: string }>;
  };
  const batchId = body.batch.id as string;
  createdBatchIds.push(batchId);
  return { batchId, codes: body.codes };
}

afterAll(async () => {
  if (createdConfigKeys.length > 0) {
    await pool.query('DELETE FROM app_config WHERE key = ANY($1)', [createdConfigKeys]);
  }
  if (createdBatchIds.length > 0) {
    await pool.query('DELETE FROM card_batches WHERE id = ANY($1)', [createdBatchIds]);
  }
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

describe('服务端开关下发（app_config）', () => {
  dbIt('GET /api/app/config 公开读默认开关：1h/10h 档位 + 余额优先', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/app/config' });
    expect(res.statusCode).toBe(200);
    const config = res.json().config as {
      showCharge: boolean;
      pricePacks: Array<{ hours: number; amountCents: number }>;
      notice: string;
      quotaPriority: string[];
    };
    expect(config.showCharge).toBe(true);
    expect(config.pricePacks).toEqual([
      { hours: 1, amountCents: 990 },
      { hours: 10, amountCents: 8990 },
    ]);
    expect(config.notice).toBe('');
    expect(config.quotaPriority).toEqual(['balance', 'quota']);
  });

  dbIt('管理端写开关：白名单拦截 + 值归一 + 公开读回生效', async () => {
    const username = `adm-m5-cfg-${Date.now().toString(36)}`;
    await createAdmin(username);
    const headers = await adminHeaders(username);
    const badKey = await app.inject({
      method: 'PUT',
      url: '/api/admin/app-config/nope',
      headers,
      payload: { value: true },
    });
    expect(badKey.statusCode).toBe(400);
    expect(badKey.json()).toMatchObject({ error: 'CONFIG_KEY_INVALID' });
    const badValue = await app.inject({
      method: 'PUT',
      url: '/api/admin/app-config/showCharge',
      headers,
      payload: { value: 'yes' },
    });
    expect(badValue.statusCode).toBe(400);
    expect(badValue.json()).toMatchObject({ error: 'CONFIG_VALUE_INVALID' });
    const ok = await app.inject({
      method: 'PUT',
      url: '/api/admin/app-config/showCharge',
      headers,
      payload: { value: false },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ key: 'showCharge', value: false });
    createdConfigKeys.push('showCharge');
    const pub = await app.inject({ method: 'GET', url: '/api/app/config' });
    expect((pub.json().config as { showCharge: boolean }).showCharge).toBe(false);
    const adminRead = await app.inject({
      method: 'GET',
      url: '/api/admin/app-config',
      headers,
    });
    expect(adminRead.statusCode).toBe(200);
    expect(adminRead.json().config).toMatchObject({ showCharge: false });
  });
});

describe('扫码直充 mock 全链路（M5 服务端账本）', () => {
  dbIt('下单 → 轮询 pending → 运营确权 → 时长入账且不碰订阅', async () => {
    const merchant = await registerMerchant(randomPhone());
    const headers = { authorization: `Bearer ${merchant.token}` };
    const badHours = await app.inject({
      method: 'POST',
      url: '/api/recharge/scan',
      headers,
      payload: { hours: 'x' },
    });
    expect(badHours.statusCode).toBe(400);
    expect(badHours.json()).toMatchObject({ error: 'HOURS_INVALID' });
    const badPack = await app.inject({
      method: 'POST',
      url: '/api/recharge/scan',
      headers,
      payload: { hours: 3 },
    });
    expect(badPack.statusCode).toBe(400);
    expect(badPack.json()).toMatchObject({ error: 'PACK_INVALID' });
    const scan = await app.inject({
      method: 'POST',
      url: '/api/recharge/scan',
      headers,
      payload: { hours: 1 },
    });
    expect(scan.statusCode).toBe(200);
    const scanBody = scan.json() as {
      mockChannel: boolean;
      qrcodeUrl: string;
      order: Record<string, unknown>;
    };
    expect(scanBody.mockChannel).toBe(true);
    expect(scanBody.qrcodeUrl.startsWith('mock://')).toBe(true);
    expect(scanBody.order).toMatchObject({
      kind: 'recharge',
      channel: 'alipay_scan',
      hours: 1,
      minutes: 60,
      amountCents: 990,
      status: 'pending',
    });
    const orderId = scanBody.order.id as string;
    const pendingPoll = await app.inject({
      method: 'POST',
      url: '/api/recharge/poll',
      headers,
      payload: { orderId },
    });
    expect(pendingPoll.statusCode).toBe(200);
    expect(pendingPoll.json()).toMatchObject({ status: 'pending', paidAt: null });
    expect(pendingPoll.json().balanceMinutes).toBeUndefined();

    const adminUser = `adm-m5-scan-${Date.now().toString(36)}`;
    await createAdmin(adminUser);
    const adminHdrs = await adminHeaders(adminUser);
    const confirm = await app.inject({
      method: 'POST',
      url: `/api/admin/orders/${orderId}/confirm`,
      headers: adminHdrs,
    });
    expect(confirm.statusCode).toBe(200);
    expect(confirm.json().order).toMatchObject({
      id: orderId,
      kind: 'recharge',
      status: 'paid',
      amountCents: 990,
    });
    expect(confirm.json().recharge).toMatchObject({ creditedMinutes: 60, balanceMinutes: 60 });

    const account = await pool.query(
      `SELECT balance_minutes AS balance FROM hour_balance_accounts WHERE user_id = $1`,
      [merchant.userId],
    );
    expect(account.rows[0]).toMatchObject({ balance: 60 });
    const ledger = await pool.query(
      `SELECT delta_minutes AS delta, balance_after_minutes AS after, source_kind AS kind
       FROM hour_balance_ledger WHERE user_id = $1 AND source_kind = 'recharge_order'`,
      [merchant.userId],
    );
    expect(ledger.rows).toHaveLength(1);
    expect(ledger.rows[0]).toMatchObject({ delta: 60, after: 60, kind: 'recharge_order' });
    const userRows = await pool.query(
      `SELECT subscription_status AS status, subscription_expires_at AS expires
       FROM users WHERE id = $1`,
      [merchant.userId],
    );
    expect(userRows.rows[0]).toMatchObject({ status: 'free' });
    expect(userRows.rows[0]?.expires).toBeNull();

    const dup = await app.inject({
      method: 'POST',
      url: `/api/admin/orders/${orderId}/confirm`,
      headers: adminHdrs,
    });
    expect(dup.statusCode).toBe(409);
    expect(dup.json()).toMatchObject({ error: 'ALREADY_CONFIRMED' });
    const paidPoll = await app.inject({
      method: 'POST',
      url: '/api/recharge/poll',
      headers,
      payload: { orderId },
    });
    expect(paidPoll.statusCode).toBe(200);
    expect(paidPoll.json()).toMatchObject({ status: 'paid' });
    expect(paidPoll.json().balanceMinutes).toBe(60);
  });
});

describe('卡密批次生成与核销（M5 服务端账本）', () => {
  dbIt('批次生成 → 商家核销入账 → 重复核销 409 且不入账', async () => {
    const adminUser = `adm-m5-card-${Date.now().toString(36)}`;
    await createAdmin(adminUser);
    const adminHdrs = await adminHeaders(adminUser);
    const { batchId, codes } = await createCardBatch(adminHdrs);
    expect(codes).toHaveLength(2);
    for (const item of codes) {
      expect(item.code).toMatch(/^[A-Z0-9]{16}$/);
      expect(item.displayCode).toMatch(/^[A-Z0-9]{4}(-[A-Z0-9]{4}){3}$/);
    }
    const list = await app.inject({
      method: 'GET',
      url: '/api/admin/card-batches?pageSize=50',
      headers: adminHdrs,
    });
    const found = (list.json().items as Array<Record<string, unknown>>).find(
      (item) => item.id === batchId,
    );
    expect(found).toMatchObject({
      id: batchId,
      total_count: 2,
      minutes_per_card: 90,
      issued_count: 2,
      redeemed_count: 0,
    });
    const detail = await app.inject({
      method: 'GET',
      url: `/api/admin/card-batches/${batchId}`,
      headers: adminHdrs,
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().batch).toMatchObject({
      id: batchId,
      totalCount: 2,
      minutesPerCard: 90,
      status: 'active',
    });
    expect(detail.json().codes).toHaveLength(2);

    const merchant = await registerMerchant(randomPhone());
    const redeemHdrs = { authorization: `Bearer ${merchant.token}` };
    const lowerDashed = codes[0]?.displayCode.toLowerCase();
    const redeem = await app.inject({
      method: 'POST',
      url: '/api/cards/redeem',
      headers: redeemHdrs,
      payload: { code: lowerDashed },
    });
    expect(redeem.statusCode).toBe(200);
    expect(redeem.json()).toMatchObject({
      status: 'redeemed',
      batchId,
      creditedMinutes: 90,
      balanceMinutes: 90,
    });
    const codeRows = await pool.query(
      `SELECT status, redeemed_by_user_id AS uid FROM card_codes WHERE code = $1`,
      [codes[0]?.code],
    );
    expect(codeRows.rows[0]).toMatchObject({ status: 'redeemed', uid: merchant.userId });
    const redeemOrder = await pool.query(
      `SELECT kind, channel, minutes, amount_cents AS cents, status
       FROM orders WHERE user_id = $1 AND kind = 'recharge' AND channel = 'card'`,
      [merchant.userId],
    );
    expect(redeemOrder.rows).toHaveLength(1);
    expect(redeemOrder.rows[0]).toMatchObject({
      kind: 'recharge',
      channel: 'card',
      minutes: 90,
      cents: 0,
      status: 'paid',
    });

    const dup = await app.inject({
      method: 'POST',
      url: '/api/cards/redeem',
      headers: redeemHdrs,
      payload: { code: codes[0]?.displayCode },
    });
    expect(dup.statusCode).toBe(409);
    expect(dup.json()).toMatchObject({ error: 'CARD_REDEEMED' });
    const afterDup = await pool.query(
      `SELECT balance_minutes AS balance FROM hour_balance_accounts WHERE user_id = $1`,
      [merchant.userId],
    );
    expect(afterDup.rows[0]).toMatchObject({ balance: 90 });
    const ledger = await pool.query(
      `SELECT count(*)::int AS total FROM hour_balance_ledger
       WHERE user_id = $1 AND source_kind = 'card_redeem'`,
      [merchant.userId],
    );
    expect(ledger.rows[0]).toMatchObject({ total: 1 });

    const unknown = await app.inject({
      method: 'POST',
      url: '/api/cards/redeem',
      headers: redeemHdrs,
      payload: { code: 'ZZZZ-ZZZZ-ZZZZ-ZZZZ' },
    });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toMatchObject({ error: 'CARD_NOT_FOUND' });
  });

  dbIt('停用批次 / 作废卡密核销被拒', async () => {
    const adminUser = `adm-m5-cardoff-${Date.now().toString(36)}`;
    await createAdmin(adminUser);
    const adminHdrs = await adminHeaders(adminUser);
    const create = await app.inject({
      method: 'POST',
      url: '/api/admin/card-batches',
      headers: adminHdrs,
      payload: { name: '停用批次', count: 1, minutesPerCard: 30, remark: '' },
    });
    const batch = (create.json() as { batch: Record<string, unknown> }).batch;
    const batchId = batch.id as string;
    createdBatchIds.push(batchId);
    const code = (create.json() as { codes: Array<{ code: string; displayCode: string }> }).codes[0]
      ?.code as string;
    const merchant = await registerMerchant(randomPhone());
    const redeemHdrs = { authorization: `Bearer ${merchant.token}` };
    await pool.query(`UPDATE card_batches SET status = 'disabled' WHERE id = $1`, [batchId]);
    const disabled = await app.inject({
      method: 'POST',
      url: '/api/cards/redeem',
      headers: redeemHdrs,
      payload: { code },
    });
    expect(disabled.statusCode).toBe(409);
    expect(disabled.json()).toMatchObject({ error: 'BATCH_DISABLED' });
    await pool.query(`UPDATE card_codes SET status = 'revoked' WHERE batch_id = $1`, [batchId]);
    const revoked = await app.inject({
      method: 'POST',
      url: '/api/cards/redeem',
      headers: redeemHdrs,
      payload: { code },
    });
    expect(revoked.statusCode).toBe(409);
    expect(revoked.json()).toMatchObject({ error: 'CARD_REVOKED' });
  });
});

describe('时长扣减（services/ledger）', () => {
  dbIt('余额优先，余额不足回落当月免费直播分钟', async () => {
    const merchant = await registerMerchant(randomPhone());
    await pool.query(
      `INSERT INTO hour_balance_accounts (user_id, balance_minutes)
       VALUES ($1, 100) ON CONFLICT (user_id) DO NOTHING`,
      [merchant.userId],
    );
    const first = await deductLiveMinutes({ userId: merchant.userId, minutes: 40 });
    expect(first).toMatchObject({
      ok: true,
      drawnFromBalance: 40,
      drawnFromQuota: 0,
      balanceMinutes: 60,
    });
    const second = await deductLiveMinutes({ userId: merchant.userId, minutes: 30 });
    expect(second).toMatchObject({
      ok: true,
      drawnFromBalance: 30,
      drawnFromQuota: 0,
      balanceMinutes: 30,
    });
    const third = await deductLiveMinutes({ userId: merchant.userId, minutes: 50 });
    expect(third).toMatchObject({
      ok: true,
      drawnFromBalance: 30,
      drawnFromQuota: 20,
      balanceMinutes: 0,
    });
    // 把当月免费直播分钟也用满后，扣减应整体拒绝（不产生部分扣减）
    await pool.query(
      `UPDATE quotas SET live_minutes_used = live_minutes_quota
       WHERE user_id = $1 AND period = to_char(now(), 'YYYY-MM')`,
      [merchant.userId],
    );
    const exhaustion = await deductLiveMinutes({ userId: merchant.userId, minutes: 10 });
    expect(exhaustion.ok).toBe(false);
    expect(exhaustion).toMatchObject({
      drawnFromBalance: 0,
      drawnFromQuota: 0,
      balanceMinutes: 0,
    });
    expect(exhaustion.reason).toBe('BALANCE_AND_QUOTA_EXHAUSTED');
    const deductions = await pool.query(
      `SELECT count(*)::int AS total FROM hour_balance_ledger
       WHERE user_id = $1 AND source_kind = 'live_deduct'`,
      [merchant.userId],
    );
    expect(deductions.rows[0]).toMatchObject({ total: 3 });
  });
});
