// 互动统计（R45）：让商家看见「本场收到多少 / 有效多少 / 回了多少 / 因为频次漏了多少」。
//
// 为什么要它（docs/INTERACTION-VS-SCRIPT-PRODUCT-2.md §6 Q3，用户拍板「留计数不留内容」）：
//   商家现在**完全不知道**自己漏了多少问题 —— 不显示覆盖率，他就无法判断
//   「回复频次是不是设得太紧」。这是 R41（前置过滤）效果的唯一判据。
//
// 与 replyLedger 的分工：那边存**内容**（商家要回看 AI 说了什么），这边只存**计数**。
// 已知债：进程内内存态，重启即丢（与 replyLedger / liveCollector 同源）。

import type { DanmakuQuality } from './danmakuQuality';

export interface LiveInteractionStats {
  /** 本场收到的弹幕总数 */
  received: number;
  /** 实际产出回复的条数 */
  replied: number;
  /** **有效但被频控挡下**的条数 —— 商家据此判断「频次是不是设得太紧」 */
  throttled: number;
  /** 按质量分类的计数（不含 replied/throttled，纯分类分布） */
  byQuality: Record<DanmakuQuality, number>;
}

function emptyStats(): LiveInteractionStats {
  return {
    received: 0,
    replied: 0,
    throttled: 0,
    byQuality: { question: 0, need: 0, greeting: 0, smalltalk: 0, spam: 0 },
  };
}

const counters = new Map<string, LiveInteractionStats>();

function ensure(liveId: string): LiveInteractionStats {
  const existing = counters.get(liveId);
  if (existing) {
    return existing;
  }
  const created = emptyStats();
  counters.set(liveId, created);
  return created;
}

/** 收到一条弹幕：计一次总量 + 一次分类 */
export function recordDanmakuReceived(liveId: string, quality: DanmakuQuality): void {
  const stats = ensure(liveId);
  stats.received += 1;
  stats.byQuality[quality] += 1;
}

/** 产出了一条回复 */
export function recordReply(liveId: string): void {
  ensure(liveId).replied += 1;
}

/** 有效弹幕但被频控挡下（这部分才是「因为设置太紧漏掉的」） */
export function recordThrottled(liveId: string): void {
  ensure(liveId).throttled += 1;
}

/** 读某场统计（无记录返回全零，不写库也不建条目） */
export function statsOf(liveId: string): LiveInteractionStats {
  const existing = counters.get(liveId);
  return existing ? { ...existing, byQuality: { ...existing.byQuality } } : emptyStats();
}

/** 开播清空（新场次从零开始） */
export function clearStats(liveId: string): void {
  counters.delete(liveId);
}

/** 全部清空（服务关停 / 测试收尾） */
export function disposeStats(): void {
  counters.clear();
}

/** 当前有统计的场次数（排障用） */
export function statsKeyCount(): number {
  return counters.size;
}
