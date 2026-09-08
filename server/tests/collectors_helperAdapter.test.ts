import { describe, expect, it } from 'vitest';
import {
  createDanmakuMonitor,
  parseConsoleDanmakuLine,
  parseHelperJson,
  type DanmakuMonitorDeps,
} from '../src/collectors/helperAdapter';
import type { UnifiedDanmakuEvent } from '../src/collectors/types';

// D5.2 外挂弹幕助手输出适配：控制台行 / JSON 归一化 + 监控计数与转发。
// 口径：用户自跑第三方助手（自有直播间 / 自用自测），本项目只解析归一化，不内嵌第三方代码。

describe('D5.2 parseConsoleDanmakuLine 控制台行解析', () => {
  it('【聊天msg】行：带 [userid]，英文 / 中文冒号均可拆出昵称与内容', () => {
    expect(parseConsoleDanmakuLine('【聊天msg】[7212345]吃货小王: 老板双人餐多少钱？')).toEqual({
      kind: 'chat',
      senderId: '7212345',
      nickname: '吃货小王',
      content: '老板双人餐多少钱？',
    });
    expect(parseConsoleDanmakuLine('【聊天msg】[88]爱吃的阿黄：这个牛油锅辣吗')).toEqual({
      kind: 'chat',
      senderId: '88',
      nickname: '爱吃的阿黄',
      content: '这个牛油锅辣吗',
    });
  });

  it('【聊天msg】行：昵称或内容为空 → 不当作事件返回 null', () => {
    expect(parseConsoleDanmakuLine('【聊天msg】[1]:')).toBeNull();
    expect(parseConsoleDanmakuLine('【聊天msg】[1]小美:   ')).toBeNull();
    expect(parseConsoleDanmakuLine('【聊天msg】[1]   : 内容')).toBeNull();
  });

  it('【礼物msg】行：拆出送礼昵称与礼物内容', () => {
    expect(parseConsoleDanmakuLine('【礼物msg】榜一大哥 送出了 保时捷×2')).toEqual({
      kind: 'gift',
      nickname: '榜一大哥',
      content: '保时捷×2',
    });
  });

  it('【点赞msg】行：拆出点赞昵称与数量', () => {
    expect(parseConsoleDanmakuLine('【点赞msg】路过的猫 点了3个赞')).toEqual({
      kind: 'like',
      nickname: '路过的猫',
      content: '3个赞',
    });
  });

  it('【进场msg】行：剥离 [userid] 与性别后取昵称', () => {
    expect(parseConsoleDanmakuLine('【进场msg】[102938][女]甜品控 进入了直播间')).toEqual({
      kind: 'enter',
      senderId: '102938',
      nickname: '甜品控',
    });
    expect(parseConsoleDanmakuLine('【进场msg】[7]张三 进入了直播间')).toEqual({
      kind: 'enter',
      senderId: '7',
      nickname: '张三',
    });
  });

  it('统计 / 其它提示 / 非弹幕行：忽略返回 null', () => {
    expect(parseConsoleDanmakuLine('【统计msg】本场观众 120 人')).toBeNull();
    expect(parseConsoleDanmakuLine('直播间人气 1200')).toBeNull();
    expect(parseConsoleDanmakuLine('')).toBeNull();
  });
});

describe('D5.2 parseHelperJson 弹幕姬 JSON 归一化', () => {
  it('WebcastChatMessage / WebcastEmojiChatMessage → chat', () => {
    expect(parseHelperJson({ method: 'WebcastChatMessage', user: { name: '小美' }, content: '你好呀' })).toEqual({
      kind: 'chat',
      nickname: '小美',
      content: '你好呀',
    });
    expect(parseHelperJson({ method: 'WebcastEmojiChatMessage', user: { name: '阿萌' }, content: '❤️' })).toEqual({
      kind: 'chat',
      nickname: '阿萌',
      content: '❤️',
    });
  });

  it('WebcastGiftMessage → gift：礼物名与数量拼接', () => {
    expect(
      parseHelperJson({ method: 'WebcastGiftMessage', user: { name: '大款' }, gift: { name: '嘉年华', count: 3 } }),
    ).toEqual({
      kind: 'gift',
      nickname: '大款',
      content: '嘉年华 ×3',
    });
    expect(parseHelperJson({ method: 'WebcastGiftMessage', user: { name: '大款' }, gift: { name: '小心心' } })).toEqual({
      kind: 'gift',
      nickname: '大款',
      content: '小心心',
    });
  });

  it('WebcastLikeMessage / WebcastMemberMessage → like / enter', () => {
    expect(parseHelperJson({ method: 'WebcastLikeMessage', user: { name: '点赞狂' }, content: '5' })).toEqual({
      kind: 'like',
      nickname: '点赞狂',
      content: '5',
    });
    expect(parseHelperJson({ method: 'WebcastMemberMessage', user: { name: '新观众' } })).toEqual({
      kind: 'enter',
      nickname: '新观众',
    });
  });

  it('未知类型 / 非对象 / chat 空内容：返回 null', () => {
    expect(parseHelperJson({ method: 'WebcastRoomStatsMessage', data: {} })).toBeNull();
    expect(parseHelperJson({ method: 'WebcastChatMessage', user: { name: '小美' }, content: '  ' })).toBeNull();
    expect(parseHelperJson('oops')).toBeNull();
    expect(parseHelperJson(null)).toBeNull();
    expect(parseHelperJson(undefined)).toBeNull();
  });
});

describe('D5.2 createDanmakuMonitor 监控计数与转发', () => {
  const ROOM = '7312834574980';
  const LIVE = 'live-0001';
  const T0 = '2026-09-08T10:00:00.000Z';

  function createMonitor(overrides?: Partial<DanmakuMonitorDeps>): {
    monitor: ReturnType<typeof createDanmakuMonitor>;
    events: UnifiedDanmakuEvent[];
  } {
    const events: UnifiedDanmakuEvent[] = [];
    const monitor = createDanmakuMonitor({
      roomRef: ROOM,
      liveId: LIVE,
      now: () => new Date(T0),
      onEvent: (event) => events.push({ ...event }),
      ...overrides,
    });
    return { monitor, events };
  }

  it('控制台五行混合推送：按类型计数、逐条转发并带平台消息键', () => {
    const { monitor, events } = createMonitor();
    expect(
      monitor.pushLine('【聊天msg】[7212345]吃货小王: 老板双人餐多少钱？'),
    ).toBe(true);
    expect(monitor.pushLine('【礼物msg】榜一大哥 送出了 保时捷×2')).toBe(true);
    expect(monitor.pushLine('【点赞msg】路过的猫 点了3个赞')).toBe(true);
    expect(monitor.pushLine('【进场msg】[102938][女]甜品控 进入了直播间')).toBe(true);

    expect(monitor.status()).toMatchObject({
      eventCount: 4,
      invalidCount: 0,
      byType: { chat: 1, gift: 1, like: 1, enter: 1 },
    });
    expect(events).toHaveLength(4);
    expect(events[0]).toMatchObject({
      platform: 'douyin',
      roomRef: ROOM,
      liveId: LIVE,
      msgKey: 'douyin:7212345-1',
      msgType: 'chat',
      content: '老板双人餐多少钱？',
      senderNickname: '吃货小王',
      happenedAt: T0,
    });
    expect(events[1]?.msgKey).toBe('douyin:u-2');
    expect(events[2]?.msgKey).toBe('douyin:u-3');
    expect(events[3]).toMatchObject({ msgType: 'enter', msgKey: 'douyin:102938-4', senderNickname: '甜品控' });
    expect('content' in (events[3] ?? {})).toBe(false);
  });

  it('非弹幕行忽略不算脏数据；超长 chat 由守卫兜底计入 invalid', () => {
    const { monitor, events } = createMonitor();
    expect(monitor.pushLine('【统计msg】本场观众 120 人')).toBe(false);
    expect(monitor.pushLine('主播正在跟大家打招呼')).toBe(false);
    expect(monitor.pushLine('【聊天msg】[1]刷屏哥: a'.concat('a'.repeat(201)))).toBe(true);

    expect(monitor.status()).toMatchObject({ eventCount: 0, invalidCount: 1, byType: {} });
    expect(events).toHaveLength(0);
  });

  it('JSON chat 转发触发 onEvent，字段完整且计入计数', () => {
    const { monitor, events } = createMonitor();
    expect(
      monitor.pushJson({ method: 'WebcastChatMessage', user: { name: '小美' }, content: '双人餐还有吗' }),
    ).toBe(true);
    expect(monitor.status()).toMatchObject({ eventCount: 1, invalidCount: 0, byType: { chat: 1 } });
    expect(events[0]).toMatchObject({
      platform: 'douyin',
      roomRef: ROOM,
      liveId: LIVE,
      msgType: 'chat',
      content: '双人餐还有吗',
      senderNickname: '小美',
    });
    expect(events[0]?.msgKey).toBe('douyin:u-1');
  });

  it('platform 可配置（非抖音直播同样可接），roomRef 按目标透传', () => {
    const { monitor, events } = createMonitor({ platform: 'bilibili' });
    monitor.pushLine('【聊天msg】[5566]直播间老板: 套餐怎么买');
    expect(events[0]).toMatchObject({
      platform: 'bilibili',
      roomRef: ROOM,
      msgType: 'chat',
      senderNickname: '直播间老板',
    });
    expect(events[0]?.msgKey).toBe('bilibili:5566-1');
  });
});
