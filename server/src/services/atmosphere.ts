// 氛围台词库（M4.5 立项 → M10 落地）：竞品「氛围语」的合规复刻 —— 循环播报空档自动插播的暖场短句。
// 本模块只放「纯函数 + 常量」：类别枚举、长度上限、频率档位规则、默认模板、占位渲染与插播优先级，
// 供路由入库校验（routes/atmosphereTemplates.ts）与空档插播调度（services/atmosphereScheduler.ts）复用。
// 合规红线：所有文本在落库前由路由调用 scanSensitive 扫描，命中 400 不落库；本模块不做任何旁路。
// 口径见 docs/ATMOSPHERE-INTERACTION-PLAN.md。

/** 氛围台词类别（宽松存储，未知类别路由直接拒绝） */
export const ATMOSPHERE_CATEGORIES = [
  'welcome', // 欢迎
  'follow', // 关注引导
  'thumb', // 点赞互动
  'clock', // 整点报时
  'custom', // 自定义暖场
] as const;

export type AtmosphereCategory = (typeof ATMOSPHERE_CATEGORIES)[number];

/** 单条模板文本上限（可多行，一行 = 一条候选句）：沿用竞品 500 字口径 */
export const MAX_ATMOSPHERE_TEXT_LENGTH = 500;

/** 渲染上下文变量（模板里写成 [昵称] 形式） */
export const ATMOSPHERE_PLACEHOLDERS = ['昵称', '问题', '答案', '时间', '在线人数'] as const;

export type AtmospherePlaceholder = (typeof ATMOSPHERE_PLACEHOLDERS)[number];

/** 历史别名：仓库早期口径用 {昵称}，保留兼容（等价于 [昵称]） */
export const LEGACY_NICKNAME_PLACEHOLDER = '{昵称}';

/** 无值占位（定时插播没有昵称/在线人数）时的取值规则：不渲染，直接判定该行不可用 */
export interface AtmosphereRenderContext {
  nickname?: string | null;
  question?: string | null;
  answer?: string | null;
  /** 插播时刻（毫秒时间戳）：用于 [时间] 渲染，缺省视为该行不可用 */
  nowMs?: number | null;
  onlineCount?: number | null;
}

/** 一条待插播的氛围台词（调度器产出，循环引擎负责出声） */
export interface AtmosphereInsertion {
  category: AtmosphereCategory;
  text: string;
}

/** 频率档位规则：默认值 + 自定义范围（秒） */
export interface AtmosphereFrequencyRule {
  defaultSeconds: number;
  minSeconds: number;
  maxSeconds: number;
}

/**
 * 五类氛围语的插播间隔规则（docs/ATMOSPHERE-INTERACTION-PLAN.md §3）。
 * 欢迎/关注/点赞沿用竞品默认 60s；报时有意偏离竞品默认 60s（过密会与台本节奏打架，取 3 分钟）。
 */
export const ATMOSPHERE_FREQUENCY_RULES: Record<AtmosphereCategory, AtmosphereFrequencyRule> = {
  welcome: { defaultSeconds: 60, minSeconds: 1, maxSeconds: 300 },
  follow: { defaultSeconds: 60, minSeconds: 1, maxSeconds: 300 },
  thumb: { defaultSeconds: 60, minSeconds: 1, maxSeconds: 300 },
  clock: { defaultSeconds: 180, minSeconds: 60, maxSeconds: 3000 },
  custom: { defaultSeconds: 300, minSeconds: 1, maxSeconds: 3000 },
};

/** 频率取值：0 = 该类不插播（竞品「不回复」等价项） */
export const ATMOSPHERE_FREQUENCY_DISABLED_SECONDS = 0;

/**
 * 空档插播扫描顺序：先命中先插。
 * 完整优先级 = 弹幕回复 > 欢迎/关注/点赞 > 报时 > 自定义暖场 > 循环台本句；
 * 弹幕回复更高由出声链路「忙则让位」天然保证（见 services/loopCaster.ts）。
 */
export const ATMOSPHERE_INSERT_PRIORITY: readonly AtmosphereCategory[] = [
  'welcome',
  'follow',
  'thumb',
  'clock',
  'custom',
];

/**
 * 五类默认模板（A4 一键填充用）：多行 = 多条候选句，`{A|B|C}` = 随机词。
 * 每类都含至少一条**不含 [昵称]** 的候选行 —— 采集器（B1）到位前，定时插播只能走这条，
 * 保证「开箱即有暖场声」而不是因占位符取不到值整类静音。
 */
export const ATMOSPHERE_DEFAULT_TEMPLATES: Record<AtmosphereCategory, string> = {
  welcome: [
    '欢迎[昵称]来到直播间～',
    '[昵称]来啦，欢迎欢迎，咱们的团购套餐可以看看哦',
    '欢迎新来的朋友，点点关注不迷路～',
  ].join('\n'),
  follow: [
    '感谢[昵称]的关注～',
    '谢谢[昵称]点亮关注，福利随时在直播间哦',
    '新关注的朋友记得看看咱们的团购套餐，到店直接能用～',
  ].join('\n'),
  thumb: [
    '感谢[昵称]的点赞支持～',
    '谢谢[昵称]点赞，手速真快',
    '点赞收到啦，谢谢支持，我们继续介绍套餐～',
  ].join('\n'),
  clock: [
    '现在是[时间]，还在看的朋友扣个 1，我们继续介绍套餐',
    '[时间]啦，咱们的团购券还在直播间，随时可以下单',
  ].join('\n'),
  custom: [
    '咱们的团购套餐分量足、出餐快，感兴趣的朋友可以看看详情',
    '有想问的问题直接打在公屏上，我来给大家解答',
    '团购券下单后到店扫码就能用，有效期长，用不完可以退',
  ].join('\n'),
};

/** 随机词占位：{A|B|C}（至少一个竖线才视为随机词） */
const ALTERNATIVE_PATTERN = /\{([^{}]*\|[^{}]*)\}/g;

export function isAtmosphereCategory(value: unknown): value is AtmosphereCategory {
  return (
    typeof value === 'string' && (ATMOSPHERE_CATEGORIES as readonly string[]).includes(value)
  );
}

/** 频率是否合法：0（不插播）或落在该类别的自定义范围内（整数秒） */
export function isValidAtmosphereInterval(category: AtmosphereCategory, seconds: unknown): boolean {
  if (typeof seconds !== 'number' || !Number.isInteger(seconds)) {
    return false;
  }
  if (seconds === ATMOSPHERE_FREQUENCY_DISABLED_SECONDS) {
    return true;
  }
  const rule = ATMOSPHERE_FREQUENCY_RULES[category];
  return seconds >= rule.minSeconds && seconds <= rule.maxSeconds;
}

/** 多行模板 → 候选行数组：逐行 trim、丢空行，保留顺序 */
export function splitAtmosphereLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** 时刻格式化为本地 HH:mm（报时语用） */
export function formatClockTime(nowMs: number): string {
  const date = new Date(nowMs);
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
}

/** 取占位符值：取不到（undefined/null/空串）返回 null，表示该行不可用 */
function resolvePlaceholder(
  placeholder: AtmospherePlaceholder,
  context: AtmosphereRenderContext,
): string | null {
  switch (placeholder) {
    case '昵称':
      return normalizeValue(context.nickname);
    case '问题':
      return normalizeValue(context.question);
    case '答案':
      return normalizeValue(context.answer);
    case '时间':
      return typeof context.nowMs === 'number' ? formatClockTime(context.nowMs) : null;
    case '在线人数':
      return typeof context.onlineCount === 'number' && context.onlineCount > 0
        ? String(context.onlineCount)
        : null;
    default:
      return null;
  }
}

function normalizeValue(value: string | null | undefined): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * 渲染单行模板：先替换 {A|B|C} 随机词，再替换占位符。
 * 任一占位符取不到值 → 返回 null（该行不可用），避免把「[昵称]」直接念出来。
 */
export function renderAtmosphereLine(
  line: string,
  context: AtmosphereRenderContext,
  random: () => number = Math.random,
): string | null {
  let rendered = line.replace(ALTERNATIVE_PATTERN, (_match, body: string) => {
    const options = body
      .split('|')
      .map((option) => option.trim())
      .filter((option) => option.length > 0);
    if (options.length === 0) {
      return '';
    }
    const index = Math.min(options.length - 1, Math.floor(random() * options.length));
    return options[index] ?? '';
  });

  for (const placeholder of ATMOSPHERE_PLACEHOLDERS) {
    const token = `[${placeholder}]`;
    const legacyTokens =
      placeholder === '昵称' ? [token, LEGACY_NICKNAME_PLACEHOLDER] : [token];
    const hit = legacyTokens.some((candidate) => rendered.includes(candidate));
    if (!hit) {
      continue;
    }
    const value = resolvePlaceholder(placeholder, context);
    if (value === null) {
      return null;
    }
    for (const candidate of legacyTokens) {
      rendered = rendered.split(candidate).join(value);
    }
  }

  const trimmed = rendered.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * 从多行模板里随机挑一行并渲染：随机起点起顺序扫描，跳过不可用行（占位符取不到值）。
 * 全部不可用（或模板为空）→ 返回 null，调用方本次不插播。
 */
export function pickAtmosphereText(
  text: string,
  context: AtmosphereRenderContext,
  random: () => number = Math.random,
): string | null {
  const lines = splitAtmosphereLines(text);
  if (lines.length === 0) {
    return null;
  }
  const start = Math.min(lines.length - 1, Math.floor(random() * lines.length));
  for (let offset = 0; offset < lines.length; offset += 1) {
    const line = lines[(start + offset) % lines.length];
    if (line === undefined) {
      continue;
    }
    const rendered = renderAtmosphereLine(line, context, random);
    if (rendered !== null) {
      return rendered;
    }
  }
  return null;
}
