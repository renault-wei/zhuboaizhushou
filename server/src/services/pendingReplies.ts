// 待播回复队列（R42）：台本在跑时，回复**入队**而不是直接抢播。
//
// 为什么需要它（docs/INTERACTION-VS-SCRIPT-PRODUCT-2.md §3，用户定调「节奏一定要好」）：
//   原机制是「回复直接进出声链路 → 台本每句前 while(isBusy) 等链路排空」。
//   而 `while` **没有超时、没有配额**，当「回复音频时长 > 回复间隔」时链路永远排不空 ——
//   台本被无限让位（默认 5 秒/次已贴着临界线，App 里还有「1 秒/次」一档）。
//
// 改成队列之后：
//   * **节奏有硬保障**：台本每个句间空档最多放一条回复 —— 无论弹幕多少，台本都按轮推进；
//   * **轮次完整**：一轮台本的每一句都能播到（不再被无限挤出）；
//   * **队列有上界**：灌水已在 R41 被挡在门外，这里再兜一层，满了丢最旧。
//
// 已知债：进程内内存态，重启即丢（与 replyLedger / interactionStats 同源）。

/** 队列上界：台本每个空档只放一条，积压再多也没意义，满了丢最旧 */
export const MAX_PENDING_REPLIES = 10;

export interface PendingReply {
  liveId: string;
  /** 待口播文案（音色由 loopCaster 按本场快照解析，与台本句同源） */
  text: string;
  createdAt: string;
}

const queues = new Map<string, PendingReply[]>();

/**
 * 入队。返回入队后的队列长度。
 * 超过上界时**丢最旧的** —— 旧问题的观众多半已经走了，新问题更值得答。
 */
export function enqueuePendingReply(reply: PendingReply): number {
  const queue = queues.get(reply.liveId) ?? [];
  queue.push(reply);
  if (queue.length > MAX_PENDING_REPLIES) {
    queue.splice(0, queue.length - MAX_PENDING_REPLIES);
  }
  queues.set(reply.liveId, queue);
  return queue.length;
}

/** 取一条（FIFO）；空则 null */
export function takePendingReply(liveId: string): PendingReply | null {
  const queue = queues.get(liveId);
  if (!queue || queue.length === 0) {
    return null;
  }
  const next = queue.shift() ?? null;
  if (queue.length === 0) {
    queues.delete(liveId);
  }
  return next;
}

/** 当前积压条数 */
export function pendingReplyCount(liveId: string): number {
  return queues.get(liveId)?.length ?? 0;
}

/** 清空某场次（开播 / 结束 / 停采集时调用，避免队列里的回复永远播不出去） */
export function clearPendingReplies(liveId: string): void {
  queues.delete(liveId);
}

/** 全部清空（服务关停 / 测试收尾） */
export function disposePendingReplies(): void {
  queues.clear();
}
