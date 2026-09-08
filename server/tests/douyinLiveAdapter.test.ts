import { afterEach, describe, expect, it, vi } from 'vitest';
import { gzipSync } from 'node:zlib';
import { createDouyinHttpSigner, createDouyinLiveAdapter, type DouyinLiveSocket } from '../src/collectors/douyinLiveAdapter';
import { concatBytes, decodeDouyinPushFrame, pbFieldBytes, pbVarint } from '../src/collectors/douyinWire';
import {
  buildChatBytes,
  buildGiftBytes,
  buildLikeBytes,
  buildMemberBytes,
  buildMessageBytes,
  buildPushFrameBytes,
  buildResponseBytes,
  buildSocialBytes,
} from '../src/collectors/douyinWireFixtures';
import type { AdapterSession, UnifiedDanmakuEvent, WatchTarget } from '../src/collectors/types';

// D2.3 抖音直播采集适配器：替身 socket 离线推流，验证归一化 / ack / 心跳 / 幂等键，不真连平台。

const TARGET: WatchTarget = { source: 'douyin', platform: 'douyin', roomRef: '7312834574980', liveId: 'live-0001' };
const WSS_URL = 'wss://fake-douyin-im.test/ws';

function pbTagForTest(fieldNo: number, wireType: number): Uint8Array {
  return pbVarint((BigInt(fieldNo) << 3n) | BigInt(wireType));
}

/** 替身 socket：记录 send 字节与回调，测试手动触发 open / message / close / error */
class FakeSocket implements DouyinLiveSocket {
  sent: Uint8Array[] = [];
  private openListeners: Array<() => void> = [];
  private messageListeners: Array<(raw: unknown) => void> = [];
  private closeListeners: Array<() => void> = [];
  private errorListeners: Array<(error: unknown) => void> = [];
  open = true;
  closed = false;

  send(data: Uint8Array): void {
    if (this.open) {
      this.sent.push(Uint8Array.from(data));
    }
  }

  close(): void {
    this.closed = true;
    this.open = false;
  }

  onOpen(listener: () => void): void {
    this.openListeners.push(listener);
  }

  onMessage(listener: (raw: unknown) => void): void {
    this.messageListeners.push(listener);
  }

  onClose(listener: () => void): void {
    this.closeListeners.push(listener);
  }

  onError(listener: (error: unknown) => void): void {
    this.errorListeners.push(listener);
  }

  get isOpen(): boolean {
    return this.open;
  }

  emitOpen(): void {
    for (const listener of [...this.openListeners]) {
      listener();
    }
  }

  emitMessage(raw: Uint8Array): void {
    for (const listener of [...this.messageListeners]) {
      listener(raw);
    }
  }

  emitClose(): void {
    this.open = false;
    for (const listener of [...this.closeListeners]) {
      listener();
    }
  }

  emitError(error: unknown): void {
    for (const listener of [...this.errorListeners]) {
      listener(error);
    }
  }
}

interface Harness {
  socket: FakeSocket;
  session: AdapterSession;
  events: UnifiedDanmakuEvent[];
  states: string[];
}

function connectSpy(): {
  fake: FakeSocket;
  connect: (url: string, headers: Record<string, string>) => DouyinLiveSocket;
  calls: Array<{ url: string; headers: Record<string, string> }>;
} {
  const fake = new FakeSocket();
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const connect = (url: string, headers: Record<string, string>): DouyinLiveSocket => {
    calls.push({ url, headers });
    return fake;
  };
  return { fake, connect, calls };
}

async function openHarness(deps: {
  wssUrl?: string;
  signer?: { signWssUrl(roomId: string): Promise<string> };
  headers?: Record<string, string>;
  heartbeatIntervalMs?: number;
}): Promise<Harness> {
  const { fake, connect, calls } = connectSpy();
  const events: UnifiedDanmakuEvent[] = [];
  const states: string[] = [];
  const adapter = createDouyinLiveAdapter({
    wssUrl: deps.wssUrl ?? WSS_URL,
    signer: deps.signer,
    headers: deps.headers,
    heartbeatIntervalMs: deps.heartbeatIntervalMs ?? 100000,
    connect,
  });
  const session = await adapter.open(TARGET, {
    onEvent: (event) => events.push(event),
    onStateChange: (state) => states.push(state),
  });
  void calls;
  void connect;
  void fake;
  return { socket: fake, session, events, states };
}

function chatMessage(opts: { msgId?: bigint | number; nickName?: string; content: string }): Uint8Array {
  return buildMessageBytes({
    method: 'WebcastChatMessage',
    payload: buildChatBytes({ nickName: opts.nickName, content: opts.content }),
    msgId: opts.msgId,
  });
}

describe('D2.3 createDouyinLiveAdapter 连接入口', () => {
  it('wssUrl 直连优先：signer 不被调用，socket 收到合并后的请求头（UA + 自定义 Cookie）', async () => {
    const signer = { signWssUrl: async (): Promise<string> => { throw new Error('不应调用 signer'); } };
    const { fake, connect, calls } = connectSpy();
    const events: UnifiedDanmakuEvent[] = [];
    const adapter = createDouyinLiveAdapter({
      wssUrl: WSS_URL,
      signer,
      headers: { Cookie: 'ttwid=abc123' },
      connect,
    });
    const session = await adapter.open(TARGET, {
      onEvent: (event) => events.push(event),
      onStateChange: () => undefined,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(WSS_URL);
    expect(calls[0]?.headers['User-Agent']).toContain('Chrome');
    expect(calls[0]?.headers['Cookie']).toBe('ttwid=abc123');
    await session.close();
    void fake;
    void events;
  });

  it('未配 wssUrl 时走 signer，房间号透传给签名服务', async () => {
    const signed: string[] = [];
    const { fake, connect, calls } = connectSpy();
    const adapter = createDouyinLiveAdapter({
      signer: {
        async signWssUrl(roomId: string): Promise<string> {
          signed.push(roomId);
          return WSS_URL;
        },
      },
      connect,
    });
    const session = await adapter.open(TARGET, {
      onEvent: () => undefined,
      onStateChange: () => undefined,
    });
    expect(signed).toEqual(['7312834574980']);
    expect(calls[0]?.url).toBe(WSS_URL);
    await session.close();
    void fake;
  });

  it('既无 wssUrl 也无 signer → open 拒绝并提示缺签名服务', async () => {
    const adapter = createDouyinLiveAdapter({ connect: () => new FakeSocket() });
    await expect(
      adapter.open(TARGET, { onEvent: () => undefined, onStateChange: () => undefined }),
    ).rejects.toThrow(/签名服务/);
  });

  it('roomRef 缺失 / 纯空白 → open 拒绝', async () => {
    const adapter = createDouyinLiveAdapter({ wssUrl: WSS_URL, connect: () => new FakeSocket() });
    await expect(
      adapter.open(
        { source: 'douyin', platform: 'douyin', roomRef: '   ', liveId: null },
        { onEvent: () => undefined, onStateChange: () => undefined },
      ),
    ).rejects.toThrow(/roomRef 缺失/);
  });
});

describe('D2.3 消息推流与归一化', () => {
  it('open 后推 chat 帧：去空白、带昵称、msgKey 用平台 msgId、状态先 connected', async () => {
    const handle = await openHarness({});
    handle.socket.emitOpen();
    const message = chatMessage({ msgId: 101n, nickName: ' 吃货小王 ', content: ' 双人毛肚套餐多少钱？ ' });
    handle.socket.emitMessage(buildPushFrameBytes({ logId: 88n, response: buildResponseBytes({ messages: [message] }) }));
    expect(handle.states).toEqual(['connected']);
    expect(handle.events).toHaveLength(1);
    expect(handle.events[0]).toMatchObject({
      platform: 'douyin',
      roomRef: '7312834574980',
      liveId: 'live-0001',
      msgType: 'chat',
      content: '双人毛肚套餐多少钱？',
      senderNickname: '吃货小王',
    });
    expect(handle.events[0]?.msgKey).toBe('douyin:101');
    await handle.session.close();
  });

  it('同一帧里 chat/like/enter/gift 分别归一化，like 与 gift 的文案含数量', async () => {
    const handle = await openHarness({});
    handle.socket.emitOpen();
    const messages = [
      chatMessage({ msgId: 1n, nickName: '老王', content: '有团购券吗' }),
      buildMessageBytes({ method: 'WebcastLikeMessage', payload: buildLikeBytes({ nickName: '小美', count: 3n }), msgId: 2n }),
      buildMessageBytes({ method: 'WebcastMemberMessage', payload: buildMemberBytes({ nickName: '路人甲', memberCount: 99n }), msgId: 3n }),
      buildMessageBytes({
        method: 'WebcastGiftMessage',
        payload: buildGiftBytes({ nickName: '榜一大哥', giftName: '小心心', repeatCount: 2n }),
        msgId: 4n,
      }),
    ];
    handle.socket.emitMessage(buildPushFrameBytes({ logId: 1n, response: buildResponseBytes({ messages }) }));
    expect(handle.events.map((event) => event.msgType)).toEqual(['chat', 'like', 'enter', 'gift']);
    expect(handle.events[1]?.content).toBe('3个赞');
    expect(handle.events[1]?.senderNickname).toBe('小美');
    expect(handle.events[3]?.content).toBe('小心心 ×2');
    expect(handle.events[3]?.senderNickname).toBe('榜一大哥');
    await handle.session.close();
  });

  it('needAck 帧：先回 ack（logId + internalExt 原样），再广播事件', async () => {
    const handle = await openHarness({});
    handle.socket.emitOpen();
    handle.socket.sent.length = 0;
    const message = chatMessage({ msgId: 7n, nickName: '小明', content: '锅底辣吗' });
    handle.socket.emitMessage(
      buildPushFrameBytes({
        logId: 88n,
        response: buildResponseBytes({ messages: [message], internalExt: 'ie-1', needAck: true }),
      }),
    );
    const ackBytes = handle.socket.sent.find((bytes) => decodeDouyinPushFrame(bytes).payloadType === 'ack');
    expect(ackBytes).toBeDefined();
    const ack = decodeDouyinPushFrame(ackBytes ?? new Uint8Array());
    expect(ack.logId).toBe(88n);
    expect(new TextDecoder().decode(ack.payload ?? new Uint8Array())).toBe('ie-1');
    expect(handle.events).toHaveLength(1);
    await handle.session.close();
  });

  it('无 msgId 的 chat：幂等键回退 roomRef-sessionSeq-seq，同帧多条仍唯一', async () => {
    const handle = await openHarness({});
    handle.socket.emitOpen();
    const messages = [
      chatMessage({ nickName: 'A', content: '第一条' }),
      chatMessage({ nickName: 'B', content: '第二条' }),
    ];
    handle.socket.emitMessage(buildPushFrameBytes({ logId: 1n, response: buildResponseBytes({ messages }) }));
    expect(handle.events).toHaveLength(2);
    expect(handle.events[0]?.msgKey).toBe('douyin:7312834574980-1-1');
    expect(handle.events[1]?.msgKey).toBe('douyin:7312834574980-1-2');
    await handle.session.close();
  });

  it('脏事件被丢弃但不崩会话：空正文 chat / 无昵称 like / 无昵称 enter / 无礼物名 gift / 未建模方法', async () => {
    const handle = await openHarness({});
    handle.socket.emitOpen();
    const messages = [
      buildMessageBytes({ method: 'WebcastChatMessage', payload: buildChatBytes({ content: '   ' }), msgId: 1n }),
      buildMessageBytes({ method: 'WebcastLikeMessage', payload: buildLikeBytes({ count: 1n }), msgId: 2n }),
      buildMessageBytes({ method: 'WebcastMemberMessage', payload: buildMemberBytes({ memberCount: 1n }), msgId: 3n }),
      buildMessageBytes({ method: 'WebcastGiftMessage', payload: buildGiftBytes({ nickName: 'X', giftName: '' }), msgId: 4n }),
      buildMessageBytes({ method: 'WebcastSocialMessage', payload: buildSocialBytes({ nickName: '关注者' }), msgId: 5n }),
    ];
    handle.socket.emitMessage(buildPushFrameBytes({ logId: 1n, response: buildResponseBytes({ messages }) }));
    expect(handle.events).toHaveLength(0);
    await handle.session.close();
  });

  it('无 payload 的帧（纯心跳下行 / 空响应）静默跳过，不影响后续消息', async () => {
    const handle = await openHarness({});
    handle.socket.emitOpen();
    handle.socket.emitMessage(buildPushFrameBytes({ logId: 1n }));
    handle.socket.emitMessage(buildPushFrameBytes({ logId: 2n, response: buildResponseBytes({ messages: [] }) }));
    expect(handle.events).toHaveLength(0);
    const message = chatMessage({ msgId: 9n, nickName: '小明', content: '还在吗' });
    handle.socket.emitMessage(buildPushFrameBytes({ logId: 3n, response: buildResponseBytes({ messages: [message] }) }));
    expect(handle.events).toHaveLength(1);
    await handle.session.close();
  });
});

describe('D2.3 createDouyinHttpSigner 签名请求', () => {
  const ENDPOINT = 'https://api.aiobs.cn/Douyin/Douyin/SignWss';

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function stubFetch(body: unknown, ok = true, status = 200): void {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok,
      status,
      text: async () => JSON.stringify(body),
    } as unknown as Response);
  }

  it('200 且带 Data.WssUrl → 原样返回 wss 地址，请求体字段正确', async () => {
    stubFetch({ Data: { WssUrl: 'wss://webcast.amemv.com/webcast/im/push/v2/?room_id=7312834574980&sig=abc' } });
    const signer = createDouyinHttpSigner({ endpointUrl: ENDPOINT, apiKey: 'test-key' });
    await expect(signer.signWssUrl('7312834574980')).resolves.toBe(
      'wss://webcast.amemv.com/webcast/im/push/v2/?room_id=7312834574980&sig=abc',
    );
    const [url, init] = vi.mocked(fetch).mock.calls[0] ?? [];
    expect(String(url)).toBe(ENDPOINT);
    const sent = JSON.parse(String((init as RequestInit).body)) as Record<string, string>;
    expect(sent.ApiKey).toBe('test-key');
    expect(sent.RoomId).toBe('7312834574980');
    expect(sent.BrowserVersion).toContain('Chrome');
  });

  it('HTTP 非 2xx → 拒绝并带服务端返回体（便于区分 Key 未授权等）', async () => {
    stubFetch({ Code: 401, Msg: '授权失败或未开通' }, false, 401);
    const signer = createDouyinHttpSigner({ endpointUrl: ENDPOINT, apiKey: 'bad-key' });
    await expect(signer.signWssUrl('7312834574980')).rejects.toThrow(/HTTP 401/);
    await expect(signer.signWssUrl('7312834574980')).rejects.toThrow(/授权失败或未开通/);
  });

  it('200 但缺 Data.WssUrl → 拒绝并提示响应内容', async () => {
    stubFetch({ Code: 1, Msg: '房间不存在' });
    const signer = createDouyinHttpSigner({ endpointUrl: ENDPOINT, apiKey: 'test-key' });
    await expect(signer.signWssUrl('999')).rejects.toThrow(/缺少 Data\.WssUrl/);
    await expect(signer.signWssUrl('999')).rejects.toThrow(/房间不存在/);
  });
});

describe('D2.3 心跳与生命周期', () => {
  it('open 后立即发一次心跳，随后按 interval 持续；close 后停止', async () => {
    const handle = await openHarness({ heartbeatIntervalMs: 15 });
    handle.socket.emitOpen();
    expect(handle.socket.sent.length).toBeGreaterThanOrEqual(1);
    const snapshot = handle.socket.sent.length;
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(handle.socket.sent.length).toBeGreaterThan(snapshot);
    await handle.session.close();
    const afterClose = handle.socket.sent.length;
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(handle.socket.sent.length).toBe(afterClose);
  });

  it('heartbeat 探活：连接在 → true；close 幂等且之后 → false，close 只执行一次', async () => {
    const handle = await openHarness({});
    expect(await handle.session.heartbeat()).toBe(true);
    await handle.session.close();
    await handle.session.close();
    expect(await handle.session.heartbeat()).toBe(false);
    expect(handle.socket.closed).toBe(true);
  });

  it('远端断开触发 disconnected 状态，但不重复上报（close 后 onClose 被忽略）', async () => {
    const handle = await openHarness({});
    handle.socket.emitOpen();
    handle.socket.emitClose();
    expect(handle.states).toEqual(['connected', 'disconnected']);
    await handle.session.close();
    handle.socket.emitClose();
    expect(handle.states).toEqual(['connected', 'disconnected']);
  });
});

describe('D2.3 畸形报文容错', () => {
  it('截断 / 非 protobuf 字节只告警跳过，不冒泡到调用方', async () => {
    const handle = await openHarness({});
    handle.socket.emitOpen();
    expect(() => handle.socket.emitMessage(new Uint8Array([0x3a, 0x05, 0x68]))).not.toThrow();
    expect(handle.events).toHaveLength(0);
    await handle.session.close();
  });

  it('未知 wireType 字段在帧内被跳过，业务字段仍能解出', async () => {
    const handle = await openHarness({});
    handle.socket.emitOpen();
    const message = chatMessage({ msgId: 5n, nickName: '小明', content: '你好' });
    const response = buildResponseBytes({ messages: [message] });
    // 在 payload 前塞一段 64 位 fixed 字段（wireType 1）验证 skip 逻辑
    const junkFrame = concatBytes([
      pbTagForTest(3, 1),
      new Uint8Array(8),
      pbFieldBytes(8, gzipSync(response)),
    ]);
    handle.socket.emitMessage(junkFrame);
    expect(handle.events).toHaveLength(1);
    expect(handle.events[0]?.msgKey).toBe('douyin:5');
    await handle.session.close();
  });
});
