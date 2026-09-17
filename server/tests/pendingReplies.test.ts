// R42 待播回复队列单测：纯内存，不碰 DB / 网络。

import { afterEach, describe, expect, it } from 'vitest';
import {
  clearPendingReplies,
  disposePendingReplies,
  enqueuePendingReply,
  MAX_PENDING_REPLIES,
  pendingReplyCount,
  takePendingReply,
} from '../src/services/pendingReplies';

function reply(liveId: string, text: string) {
  return { liveId, text, createdAt: new Date().toISOString() };
}

afterEach(() => {
  disposePendingReplies();
});

describe('R42 待播回复队列', () => {
  it('FIFO：先进先出，取空了返回 null', () => {
    enqueuePendingReply(reply('L', '第一条'));
    enqueuePendingReply(reply('L', '第二条'));
    expect(takePendingReply('L')?.text).toBe('第一条');
    expect(takePendingReply('L')?.text).toBe('第二条');
    expect(takePendingReply('L')).toBeNull();
    expect(pendingReplyCount('L')).toBe(0);
  });

  it('场次之间互不串台', () => {
    enqueuePendingReply(reply('A', 'A 场的回复'));
    enqueuePendingReply(reply('B', 'B 场的回复'));
    expect(takePendingReply('A')?.text).toBe('A 场的回复');
    expect(takePendingReply('B')?.text).toBe('B 场的回复');
  });

  it('有上界：满了**丢最旧**（旧问题的观众多半已经走了）', () => {
    for (let index = 1; index <= MAX_PENDING_REPLIES + 3; index += 1) {
      enqueuePendingReply(reply('L', `第 ${index} 条`));
    }
    expect(pendingReplyCount('L')).toBe(MAX_PENDING_REPLIES);
    // 最新的那条一定还在；被挤掉的是最旧的几条
    const all: string[] = [];
    let next = takePendingReply('L');
    while (next) {
      all.push(next.text);
      next = takePendingReply('L');
    }
    expect(all).toHaveLength(MAX_PENDING_REPLIES);
    expect(all.at(-1)).toBe(`第 ${MAX_PENDING_REPLIES + 3} 条`);
    expect(all).not.toContain('第 1 条');
  });

  it('clearPendingReplies 只清本场（开播 / 结束的回收路径）', () => {
    enqueuePendingReply(reply('A', 'A'));
    enqueuePendingReply(reply('B', 'B'));
    clearPendingReplies('A');
    expect(pendingReplyCount('A')).toBe(0);
    expect(pendingReplyCount('B')).toBe(1);
  });
});
