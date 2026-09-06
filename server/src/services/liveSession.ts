import { and, count, desc, eq } from 'drizzle-orm';
import { db } from '../db/client';
import { liveDanmaku as liveDanmakuTable, lives as livesTable } from '../db/schema';
import { LiveError, toLive } from './live';
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

/** 直播中监控快照：状态 + 已播时长 + 弹幕计数（供客户端轮询） */
export interface LiveMonitor {
  status: LiveStatus;
  videoSourceUrl: string;
  aiBadgeShown: boolean;
  startedAt: string | null;
  endedAt: string | null;
  /** 已播时长（秒）：live = now - startedAt；ended = endedAt - startedAt；其它 0 */
  durationSeconds: number;
  danmakuCount: number;
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
 * - status !== 'ready' → 抛 LIVE_NOT_READY（未合成完成不可开播）。
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
  return {
    status: row.status,
    videoSourceUrl: row.videoSourceUrl,
    aiBadgeShown: row.aiBadgeShown,
    startedAt: row.startedAt ? row.startedAt.toISOString() : null,
    endedAt: row.endedAt ? row.endedAt.toISOString() : null,
    durationSeconds: computeDurationSeconds(row),
    danmakuCount,
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
