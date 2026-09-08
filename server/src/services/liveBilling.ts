import { drainLiveMinutes } from './ledger';
import { readAppConfig } from './appConfig';

// 直播在线分钟结算（v0.3 M5 之后接线批）：
// 口径 = docs/console-roadmap.md §1.5 ——「直播在线分钟先扣时长余额 → 回落当月免费直播分钟」。
// 本批实现在直播**结束时**按已播整分钟欠费式结算（服务已发生，扣光当前可用、缺额返回运营对账），
// 不引入后台定时器、不改变循环播报行为；直播中的 402 引导续费闸门需联动工作台，
// 属后续决策批（见 PROGRESS §6 第 35 条「后续」）。

export interface SettleLiveSessionInput {
  userId: string;
  /** 场次 id（仅作流水 remark 便于对账） */
  liveId: string;
  /** 开播时间（ISO8601；为 null 视为不可结算） */
  startedAt: string | null;
  /** 结束时间（ISO8601；为 null 视为不可结算） */
  endedAt: string | null;
}

export interface SettleLiveSessionResult {
  /** 结算到的最小分钟数（不足 1 分钟 = 0，不结算） */
  settledMinutes: number;
  drawnFromBalance: number;
  drawnFromQuota: number;
  /** 余额 + 免费分钟都尽后的缺额（分钟），>0 时应引起运营注意 */
  shortfallMinutes: number;
}

/** 已播整分钟：不足 1 分钟按 0 处理（短测 / 误触不产生扣减） */
export function billableWholeMinutes(
  startedAtIso: string | null,
  endedAtIso: string | null,
): number {
  if (!startedAtIso || !endedAtIso) {
    return 0;
  }
  const startedAt = new Date(startedAtIso).getTime();
  const endedAt = new Date(endedAtIso).getTime();
  if (!Number.isFinite(startedAt) || !Number.isFinite(endedAt) || endedAt <= startedAt) {
    return 0;
  }
  return Math.floor((endedAt - startedAt) / 60_000);
}

/**
 * 直播结束结算：按已播整分钟读取 app_config.quotaPriority 做缺额式扣减。
 * 场次无有效起止时间 → settledMinutes=0（什么都不做）。
 */
export async function settleLiveSession(
  input: SettleLiveSessionInput,
): Promise<SettleLiveSessionResult> {
  const minutes = billableWholeMinutes(input.startedAt, input.endedAt);
  if (minutes <= 0) {
    return { settledMinutes: 0, drawnFromBalance: 0, drawnFromQuota: 0, shortfallMinutes: 0 };
  }
  const config = await readAppConfig();
  const result = await drainLiveMinutes({
    userId: input.userId,
    minutes,
    priority: config.quotaPriority,
    remark: `live:${input.liveId}`,
  });
  return {
    settledMinutes: minutes,
    drawnFromBalance: result.drawnFromBalance,
    drawnFromQuota: result.drawnFromQuota,
    shortfallMinutes: result.shortfallMinutes,
  };
}
