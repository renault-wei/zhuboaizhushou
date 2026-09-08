import { sql, type SQL } from 'drizzle-orm';
import { db } from '../db/client';
import { QUOTA_TIERS } from './quotaTiers';

// ---------- 时长余额账本（console-roadmap v0.3 商业化 M5）----------
// 与月度 quotas（免费试用 / 赠送上限）并行的第二本账：预充时长跨月不清零。
// 扣减口径（默认，可被 app_config.quotaPriority 覆盖）：
// 直播在线分钟先扣时长余额 → 余额为 0 回落当月免费直播分钟 → 再尽拒绝（路由层映射 402）。
// 入账 / 扣减都写 hour_balance_ledger 流水（含变动后余额），便于对账与审计。

export const LEDGER_SOURCE = {
  // 充值订单入账（扫码单运营确权 / 轮询确认）
  RECHARGE_ORDER: 'recharge_order',
  // 卡密核销入账
  CARD_REDEEM: 'card_redeem',
  // 直播 / 循环播报扣减
  LIVE_DEDUCT: 'live_deduct',
  // 运营手动调整
  ADMIN_ADJUST: 'admin_adjust',
} as const;

// 默认扣减优先级：先时长余额，后当月免费直播分钟（app_config.quotaPriority 可覆盖）
export const DEFAULT_QUOTA_PRIORITY: ReadonlyArray<'balance' | 'quota'> = ['balance', 'quota'];

/** 事务内 SQL 执行器：兼容 db 与 db.transaction 回调里的 tx（两者都有 execute） */
export type LedgerExecutor = {
  execute: (
    query: SQL,
  ) => Promise<{ rows: Record<string, unknown>[]; rowCount?: number | null }>;
};

/** 把 db / tx 收敛成 LedgerExecutor（execute 签名差异走 unknown 收敛，避免类型膨胀） */
export function toLedgerExecutor(executor: { execute: unknown }): LedgerExecutor {
  const run = executor.execute as LedgerExecutor['execute'];
  // 用箭头函数保持 this=executor：drizzle 的 execute 依赖实例上的 dialect/session
  return { execute: (query) => run.call(executor, query) };
}

export interface TopUpInput {
  userId: string;
  /** 入账分钟数，正整数 */
  minutes: number;
  sourceKind: string;
  sourceId?: string | null;
  remark?: string | null;
}

export interface TopUpResult {
  userId: string;
  creditedMinutes: number;
  balanceMinutes: number;
}

/** 查询用户时长余额（分钟）；账户未建档返回 0 */
export async function readBalanceMinutes(userId: string): Promise<number> {
  const rows = await db.execute(sql`
    SELECT balance_minutes FROM hour_balance_accounts WHERE user_id = ${userId} LIMIT 1
  `);
  return (rows.rows[0]?.balance_minutes as number | undefined) ?? 0;
}

/**
 * 时长余额入账：账户懒建档（无行则补 0 行）+ 余额累加 + 写流水。
 * 在调用方事务内执行（exec 传 tx）；独立场景传 db 亦可。
 */
export async function topUpMinutes(
  exec: LedgerExecutor,
  input: TopUpInput,
): Promise<TopUpResult> {
  const minutes = Math.floor(input.minutes);
  if (!Number.isInteger(minutes) || minutes <= 0) {
    throw new Error('LEDGER_INVALID:入账分钟数必须为正整数');
  }
  await exec.execute(sql`
    INSERT INTO hour_balance_accounts (user_id, balance_minutes, updated_at)
    VALUES (${input.userId}, 0, now())
    ON CONFLICT (user_id) DO NOTHING
  `);
  const updated = await exec.execute(sql`
    UPDATE hour_balance_accounts
    SET balance_minutes = balance_minutes + ${minutes}, updated_at = now()
    WHERE user_id = ${input.userId}
    RETURNING balance_minutes
  `);
  const row = updated.rows[0];
  if (!row) {
    throw new Error('账本更新失败：时长余额账户缺失');
  }
  const balanceMinutes = row.balance_minutes as number;
  await exec.execute(sql`
    INSERT INTO hour_balance_ledger
      (user_id, delta_minutes, balance_after_minutes, source_kind, source_id, remark)
    VALUES
      (${input.userId}, ${minutes}, ${balanceMinutes}, ${input.sourceKind},
       ${input.sourceId ?? null}, ${input.remark ?? null})
  `);
  return { userId: input.userId, creditedMinutes: minutes, balanceMinutes };
}

export interface DeductLiveMinutesInput {
  userId: string;
  /** 本次扣减分钟数，正整数 */
  minutes: number;
  /** 扣减优先级：只允许出现 balance / quota，默认先余额后免费直播分钟 */
  priority?: ReadonlyArray<'balance' | 'quota'>;
  remark?: string | null;
}

export interface DeductLiveMinutesResult {
  ok: boolean;
  userId: string;
  requestedMinutes: number;
  /** 本次从时长余额扣掉的分钟数 */
  drawnFromBalance: number;
  /** 本次从当月免费直播分钟扣掉的分钟数 */
  drawnFromQuota: number;
  /** 扣减后时长余额（分钟） */
  balanceMinutes: number;
  /** 扣减后当月免费直播剩余（分钟） */
  monthlyQuotaRemaining: number;
  /** 扣减后每月免费直播剩余 */
  reason?: 'BALANCE_AND_QUOTA_EXHAUSTED';
}

/**
 * 直播 / 循环播报分钟扣减（原子，全成或全不成）：
 * 余额 + 免费直播分钟都不足时不做任何扣减，返回 ok=false（由路由层映射 402 引导续费）。
 */
export async function deductLiveMinutes(
  input: DeductLiveMinutesInput,
): Promise<DeductLiveMinutesResult> {
  const minutes = Math.floor(input.minutes);
  if (!Number.isInteger(minutes) || minutes <= 0) {
    throw new Error('LEDGER_INVALID:扣减分钟数必须为正整数');
  }
  const priority = input.priority ?? DEFAULT_QUOTA_PRIORITY;
  const free = QUOTA_TIERS.free;
  return db.transaction(async (tx) => {
    const exec = toLedgerExecutor(tx);
    const account = await exec.execute(sql`
      SELECT balance_minutes FROM hour_balance_accounts
      WHERE user_id = ${input.userId} FOR UPDATE
    `);
    const balance = (account.rows[0]?.balance_minutes as number | undefined) ?? 0;
    const periodRows = await exec.execute(sql`SELECT to_char(now(), 'YYYY-MM') AS period`);
    const period = periodRows.rows[0]?.period as string;
    await exec.execute(sql`
      INSERT INTO quotas
        (user_id, period, tts_chars_quota, script_generations_quota, live_minutes_quota, updated_at)
      VALUES
        (${input.userId}, ${period}, ${free.ttsCharsQuota}, ${free.scriptGenerationsQuota},
         ${free.liveMinutesQuota}, now())
      ON CONFLICT (user_id, period) DO NOTHING
    `);
    const quota = await exec.execute(sql`
      SELECT live_minutes_quota, live_minutes_used FROM quotas
      WHERE user_id = ${input.userId} AND period = ${period} FOR UPDATE
    `);
    const quotaRow = quota.rows[0] as Record<string, unknown> | undefined;
    const liveQuota = (quotaRow?.live_minutes_quota as number | undefined) ?? 0;
    const liveUsed = (quotaRow?.live_minutes_used as number | undefined) ?? 0;
    const quotaRemaining = Math.max(liveQuota - liveUsed, 0);

    // 先算总账：可供给 < 需求则整体拒绝，不做部分扣减
    let remaining = minutes;
    let drawnFromBalance = 0;
    let drawnFromQuota = 0;
    for (const step of priority) {
      if (remaining <= 0) {
        break;
      }
      if (step === 'balance') {
        drawnFromBalance = Math.min(balance, remaining);
        remaining -= drawnFromBalance;
      } else if (step === 'quota') {
        drawnFromQuota = Math.min(quotaRemaining, remaining);
        remaining -= drawnFromQuota;
      }
    }
    if (remaining > 0) {
      return {
        ok: false,
        userId: input.userId,
        requestedMinutes: minutes,
        drawnFromBalance: 0,
        drawnFromQuota: 0,
        balanceMinutes: balance,
        monthlyQuotaRemaining: quotaRemaining,
        reason: 'BALANCE_AND_QUOTA_EXHAUSTED' as const,
      };
    }

    const balanceAfter = balance - drawnFromBalance;
    if (drawnFromBalance > 0) {
      await exec.execute(sql`
        UPDATE hour_balance_accounts
        SET balance_minutes = balance_minutes - ${drawnFromBalance}, updated_at = now()
        WHERE user_id = ${input.userId}
      `);
      await exec.execute(sql`
        INSERT INTO hour_balance_ledger
          (user_id, delta_minutes, balance_after_minutes, source_kind, source_id, remark)
        VALUES
          (${input.userId}, ${-drawnFromBalance}, ${balanceAfter}, ${LEDGER_SOURCE.LIVE_DEDUCT},
           ${input.userId}, ${input.remark ?? null})
      `);
    }
    if (drawnFromQuota > 0) {
      await exec.execute(sql`
        UPDATE quotas
        SET live_minutes_used = live_minutes_used + ${drawnFromQuota}, updated_at = now()
        WHERE user_id = ${input.userId} AND period = ${period}
      `);
    }
    return {
      ok: true,
      userId: input.userId,
      requestedMinutes: minutes,
      drawnFromBalance,
      drawnFromQuota,
      balanceMinutes: balanceAfter,
      monthlyQuotaRemaining: quotaRemaining - drawnFromQuota,
    };
  });
}
