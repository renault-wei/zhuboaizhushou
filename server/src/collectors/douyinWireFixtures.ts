import { gzipSync } from 'node:zlib';
import { concatBytes, pbFieldBytes, pbFieldString, pbFieldVarint, pbTag, pbVarint } from './douyinWire';

// D2.3 测试报文构造（fixture 用，与 douyinWire 解码共用字段编号保证可回归）。
// 与解码实现分离：生产模块 douyinWire 不携带造数代码，测试侧引用本文件即可。

export function buildUserBytes(id: bigint | number | null, nickName: string): Uint8Array {
  const parts: Uint8Array[] = [];
  if (id !== null && id !== undefined) {
    parts.push(pbFieldVarint(1, id));
  }
  if (nickName) {
    parts.push(pbFieldString(3, nickName));
  }
  return concatBytes(parts);
}

export function buildChatBytes(opts: { userId?: bigint | number; nickName?: string; content: string }): Uint8Array {
  return concatBytes([
    pbFieldBytes(2, buildUserBytes(opts.userId ?? null, opts.nickName ?? '')),
    pbFieldString(3, opts.content),
  ]);
}

export function buildLikeBytes(opts: { userId?: bigint | number; nickName?: string; count?: bigint | number }): Uint8Array {
  const parts: Uint8Array[] = [pbFieldBytes(5, buildUserBytes(opts.userId ?? null, opts.nickName ?? ''))];
  if (opts.count !== undefined) {
    parts.push(pbFieldVarint(2, opts.count));
  }
  return concatBytes(parts);
}

export function buildMemberBytes(opts: { userId?: bigint | number; nickName?: string; memberCount?: bigint | number }): Uint8Array {
  const parts: Uint8Array[] = [pbFieldBytes(2, buildUserBytes(opts.userId ?? null, opts.nickName ?? ''))];
  if (opts.memberCount !== undefined) {
    parts.push(pbFieldVarint(3, opts.memberCount));
  }
  return concatBytes(parts);
}

export function buildGiftBytes(opts: { userId?: bigint | number; nickName?: string; giftName: string; repeatCount?: bigint | number }): Uint8Array {
  const gift = opts.giftName ? pbFieldString(16, opts.giftName) : new Uint8Array();
  const parts: Uint8Array[] = [pbFieldBytes(7, buildUserBytes(opts.userId ?? null, opts.nickName ?? ''))];
  if (opts.repeatCount !== undefined) {
    parts.push(pbFieldVarint(5, opts.repeatCount));
  }
  parts.push(pbFieldBytes(15, gift));
  return concatBytes(parts);
}

export function buildSocialBytes(opts: { userId?: bigint | number; nickName?: string }): Uint8Array {
  return pbFieldBytes(2, buildUserBytes(opts.userId ?? null, opts.nickName ?? ''));
}

export function buildMessageBytes(opts: { method: string; payload: Uint8Array; msgId?: bigint | number }): Uint8Array {
  const parts: Uint8Array[] = [pbFieldString(1, opts.method), pbFieldBytes(2, opts.payload)];
  if (opts.msgId !== undefined) {
    parts.push(pbFieldVarint(3, opts.msgId));
  }
  return concatBytes(parts);
}

export function buildResponseBytes(opts: {
  messages: Uint8Array[];
  internalExt?: string;
  needAck?: boolean;
}): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const message of opts.messages) {
    parts.push(pbFieldBytes(1, message));
  }
  if (opts.internalExt) {
    parts.push(pbFieldString(5, opts.internalExt));
  }
  if (opts.needAck) {
    parts.push(pbFieldVarint(9, 1));
  }
  return concatBytes(parts);
}

/** 组一条完整下行帧（PushFrame + gzip(Response)），供适配器单测推送 */
export function buildPushFrameBytes(opts: {
  logId?: bigint | number;
  response?: Uint8Array;
  compress?: boolean;
}): Uint8Array {
  const parts: Uint8Array[] = [];
  if (opts.logId !== undefined) {
    parts.push(pbTag(2, 0), pbVarint(opts.logId));
  }
  if (opts.response) {
    const payload = opts.compress === false ? opts.response : gzipSync(opts.response);
    parts.push(pbFieldBytes(8, payload));
  }
  return concatBytes(parts);
}
