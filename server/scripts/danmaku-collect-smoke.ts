import 'dotenv/config';
import { createCollectorManager } from '../src/collectors/collectorManager';
import { createDouyinHttpSigner, createDouyinLiveAdapter } from '../src/collectors/douyinLiveAdapter';
import { createLinkResolver } from '../src/collectors/linkResolver';
import { createHttpShortLinkExpander } from '../src/collectors/shortLinkExpander';

// 真实弹幕采集探针（R5 验收用）：贴一段抖音分享文本 → 解析房间 → 签名 → 真连 wss → 打印收到的弹幕。
// 仅手动运行（npm run collect:smoke -- "<分享文本或链接>" [监听秒数]）：
// 它会真实连接抖音 wss 并消耗第三方签名额度，**不得进入自动化测试套件**。
//
// 合规：以观众身份连接公开网页端，仅用于自有直播间低流量自测（见 docs/DANMAKU-COLLECTOR-PLAN.md §7）。

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const seconds = Number(args[args.length - 1]);
  const hasSeconds = Number.isFinite(seconds) && seconds > 0 && args.length > 1;
  const shareText = (hasSeconds ? args.slice(0, -1) : args).join(' ').trim();
  if (!shareText) {
    throw new Error('用法：npm run collect:smoke -- "<抖音分享文本或链接>" [监听秒数]');
  }
  const listenSeconds = hasSeconds ? seconds : 30;

  const resolver = createLinkResolver({ expandShortLink: createHttpShortLinkExpander() });
  const resolved = await resolver.resolveShareText(shareText);
  if (!resolved.ok) {
    throw new Error(`链接解析失败（${resolved.code}）：${resolved.reason}`);
  }
  console.log(`① 解析成功：platform=${resolved.room.platform} roomRef=${resolved.room.roomRef}`);

  const endpointUrl = process.env.DOUYIN_SIGN_ENDPOINT_URL ?? '';
  const apiKey = process.env.DOUYIN_SIGN_API_KEY ?? '';
  const userUniqueId = process.env.DOUYIN_SIGN_USER_UNIQUE_ID ?? '';
  if (!apiKey) {
    throw new Error('缺少 DOUYIN_SIGN_API_KEY（复制 .env.example 后填写）');
  }
  console.log(`② 签名身份：UserUniqueId=${userUniqueId || '(空)'}`);

  const signer = createDouyinHttpSigner({ endpointUrl, apiKey, userUniqueId });
  const wssUrl = await signer.signWssUrl(resolved.room.roomRef);
  console.log(`③ 签名成功：${wssUrl.slice(0, 90)}…（总长 ${wssUrl.length}）`);

  let eventCount = 0;
  const adapter = createDouyinLiveAdapter({ signer });
  const manager = createCollectorManager({
    adapters: [adapter],
    onEvent: (event) => {
      eventCount += 1;
      const nick = event.senderNickname ?? '-';
      const body = event.content ?? '';
      console.log(`   [${eventCount}] ${event.msgType.padEnd(6)} | ${nick} | ${body}`);
    },
  });

  const cookie = resolved.room.connectHints?.cookie;
  console.log(`③.5 连接 Cookie：${cookie ? cookie.slice(0, 40) + '…' : '(未取到 —— 抖音 wss 握手会失败)'}`);

  const started = await manager.startWatching({
    source: 'douyin',
    platform: 'douyin',
    roomRef: resolved.room.roomRef,
    liveId: null,
    // 抖音 wss 必须带 ttwid（2026-09-16 实测：不带时握手被回 HTTP 200 而非 101）
    ...(cookie ? { headers: { Cookie: cookie } } : {}),
  });
  if (!started.ok) {
    throw new Error(`启动采集失败（${started.code}）：${started.reason}`);
  }
  console.log(`④ 已开始监听 ${listenSeconds}s（会话 ${started.summary.key}）…`);

  await new Promise((resolve) => setTimeout(resolve, listenSeconds * 1000));

  const status = manager.status();
  console.log('⑤ 结束。最终状态：');
  console.log(JSON.stringify(status.active[0] ?? status.history[0] ?? null, null, 2));
  console.log(`   共收到 ${eventCount} 条事件`);
  if (eventCount === 0) {
    console.log('   ⚠️ 一条都没收到：见上方 lastError / 心跳状态，或该直播间当前确实没人发言。');
  }
  await manager.dispose();
}

void main().catch((err: unknown) => {
  console.error(`采集探针失败：${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
