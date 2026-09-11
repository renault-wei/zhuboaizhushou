import { eq } from 'drizzle-orm';
import { db } from '../db/client';
import { lives as livesTable } from '../db/schema';
import type { SpeechOverrides } from './liveSpeaker';
import { findVolcPreset } from './volcPresets';

// 档 A 场次音色解析：把 lives 上绑定的音色与语速翻译成合成器的「单次音色覆盖项」。
// - 预设音色（volcPresetId）：命中内置白名单才生效，实际改变 TTS 发音人；
// - 克隆音色（voiceId）：声音复刻尚未接入（档 B），此处不产出覆盖项、回落默认音色，
//   避免「选了克隆音色反而无声」；接入后在这里补 provider 音色映射即可，调用方不动。
// - 语速（speechRate）：商家滑块档，火山 speech_rate 口径 0~60（0 = 正常语速），默认 15。
// 读取时机：开播 / 单场只读一次（与 loopCaster 台本快照同口径），开播后改库不影响本场。

/** 商家语速滑块下沿：0 = 正常语速（火山口径），低于该档一律钳回 */
export const MIN_LIVE_SPEECH_RATE = 0;
/** 商家语速滑块上沿：60 ≈ 1.6 倍速（再快就脱离真人节奏，产品不放开） */
export const MAX_LIVE_SPEECH_RATE = 60;
/** 场次未设语速时的默认档：15 ≈ 1.15 倍速（真机实测「略快于真人、不赶」的带货节奏） */
export const DEFAULT_LIVE_SPEECH_RATE = 15;

/** 语速归一：非有限数字回落默认档，其余就近取整并钳到滑块区间 */
export function clampLiveSpeechRate(rate: number | null | undefined): number {
  if (rate === null || rate === undefined || !Number.isFinite(rate)) {
    return DEFAULT_LIVE_SPEECH_RATE;
  }
  return Math.min(MAX_LIVE_SPEECH_RATE, Math.max(MIN_LIVE_SPEECH_RATE, Math.round(rate)));
}

/**
 * 场次音色 + 语速 → 合成覆盖项（恒非空）。
 * 语速一律下发滑块档（含默认档 15）；speaker 仅在预设 id 命中白名单时下发，
 * 其余情况（空 id / 克隆音色 / 未知脏 id）回落合成器默认音色，不影响出声。
 */
export function presetSpeechOverrides(
  presetId: string | null | undefined,
  speechRate?: number | null,
): SpeechOverrides {
  const overrides: SpeechOverrides = { speechRate: clampLiveSpeechRate(speechRate) };
  if (!presetId) {
    return overrides;
  }
  if (!findVolcPreset(presetId)) {
    console.warn(`[liveVoice] 未知预设音色 ${presetId}，本场回落默认音色`);
    return overrides;
  }
  overrides.speaker = presetId;
  return overrides;
}

/**
 * 读场次绑定的音色与语速并解析为合成覆盖项。
 * 场次不存在 → null（调用方回落合成器默认；不开播的场次本就无出声链路）。
 */
export async function loadLiveSpeechOverrides(
  liveId: string,
): Promise<SpeechOverrides | null> {
  const rows = await db
    .select({ volcPresetId: livesTable.volcPresetId, speechRate: livesTable.speechRate })
    .from(livesTable)
    .where(eq(livesTable.id, liveId))
    .limit(1);
  const row = rows[0];
  if (!row) {
    return null;
  }
  return presetSpeechOverrides(row.volcPresetId, row.speechRate);
}
