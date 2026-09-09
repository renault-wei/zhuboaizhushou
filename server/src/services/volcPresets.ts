// ---------- 火山预设音色目录（只读内置常量，不调火山接口）----------

/** 预设音色条目：id 即火山发音人 ID（TTS speaker 参数），name 为客户端展示名 */
export interface VolcPresetVoice {
  id: string;
  name: string;
  /** 音色分组：female 女声 / male 男声（客户端按组展示） */
  gender: 'female' | 'male';
}

/**
 * 可用预设：仅收录经火山语音合成大模型 2.0 实测可用的两个音色
 * （候选 16 个里其余资源 ID 不匹配，列入会合成失败，故不展示）。
 */
export const VOLC_PRESET_VOICES: VolcPresetVoice[] = [
  { id: 'zh_female_vv_uranus_bigtts', name: 'Vivi 2.0', gender: 'female' },
  { id: 'zh_male_m191_uranus_bigtts', name: '云舟 2.0', gender: 'male' },
];

/** 判断是否为内置火山预设音色 id（服务端写入前的白名单校验） */
export function isVolcPresetId(id: string): boolean {
  return VOLC_PRESET_VOICES.some((preset) => preset.id === id);
}
