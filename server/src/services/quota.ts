import { sql } from 'drizzle-orm';
import { db } from '../db/client';
import { QUOTA_TIERS } from './quotaTiers';

// ---------- 商家月度配额账本（console-roadmap M4）----------
// quotas 唯一键 (user_id, period)，period=YYYY-MM；月度重置 = 每月新起一行。
// 口径：商家首次调用第三方 AI 前按「免费试用档」自动建档；此后按行内 quota/used 校验。

export interface MonthlyQuotaRow {
  id: string;
  userId: string;
  period: string;
  ttsCharsQuota: number;
  ttsCharsUsed: number;
  scriptGenerationsQuota: number;
  scriptGenerationsUsed: number;
  liveMinutesQuota: number;
  liveMinutesUsed: number;
}

/** 月度周期（period=YYYY-MM）当前值：以数据库时间为准，避免应用/DB 时区漂移 */
export async function readCurrentPeriod(): Promise<string> {
  const rows = await db.execute(sql`SELECT to_char(now(), 'YYYY-MM') AS period`);
  return (rows.rows[0]?.period as string) ?? new Date().toISOString().slice(0, 7);
}

/** 确保当月配额行存在：无行时按免费试用档自动建档；已有行（付费档/运营调整）原样保留 */
export async function ensureMonthlyQuotaRow(
  userId: string,
  period: string,
): Promise<MonthlyQuotaRow> {
  const free = QUOTA_TIERS.free;
  await db.execute(sql`
    INSERT INTO quotas (user_id, period, tts_chars_quota, script_generations_quota, live_minutes_quota, updated_at)
    VALUES (${userId}, ${period}, ${free.ttsCharsQuota}, ${free.scriptGenerationsQuota}, ${free.liveMinutesQuota}, now())
    ON CONFLICT (user_id, period) DO NOTHING
  `);
  const rows = await db.execute(sql`
    SELECT id, user_id, period, tts_chars_quota, tts_chars_used,
           script_generations_quota, script_generations_used,
           live_minutes_quota, live_minutes_used
    FROM quotas
    WHERE user_id = ${userId} AND period = ${period}
    LIMIT 1
  `);
  const row = rows.rows[0] as Record<string, unknown> | undefined;
  if (!row) {
    throw new Error('配额行初始化失败');
  }
  return {
    id: row.id as string,
    userId: row.user_id as string,
    period: row.period as string,
    ttsCharsQuota: row.tts_chars_quota as number,
    ttsCharsUsed: row.tts_chars_used as number,
    scriptGenerationsQuota: row.script_generations_quota as number,
    scriptGenerationsUsed: row.script_generations_used as number,
    liveMinutesQuota: row.live_minutes_quota as number,
    liveMinutesUsed: row.live_minutes_used as number,
  };
}

/**
 * 话术生成成功后的额度 +1（原子守门：used < quota 才放行）。
 * 返回 false 表示该瞬间额度已被并发请求耗尽（不会把 used 加超）。
 */
export async function bumpScriptGenerationUsed(
  userId: string,
  period: string,
): Promise<boolean> {
  const result = await db.execute(sql`
    UPDATE quotas
    SET script_generations_used = script_generations_used + 1, updated_at = now()
    WHERE user_id = ${userId} AND period = ${period}
      AND script_generations_used < script_generations_quota
  `);
  return (result.rowCount ?? 0) > 0;
}
