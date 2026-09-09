import { afterAll, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { pool } from '../src/db/client';
import { readCurrentPeriod } from '../src/services/quota';
import { recordTtsUsage } from '../src/services/ttsUsage';

// T5 TTS 计量服务测试：真实合成才扣额度 + 落 usage_logs；命中不写（命中旁路不调用本服务）。
// DB 探测：库不可用时整组 skip（同 voices.test.ts / streaming.test.ts 惯例），避免 CI 误报。

let dbAvailable = false;
try {
  await pool.query('SELECT 1');
  dbAvailable = true;
} catch {
  dbAvailable = false;
}
const dbIt = dbAvailable ? it : it.skip;

const createdUsers: string[] = [];

async function createTestUser(): Promise<string> {
  const phone = `138${randomUUID().replace(/-/g, '').slice(0, 8)}`;
  const rows = await pool.query('INSERT INTO users (phone) VALUES ($1) RETURNING id', [phone]);
  const userId = rows.rows[0]?.id as string | undefined;
  if (!userId) {
    throw new Error('测试用户创建失败');
  }
  createdUsers.push(userId);
  return userId;
}

async function quotaUsed(userId: string, period: string): Promise<number> {
  const rows = await pool.query(
    'SELECT tts_chars_used::int AS used FROM quotas WHERE user_id = $1 AND period = $2',
    [userId, period],
  );
  return rows.rows[0]?.used as number;
}

async function ttsUsageLogCount(userId: string): Promise<number> {
  const rows = await pool.query(
    "SELECT count(*)::int AS n FROM usage_logs WHERE user_id = $1 AND category = 'tts'",
    [userId],
  );
  return rows.rows[0]?.n as number;
}

afterAll(async () => {
  for (const userId of createdUsers) {
    await pool.query('DELETE FROM users WHERE id = $1', [userId]).catch(() => undefined);
  }
  await pool.end().catch(() => undefined);
});

dbIt('真实合成计量：扣当月字符额度并写 usage_logs 一条', async () => {
  const userId = await createTestUser();
  const period = await readCurrentPeriod();
  const result = await recordTtsUsage({ userId, chars: 12, provider: 'volc', model: 'seed-tts-2.0' });
  expect(result.ok).toBe(true);
  expect(await quotaUsed(userId, period)).toBe(12);
  expect(await ttsUsageLogCount(userId)).toBe(1);

  const logs = await pool.query(
    "SELECT provider, model, output_chars::int AS chars, cost_cents::int AS cost, status FROM usage_logs WHERE user_id = $1 AND category = 'tts'",
    [userId],
  );
  expect(logs.rows[0]).toMatchObject({
    provider: 'volc',
    model: 'seed-tts-2.0',
    chars: 12,
    cost: 0,
    status: 'success',
  });
});

dbIt('额度不足：拒绝扣减、不写流水（原子守门）', async () => {
  const userId = await createTestUser();
  const period = await readCurrentPeriod();
  const first = await recordTtsUsage({ userId, chars: 5 });
  expect(first.ok).toBe(true);

  // 人为把当月额度压到已用量，模拟额度耗尽
  await pool.query(
    'UPDATE quotas SET tts_chars_quota = tts_chars_used WHERE user_id = $1 AND period = $2',
    [userId, period],
  );

  const second = await recordTtsUsage({ userId, chars: 1 });
  expect(second).toEqual({ ok: false, reason: 'quota_exceeded' });
  expect(await quotaUsed(userId, period)).toBe(5);
  expect(await ttsUsageLogCount(userId)).toBe(1);
});

dbIt('计量入参非法：字符数非正数直接抛错', async () => {
  const userId = await createTestUser();
  await expect(recordTtsUsage({ userId, chars: 0 })).rejects.toThrow();
});
