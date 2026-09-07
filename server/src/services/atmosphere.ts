// 氛围台词库（M4.5）：竞品「氛围语」的合规复刻 —— 循环播报空档自动插播的暖场短句。
// 本模块只放「纯函数 + 白名单」：类别枚举、长度上限、{昵称} 占位渲染，供路由入库与循环引擎复用。
// 合规红线：所有文本在落库前由路由调用 scanSensitive 扫描，命中 400 不落库；本模块不做任何旁路。

/** 氛围台词类别（宽松存储，未知类别路由直接拒绝） */
export const ATMOSPHERE_CATEGORIES = [
  'welcome', // 欢迎
  'follow', // 关注引导
  'thumb', // 点赞互动
  'clock', // 整点报时
  'custom', // 自定义暖场
] as const;

export type AtmosphereCategory = (typeof ATMOSPHERE_CATEGORIES)[number];

/** 单条氛围台词文本上限：短句不宜过长，沿用台本单条口径 */
export const MAX_ATMOSPHERE_TEXT_LENGTH = 200;

/** 昵称占位符：模板文本可写「欢迎{昵称}来到直播间」，播报时替换 */
export const NICKNAME_PLACEHOLDER = '{昵称}';

/** 无昵称上下文（定时插播）时的占位兜底：直接留空，避免念出占位符 */
const DEFAULT_NICKNAME_FALLBACK = '';

export function isAtmosphereCategory(value: unknown): value is AtmosphereCategory {
  return (
    typeof value === 'string' && (ATMOSPHERE_CATEGORIES as readonly string[]).includes(value)
  );
}

/**
 * 渲染一条氛围台词：把 {昵称} 占位替换成给定昵称。
 * 无昵称（定时插播等场景）时替换为空，避免直接念出花括号占位。
 */
export function renderAtmosphereText(text: string, nickname: string | null): string {
  if (!text.includes(NICKNAME_PLACEHOLDER)) {
    return text;
  }
  const replacement = nickname ?? DEFAULT_NICKNAME_FALLBACK;
  return text.split(NICKNAME_PLACEHOLDER).join(replacement);
}
