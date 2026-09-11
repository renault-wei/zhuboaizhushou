import { eq } from 'drizzle-orm';
import { db } from '../db/client';
import { lives as livesTable } from '../db/schema';
import type { SpeechOverrides } from './liveSpeaker';
import { findVolcPreset } from './volcPresets';

// 档 A 场次音色解析：把 lives 上绑定的音色与语速翻译成合成器的「单次音色覆盖项」。
// - 预设音色（volcPresetId）：命中内置白名单才生效，实际改变 TTS 发音人；
// - 克隆音色（voiceId）：声音复刻尚未接入（档 B），此处不产出覆盖项、回落默认音色，
//   避免「选了克隆音色反而无声」；接入后在这里补 provider 音色映射即可，调用方不动。
// - 语速（speechRate）：商家滑块档，火山 speech_rate 口径 -20~60（0 = 正常语速，负值更慢），默认 -10。
// 读取时机：开播 / 单场只读一次（与 loopCaster 台本快照同口径），开播后改库不影响本场。

/** 商家语速滑块下沿：-20 ≈ 比真人略慢（再慢就显得拖沓，产品不放开） */
export const MIN_LIVE_SPEECH_RATE = -20;
/** 商家语速滑块上沿：60 ≈ 1.6 倍速（再快就脱离真人节奏，产品不放开） */
export const MAX_LIVE_SPEECH_RATE = 60;
/** 场次未设语速时的默认档：-10 ≈ 4.7 字/秒（真机复听：原默认 15 档 6.1 字/秒偏快，下调后接近真人主播节奏） */
export const DEFAULT_LIVE_SPEECH_RATE = -10;

/** 语速归一：非有限数字回落默认档，其余就近取整并钳到滑块区间 */
export function clampLiveSpeechRate(rate: number | null | undefined): number {
  if (rate === null || rate === undefined || !Number.isFinite(rate)) {
    return DEFAULT_LIVE_SPEECH_RATE;
  }
  return Math.min(MAX_LIVE_SPEECH_RATE, Math.max(MIN_LIVE_SPEECH_RATE, Math.round(rate)));
}

/**
 * 场次音色 + 语速 → 合成覆盖项（恒非空）。
 * 语速一律下发滑块档（含默认档 -10）；speaker 仅在预设 id 命中白名单时下发，
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

// ---------- 场次音色快照（开播冻结）----------

/**
 * 场次音色快照表：开播时抓一次，循环口播与弹幕回复共用同一份。
 * 背景：循环句读「开播快照」而弹幕回复曾按条读库实时值，同一场若中途改库会出现两种音色；
 * 统一到快照后，本场音色只由开播那一刻决定，与文件头注释口径一致。
 * 内存态：进程重启即清空（重启后直播本就不恢复），不会跨场次串读数。
 */
const liveSpeechSnapshots = new Map<string, SpeechOverrides | null>();

/** 开播抓快照：读库失败回落 null（= 合成器默认音色），不阻断开播 */
export async function captureLiveSpeech(
  liveId: string,
): Promise<SpeechOverrides | null> {
  let snapshot: SpeechOverrides | null = null;
  try {
    snapshot = await loadLiveSpeechOverrides(liveId);
  } catch (err) {
    console.warn(
      `[liveVoice] 场次 ${liveId} 音色快照读取失败，本场回落默认音色：${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  liveSpeechSnapshots.set(liveId, snapshot);
  return snapshot;
}

/** 取本场音色快照：未抓过（进程重启后补入的场次）就地抓一次并缓存，保证同场只读一次 */
export async function getLiveSpeech(
  liveId: string,
): Promise<SpeechOverrides | null> {
  if (liveSpeechSnapshots.has(liveId)) {
    return liveSpeechSnapshots.get(liveId) ?? null;
  }
  return captureLiveSpeech(liveId);
}

/** 结束直播 / 场次清理：丢弃快照，避免内存滞留（下次开播重新抓） */
export function forgetLiveSpeech(liveId: string): void {
  liveSpeechSnapshots.delete(liveId);
}
