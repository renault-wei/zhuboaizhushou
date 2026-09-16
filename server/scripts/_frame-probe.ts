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
      if (response.needAck && frame.logId !== null && frame.logId !== undefined && response.internalExt) {
        ws.send(buildAckFrame(frame.logId, response.internalExt));
      }
      totalMessages += response.messages.length;
      if (response.messages.length > 0) {
        console.log(
          '    → 解出 ' +
            response.messages.length +
            ' 条：' +
            response.messages.map((m) => m.method).join(', '),
        );
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
  console.log('\n统计：原始帧 ' + frames + ' ｜ 带负载帧 ' + payloadFrames + ' ｜ 解出消息 ' + totalMessages);
  ws.close();
}

void main().catch((err: unknown) => {
  console.error('探针失败：' + (err instanceof Error ? err.message : String(err)));
  process.exitCode = 1;
});
