import {
  KNOWN_MESSAGE_TYPES,
  KNOWN_PLATFORMS,
  MAX_DANMAKU_CONTENT_LENGTH,
  MAX_DANMAKU_NICKNAME_LENGTH,
  type DanmakuMessageType,
  type DanmakuPlatform,
  type UnifiedDanmakuEvent,
} from './types';
import type { DanmakuIngestInput } from '../services/danmaku';

// 统一事件守卫与 G3 网关转换（D2.1 纯函数，D 系列核心的公共底座）：
// 适配器（含未来真实协议实现）输出统一事件 → 守卫层做运行时兜底（类型 / 长度 / 必填 / 时间），
// 再交给 manager 落库与广播，保证单个适配器异常不冒到业务链路（对齐 PLAN §10「归一化层兜底」）。

/** 幂等键：platform + 平台侧消息 id，作为未来 (platform, msg_key) 唯一索引的组成 */
export function buildMsgKey(platform: DanmakuPlatform, providerMessageId: string): string {
  return `${platform}:${providerMessageId}`;
}

export type EventGuardResult =
  | { ok: true; event: UnifiedDanmakuEvent }
  | { ok: false; reason: string };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 时间字段兜底：非法 / 缺失一律用本地当前时间（ISO8601），保证下游排序与落库不炸 */
function normalizeIsoTime(value: unknown): string {
  if (typeof value === 'string' && !Number.isNaN(Date.parse(value))) {
    return value;
  }
  return new Date().toISOString();
}

/** 非空字符串并截断到上限；非法输入返回空串由调用方按字段语义处理 */
function stringField(value: unknown, maxLength: number): string {
  if (typeof value !== 'string') {
    return '';
  }
  return value.trim().slice(0, maxLength);
}

/**
 * 守卫统一事件：只放行结构合法的归一化事件。
 * - chat 必带非空文本且 ≤200 字（对齐 G3 网关口径）；
 * - 昵称超长截断到 50 字；msgType 非法 / platform 未知 / roomRef 或 msgKey 缺失 → 整条丢弃并给原因；
 * - 单条适配器脏数据只影响本条（由 manager 计入 invalidEvents），不让整条采集会话崩。
 */
export function guardEvent(raw: unknown): EventGuardResult {
  if (!isObject(raw)) {
    return { ok: false, reason: '事件不是对象' };
  }
  const { platform, roomRef, msgKey, msgType, content, senderNickname, liveId, happenedAt, raw: origin } = raw;

  if (typeof platform !== 'string' || !KNOWN_PLATFORMS.includes(platform as DanmakuPlatform)) {
    return { ok: false, reason: `未知平台：${String(platform)}` };
  }
  const roomId = stringField(roomRef, 64);
  if (roomId.length === 0) {
    return { ok: false, reason: 'roomRef 缺失或为空' };
  }
  if (typeof msgKey !== 'string' || msgKey.trim().length === 0) {
    return { ok: false, reason: 'msgKey 缺失或为空（无法幂等去重）' };
  }
  if (typeof msgType !== 'string' || !KNOWN_MESSAGE_TYPES.includes(msgType as DanmakuMessageType)) {
    return { ok: false, reason: `未知事件类型：${String(msgType)}` };
  }

  const body = typeof content === 'string' ? content.trim() : '';
  if (msgType === 'chat' && body.length === 0) {
    return { ok: false, reason: 'chat 事件缺少非空文本内容' };
  }
  if (typeof content !== 'undefined' && typeof content !== 'string') {
    return { ok: false, reason: 'content 必须为字符串' };
  }
  if (body.length > MAX_DANMAKU_CONTENT_LENGTH) {
    return { ok: false, reason: `content 超过 ${MAX_DANMAKU_CONTENT_LENGTH} 字上限` };
  }

  const nickname = stringField(senderNickname, MAX_DANMAKU_NICKNAME_LENGTH);
  const event: UnifiedDanmakuEvent = {
    platform: platform as DanmakuPlatform,
    roomRef: roomId,
    liveId: typeof liveId === 'string' && liveId.length > 0 ? liveId : null,
    msgKey: msgKey.trim(),
    msgType: msgType as DanmakuMessageType,
    happenedAt: normalizeIsoTime(happenedAt),
  };
  if (body.length > 0) {
    event.content = body;
  }
  if (nickname.length > 0) {
    event.senderNickname = nickname;
  }
  if (isObject(origin)) {
    event.raw = origin;
  }
  return { ok: true, event };
}

/** 把 chat 统一事件转成 G3 弹幕网关入参（D5.1 接线缝）：非 chat 或空文本 → null，由调用方决定忽略 */
export function eventToIngestInput(event: UnifiedDanmakuEvent): DanmakuIngestInput | null {
  if (event.msgType !== 'chat') {
    return null;
  }
  const content = event.content?.trim() ?? '';
  if (content.length === 0) {
    return null;
  }
  const senderNickname = event.senderNickname?.trim().slice(0, MAX_DANMAKU_NICKNAME_LENGTH);
  return senderNickname ? { content, senderNickname } : { content, senderNickname: null };
}
