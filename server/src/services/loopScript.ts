import { env } from '../config/env';
import { SENSITIVE_GUARD_PROMPT } from './sensitive';

// ---------- 常量与对外类型 ----------

// 台本条目数与单条字数口径（与 docs/LOOP-BROADCAST-PLAN.md §3.2 对齐）：
// 默认生成 6 条；每条 15-80 字（AI 生成口径，代码只保上限）；上限 12 条 / 单条 200 字。
export const MIN_LOOP_ITEMS = 1;
export const MAX_LOOP_ITEMS = 12;
export const DEFAULT_LOOP_ITEM_COUNT = 6;
export const MAX_LOOP_ITEM_TEXT_LENGTH = 200;

/** 合法段落类型（宽松存储：未知类型一律按 null 落库） */
export const LOOP_ITEM_KINDS = [
  'opening',
  'product',
  'coupon',
  'warmup',
  'closing',
  'custom',
] as const;
export type LoopItemKind = (typeof LOOP_ITEM_KINDS)[number];

/** 单条台本（对外 JSON 形状：kind / gapAfterSeconds 可空） */
export interface LoopItemDraft {
  kind: LoopItemKind | null;
  text: string;
  gapAfterSeconds: number | null;
}

export type LoopScriptErrorCode = 'GENERATION_FAILED';

/** DeepSeek 台本生成业务错误：由路由层翻译成 HTTP 状态（502） */
export class LoopScriptError extends Error {
  readonly code: LoopScriptErrorCode;

  constructor(code: LoopScriptErrorCode, message: string) {
    super(message);
    this.name = 'LoopScriptError';
    this.code = code;
  }
}

/** 生成入参：素材全部来自路由已校验的 ready+pass 来源话术 */
export interface GenerateLoopItemsInput {
  industry: string;
  /** 来源话术的商品快照（客观口径，不得编造新信息） */
  product: Record<string, string>;
  /** 来源话术全文（ready+pass，路由已校验） */
  sourceContent: string;
  /** 可选的团购券展示文案：有才允许生成 coupon 段 */
  couponText?: string | null;
  /** 生成场景：单品卖货 / 团购 / 自定义（缺省按团购）；只影响增量片段，骨架共用 */
  scenario?: LoopScriptScenario;
  /** 自定义场景的参考素材（客户给的角度/人群/风格）；空则按骨架发挥，不编造 */
  customBrief?: string | null;
  /** 期望条目数：1-12 */
  itemCount: number;
}

/** 改写入参：携带被拦截的草稿与命中词，让 AI 知道要绕开哪些表述 */
export interface RewriteLoopItemsInput extends GenerateLoopItemsInput {
  /** 上一版被拦截的台本草稿 */
  draft: LoopItemDraft[];
  /** 草稿命中的拦截用语（逐条扫描汇总去重） */
  matchedWords: string[];
}

/**
 * DeepSeek 循环台本服务接口。
 * 与话术生成同一原则：必须真实调用 DeepSeek，不提供 mock 降级。
 */
export interface DeepSeekLoopScriptService {
  generateItems(input: GenerateLoopItemsInput): Promise<LoopItemDraft[]>;
  /** 针对被拦截草稿的整组改写（命中 → 重写 → 复扫，供路由重试链路使用） */
  rewriteItems(input: RewriteLoopItemsInput): Promise<LoopItemDraft[]>;
}

// ---------- 真实实现（DeepSeek chat/completions）----------

/** DeepSeek 兼容响应中需要的最小结构 */
interface DeepSeekChatCompletion {
  choices?: Array<{ message?: { content?: unknown } }>;
}

type DeepSeekChatRole = 'system' | 'user' | 'assistant';

interface DeepSeekChatMessage {
  role: DeepSeekChatRole;
  content: string;
}

function isLoopItemKind(value: unknown): value is LoopItemKind {
  return typeof value === 'string' && (LOOP_ITEM_KINDS as readonly string[]).includes(value);
}

/**
 * 台本生成 / 改写的编排系统提示词「骨架」（口径来自里程碑方案 §6.2）。
 * 三个场景（单品卖货 / 团购 / 自定义）共用同一骨架，只在末尾追加场景增量片段
 * （见 SCENARIO_HINTS），避免各写一套导致口径漂移。
 */
const LOOP_SCRIPT_SYSTEM_PROMPT =
  '你是一名本地商家直播间的 AI 循环口播编排师。用户会给你一段已成稿的产品口播话术和它的商品信息，' +
  '请把它拆解改写成一集可循环播放的台本：若干条互相独立、能单条听懂的口播短句。' +
  '顺序按自然带播节奏编排（开场欢迎 → 介绍商品/服务 → 讲套餐或卖点 → 引导点击团购或下单 → 互动或收尾），' +
  '整套播完再从第一句循环也不突兀。要求：' +
  '1. 每条 15-80 字，语气自然口语化，像真人主播说话，每条单独听懂不依赖上下文；' +
  '2. 只使用来源话术与商品快照里已有的口径与卖点，不编造价格、库存、功效等任何新信息；' +
  '3. 若提供了团购券文案，可加入一条到两条介绍该券的句子（kind 用 coupon），但不得改动券名与价格口径；' +
  '4. 输出严格 JSON 数组，不要输出任何解释或代码块。数组元素格式为：' +
  '{"kind":"opening 或 product 或 coupon 或 warmup 或 closing 或 custom 之一，拿不准就写 custom",' +
  '"text":"这条口播的台词","gapAfterSeconds":数字 0-60 或省略（省略表示用默认 6 秒间隔）}';

/** 台本生成场景：单品卖货 / 到店团购 / 自定义（决定增量编排片段，骨架共用） */
export const LOOP_SCRIPT_SCENARIOS = ['single_product', 'group_buy', 'custom'] as const;
export type LoopScriptScenario = (typeof LOOP_SCRIPT_SCENARIOS)[number];
/** 场景缺省值：到店团购（目标客群最常见的带货形态） */
export const DEFAULT_LOOP_SCRIPT_SCENARIO: LoopScriptScenario = 'group_buy';

/** 场景白名单判定（路由层校验请求体用） */
export function isLoopScriptScenario(value: unknown): value is LoopScriptScenario {
  return typeof value === 'string' && (LOOP_SCRIPT_SCENARIOS as readonly string[]).includes(value);
}

/** 场景增量片段：追加在骨架之后，只描述该场景的编排侧重，不重复通用约束 */
const SCENARIO_HINTS: Record<LoopScriptScenario, string> = {
  single_product:
    '\n\n【场景·单品卖货】围绕这一件商品反复讲透卖点与使用场景，用「痛点→卖点→证据→催单」的小回路，' +
    '节奏紧凑、不啰嗦，结尾给出明确的下单引导。',
  group_buy:
    '\n\n【场景·到店团购】重点讲清套餐包含什么、人均与到店核销方式，引导观众「点下方小房子抢券」；' +
    '反复强调到店消费场景与限时优惠，不夸大份量与价格。',
  custom:
    '\n\n【场景·自定义】按用户在【参考素材】里给出的角度、人群与语气风格编排；' +
    '参考素材未覆盖的信息一律不得编造，宁可少说也不虚构。',
};

/** 拼接系统提示词：骨架 + 场景增量 + 禁用词清单 */
function buildSystemPrompt(scenario: LoopScriptScenario): string {
  return `${LOOP_SCRIPT_SYSTEM_PROMPT}${SCENARIO_HINTS[scenario]}\n\n${SENSITIVE_GUARD_PROMPT}`;
}

function invalidResponseError(detail: string): LoopScriptError {
  return new LoopScriptError('GENERATION_FAILED', `AI 未返回可用台本（${detail}），请重试`);
}

/**
 * 解析并规范化 AI 返回：容忍首尾代码块标记，只取第一个 [ 到最后一个 ] 之间作 JSON。
 * 规范化结果保证：条目数 1-12、text 非空且 <=200 字、kind 落白名单否则 null、间隔 0-60 否则 null。
 */
function parseItems(raw: unknown): LoopItemDraft[] {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw invalidResponseError('返回内容为空');
  }
  let text = raw.trim();
  const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)```\s*$/);
  if (fenced && fenced[1]) {
    text = fenced[1].trim();
  }
  const first = text.indexOf('[');
  const last = text.lastIndexOf(']');
  if (first === -1 || last === -1 || last <= first) {
    throw invalidResponseError('未找到 JSON 数组');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(first, last + 1)) as unknown;
  } catch {
    throw invalidResponseError('JSON 解析失败');
  }
  if (!Array.isArray(parsed) || parsed.length < MIN_LOOP_ITEMS || parsed.length > MAX_LOOP_ITEMS) {
    throw invalidResponseError(`条目数需在 ${MIN_LOOP_ITEMS}-${MAX_LOOP_ITEMS} 之间`);
  }
  return parsed.map((element, index): LoopItemDraft => {
    if (typeof element !== 'object' || element === null || Array.isArray(element)) {
      throw invalidResponseError(`第 ${index + 1} 条不是对象`);
    }
    const record = element as Record<string, unknown>;
    const textValue = typeof record.text === 'string' ? record.text.trim() : '';
    if (textValue.length === 0 || textValue.length > MAX_LOOP_ITEM_TEXT_LENGTH) {
      throw invalidResponseError(`第 ${index + 1} 条字数需在 1-${MAX_LOOP_ITEM_TEXT_LENGTH} 字之间`);
    }
    const kindRaw = record.kind;
    const kind = isLoopItemKind(kindRaw) ? kindRaw : null;
    let gapAfterSeconds: number | null = null;
    const gapRaw = record.gapAfterSeconds;
    if (typeof gapRaw === 'number' && Number.isInteger(gapRaw) && gapRaw >= 0 && gapRaw <= 60) {
      gapAfterSeconds = gapRaw;
    }
    return { kind, text: textValue, gapAfterSeconds };
  });
}

export class DeepSeekLoopScriptServiceImpl implements DeepSeekLoopScriptService {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;

  constructor(options: { apiKey: string; baseUrl: string; model: string }) {
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl;
    this.model = options.model;
  }

  async generateItems(input: GenerateLoopItemsInput): Promise<LoopItemDraft[]> {
    return parseItems(await this.complete(this.buildMessages(input, null)));
  }

  async rewriteItems(input: RewriteLoopItemsInput): Promise<LoopItemDraft[]> {
    const messages = this.buildMessages(input, input.matchedWords);
    messages.push({
      role: 'assistant',
      content: JSON.stringify(input.draft),
    });
    messages.push({
      role: 'user',
      content:
        `你上一版台本被平台敏感词扫描拦截（命中：${input.matchedWords.join('、')}），不能开播。` +
        `请整体重写一版（仍为 ${input.itemCount} 条左右的循环台本）：保持原有段落结构、商品口径与节奏不变，` +
        '只把违规表述替换成合规的自然口播，并确保每条都不含上述任何被拦截用语。只输出新的 JSON 数组，不要解释。',
    });
    return parseItems(await this.complete(messages));
  }

  /** 组装对话前缀：system = 骨架 + 场景增量 + 禁用语清单，user = 来源话术 + 商品 + 可选券/参考素材 */
  private buildMessages(
    input: GenerateLoopItemsInput,
    matchedWords: string[] | null,
  ): DeepSeekChatMessage[] {
    const scenario = input.scenario ?? DEFAULT_LOOP_SCRIPT_SCENARIO;
    const parts: string[] = [
      `把下面这段口播话术改写成 ${input.itemCount} 条左右的循环台本短句：`,
      `【话术全文】${input.sourceContent}`,
      `【商品信息】${JSON.stringify(input.product)}`,
    ];
    if (input.couponText) {
      parts.push(`【团购券文案】${input.couponText}`);
    }
    // 自定义场景：把客户给的参考素材（角度/人群/风格）并入 user，未覆盖的信息不得编造
    if (scenario === 'custom' && input.customBrief) {
      parts.push(`【参考素材】${input.customBrief}`);
    }
    if (matchedWords && matchedWords.length > 0) {
      parts.push(
        `注意：上一条整组台本因含「${matchedWords.join('、')}」被拦截，请全文避开这些用语。`,
      );
    }
    return [
      {
        role: 'system',
        content: buildSystemPrompt(scenario),
      },
      { role: 'user', content: parts.join('\n') },
    ];
  }

  /** 统一发起 chat/completions 并解析为纯文本 */
  private async complete(messages: DeepSeekChatMessage[]): Promise<string> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.model,
          messages,
          temperature: 0.7,
          max_tokens: 2048,
        }),
      });
    } catch (err) {
      throw new LoopScriptError('GENERATION_FAILED', `调用 DeepSeek 失败：${(err as Error).message}`);
    }

    if (!response.ok) {
      throw new LoopScriptError('GENERATION_FAILED', `DeepSeek 返回异常状态：${response.status}`);
    }

    let data: DeepSeekChatCompletion;
    try {
      data = (await response.json()) as DeepSeekChatCompletion;
    } catch {
      throw new LoopScriptError('GENERATION_FAILED', 'DeepSeek 响应解析失败');
    }

    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || content.trim().length === 0) {
      throw new LoopScriptError('GENERATION_FAILED', 'DeepSeek 未返回台本内容');
    }
    return content.trim();
  }
}

// ---------- 工厂 + 单例 ----------

/**
 * DeepSeek 台本生成服务工厂。
 * 与话术生成一致：DEEPSEEK_API_KEY 未配置时直接抛错，避免把假数据当真实台本入库。
 */
export function createLoopScriptService(): DeepSeekLoopScriptService {
  const { apiKey, baseUrl, model } = env.deepseek;
  if (!apiKey) {
    throw new Error(
      '未配置 DEEPSEEK_API_KEY：台本生成必须真实调用 DeepSeek，本任务不提供 mock 降级',
    );
  }
  return new DeepSeekLoopScriptServiceImpl({ apiKey, baseUrl, model });
}

// 全局单例：台本生成路由共用同一实现
export const loopScriptService = createLoopScriptService();
