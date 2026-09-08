// 真实抖音直播采集适配器（D2.3，D2.5 拍板解锁后开发）：观众视角连抖音网页直播 wss，只收自己直播间弹幕。
// 链路：webRoomId → 签名服务拿 wss 地址（第三方签名，Key 由部署方自备、不内置）→ PushFrame 解码
// → gzip(Response) → 归一化 chat/like/enter/gift 统一事件；心跳/ack 与竞品同构（payloadType: hb/ack）。
// 约束：自用自测口径；签名服务与 cookie 均走可注入依赖，单测全离线替身，不真连平台。
import WebSocket from 'ws';
import { buildMsgKey } from './events';
import {
  DOUYIN_HEARTBEAT_FRAME,
  buildAckFrame,
  bytesFromWireData,
  decodeDouyinChat,
  decodeDouyinGift,
  decodeDouyinLike,
  decodeDouyinMember,
  decodeDouyinPushFrame,
  decodeDouyinResponse,
  type DouyinMessage,
} from './douyinWire';
import type { AdapterHooks, AdapterSession, CollectorAdapter, UnifiedDanmakuEvent, WatchTarget } from './types';

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/** 签名服务：把 web 房间号换成一个可直连的抖音 im wss 地址（不同厂商服务同构，字段可配） */
export interface DouyinWssSigner {
  signWssUrl(roomId: string): Promise<string>;
}

/** 自备签名服务（POST JSON，取 data.Data.WssUrl；ApiKey 走配置/环境变量，不在代码内置任何第三方 Key） */
export function createDouyinHttpSigner(opts: { endpointUrl: string; apiKey: string; userUniqueId?: string }): DouyinWssSigner {
  return {
    async signWssUrl(roomId: string): Promise<string> {
      const response = await fetch(opts.endpointUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json;charset=UTF-8' },
        body: JSON.stringify({
          ApiKey: opts.apiKey,
          BrowserName: 'Mozilla',
          BrowserVersion: DEFAULT_UA,
          RoomId: roomId,
          UserUniqueId: opts.userUniqueId ?? '',
        }),
      });
      const text = await response.text();
      if (!response.ok) {
        throw new Error(`抖音 wss 签名失败：HTTP ${response.status}，服务端返回 ${truncateForError(text)}`);
      }
      let body: { Data?: { WssUrl?: string } };
      try {
        body = JSON.parse(text) as { Data?: { WssUrl?: string } };
      } catch {
        throw new Error(`抖音 wss 签名失败：服务端返回非 JSON（HTTP ${response.status}）：${truncateForError(text)}`);
      }
      const wssUrl = body.Data?.WssUrl;
      if (!wssUrl) {
        throw new Error(`抖音 wss 签名失败：响应缺少 Data.WssUrl，服务端返回 ${truncateForError(text)}`);
      }
      return wssUrl;
    },
  };
}

/** 签名服务返回体裁断（避免把超长 / 含敏感参数的原始报文整段打进错误日志） */
function truncateForError(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= 300) {
    return trimmed || '<空响应>';
  }
  return `${trimmed.slice(0, 300)}…（总长 ${trimmed.length}）`;
}

/** 上层只需要 on/on/send/close 的最小 socket 面；生产用 ws 包实现，测试用替身 */
export interface DouyinLiveSocket {
  readonly isOpen: boolean;
  send(data: Uint8Array): void;
  close(): void;
  onOpen(listener: () => void): void;
  onMessage(listener: (raw: unknown) => void): void;
  onClose(listener: () => void): void;
  onError(listener: (error: unknown) => void): void;
}

export interface DouyinLiveAdapterDeps {
  /** 缺省不内置任何第三方签名 Key：需部署方通过配置注入，或手工给 wssUrl 直连地址 */
  signer?: DouyinWssSigner;
  /** 手工直连地址（联调兜底）：优先于 signer */
  wssUrl?: string;
  /** 连接附加头（Cookie: ttwid 等）；UA 默认给桌面 Chrome，规避移动端风控特征 */
  headers?: Record<string, string>;
  /** 测试/替换连接器；缺省用 ws 包建连 */
  connect?(url: string, headers: Record<string, string>): DouyinLiveSocket;
  /** 到抖音 im 的下行心跳间隔（ms）；默认 5000，与 ack 一起维持连接存活 */
  heartbeatIntervalMs?: number;
  now?(): Date;
}

function openWsSocket(url: string, headers: Record<string, string>): DouyinLiveSocket {
  const ws = new WebSocket(url, { headers, perMessageDeflate: false });
  return {
    get isOpen(): boolean {
      return ws.readyState === WebSocket.OPEN;
    },
    send(data: Uint8Array): void {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data);
      }
    },
    close(): void {
      try {
        ws.close();
      } catch {
        // 已断开时忽略
      }
    },
    onOpen(listener: () => void): void {
      ws.on('open', listener);
    },
    onMessage(listener: (raw: unknown) => void): void {
      ws.on('message', (raw) => listener(raw));
    },
    onClose(listener: () => void): void {
      ws.on('close', listener);
    },
    onError(listener: (error: unknown) => void): void {
      ws.on('error', listener);
    },
  };
}

export function createDouyinLiveAdapter(deps: DouyinLiveAdapterDeps = {}): CollectorAdapter {
  const heartbeatIntervalMs = deps.heartbeatIntervalMs ?? 5000;
  const now = deps.now ?? (() => new Date());

  async function resolveWssUrl(roomId: string): Promise<string> {
    if (deps.wssUrl) {
      return deps.wssUrl;
    }
    if (!deps.signer) {
      throw new Error('未配置抖音 wss 签名服务（deps.signer 或 wssUrl），本机联调请注入自备签名服务');
    }
    return deps.signer.signWssUrl(roomId);
  }

  function toEvent(message: DouyinMessage, target: WatchTarget, sessionSeq: number, seq: number): UnifiedDanmakuEvent | null {
    const payload = message.payload;
    if (!payload) {
      return null;
    }
    const msgKey = message.msgId !== null && message.msgId !== undefined
      ? buildMsgKey(target.platform, String(message.msgId))
      : buildMsgKey(target.platform, `${target.roomRef}-${sessionSeq}-${seq}`);
    const base = {
      platform: target.platform,
      roomRef: target.roomRef,
      liveId: target.liveId,
      msgKey,
      happenedAt: now().toISOString(),
    };
    switch (message.method) {
      case 'WebcastChatMessage': {
        const chat = decodeDouyinChat(payload);
        const content = chat.content.trim();
        if (content.length === 0) {
          return null;
        }
        const event: UnifiedDanmakuEvent = { ...base, msgType: 'chat', content };
        const nickname = chat.user.nickName.trim();
        if (nickname) {
          event.senderNickname = nickname;
        }
        return event;
      }
      case 'WebcastLikeMessage': {
        const like = decodeDouyinLike(payload);
        const nickname = like.user.nickName.trim();
        if (!nickname) {
          return null;
        }
        const event: UnifiedDanmakuEvent = {
          ...base,
          msgType: 'like',
          content: like.count !== null ? `${String(like.count)}个赞` : '点了赞',
        };
        event.senderNickname = nickname;
        return event;
      }
      case 'WebcastMemberMessage': {
        const member = decodeDouyinMember(payload);
        const nickname = member.user.nickName.trim();
        if (!nickname) {
          return null;
        }
        const event: UnifiedDanmakuEvent = { ...base, msgType: 'enter' };
        event.senderNickname = nickname;
        return event;
      }
      case 'WebcastGiftMessage': {
        const gift = decodeDouyinGift(payload);
        const nickname = gift.user.nickName.trim();
        const giftName = gift.giftName.trim();
        if (!nickname || !giftName) {
          return null;
        }
        const event: UnifiedDanmakuEvent = {
          ...base,
          msgType: 'gift',
          content: gift.repeatCount !== null && gift.repeatCount > 1n ? `${giftName} ×${String(gift.repeatCount)}` : giftName,
        };
        event.senderNickname = nickname;
        return event;
      }
      default:
        // 关注 / 在线人数等未建模类型：忽略但不视为错误
        return null;
    }
  }

  return {
    source: 'douyin',
    open(target: WatchTarget, hooks: AdapterHooks): Promise<AdapterSession> {
      return new Promise((resolve, reject) => {
        const roomId = target.roomRef.trim();
        if (!roomId) {
          reject(new Error('roomRef 缺失，无法连接抖音直播间'));
          return;
        }
        let sessionSeq = 0;
        void resolveWssUrl(roomId)
          .then((wssUrl) => {
            sessionSeq += 1;
            const seqOfSession = sessionSeq;
            const headers = { 'User-Agent': DEFAULT_UA, ...deps.headers };
            const socket = deps.connect ? deps.connect(wssUrl, headers) : openWsSocket(wssUrl, headers);
            let closed = false;
            let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
            let messageSeq = 0;

            const clearTimers = (): void => {
              if (heartbeatTimer !== null) {
                clearInterval(heartbeatTimer);
                heartbeatTimer = null;
              }
            };
            const sendHeartbeat = (): void => {
              if (!closed) {
                socket.send(DOUYIN_HEARTBEAT_FRAME);
              }
            };

            socket.onOpen(() => {
              if (closed) {
                return;
              }
              hooks.onStateChange('connected');
              sendHeartbeat();
              if (heartbeatTimer === null) {
                heartbeatTimer = setInterval(sendHeartbeat, heartbeatIntervalMs);
              }
            });
            socket.onMessage((raw) => {
              if (closed) {
                return;
              }
              try {
                const bytes = bytesFromWireData(raw);
                const frame = decodeDouyinPushFrame(bytes);
                if (!frame.payload || frame.payload.length === 0) {
                  return;
                }
                const response = decodeDouyinResponse(frame.payload);
                if (response.needAck && frame.logId !== null && response.internalExt) {
                  socket.send(buildAckFrame(frame.logId, response.internalExt));
                }
                for (const message of response.messages) {
                  const event = toEvent(message, target, seqOfSession, (messageSeq += 1));
                  if (event) {
                    hooks.onEvent(event);
                  }
                }
              } catch (error) {
                console.warn(`[douyinLive] 报文解析失败已跳过（${roomId}）：${error instanceof Error ? error.message : String(error)}`);
              }
            });
            socket.onError((error) => {
              console.warn(`[douyinLive] 连接错误（${roomId}）：${error instanceof Error ? error.message : String(error)}`);
            });
            socket.onClose(() => {
              clearTimers();
              if (!closed) {
                hooks.onStateChange('disconnected');
              }
            });

            const session: AdapterSession = {
              async heartbeat(): Promise<boolean> {
                return !closed && socket.isOpen;
              },
              async close(): Promise<void> {
                if (closed) {
                  return;
                }
                closed = true;
                clearTimers();
                socket.close();
              },
            };
            resolve(session);
          })
          .catch((error: unknown) => {
            reject(error instanceof Error ? error : new Error(String(error)));
          });
      });
    },
  };
}
