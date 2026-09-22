// 助播机心跳（R53）：记录「手机端最后一次来拉音频是什么时候」。
//
// 为什么需要它（2026-09-18 生产事故，docs/PROGRESS.md 第 92/95 条）：
//   助播机（手机）一旦被系统冻结 / 切后台被杀，就不再轮询 `/api/out/speech/next`，
//   **声音送不出去**。而服务端其实**早就知道** —— loopCaster 会打
//   「出声链路持续繁忙超过 30000ms（疑似助播机未轮询）」的 warn，
//   但那条日志**只有运维看得到，商家看不到**。
//   结果：AI 自说自话 15 分钟，商家以为一切正常。
//
// 这个模块把那件事变成商家能看见的数据。
//
// 已知债：进程内内存态，重启即丢（与 replyLedger / interactionStats 同源）。

const lastPullAtMs = new Map<string, number>();

/**
 * ★★C：助播机**正在取第几条**（客户端持游标时的进度）✓
 *
 * 为什么需要：C 之后循环位置在客户端 ✗ —— 服务端 loopCaster 不再运行，
 *   工作台原先读的 loopCaster.status().currentSeq 恒为 0，
 *   界面会显示成「未绑定循环台本」✗（2026-09-22 切到 client 时发现）。
 * 而「客户端点名叫第几条」这件事**服务端本来就知道** —— /item 的请求里带着 ✓
 * 直接记下来即可，而且它比生产端位置更准：**那就是听众真正在听的第几条** ✓
 */
const lastSeqAt = new Map<string, { seq: number; total: number }>();

function nowMs(): number {
  return Date.now();
}

/** 记一次拉取（助播机每次轮询都调） */
export function recordSpeakerPull(liveId: string, atMs: number = nowMs()): void {
  lastPullAtMs.set(liveId, atMs);
}

/**
 * 距上次拉取过了多少秒；从未拉过返回 null。
 *
 * 返回 null 与返回一个大数要区分开：
 *   null = 这场**从来没被拉过**（助播机没开、或还没开始）→ 不该报警；
 *   数字 = 拉过但已经停了多久 → 这才是「掉线」的信号。
 */
export function secondsSinceSpeakerPull(liveId: string, atMs: number = nowMs()): number | null {
  const last = lastPullAtMs.get(liveId);
  if (last === undefined) {
    return null;
  }
  const elapsed = Math.floor((atMs - last) / 1000);
  return elapsed < 0 ? 0 : elapsed;
}

/** 记一次「客户端要第几条」（/api/out/speech/item 每次调用都调）✓ */
export function recordSpeakerSeq(liveId: string, seq: number, total: number): void {
  lastSeqAt.set(liveId, { seq, total });
}

/** 本场最近一次「客户端要第几条」；从未取过返回 null ✓ */
export function lastSpeakerProgress(liveId: string): { seq: number; total: number } | null {
  const entry = lastSeqAt.get(liveId);
  return entry === undefined ? null : { ...entry };
}

/** 开播 / 收尾时清掉本场记录（避免 Map 随场次数无界增长） */
export function forgetSpeakerHeartbeat(liveId: string): void {
  lastPullAtMs.delete(liveId);
  lastSeqAt.delete(liveId);
}

/** 全部清空（服务关停 / 测试收尾） */
export function disposeSpeakerHeartbeat(): void {
  lastPullAtMs.clear();
  lastSeqAt.clear();
}

/** 当前有记录的场次数（排障用） */
export function speakerHeartbeatKeyCount(): number {
  return lastPullAtMs.size;
}
