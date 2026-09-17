// 回复台账（R24）：让商家看得见「AI 到底回了什么」。
//
// 为什么是**内存环形缓冲**而不是落库：
//   * 这是**可观测**需求，不是对账需求 —— 商家要的是「刚才它回了啥」，不是历史归档；
//   * 观众弹幕已经落 live_danmaku；回复再落一张表就多一套保留/清理策略；
//   * 有界内存天然随手，且不会因为回复量大把库撑起来。
// 已知债：进程重启即丢（与 liveCollector 绑定表、autoEnd 定时器同源，见 R17）。
// 生命周期：**开播时清空**（新场次从零开始），结束**不清** —— 商家下播后还能回看刚才回了什么。

export interface LiveReplyRecord {
  /** 触发这条回复的观众昵称（匿名弹幕为 null） */
  senderNickname: string | null;
  /** 实际口播的文案（命中内置敏感词时是兜底话术） */
  text: string;
  /** generated = AI 正常生成；fallback = 命中内置敏感词改念兜底话术 */
  source: 'generated' | 'fallback';
  createdAt: string;
}

/** 单场次保留条数：工作台只看「最近」，多了没意义还占内存 */
export const MAX_REPLIES_PER_LIVE = 50;

const buffers = new Map<string, LiveReplyRecord[]>();

/** 记一条回复（最新的在末尾） */
export function recordLiveReply(liveId: string, reply: LiveReplyRecord): void {
  const buffer = buffers.get(liveId) ?? [];
  buffer.push(reply);
  if (buffer.length > MAX_REPLIES_PER_LIVE) {
    buffer.splice(0, buffer.length - MAX_REPLIES_PER_LIVE);
  }
  buffers.set(liveId, buffer);
}

/** 读某场次的最近回复（最新的在前，便于工作台直接渲染） */
export function listLiveReplies(liveId: string): LiveReplyRecord[] {
  return [...(buffers.get(liveId) ?? [])].reverse();
}

/** 清空某场次（开播时调用：新场次从零开始） */
export function clearLiveReplies(liveId: string): void {
  buffers.delete(liveId);
}

/** 全部清空（服务关停 / 测试收尾） */
export function disposeReplyLedger(): void {
  buffers.clear();
}
