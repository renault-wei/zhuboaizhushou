import { and, count, desc, eq } from 'drizzle-orm';
import { db } from '../db/client';
import { liveDanmaku as liveDanmakuTable, lives as livesTable } from '../db/schema';
import { LiveError, toLive } from './live';
import { loopCaster } from './loopCaster';
import { statsOf, type LiveInteractionStats } from './interactionStats';
import { pendingReplyCount } from './pendingReplies';
import {
  lastSpeakerProgress, secondsSinceSpeakerPull } from './speakerHeartbeat';
import { listLiveReplies, type LiveReplyRecord } from './replyLedger';
import type { Live, LiveRow, LiveStatus } from './live';

// ---------- 常量 ----------

// 弹幕日志单次返回上限
export const MAX_DANMAKU_LIMIT = 100;
// 弹幕日志默认返回条数
export const DEFAULT_DANMAKU_LIMIT = 50;

// ---------- 类型定义 ----------

/** 弹幕日志条目（T13 只读，真实来源待抖音推流接入） */
export interface LiveDanmaku {
  id: string;
  content: string;
  senderNickname: string | null;
  /** 弹幕到达时间（ISO8601） */
  sentAt: string;
}

/** 直播中监控快照：状态 + 已播时长 + 弹幕计数 + 循环播报状态（供客户端轮询） */
export interface LiveMonitor {
  status: LiveStatus;
  videoSourceUrl: string;
  aiBadgeShown: boolean;
  startedAt: string | null;
  endedAt: string | null;
  /** 已播时长（秒）：live = now - startedAt；ended = endedAt - startedAt；其它 0 */
  durationSeconds: number;
  danmakuCount: number;
  /** 循环台本 Runner 是否运行中（live 且有绑定台本且已开播才可能为 true） */
  loopRunning: boolean;
  /** 已播轮数（loopCaster 内存态；进程重启不恢复属已知限制） */
  loopRound: number;
  /** 当前轮到第几条（1 起；空闲 / 结束为 0） */
  loopCurrentSeq: number;
  /** 未绑定循环台本：开播也只回弹幕，工作台需提示（Q2 正常流程不出现） */
  loopMissing: boolean;
  /** R24：最近若干条 AI 回复（最新的在前）—— 让商家看得见 AI 到底说了什么 */
  recentReplies: LiveReplyRecord[];
  /** R45：互动统计（收到 / 有效 / 回复 / 因频次漏掉）—— 商家据此判断频次是不是设太紧 */
  interactionStats: LiveInteractionStats;
  /** R42：还有几条回复在队列里等着放（台本每个空档放一条，积压不该无限涨） */
  pendingReplies: number;
  /**
   * ★R53：助播机（手机）距上次来拉音频过了多少秒；**从未拉过为 null**。
   *
   * null 与「数字很大」要分开看：null = 这场没被拉过（助播机没开或还没开始）→ 不该报警；
   * 数字 = 拉过但停了多久 → 这才是「掉线」的信号。
   * 商家据此知道「AI 在说，但声音送不出去」（2026-09-18 实测踩到过）。
   */
  speakerSecondsSincePull: number | null;
}

// ---------- 内部工具 ----------

/** 已播时长：仅 live / ended 两个状态有意义的时长，其余一律 0 */
function computeDurationSeconds(row: LiveRow): number {
  if (row.status === 'live' && row.startedAt) {
    return Math.max(0, Math.floor((Date.now() - row.startedAt.getTime()) / 1000));
  }
  if (row.status === 'ended' && row.startedAt && row.endedAt) {
    return Math.max(0, Math.floor((row.endedAt.getTime() - row.startedAt.getTime()) / 1000));
  }
  return 0;
}

/** 归属隔离 + 存在性：查当前用户名下的某条开播配置原始行 */
async function findOwnedRow(userId: string, id: string): Promise<LiveRow | null> {
  const rows = await db
    .select()
    .from(livesTable)
    .where(and(eq(livesTable.id, id), eq(livesTable.userId, userId)))
    .limit(1);
  return rows[0] ?? null;
}

// ---------- 会话生命周期 ----------

/**
 * 一键开播：ready → live，记录 startedAt（清空 endedAt）。
 * - 非本人或不存在 → 返回 null（路由转 404）；
 * - status !== 'ready' → 抛 LIVE_NOT_READY（未合成完成不可开播）；
 * - 同账号已有 status = live 的场次 → 抛 LIVE_IN_PROGRESS（路由转 409）。
 *   多场并发的实际危害：循环台本 / 弹幕回复共用一条出声链路（远程队列按场隔离前），
 *   两场同时出声会音色交错、台词互相插队，且按分钟计费会出现重复扣费口径，故开播即互斥。
 * T13 不接 RTMP / 抖音推流，此处仅状态机流转 + 记录开播时间，真实推流留 T12。
 */
export async function startLive(userId: string, id: string): Promise<Live | null> {
  const existing = await findOwnedRow(userId, id);
  if (!existing) {
    return null;
  }
  if (existing.status !== 'ready') {
    throw new LiveError('LIVE_NOT_READY', '只有合成完成（就绪）的直播才能开播');
  }
  const running = await db
    .select({ id: livesTable.id })
    .from(livesTable)
    .where(and(eq(livesTable.userId, userId), eq(livesTable.status, 'live')))
    .limit(1);
  if (running[0]) {
    throw new LiveError('LIVE_IN_PROGRESS', '当前已有进行中的直播，请先结束再开新场');
  }
  const updated = await db
    .update(livesTable)
    .set({ status: 'live', startedAt: new Date(), endedAt: null })
    .where(and(eq(livesTable.id, id), eq(livesTable.userId, userId)))
    .returning();
  const row = updated[0];
  return row ? toLive(row) : null;
}

/**
 * 结束直播：live → ended，记录 endedAt。
 * - 非本人或不存在 → 返回 null（路由转 404）；
 * - status !== 'live' → 抛 LIVE_NOT_LIVE。
 */
export async function endLive(userId: string, id: string): Promise<Live | null> {
  const existing = await findOwnedRow(userId, id);
  if (!existing) {
    return null;
  }
  if (existing.status !== 'live') {
    throw new LiveError('LIVE_NOT_LIVE', '只有直播中的场次才能结束');
  }
  const updated = await db
    .update(livesTable)
    .set({ status: 'ended', endedAt: new Date() })
    .where(and(eq(livesTable.id, id), eq(livesTable.userId, userId)))
    .returning();
  const row = updated[0];
  return row ? toLive(row) : null;
}

/**
 * 直播中监控快照：状态 + 已播时长 + 弹幕计数。
 * 非本人或不存在返回 null（路由转 404）。
 */
export async function getLiveMonitor(userId: string, id: string): Promise<LiveMonitor | null> {
  const row = await findOwnedRow(userId, id);
  if (!row) {
    return null;
  }
  const countRows = await db
    .select({ count: count(liveDanmakuTable.id) })
    .from(liveDanmakuTable)
    .where(eq(liveDanmakuTable.liveId, id));
  const rawCount = countRows[0]?.count ?? 0;
  const danmakuCount = typeof rawCount === 'number' ? rawCount : Number(rawCount);
  // M5：循环播报状态（loopCaster 为内存态；进程重启不自动恢复属已知限制）
  //
  // ★★C：client 模式下 loopCaster **根本不跑** ✗ —— 位置改读
  //   「助播机报回来的游标」（/item 的 seq）✓ 那就是听众真正在听的第几条，
  //   比生产端位置更准 ✓（否则界面会显示成「未绑定循环台本」✗）
  const loopStatus = row.status === 'live' ? loopCaster.status(id) : null;
  const clientProgress = row.status === 'live' ? lastSpeakerProgress(id) : null;
  return {
    status: row.status,
    videoSourceUrl: row.videoSourceUrl,
    aiBadgeShown: row.aiBadgeShown,
    startedAt: row.startedAt ? row.startedAt.toISOString() : null,
    endedAt: row.endedAt ? row.endedAt.toISOString() : null,
    durationSeconds: computeDurationSeconds(row),
    danmakuCount,
    loopRunning: loopStatus?.running ?? clientProgress !== null,
    loopRound:
      loopStatus?.round ??
      (clientProgress && clientProgress.total > 0
        ? Math.ceil(clientProgress.seq / clientProgress.total)
        : 0),
    loopCurrentSeq: loopStatus?.currentSeq ?? clientProgress?.seq ?? 0,
    // 未绑定循环台本：开播也只回弹幕，工作台给提示（Q2 正常流程不出现）
    loopMissing: row.status === 'live' && !row.loopScriptId,
    // R24：内存态回复台账（开播清空、结束保留；进程重启即丢属已知限制）
    recentReplies: listLiveReplies(id),
    // R45：内存态互动统计（同上）
    interactionStats: statsOf(id),
    // R42：待播回复积压条数
    pendingReplies: pendingReplyCount(id),
    // R53：助播机心跳（距上次拉音频多少秒；没拉过为 null）
    speakerSecondsSincePull: secondsSinceSpeakerPull(id),
  };
}

/**
 * 弹幕日志（只读）：按 sentAt 倒序取最近 N 条。
 * - 非本人或不存在返回 null（路由转 404）；
 * - 存在但无弹幕返回空数组。
 * 写入口由弹幕网关（G3）提供：POST /api/lives/:id/danmaku 校验归属与直播中状态后落库并广播；
 */
export async function listDanmaku(
  userId: string,
  id: string,
  limit: number = DEFAULT_DANMAKU_LIMIT,
): Promise<LiveDanmaku[] | null> {
  const owned = await db
    .select({ id: livesTable.id })
    .from(livesTable)
    .where(and(eq(livesTable.id, id), eq(livesTable.userId, userId)))
    .limit(1);
  if (owned.length === 0) {
    return null;
  }
  const capped = Math.min(Math.max(limit, 1), MAX_DANMAKU_LIMIT);
  const rows = await db
    .select()
    .from(liveDanmakuTable)
    .where(eq(liveDanmakuTable.liveId, id))
    .orderBy(desc(liveDanmakuTable.sentAt))
    .limit(capped);
  return rows.map((row) => ({
    id: row.id,
    content: row.content,
    senderNickname: row.senderNickname,
    sentAt: row.sentAt.toISOString(),
  }));
}
