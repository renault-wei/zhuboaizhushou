// R24 回复台账单测：纯内存，不碰 DB、不碰网络。
// 验的是「商家在工作台看得见 AI 回了什么」背后的存储语义。

import { afterEach, describe, expect, it } from 'vitest';
import {
  clearLiveReplies,
  disposeReplyLedger,
  listLiveReplies,
  MAX_REPLIES_PER_LIVE,
  recordLiveReply,
} from '../src/services/replyLedger';

function reply(text: string, nickname: string | null = '吃货小王') {
  return {
    senderNickname: nickname,
    text,
    source: 'generated' as const,
    createdAt: new Date().toISOString(),
  };
}

afterEach(() => {
  disposeReplyLedger();
});

describe('R24 回复台账', () => {
  it('记账后能读回，且**最新的在前**（工作台直接渲染的顺序）', () => {
    recordLiveReply('live-a', reply('第一条回复'));
    recordLiveReply('live-a', reply('第二条回复'));

    const list = listLiveReplies('live-a');
    expect(list).toHaveLength(2);
    expect(list[0]?.text).toBe('第二条回复');
    expect(list[1]?.text).toBe('第一条回复');
  });

  it('场次之间互不串台', () => {
    recordLiveReply('live-a', reply('A 场的回复'));
    recordLiveReply('live-b', reply('B 场的回复'));

    expect(listLiveReplies('live-a').map((item) => item.text)).toEqual(['A 场的回复']);
    expect(listLiveReplies('live-b').map((item) => item.text)).toEqual(['B 场的回复']);
    expect(listLiveReplies('live-c')).toEqual([]);
  });

  it('环形上界：超出的旧记录被丢弃，只留最近 MAX_REPLIES_PER_LIVE 条', () => {
    for (let index = 1; index <= MAX_REPLIES_PER_LIVE + 5; index += 1) {
      recordLiveReply('live-ring', reply(`第 ${index} 条`));
    }

    const list = listLiveReplies('live-ring');
    expect(list).toHaveLength(MAX_REPLIES_PER_LIVE);
    // 最新的是第 55 条；最旧的 5 条（1~5）已被挤掉
    expect(list[0]?.text).toBe(`第 ${MAX_REPLIES_PER_LIVE + 5} 条`);
    const texts = list.map((item) => item.text);
    expect(texts).not.toContain('第 1 条');
    expect(texts).not.toContain('第 5 条');
    expect(texts).toContain('第 6 条');
  });

  it('开播清空：clearLiveReplies 只清本场', () => {
    recordLiveReply('live-a', reply('上一场的回复'));
    recordLiveReply('live-b', reply('别场的回复'));

    clearLiveReplies('live-a');
    expect(listLiveReplies('live-a')).toEqual([]);
    expect(listLiveReplies('live-b')).toHaveLength(1);
  });

  it('保留 fallback 来源标记（商家能看出这句是兜底话术）', () => {
    recordLiveReply('live-src', {
      senderNickname: null,
      text: '您问的这个问题我帮您记下了，稍等我确认好再为您解答～',
      source: 'fallback',
      createdAt: new Date().toISOString(),
    });
    expect(listLiveReplies('live-src')[0]?.source).toBe('fallback');
    expect(listLiveReplies('live-src')[0]?.senderNickname).toBeNull();
  });
});
