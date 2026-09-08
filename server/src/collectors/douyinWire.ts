// 抖音直播长连接最小协议编解码（D2.3 真实抖音采集器底座）。
// 依据：竞品 App 反编译包内 `douyinProto` protobuf 字段定义（PushFrame/Response/Message 及各事件消息），
// 本文件以纯 TS 自研实现「只读自己直播间所需的字段子集」，不内嵌竞品代码、不引入 protobuf 运行时依赖。
// 报文形态：wss 二进制帧 = PushFrame → payload(gzip) → Response → messagesList。
import { gunzipSync } from 'node:zlib';

// ---------- 底层 protobuf wire 编码 / 解码 ----------

function big(value: number | bigint): bigint {
  return typeof value === 'bigint' ? value : BigInt(value);
}

/** 变长整数编码（支持超出 Number 的 uint64，如 logId / msgId） */
export function pbVarint(value: number | bigint): Uint8Array {
  let v = big(value);
  const out: number[] = [];
  for (;;) {
    const byte = Number(v & 0x7fn);
    v >>= 7n;
    if (v === 0n) {
      out.push(byte);
      break;
    }
    out.push(byte | 0x80);
  }
  return new Uint8Array(out);
}

export function pbTag(fieldNo: number, wireType: number): Uint8Array {
  return pbVarint((big(fieldNo) << 3n) | big(wireType));
}

/** length-delimited 字段（bytes / string / 嵌套消息共用） */
export function pbFieldBytes(fieldNo: number, data: Uint8Array): Uint8Array {
  return concatBytes([pbTag(fieldNo, 2), pbVarint(data.length), data]);
}

export function pbFieldString(fieldNo: number, text: string): Uint8Array {
  return pbFieldBytes(fieldNo, new Uint8Array(Buffer.from(text, 'utf8')));
}

export function pbFieldVarint(fieldNo: number, value: number | bigint): Uint8Array {
  return concatBytes([pbTag(fieldNo, 0), pbVarint(value)]);
}

export function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

class ByteReader {
  private readonly bytes: Uint8Array;
  private pos = 0;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
  }

  get eof(): boolean {
    return this.pos >= this.bytes.length;
  }

  readVarint(): bigint {
    let result = 0n;
    let shift = 0n;
    for (;;) {
      if (this.pos >= this.bytes.length) {
        throw new Error('protobuf 变长整数截断');
      }
      const byte = this.bytes[this.pos] ?? 0;
      this.pos += 1;
      result |= (big(byte & 0x7f)) << shift;
      if ((byte & 0x80) === 0) {
        return result;
      }
      shift += 7n;
      if (shift > 70n) {
        throw new Error('protobuf 变长整数过长');
      }
    }
  }

  readBytes(): Uint8Array {
    const length = Number(this.readVarint());
    if (length < 0 || this.pos + length > this.bytes.length) {
      throw new Error('protobuf 字节段越界');
    }
    const out = this.bytes.slice(this.pos, this.pos + length);
    this.pos += length;
    return out;
  }

  readString(): string {
    return Buffer.from(this.readBytes()).toString('utf8');
  }

  skip(wireType: number): void {
    if (wireType === 0) {
      this.readVarint();
      return;
    }
    if (wireType === 1) {
      this.pos += 8;
      return;
    }
    if (wireType === 2) {
      this.readBytes();
      return;
    }
    if (wireType === 5) {
      this.pos += 4;
      return;
    }
    throw new Error(`未知 wireType：${wireType}`);
  }
}

interface ProtoField {
  fieldNo: number;
  wireType: number;
}

function readField(reader: ByteReader): ProtoField | null {
  if (reader.eof) {
    return null;
  }
  const tag = reader.readVarint();
  const wireType = Number(tag & 7n);
  const fieldNo = Number(tag >> 3n);
  return { fieldNo, wireType };
}

// ---------- PushFrame / Response / Message 帧 ----------

export interface DouyinPushFrame {
  logId: bigint | null;
  payloadType: string;
  payload: Uint8Array | null;
}

export interface DouyinMessage {
  /** WebcastChatMessage / WebcastLikeMessage / WebcastMemberMessage / WebcastGiftMessage / WebcastSocialMessage 等 */
  method: string;
  payload: Uint8Array | null;
  msgId: bigint | null;
}

export interface DouyinResponse {
  messages: DouyinMessage[];
  internalExt: string;
  needAck: boolean;
}

/** 服务端下行帧：wss 收到一段二进制即一个 PushFrame */
export function decodeDouyinPushFrame(data: Uint8Array): DouyinPushFrame {
  const reader = new ByteReader(data);
  let logId: bigint | null = null;
  let payloadType = '';
  let payload: Uint8Array | null = null;
  for (;;) {
    const field = readField(reader);
    if (!field) {
      break;
    }
    if (field.wireType === 0 && field.fieldNo === 2) {
      logId = reader.readVarint();
    } else if (field.wireType === 2 && field.fieldNo === 7) {
      payloadType = reader.readString();
    } else if (field.wireType === 2 && field.fieldNo === 8) {
      payload = reader.readBytes();
    } else {
      reader.skip(field.wireType);
    }
  }
  return { logId, payloadType, payload };
}

/** 解出 Response：payload 一律按 gzip 处理；解压失败时尝试裸解（个别帧可能未压缩） */
export function decodeDouyinResponse(compressedOrRaw: Uint8Array): DouyinResponse {
  let bytes: Uint8Array;
  try {
    bytes = gunzipSync(compressedOrRaw);
  } catch {
    bytes = compressedOrRaw;
  }
  const reader = new ByteReader(bytes);
  const messages: DouyinMessage[] = [];
  let internalExt = '';
  let needAck = false;
  for (;;) {
    const field = readField(reader);
    if (!field) {
      break;
    }
    if (field.wireType === 2 && field.fieldNo === 1) {
      messages.push(decodeDouyinMessage(reader.readBytes()));
    } else if (field.wireType === 2 && field.fieldNo === 5) {
      internalExt = reader.readString();
    } else if (field.wireType === 0 && field.fieldNo === 9) {
      needAck = reader.readVarint() !== 0n;
    } else {
      reader.skip(field.wireType);
    }
  }
  return { messages, internalExt, needAck };
}

function decodeDouyinMessage(data: Uint8Array): DouyinMessage {
  const reader = new ByteReader(data);
  let method = '';
  let payload: Uint8Array | null = null;
  let msgId: bigint | null = null;
  for (;;) {
    const field = readField(reader);
    if (!field) {
      break;
    }
    if (field.wireType === 2 && field.fieldNo === 1) {
      method = reader.readString();
    } else if (field.wireType === 2 && field.fieldNo === 2) {
      payload = reader.readBytes();
    } else if (field.wireType === 0 && field.fieldNo === 3) {
      msgId = reader.readVarint();
    } else {
      reader.skip(field.wireType);
    }
  }
  return { method, payload, msgId };
}

// ---------- 事件消息体解析（只取昵称 / 内容等业务字段） ----------

export interface DouyinUserLite {
  id: bigint | null;
  nickName: string;
}

export interface DouyinChatLite {
  user: DouyinUserLite;
  content: string;
}

export interface DouyinLikeLite {
  user: DouyinUserLite;
  count: bigint | null;
}

export interface DouyinMemberLite {
  user: DouyinUserLite;
  memberCount: bigint | null;
}

export interface DouyinGiftLite {
  user: DouyinUserLite;
  giftName: string;
  repeatCount: bigint | null;
}

function decodeUserLite(data: Uint8Array): DouyinUserLite {
  const reader = new ByteReader(data);
  let id: bigint | null = null;
  let nickName = '';
  for (;;) {
    const field = readField(reader);
    if (!field) {
      break;
    }
    if (field.wireType === 0 && field.fieldNo === 1) {
      id = reader.readVarint();
    } else if (field.wireType === 2 && field.fieldNo === 3) {
      nickName = reader.readString();
    } else {
      reader.skip(field.wireType);
    }
  }
  return { id, nickName };
}

function decodeWithUser(
  data: Uint8Array,
  userFieldNo: number,
  onExtra: (fieldNo: number, wireType: number, reader: ByteReader) => void,
): DouyinUserLite {
  const reader = new ByteReader(data);
  let user: DouyinUserLite | null = null;
  for (;;) {
    const field = readField(reader);
    if (!field) {
      break;
    }
    if (field.wireType === 2 && field.fieldNo === userFieldNo) {
      user = decodeUserLite(reader.readBytes());
    } else {
      onExtra(field.fieldNo, field.wireType, reader);
    }
  }
  return user ?? { id: null, nickName: '' };
}

function skipByField(_fieldNo: number, wireType: number, _reader: ByteReader): void {
  _reader.skip(wireType);
}

/** WebcastChatMessage：content(3) + user(2) */
export function decodeDouyinChat(data: Uint8Array): DouyinChatLite {
  let content = '';
  const user = decodeWithUser(data, 2, (fieldNo, wireType, reader) => {
    if (fieldNo === 3 && wireType === 2) {
      content = reader.readString();
    } else {
      reader.skip(wireType);
    }
  });
  return { user, content };
}

/** WebcastLikeMessage：count(2) + user(5) */
export function decodeDouyinLike(data: Uint8Array): DouyinLikeLite {
  let count: bigint | null = null;
  const user = decodeWithUser(data, 5, (fieldNo, wireType, reader) => {
    if (fieldNo === 2 && wireType === 0) {
      count = reader.readVarint();
    } else {
      reader.skip(wireType);
    }
  });
  return { user, count };
}

/** WebcastMemberMessage：memberCount(3) + user(2) */
export function decodeDouyinMember(data: Uint8Array): DouyinMemberLite {
  let memberCount: bigint | null = null;
  const user = decodeWithUser(data, 2, (fieldNo, wireType, reader) => {
    if (fieldNo === 3 && wireType === 0) {
      memberCount = reader.readVarint();
    } else {
      reader.skip(wireType);
    }
  });
  return { user, memberCount };
}

/** WebcastGiftMessage：repeatCount(5) + user(7) + gift(15, 内 name=16) */
export function decodeDouyinGift(data: Uint8Array): DouyinGiftLite {
  let giftName = '';
  let repeatCount: bigint | null = null;
  const user = decodeWithUser(data, 7, (fieldNo, wireType, reader) => {
    if (fieldNo === 5 && wireType === 0) {
      repeatCount = reader.readVarint();
    } else if (fieldNo === 15 && wireType === 2) {
      giftName = decodeGiftStructName(reader.readBytes());
    } else {
      reader.skip(wireType);
    }
  });
  return { user, giftName, repeatCount };
}

function decodeGiftStructName(data: Uint8Array): string {
  const reader = new ByteReader(data);
  let name = '';
  let describe = '';
  for (;;) {
    const field = readField(reader);
    if (!field) {
      break;
    }
    if (field.wireType === 2 && field.fieldNo === 16) {
      name = reader.readString();
    } else if (field.wireType === 2 && field.fieldNo === 2) {
      describe = reader.readString();
    } else {
      reader.skip(field.wireType);
    }
  }
  return name || describe;
}

/** WebcastSocialMessage（关注）：user(2)。项目未建模 follow 事件，仅提供取昵称能力供上层忽略 */
export function decodeDouyinSocial(data: Uint8Array): DouyinUserLite {
  return decodeWithUser(data, 2, skipByField);
}

// ---------- 上行控制帧（ack / 心跳） ----------

/** 心跳帧原始字节：PushFrame{ payloadType: "hb" }（protobuf 紧凑编码 = [58,2,104,98]） */
export const DOUYIN_HEARTBEAT_FRAME = Uint8Array.of(0x3a, 0x02, 0x68, 0x62);

/** ack 回执：PushFrame{ logId, payloadType: "ack", payload: internalExt } */
export function buildAckFrame(logId: bigint, internalExt: string): Uint8Array {
  return concatBytes([
    pbTag(2, 0),
    pbVarint(logId),
    pbFieldString(7, 'ack'),
    pbFieldBytes(8, new Uint8Array(Buffer.from(internalExt, 'utf8'))),
  ]);
}

/** 解析 out 侧二进制：文本 base64（data:,base64 或纯 base64）或二进制统一转 Uint8Array */
export function bytesFromWireData(raw: unknown): Uint8Array {
  if (raw instanceof Uint8Array) {
    return raw;
  }
  if (raw instanceof ArrayBuffer) {
    return new Uint8Array(raw);
  }
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(raw)) {
    return new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
  }
  if (Array.isArray(raw)) {
    return Uint8Array.from(raw as number[]);
  }
  if (typeof raw === 'string') {
    const base64 = raw.includes(',') ? raw.slice(raw.indexOf(',') + 1) : raw;
    return new Uint8Array(Buffer.from(base64, 'base64'));
  }
  throw new Error('无法识别的 wss 报文类型');
}
