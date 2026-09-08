import 'dotenv/config';
import { createDouyinHttpSigner } from '../src/collectors/douyinLiveAdapter';

// 抖音 wss 签名最小探针（D2.3/D2.5 · 官方 Key 验收）：用 .env 自备的
// DOUYIN_SIGN_ENDPOINT_URL / DOUYIN_SIGN_API_KEY 真调第三方签名接口一次，把抖音 web 房间号
// 换成可直连的抖音 im wss 地址。只做签名、不建立 wss 连接；失败会输出服务端返回，便于
// 区分「Key 未授权 / 房间非法 / 服务异常」。仅手动运行（npm run sign:smoke -- <房间号> [userUniqueId]），
// 不得进入自动化测试套件（会消耗第三方试用额度）。

function maskWssUrl(url: string): string {
  if (url.length <= 40) {
    return '<wss 地址异常偏短，已隐藏>';
  }
  return `${url.slice(0, 60)}…（总长 ${url.length}，连接参数已隐藏）`;
}

async function main(): Promise<void> {
  const endpointUrl = process.env.DOUYIN_SIGN_ENDPOINT_URL;
  const apiKey = process.env.DOUYIN_SIGN_API_KEY;
  if (!endpointUrl || !apiKey) {
    throw new Error('缺少 DOUYIN_SIGN_ENDPOINT_URL / DOUYIN_SIGN_API_KEY，请复制 .env.example 后在 .env 填写');
  }
  const roomId = process.argv[2];
  if (!roomId) {
    throw new Error('缺少房间号参数：npm run sign:smoke -- <抖音 web 房间号>');
  }
  const userUniqueId = process.argv[3] ?? undefined;
  const signer = createDouyinHttpSigner({ endpointUrl, apiKey, userUniqueId });
  const startedAt = Date.now();
  const wssUrl = await signer.signWssUrl(roomId);
  console.log(`签名成功（耗时 ${Date.now() - startedAt}ms，roomId=${roomId}）：${maskWssUrl(wssUrl)}`);
}

void main().catch((err: unknown) => {
  console.error(`签名探针失败：${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
