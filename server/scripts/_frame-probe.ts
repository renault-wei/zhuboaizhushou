import 'dotenv/config';
import WebSocket from 'ws';
import { createDouyinHttpSigner } from '../src/collectors/douyinLiveAdapter';
import { createLinkResolver } from '../src/collectors/linkResolver';
import { createHttpShortLinkExpander } from '../src/collectors/shortLinkExpander';
import {
  DOUYIN_HEARTBEAT_FRAME,
  buildAckFrame,
  bytesFromWireData,
  decodeDouyinPushFrame,
  decodeDouyinResponse,
} from '../src/collectors/douyinWire';

// 临时诊断：连上之后把每一帧的原始信息打出来，区分「没人发言」与「帧收不到 / 解不出」。

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

async function main(): Promise<void> {
  const shareUrl = process.argv[2];
  const seconds = Number(process.argv[3] ?? 40);
  if (!shareUrl) {
    throw new Error('用法：tsx scripts/_frame-probe.ts <分享链接> [秒数]');
  }

  const resolver = createLinkResolver({ expandShortLink: createHttpShortLinkExpander() });
  const resolved = await resolver.resolveShareText(shareUrl);
  if (!resolved.ok) {
    throw new Error('解析失败：' + resolved.reason);
  }
  const cookie = resolved.room.connectHints?.cookie;
  console.log('房间号 ' + resolved.room.roomRef + ' | ttwid ' + (cookie ? '已取到' : '未取到'));

  const signer = createDouyinHttpSigner({
    endpointUrl: process.env.DOUYIN_SIGN_ENDPOINT_URL ?? '',
    apiKey: process.env.DOUYIN_SIGN_API_KEY ?? '',
    userUniqueId: process.env.DOUYIN_SIGN_USER_UNIQUE_ID ?? '',
  });
  const wssUrl = await signer.signWssUrl(resolved.room.roomRef);

  const ws = new WebSocket(wssUrl, {
    headers: { 'User-Agent': UA, ...(cookie ? { Cookie: cookie } : {}) },
    perMessageDeflate: false,
  });

  let frames = 0;
  let payloadFrames = 0;
  let totalMessages = 0;
  let needAckFrames = 0;
  let acksSent = 0;
  const methodCensus = new Map<string, number>();

  ws.on('open', () => {
    console.log('✅ 101 已连接，发首帧心跳');
    ws.send(DOUYIN_HEARTBEAT_FRAME);
  });

  ws.on('message', (raw: unknown) => {
    frames += 1;
    try {
      const bytes = bytesFromWireData(raw);
      const frame = decodeDouyinPushFrame(bytes);
      if (frames <= 10) {
        console.log(
          '  帧#' +
            frames +
            ' len=' +
            bytes.length +
            ' keys=' +
            Object.keys(frame as object).join(',') +
            ' payloadLen=' +
            (frame.payload ? frame.payload.length : 0),
        );
      }
      if (!frame.payload || frame.payload.length === 0) {
        return;
      }
      payloadFrames += 1;
      const response = decodeDouyinResponse(frame.payload);
      if (response.needAck) {
        needAckFrames += 1;
        const hasLogId = frame.logId !== null && frame.logId !== undefined;
        if (hasLogId && response.internalExt) {
          ws.send(buildAckFrame(frame.logId, response.internalExt));
          acksSent += 1;
        } else if (needAckFrames <= 3) {
          console.log(
            '   ⚠️ 声明 needAck 但无法回 ack：logId=' +
              String(frame.logId) +
              ' internalExt=' +
              (response.internalExt ? '有' : '空'),
          );
        }
      }
      totalMessages += response.messages.length;
      for (const msg of response.messages) {
        methodCensus.set(msg.method, (methodCensus.get(msg.method) ?? 0) + 1);
      }
      const interesting = response.messages.filter(
        (m) => !/BackupSEIMessage|RoomStreamAdaptation/.test(m.method),
      );
      if (interesting.length > 0) {
        console.log('    → ' + interesting.map((m) => m.method).join(', '));
      }
    } catch (err) {
      console.log('   ⚠️ 帧解析失败：' + (err instanceof Error ? err.message : String(err)));
    }
  });

  ws.on('error', (err) => console.log('❌ error: ' + (err instanceof Error ? err.message : String(err))));
  ws.on('close', (code) => console.log('连接关闭 code=' + String(code)));

  const hb = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(DOUYIN_HEARTBEAT_FRAME);
    }
  }, 5000);

  await new Promise((r) => setTimeout(r, seconds * 1000));
  clearInterval(hb);
  console.log(
    '\n统计：原始帧 ' + frames + ' ｜ 带负载帧 ' + payloadFrames + ' ｜ 解出消息 ' + totalMessages,
  );
  console.log('ack：needAck 帧 ' + needAckFrames + ' ｜ 已回 ack ' + acksSent);
  console.log('方法普查：');
  for (const [name, count] of [...methodCensus.entries()].sort((a, b) => b[1] - a[1])) {
    console.log('  ' + String(count).padStart(5) + '  ' + name);
  }
  const chats = [...methodCensus.keys()].filter((k) => /ChatMessage/.test(k));
  console.log('含 Chat 的方法：' + (chats.length > 0 ? chats.join(', ') : '（无）'));
  ws.close();
}

void main().catch((err: unknown) => {
  console.error('探针失败：' + (err instanceof Error ? err.message : String(err)));
  process.exitCode = 1;
});
