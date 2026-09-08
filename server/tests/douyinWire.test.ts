import { describe, expect, it } from 'vitest';
import { Buffer } from 'node:buffer';
import {
  DOUYIN_HEARTBEAT_FRAME,
  buildAckFrame,
  bytesFromWireData,
  concatBytes,
  decodeDouyinChat,
  decodeDouyinGift,
  decodeDouyinLike,
  decodeDouyinMember,
  decodeDouyinPushFrame,
  decodeDouyinResponse,
  decodeDouyinSocial,
  pbFieldBytes,
  pbFieldString,
  pbFieldVarint,
  pbVarint,
} from '../src/collectors/douyinWire';
import {
  buildChatBytes,
  buildGiftBytes,
  buildLikeBytes,
  buildMemberBytes,
  buildMessageBytes,
  buildPushFrameBytes,
  buildResponseBytes,
  buildSocialBytes,
  buildUserBytes,
} from '../src/collectors/douyinWireFixtures';

// D2.3 抖音直播最小 protobuf 编解码：纯离线单测，fixture 由 douyinWireFixtures 构造，不真连平台。

describe('D2.3 decodeDouyinPushFrame 帧解析', () => {
  it('解析出 logId / payloadType / payload，payload 原样保留', () => {
    const payload = new Uint8Array([1, 2, 3]);
    const frame = decodeDouyinPushFrame(
      concatBytes([pbVarint((2n << 3n) | 0n), pbVarint(9876543210n), pbFieldString(7, 'push'), pbFieldBytes(8, payload)]),
    );
    expect(frame.logId).toBe(9876543210n);
    expect(frame.payloadType).toBe('push');
    expect([...frame.payload ?? []]).toEqual([1, 2, 3]);
  });

  it('心跳帧 [58,2,104,98] = PushFrame{ payloadType: hb }，无 payload', () => {
    const frame = decodeDouyinPushFrame(DOUYIN_HEARTBEAT_FRAME);
    expect(frame.payloadType).toBe('hb');
    expect(frame.payload).toBeNull();
    expect(frame.logId).toBeNull();
  });

  it('空报文不抛错，返回全默认', () => {
    expect(decodeDouyinPushFrame(new Uint8Array())).toEqual({ logId: null, payloadType: '', payload: null });
  });
});

describe('D2.3 decodeDouyinResponse 响应解码', () => {
  it('gzip 负载解出 messages 列表；空消息时为空数组', () => {
    const response = buildResponseBytes({ messages: [new Uint8Array([0x0a, 0x00])] });
    const decoded = decodeDouyinResponse(response);
    expect(decoded.messages).toHaveLength(1);
    expect(decoded.needAck).toBe(false);
    expect(decoded.internalExt).toBe('');
  });

  it('未压缩负载自动兜底裸解（个别帧可能不带 gzip）', () => {
    const message = buildMessageBytes({ method: 'WebcastChatMessage', payload: buildChatBytes({ content: '裸解' }), msgId: 42n });
    const decoded = decodeDouyinResponse(buildResponseBytes({ messages: [message] }));
    expect(decoded.messages).toHaveLength(1);
    expect(decoded.messages[0]?.method).toBe('WebcastChatMessage');
  });

  it('needAck / internalExt 解析正确', () => {
    const decoded = decodeDouyinResponse(buildResponseBytes({ messages: [], internalExt: 'abc', needAck: true }));
    expect(decoded.needAck).toBe(true);
    expect(decoded.internalExt).toBe('abc');
  });
});

describe('D2.3 事件消息体解码（字段编号对齐竞品反编译 schema）', () => {
  it('WebcastChatMessage：拆出昵称 / 用户 id / 正文，空白原样保留（裁剪在适配器层做）', () => {
    const decoded = decodeDouyinChat(buildChatBytes({ userId: 777n, nickName: ' 吃货小王 ', content: ' 双人餐多少钱？ ' }));
    expect(decoded.content).toBe(' 双人餐多少钱？ ');
    expect(decoded.user.nickName).toBe(' 吃货小王 ');
    expect(decoded.user.id).toBe(777n);
  });

  it('WebcastLikeMessage：拆出点赞数与用户', () => {
    const decoded = decodeDouyinLike(buildLikeBytes({ userId: 1n, nickName: '小美', count: 3n }));
    expect(decoded.count).toBe(3n);
    expect(decoded.user.nickName).toBe('小美');
  });

  it('WebcastMemberMessage：拆出进场人数与用户', () => {
    const decoded = decodeDouyinMember(buildMemberBytes({ userId: 2n, nickName: '路人甲', memberCount: 99n }));
    expect(decoded.memberCount).toBe(99n);
    expect(decoded.user.nickName).toBe('路人甲');
  });

  it('WebcastGiftMessage：拆出礼物名与连击数；name 缺省时回退 describe', () => {
    const gift = buildGiftBytes({ userId: 3n, nickName: '榜一大哥', giftName: '小心心', repeatCount: 2n });
    const decoded = decodeDouyinGift(gift);
    expect(decoded.giftName).toBe('小心心');
    expect(decoded.repeatCount).toBe(2n);
    expect(decoded.user.nickName).toBe('榜一大哥');

    const withDescribe = decodeDouyinGift(concatBytes([
      pbFieldBytes(7, buildUserBytes(3n, '榜一大哥')),
      pbFieldBytes(15, pbFieldString(2, '玫瑰')),
      pbFieldVarint(5, 1n),
    ]));
    void gift;
    expect(withDescribe.giftName).toBe('玫瑰');
  });

  it('WebcastSocialMessage（关注）：只取用户信息不崩溃', () => {
    const decoded = decodeDouyinSocial(buildSocialBytes({ userId: 4n, nickName: '关注者' }));
    expect(decoded.nickName).toBe('关注者');
  });
});

describe('D2.3 上行控制帧（ack / 心跳）', () => {
  it('心跳字节与竞品一致：protobuf 紧凑编码 [0x3a,0x02,0x68,0x62]', () => {
    expect([...DOUYIN_HEARTBEAT_FRAME]).toEqual([0x3a, 0x02, 0x68, 0x62]);
  });

  it('buildAckFrame 组出可被对端解析的 ack：logId + internalExt 原样回传', () => {
    const ack = buildAckFrame(123456789012345678n, 'internal-ext-payload');
    const frame = decodeDouyinPushFrame(ack);
    expect(frame.payloadType).toBe('ack');
    expect(frame.logId).toBe(123456789012345678n);
    expect(Buffer.from(frame.payload ?? new Uint8Array()).toString('utf8')).toBe('internal-ext-payload');
  });
});

describe('D2.3 bytesFromWireData 报文归一化', () => {
  it('Uint8Array / ArrayBuffer / Buffer / 数字数组 / base64 字符串统一转 Uint8Array', () => {
    const source = Uint8Array.of(1, 2, 3);
    expect([...bytesFromWireData(source)]).toEqual([1, 2, 3]);
    expect([...bytesFromWireData(source.buffer)]).toEqual([1, 2, 3]);
    expect([...bytesFromWireData(Buffer.from(source))]).toEqual([1, 2, 3]);
    expect([...bytesFromWireData([1, 2, 3])]).toEqual([1, 2, 3]);
    expect([...bytesFromWireData('data:,AQID')]).toEqual([1, 2, 3]);
    expect([...bytesFromWireData('AQID')]).toEqual([1, 2, 3]);
  });

  it('无法识别的类型抛错', () => {
    expect(() => bytesFromWireData({ hello: 1 })).toThrow();
  });
});

describe('D2.3 fixture 构造与解码往返（build 与 decode 共用字段编号）', () => {
  it('完整 chat 帧往返：PushFrame(gzip(Response(Message(chat)))) 解出业务字段', () => {
    const message = buildMessageBytes({
      method: 'WebcastChatMessage',
      payload: buildChatBytes({ userId: 202n, nickName: '小明', content: '锅底能换鸳鸯吗' }),
      msgId: 101n,
    });
    const response = buildResponseBytes({ messages: [message], internalExt: 'ie', needAck: true });
    const frame = buildPushFrameBytes({ logId: 88n, response });
    const decodedFrame = decodeDouyinPushFrame(frame);
    expect(decodedFrame.logId).toBe(88n);
    const decoded = decodeDouyinResponse(decodedFrame.payload ?? new Uint8Array());
    expect(decoded.needAck).toBe(true);
    expect(decoded.internalExt).toBe('ie');
    expect(decoded.messages).toHaveLength(1);
    const decodedMessage = decoded.messages[0];
    expect(decodedMessage?.method).toBe('WebcastChatMessage');
    expect(decodedMessage?.msgId).toBe(101n);
    const chat = decodeDouyinChat(decodedMessage?.payload ?? new Uint8Array());
    expect(chat.content).toBe('锅底能换鸳鸯吗');
    expect(chat.user.nickName).toBe('小明');
    expect(chat.user.id).toBe(202n);
  });

  it('gzip 与裸解两条 fixture 路径都走通', () => {
    const message = buildMessageBytes({ method: 'WebcastChatMessage', payload: buildChatBytes({ content: 'a' }) });
    const compressed = buildPushFrameBytes({ logId: 1n, response: buildResponseBytes({ messages: [message] }) });
    const raw = buildPushFrameBytes({ logId: 1n, response: buildResponseBytes({ messages: [message] }), compress: false });
    const decode = (frame: Uint8Array): string => {
      const decoded = decodeDouyinResponse(decodeDouyinPushFrame(frame).payload ?? new Uint8Array());
      return decodeDouyinChat(decoded.messages[0]?.payload ?? new Uint8Array()).content;
    };
    expect(decode(compressed)).toBe('a');
    expect(decode(raw)).toBe('a');
  });
});
