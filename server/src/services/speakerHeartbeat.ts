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

/** 开播 / 收尾时清掉本场记录（避免 Map 随场次数无界增长） */
export function forgetSpeakerHeartbeat(liveId: string): void {
  lastPullAtMs.delete(liveId);
}

/** 全部清空（服务关停 / 测试收尾） */
export function disposeSpeakerHeartbeat(): void {
  lastPullAtMs.clear();
}

/** 当前有记录的场次数（排障用） */
export function speakerHeartbeatKeyCount(): number {
  return lastPullAtMs.size;
}
