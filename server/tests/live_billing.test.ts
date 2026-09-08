import { afterAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { pool } from '../src/db/client';
import { billableWholeMinutes } from '../src/services/liveBilling';

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

// 本次测试注册的用户（afterAll 统一删除；users 级联清理 lives/账本/额度）
const createdUserIds: string[] = [];

function randomPhone(): string {
  return `138${String(Math.floor(Math.random() * 90000000) + 10000000)}`;
}

async function registerMerchant(phone: string): Promise<{ token: string; userId: string }> {
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
  const rows = await pool.query<{ id: string }>('SELECT id FROM users WHERE phone = $1', [phone]);
  const userId = rows.rows[0]?.id;
  if (!userId) {
    throw new Error('注册商家后查询用户失败');
  }
  createdUserIds.push(userId);
  return { token: verify.json().token as string, userId };
}

function bearer(token: string): { authorization: string } {
  return { authorization: `Bearer ${token}` };
}

/** 创建开播配置草稿（201），返回 live.id */
async function createLiveDraft(token: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/lives',
    headers: bearer(token),
    payload: { title: '结束结算接线测试' },
  });
  expect(res.statusCode).toBe(201);
  return (res.json() as { live: { id: string } }).live.id;
}

/** 直接把场次置为 live（N 秒前开播），再走真实 /end 路由结算 */
async function startAndEndLive(token: string, startedSecondsAgo: number): Promise<void> {
  const liveId = await createLiveDraft(token);
  const headers = bearer(token);
  const startedAt = new Date(Date.now() - startedSecondsAgo * 1000);
  await pool.query(
    `UPDATE lives
        SET status = 'live', started_at = $1, ended_at = null
      WHERE id = $2`,
    [startedAt, liveId],
  );
  const ended = await app.inject({
    method: 'POST',
    url: `/api/lives/${liveId}/end`,
    headers,
    payload: {},
  });
  expect(ended.statusCode).toBe(200);
  const live = ended.json().live as { status: string; startedAt: string | null; endedAt: string | null };
  expect(live.status).toBe('ended');
  expect(live.endedAt).toBeTruthy();
}

/** 复位该用户的账本/额度，并按需预置：balanceMinutes 余额 + 当月直播免费额度 */
async function seedLedger(
  userId: string,
  opts: { balanceMinutes?: number; liveQuota?: number; liveUsed?: number },
): Promise<void> {
  await pool.query('DELETE FROM hour_balance_ledger WHERE user_id = $1', [userId]);
  await pool.query('DELETE FROM hour_balance_accounts WHERE user_id = $1', [userId]);
  await pool.query('DELETE FROM quotas WHERE user_id = $1', [userId]);
  const balance = opts.balanceMinutes ?? 0;
  await pool.query(
    `INSERT INTO hour_balance_accounts (user_id, balance_minutes) VALUES ($1, $2)`,
    [userId, balance],
  );
  const liveQuota = opts.liveQuota ?? 10;
  const liveUsed = opts.liveUsed ?? 0;
  await pool.query(
    `INSERT INTO quotas
       (user_id, period, tts_chars_quota, script_generations_quota, live_minutes_quota, live_minutes_used)
     VALUES ($1, to_char(now(), 'YYYY-MM'), 0, 0, $2, $3)`,
    [userId, liveQuota, liveUsed],
  );
}

/** 读取该用户结算后的账本/额度/扣减流水 */
async function readLedgerState(userId: string): Promise<{
  balance: number;
  quotaUsed: number;
  deductCount: number;
  lastRemark: string | null;
}> {
  const bal = await pool.query<{ b: number }>(
    'SELECT balance_minutes AS b FROM hour_balance_accounts WHERE user_id = $1',
    [userId],
  );
  const quota = await pool.query<{ u: number }>(
    `SELECT live_minutes_used AS u FROM quotas
     WHERE user_id = $1 AND period = to_char(now(), 'YYYY-MM')`,
    [userId],
  );
  const ledger = await pool.query<{ delta: number; remark: string | null }>(
    `SELECT delta_minutes AS delta, remark
     FROM hour_balance_ledger WHERE user_id = $1 AND source_kind = 'live_deduct'
     ORDER BY created_at`,
    [userId],
  );
  const rows = ledger.rows;
  return {
    balance: bal.rows[0]?.b ?? 0,
    quotaUsed: quota.rows[0]?.u ?? 0,
    deductCount: rows.length,
    lastRemark: rows[rows.length - 1]?.remark ?? null,
  };
}

afterAll(async () => {
  if (createdUserIds.length > 0) {
    await pool.query('DELETE FROM users WHERE id = ANY($1)', [createdUserIds]);
  }
  await app.close();
  await pool.end().catch(() => undefined);
});

it('billableWholeMinutes：整分钟向下取整，起止缺失 / 反向为 0', () => {
  expect(billableWholeMinutes(null, '2026-09-08T00:00:30.000Z')).toBe(0);
  expect(billableWholeMinutes('2026-09-08T00:00:30.000Z', null)).toBe(0);
  const start = new Date('2026-09-08T00:00:00.000Z');
  const end = new Date('2026-09-08T00:00:59.000Z');
  expect(billableWholeMinutes(start.toISOString(), end.toISOString())).toBe(0);
  const end2 = new Date('2026-09-08T00:01:00.000Z');
  expect(billableWholeMinutes(start.toISOString(), end2.toISOString())).toBe(1);
  const end3 = new Date('2026-09-08T00:05:29.000Z');
  expect(billableWholeMinutes(start.toISOString(), end3.toISOString())).toBe(5);
  const back = new Date('2026-09-07T23:00:00.000Z');
  expect(billableWholeMinutes(start.toISOString(), back.toISOString())).toBe(0);
});

describe('直播结束结算（/api/lives/:id/end 接线）', () => {
  dbIt('余额优先 → 免费分钟兜底 → 双双耗尽缺额不阻断；不足 1 分钟不结算', async () => {
    const merchant = await registerMerchant(randomPhone());
    // 预置：余额 30 分钟，当月免费直播 10 分钟
    await seedLedger(merchant.userId, { balanceMinutes: 30, liveQuota: 10, liveUsed: 0 });

    // 场景 1：余额充足 → 扣余额 1 分钟，不碰免费额度，写 live_deduct 流水（remark 带场次号）
    await startAndEndLive(merchant.token, 61);
    let state = await readLedgerState(merchant.userId);
    expect(state.balance).toBe(29);
    expect(state.quotaUsed).toBe(0);
    expect(state.deductCount).toBe(1);
    expect(state.lastRemark).toMatch(/^live:/);

    // 场景 2：余额清零 → 回落到当月免费直播分钟（仍不写余额流水）
    await pool.query('UPDATE hour_balance_accounts SET balance_minutes = 0 WHERE user_id = $1', [
      merchant.userId,
    ]);
    await startAndEndLive(merchant.token, 61);
    state = await readLedgerState(merchant.userId);
    expect(state.balance).toBe(0);
    expect(state.quotaUsed).toBe(1);
    // 免费分钟兜底不走余额流水，live_deduct 仍只有场景 1 那一条
    expect(state.deductCount).toBe(1);

    // 场景 3：免费额度也用满 → 缺额式结算不抛错不阻断，账本原样（仅服务端告警）
    await pool.query(
      `UPDATE quotas SET live_minutes_used = live_minutes_quota
       WHERE user_id = $1 AND period = to_char(now(), 'YYYY-MM')`,
      [merchant.userId],
    );
    await startAndEndLive(merchant.token, 61);
    state = await readLedgerState(merchant.userId);
    expect(state.balance).toBe(0);
    expect(state.quotaUsed).toBe(10);
    expect(state.deductCount).toBe(1);

    // 场景 4：不足 1 分钟（30 秒前开播）→ settledMinutes=0，什么都不扣
    await pool.query(
      `UPDATE quotas SET live_minutes_used = 0
       WHERE user_id = $1 AND period = to_char(now(), 'YYYY-MM')`,
      [merchant.userId],
    );
    await startAndEndLive(merchant.token, 30);
    state = await readLedgerState(merchant.userId);
    expect(state.balance).toBe(0);
    expect(state.quotaUsed).toBe(0);
    expect(state.deductCount).toBe(1);
  });
});
