import { describe, expect, it } from 'vitest';
import { MAX_DANMAKU_NICKNAME_LENGTH } from '../src/collectors/types';
import {
  buildMsgKey,
  eventToIngestInput,
  guardEvent,
  type EventGuardResult,
} from '../src/collectors/events';

// D2.1 统一事件守卫与网关转换：纯函数单测，覆盖类型兜底 / 长度上限 / 必填校验 / 幂等键 / chat 转网关入参。

describe('D2.1 buildMsgKey 幂等键', () => {
  it('按 platform + 平台侧消息 id 拼接', () => {
    expect(buildMsgKey('douyin', 'msg_1024')).toBe('douyin:msg_1024');
    expect(buildMsgKey('bilibili', 'dq_5566')).toBe('bilibili:dq_5566');
  });
});

describe('D2.1 guardEvent 统一事件守卫', () => {
  it('chat 完整事件放行：字段保留 / 内容去首尾空白 / liveId 原样', () => {
    const result = guardEvent({
      platform: 'douyin',
      roomRef: '7312834574980',
      msgKey: 'douyin:987',
      msgType: 'chat',
      content: '  老板这个双人餐多少钱？  ',
      senderNickname: '吃货小王',
      liveId: 'live-0001',
      happenedAt: '2026-09-08T10:00:00.000Z',
      raw: { protoSeq: 987 },
    });
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) {
      return;
    }
    expect(result.event).toMatchObject({
      platform: 'douyin',
      roomRef: '7312834574980',
      liveId: 'live-0001',
      msgKey: 'douyin:987',
      msgType: 'chat',
      content: '老板这个双人餐多少钱？',
      senderNickname: '吃货小王',
      happenedAt: '2026-09-08T10:00:00.000Z',
    });
    expect(result.event.raw).toEqual({ protoSeq: 987 });
  });

  it('chat 缺文本 / 纯空白 / 超 200 字 → 整条拒绝并给原因', () => {
    const cases: Array<Record<string, unknown>> = [
      { platform: 'douyin', roomRef: '1', msgKey: 'k', msgType: 'chat' },
      { platform: 'douyin', roomRef: '1', msgKey: 'k', msgType: 'chat', content: '   ' },
      { platform: 'douyin', roomRef: '1', msgKey: 'k', msgType: 'chat', content: 'a'.repeat(201) },
    ];
    for (const input of cases) {
      const result = guardEvent(input);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason.length).toBeGreaterThan(0);
      }
    }
  });

  it('gift / like 事件可无 content；缺失 happenedAt 以本地时间兜底', () => {
    const result = guardEvent({
      platform: 'bilibili',
      roomRef: '5566',
      msgKey: 'bilibili:li_1',
      msgType: 'like',
      senderNickname: '路人甲',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.event.content).toBeUndefined();
    expect(Number.isNaN(Date.parse(result.event.happenedAt))).toBe(false);
  });

  it('昵称超长截断到 50 字，非法 liveId 归 null', () => {
    const result = guardEvent({
      platform: 'douyin',
      roomRef: '1',
      msgKey: 'k',
      msgType: 'chat',
      content: '你好',
      senderNickname: 'n'.repeat(80),
      liveId: 123 as unknown,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.event.senderNickname).toBe('n'.repeat(MAX_DANMAKU_NICKNAME_LENGTH));
    expect(result.event.liveId).toBeNull();
  });

  it('脏数据兜底：非对象 / 未知平台 / 未知 msgType / 缺 roomRef 或 msgKey → 拒绝且不抛', () => {
    const dirty: unknown[] = [
      null,
      42,
      { platform: 'weibo', roomRef: '1', msgKey: 'k', msgType: 'chat', content: 'hi' },
      { platform: 'douyin', roomRef: '1', msgKey: 'k', msgType: 'ban', content: 'hi' },
      { platform: 'douyin', msgKey: 'k', msgType: 'chat', content: 'hi' },
      { platform: 'douyin', roomRef: '1', msgType: 'chat', content: 'hi' },
      { platform: 'douyin', roomRef: '1', msgKey: 'k', msgType: 'chat', content: 7 },
    ];
    for (const input of dirty) {
      const result = guardEvent(input);
      expect(result.ok).toBe(false);
    }
  });

  it('msgKey 带空白时去除首尾空白', () => {
    const result = guardEvent({
      platform: 'douyin',
      roomRef: '1',
      msgKey: '  douyin:7  ',
      msgType: 'chat',
      content: '你好',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.event.msgKey).toBe('douyin:7');
    }
  });
});

describe('D2.1 eventToIngestInput 转 G3 网关入参', () => {
  function okEvent(): EventGuardResult {
    return guardEvent({
      platform: 'douyin',
      roomRef: '1',
      msgKey: 'douyin:9',
      msgType: 'chat',
      content: '怎么卖？',
      senderNickname: '吃货小王',
    });
  }

  it('chat → { content, senderNickname }；昵称截断 50 字', () => {
    const guarded = okEvent();
    expect(guarded.ok).toBe(true);
    if (!guarded.ok) {
      return;
    }
    expect(eventToIngestInput(guarded.event)).toEqual({
      content: '怎么卖？',
      senderNickname: '吃货小王',
    });
  });

  it('非 chat（like / gift）→ null，不误入弹幕网关', () => {
    const liked = guardEvent({
      platform: 'bilibili',
      roomRef: '5566',
      msgKey: 'bilibili:li_3',
      msgType: 'like',
      senderNickname: '路人甲',
    });
    expect(liked.ok).toBe(true);
    if (!liked.ok) {
      return;
    }
    expect(eventToIngestInput(liked.event)).toBeNull();
  });

  it('chat 但空文本（理论被守卫拦截）→ null 兜底', () => {
    const guarded = okEvent();
    if (!guarded.ok) {
      return;
    }
    const withoutContent: EventGuardResult = {
      ok: true,
      event: { ...guarded.event, content: '   ' },
    };
    const mapped = eventToIngestInput(withoutContent.event);
    expect(mapped).toBeNull();
  });
});
