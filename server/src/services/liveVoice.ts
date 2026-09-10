import { eq } from 'drizzle-orm';
import { db } from '../db/client';
import { lives as livesTable } from '../db/schema';
import type { SpeechOverrides } from './liveSpeaker';
import { findVolcPreset } from './volcPresets';

// 档 A 场次音色解析：把 lives 上绑定的音色翻译成合成器的「单次音色覆盖项」。
// - 预设音色（volcPresetId）：命中内置白名单才生效，实际改变 TTS 发音人；
// - 克隆音色（voiceId）：声音复刻尚未接入（档 B），此处不产出覆盖项、回落默认音色，
//   避免「选了克隆音色反而无声」；接入后在这里补 provider 音色映射即可，调用方不动。
// 读取时机：开播 / 单场只读一次（与 loopCaster 台本快照同口径），开播后改库不影响本场。

/** 预设音色 id → 合成覆盖项；id 缺失或不在白名单时返回 null（回落默认音色） */
export function presetSpeechOverrides(
  presetId: string | null | undefined,
): SpeechOverrides | null {
  if (!presetId) {
    return null;
  }
  if (!findVolcPreset(presetId)) {
    console.warn(`[liveVoice] 未知预设音色 ${presetId}，本场回落默认音色`);
    return null;
  }
  return { speaker: presetId };
}

/**
 * 读场次绑定的音色并解析为合成覆盖项。
 * 场次不存在 / 未绑定 / 伪 id → null（调用方回落合成器默认音色，不打断出声链路）。
 */
export async function loadLiveSpeechOverrides(
  liveId: string,
): Promise<SpeechOverrides | null> {
  const rows = await db
    .select({ volcPresetId: livesTable.volcPresetId })
    .from(livesTable)
    .where(eq(livesTable.id, liveId))
    .limit(1);
  return presetSpeechOverrides(rows[0]?.volcPresetId ?? null);
}
