// 外挂弹幕助手输出适配（D5.2 真机复测准备）：把「自用自测弹幕助手」的控制台行 / JSON 归一化进统一事件。
// 定位：采集端是用户自己跑的第三方助手（灰区但合规口径允许的自有直播间小流量自测），
// 本项目只做「解析 + 归一化 + 监控计数」，不内嵌任何第三方代码、不触碰平台协议。
// 参考输出形态：saermart/DouyinLiveWebFetcher 控制台行；dycast / tiktok-live-monitor 的 JSON 转发。
import { guardEvent, type EventGuardResult } from './events';
import type { DanmakuMessageType, DanmakuPlatform, UnifiedDanmakuEvent } from './types';

// ---------- 解析结果（统一中间态，平台无关） ----------

export type ParsedHelperMessage =
  | { kind: 'chat'; senderId?: string; nickname: string; content: string }
  | { kind: 'gift'; nickname: string; content?: string }
  | { kind: 'like'; nickname: string; content?: string }
  | { kind: 'enter'; senderId?: string; nickname: string };

/** 控制台行解析结果：null = 非弹幕内容行（统计/粉丝团等，监控时忽略） */
export function parseConsoleDanmakuLine(line: string): ParsedHelperMessage | null {
  const text = line.trim();
  if (!text.startsWith('【')) {
    return null;
  }
  if (text.startsWith('【聊天msg】')) {
    return parseChatLine(text);
  }
  if (text.startsWith('【礼物msg】')) {
    const body = text.slice('【礼物msg】'.length);
    const match = body.match(/^(.+?) 送出了 (.+)$/);
    return match ? { kind: 'gift', nickname: match[1]?.trim() ?? '', content: match[2]?.trim() } : null;
  }
  if (text.startsWith('【点赞msg】')) {
    const body = text.slice('【点赞msg】'.length);
    const match = body.match(/^(.+?) 点了(.+)$/);
    return match ? { kind: 'like', nickname: match[1]?.trim() ?? '', content: match[2]?.trim() } : null;
  }
  if (text.startsWith('【进场msg】')) {
    const body = text.slice('【进场msg】'.length);
    const idMatch = body.match(/^\[(\d+)\]/);
    const rest = idMatch ? body.slice(idMatch[0].length) : body;
    const nickname = rest.replace(/^\[[^\]]*\]/, '').replace(/ 进入了直播间.*$/, '').trim();
    return nickname.length > 0 ? { kind: 'enter', nickname, senderId: idMatch?.[1] } : null;
  }
  // 统计 / 粉丝团 / 其它提示行：不属于五类事件，忽略
  return null;
}

function parseChatLine(text: string): ParsedHelperMessage | null {
  const body = text.slice('【聊天msg】'.length);
  const idMatch = body.match(/^\[(\d+)\]/);
  const rest = idMatch ? body.slice(idMatch[0].length) : body;
  const sepIndex = rest.search(/[:：]/);
  if (sepIndex <= 0) {
    return null;
  }
  const nickname = rest.slice(0, sepIndex).trim();
  const content = rest.slice(sepIndex + 1).trim();
  if (nickname.length === 0 || content.length === 0) {
    return null;
  }
  return { kind: 'chat', senderId: idMatch?.[1], nickname, content };
}

// ---------- JSON 转发（dycast / tiktok-live-monitor 形态） ----------

/** dycast 弹幕类型名 → 本项目统一类型；未知类型一律忽略 */
const JSON_METHOD_TYPE_MAP: Record<string, ParsedHelperMessage['kind']> = {
  WebcastChatMessage: 'chat',
  WebcastGiftMessage: 'gift',
  WebcastLikeMessage: 'like',
  WebcastMemberMessage: 'enter',
  WebcastEmojiChatMessage: 'chat',
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 解析弹幕姬 JSON 转发行：{ method, id, user:{name}, content, gift:{name,count}, toUser }。
 * 返回中间态；无法识别（房间统计等）返回 null。
 */
export function parseHelperJson(raw: unknown): ParsedHelperMessage | null {
  if (!isObject(raw)) {
    return null;
  }
  const method = typeof raw.method === 'string' ? raw.method : '';
  const kind = JSON_METHOD_TYPE_MAP[method];
  if (!kind) {
    return null;
  }
  const user = isObject(raw.user) ? raw.user : {};
  const nickname = typeof user.name === 'string' ? user.name.trim() : '';
  if (kind === 'gift') {
    const gift = isObject(raw.gift) ? raw.gift : {};
    const giftName = typeof gift.name === 'string' ? gift.name : '';
    const count = typeof gift.count === 'number' ? gift.count : undefined;
    const content = count !== undefined ? `${giftName} ×${count}` : giftName;
    return { kind, nickname, content: content || undefined };
  }
  if (kind === 'like') {
    const content = typeof raw.content === 'string' && raw.content.trim() ? raw.content.trim() : undefined;
    return { kind, nickname, content };
  }
  if (kind === 'chat') {
    const content = typeof raw.content === 'string' ? raw.content.trim() : '';
    return content.length > 0 ? { kind, nickname, content } : null;
  }
  return { kind, nickname };
}

// ---------- 监控器：解析 → 守卫 → 计数 / 可选转发 ----------

export interface DanmakuMonitorDeps {
  platform?: DanmakuPlatform;
  roomRef: string;
  liveId?: string | null;
  /** 通过守卫的有效事件转发（D5.1：接既有弹幕网关触发 AI 回复） */
  onEvent?(event: UnifiedDanmakuEvent): void;
  now?(): Date;
}

export interface DanmakuMonitorStatus {
  /** 通过守卫的有效事件总数 */
  eventCount: number;
  /** 被守卫丢弃数（脏行 / 缺内容） */
  invalidCount: number;
  byType: Partial<Record<DanmakuMessageType, number>>;
  /** 最近一条有效事件（无则 null） */
  lastEvent: UnifiedDanmakuEvent | null;
}

/** 解析并归一化助手输出；seq 提供控制台行无平台消息 id 时的幂等兜底 */
function toEvent(
  message: ParsedHelperMessage,
  roomRef: string,
  liveId: string | null,
  platform: DanmakuPlatform,
  happenedAt: Date,
  seq: number,
): UnifiedDanmakuEvent {
  const msgKeySeed = message.kind === 'chat' || message.kind === 'enter' ? (message.senderId ?? 'u') : 'u';
  const msgKey = `${platform}:${msgKeySeed}-${seq}`;
  const event: UnifiedDanmakuEvent = {
    platform,
    roomRef,
    liveId,
    msgKey,
    msgType: message.kind,
    senderNickname: message.nickname,
    happenedAt: happenedAt.toISOString(),
  };
  if (message.kind !== 'enter' && message.content) {
    event.content = message.content;
  }
  return event;
}

export function createDanmakuMonitor(deps: DanmakuMonitorDeps) {
  const platform = deps.platform ?? 'douyin';
  const liveId = deps.liveId ?? null;
  const now = deps.now ?? (() => new Date());
  let seq = 0;
  let eventCount = 0;
  let invalidCount = 0;
  const byType: Partial<Record<DanmakuMessageType, number>> = {};
  let lastEvent: UnifiedDanmakuEvent | null = null;

  /** 守卫结果统一的入参（含非事件行忽略语义）：返回 true=已处理 */
  function ingest(parsed: ParsedHelperMessage | null): boolean {
    if (parsed === null) {
      // 非弹幕内容行（统计等）：不算脏数据，直接忽略
      return false;
    }
    seq += 1;
    const raw = toEvent(parsed, deps.roomRef, liveId, platform, now(), seq);
    const result: EventGuardResult = guardEvent(raw);
    if (!result.ok) {
      invalidCount += 1;
      console.warn(`[danmakuMonitor] 丢弃（${deps.roomRef}）：${result.reason}`);
      return true;
    }
    eventCount += 1;
    byType[result.event.msgType] = (byType[result.event.msgType] ?? 0) + 1;
    lastEvent = result.event;
    deps.onEvent?.(result.event);
    return true;
  }

  return {
    /** 喂助手控制台行（DouyinLiveWebFetcher 输出） */
    pushLine(line: string): boolean {
      return ingest(parseConsoleDanmakuLine(line));
    },
    /** 喂弹幕姬 JSON 转发行（dycast / tiktok-live-monitor 输出） */
    pushJson(raw: unknown): boolean {
      return ingest(parseHelperJson(raw));
    },
    status(): DanmakuMonitorStatus {
      return { eventCount, invalidCount, byType: { ...byType }, lastEvent: lastEvent ? { ...lastEvent } : null };
    },
  };
}
