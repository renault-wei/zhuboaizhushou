import { readFile, unlink } from 'node:fs/promises';
import { createVolcTtsSynth } from '../src/services/volcTTS';

// 火山预制音色目录静默探测：
// - 对一批候选 speaker ID 各合成一句短口播，验证在当前账号 / seed-tts-2.0 资源下是否可用；
// - 用同一句文本在不同 speech_rate 下实测 wav 时长，确认火山语速参数方向与幅度；
// 全程不播放声音（只合成不 rec 到默认设备），临时 wav 播完即删。

const PROBE_TEXT =
  '欢迎来到我们直播间，今天给大家带来一份双人火锅福利套餐，只要九十九元，喜欢的朋友别错过。';

/** 候选火山 2.0 通用音色（推测命名：行星系列，女 vv_ / 男 m19x_） */
const CANDIDATE_SPEAKERS = [
  'zh_female_vv_uranus_bigtts',
  'zh_male_m191_uranus_bigtts',
  'zh_female_vv_mars_bigtts',
  'zh_male_m192_mars_bigtts',
  'zh_female_vv_jupiter_bigtts',
  'zh_male_m193_jupiter_bigtts',
  'zh_female_vv_earth_bigtts',
  'zh_male_m194_earth_bigtts',
  'zh_female_vv_venus_bigtts',
  'zh_male_m195_venus_bigtts',
  'zh_female_vv_saturn_bigtts',
  'zh_male_m196_saturn_bigtts',
  'zh_female_vv_neptune_bigtts',
  'zh_male_m197_neptune_bigtts',
  'zh_female_vv_mercury_bigtts',
  'zh_male_m198_mercury_bigtts',
] as const;

/** 语速方向探针：只对已确认可用的音色做，避免无效调用 */
const RATE_PROBE_SPEAKER = 'zh_female_vv_uranus_bigtts';
const RATE_PROBE_VALUES = [-40, 0, 40] as const;

/** 从 wav 头读取时长（毫秒）：按块扫描定位 data 块，用 fmt 的每秒字节数换算 */
async function wavDurationMs(path: string): Promise<number> {
  const buffer = await readFile(path);
  const byteRate = buffer.readUInt32LE(28);
  let offset = 12;
  let dataSize = 0;
  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    if (chunkId === 'data') {
      dataSize = size;
      break;
    }
    // 块从内容对齐到 2 字节：size 为奇数时补 1
    offset += 8 + size + (size % 2);
  }
  if (byteRate <= 0 || dataSize <= 0) {
    return 0;
  }
  return Math.round((dataSize / byteRate) * 1000);
}

interface ProbeRow {
  speaker: string;
  ok: boolean;
  durationMs: number;
  detail: string;
}

async function synthesize(
  speaker: string,
  speechRate: number,
): Promise<{ wavPath: string; durationMs: number }> {
  const synth = createVolcTtsSynth({ speaker, speechRate });
  const { wavPath } = await synth.synthesize(PROBE_TEXT);
  const durationMs = await wavDurationMs(wavPath);
  return { wavPath, durationMs };
}

async function main(): Promise<void> {
  console.log('语速方向探针（' + RATE_PROBE_SPEAKER + '）：');
  const rateRows: ProbeRow[] = [];
  for (const speechRate of RATE_PROBE_VALUES) {
    try {
      const { wavPath, durationMs } = await synthesize(RATE_PROBE_SPEAKER, speechRate);
      rateRows.push({
        speaker: RATE_PROBE_SPEAKER,
        ok: true,
        durationMs,
        detail: 'speech_rate=' + speechRate,
      });
      await unlink(wavPath).catch(() => undefined);
    } catch (err) {
      rateRows.push({
        speaker: RATE_PROBE_SPEAKER,
        ok: false,
        durationMs: 0,
        detail: 'speech_rate=' + speechRate + ' → ' + (err instanceof Error ? err.message : String(err)),
      });
    }
  }
  for (const row of rateRows) {
    console.log('  ' + (row.ok ? 'OK ' : 'FAIL ') + row.detail + (row.ok ? '，时长 ' + row.durationMs + ' ms' : ''));
  }

  console.log('候选音色目录探测：');
  const rows: ProbeRow[] = [];
  for (const speaker of CANDIDATE_SPEAKERS) {
    try {
      const { wavPath, durationMs } = await synthesize(speaker, 0);
      rows.push({ speaker, ok: true, durationMs, detail: '可用' });
      await unlink(wavPath).catch(() => undefined);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      rows.push({ speaker, ok: false, durationMs: 0, detail: message.slice(0, 120) });
    }
  }
  for (const row of rows) {
    const tag = row.ok ? 'OK  ' : 'FAIL';
    console.log(
      '  [' + tag + '] ' + row.speaker + (row.ok ? '，时长 ' + row.durationMs + ' ms' : '，' + row.detail),
    );
  }
  const okCount = rows.filter((row) => row.ok).length;
  console.log('探测完成：可用 ' + okCount + '/' + rows.length);
}

void main().catch((err: unknown) => {
  console.error('火山音色目录探测失败：' + (err instanceof Error ? err.message : String(err)));
  process.exitCode = 1;
});
