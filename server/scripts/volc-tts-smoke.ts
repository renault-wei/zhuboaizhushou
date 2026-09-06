import { createVoicePlayer } from '../src/services/voicePlayer';
import { createVolcTtsSynth } from '../src/services/volcTTS';

// G5 商用音色真连冒烟（火山引擎 · 豆包语音 TTS）：
// 用 .env 里配置好的 VOLC_TTS_API_KEY 真调火山合成一段口播 → 生成 PCM wav → 播到系统默认播放设备。
// 用途：
// 1. 换商用音色的第一次真连验收：火山侧正常合成（按量计费）+ 播放出声 = 链路通；
// 2. 直播现场把系统默认播放设备设为 VB-Cable（CABLE Input）后重跑，声音会进抖音直播伴侣。
// 注意：这里合成的是火山示例音色（VOLC_TTS_SPEAKER），不是克隆音色；克隆音色在火山控制台创建后改配置即可。

/** 默认冒烟文案：门店口播风格的一句话，方便听清音色与语速 */
const DEFAULT_TEXT =
  '大家好，欢迎来到我们直播间。今天给家人们准备了一份双人火锅福利套餐，只要九十九元，喜欢的朋友抓紧下单哦。';

async function main(): Promise<void> {
  const text = (process.argv[2] ?? DEFAULT_TEXT).trim();
  if (text.length === 0) {
    throw new Error('待合成文案不能为空');
  }

  const synth = createVolcTtsSynth();
  const { wavPath } = await synth.synthesize(text);
  console.log(`火山 TTS 真连成功，已生成可播 wav：${wavPath}`);

  if (process.platform !== 'win32') {
    console.log('非 Windows 平台，跳过出声播放（wav 已保留，可手动试听）');
    return;
  }

  const player = createVoicePlayer();
  const outcome = await player.enqueue(wavPath);
  console.log(`播放完成，结果：${outcome}`);
  if (outcome !== 'played') {
    process.exitCode = 1;
  }
}

void main().catch((err: unknown) => {
  console.error(`火山真连冒烟失败：${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
