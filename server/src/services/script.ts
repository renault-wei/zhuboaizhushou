import { env } from '../config/env';
import { scanSensitive, SENSITIVE_GUARD_PROMPT } from './sensitive';

// ---------- 行业模板常量（导出，供路由校验与客户端复用）----------

export interface ScriptIndustryTemplate {
  /** 行业 code：restaurant / local_service / retail */
  code: string;
  /** 中文名：餐饮 / 到店服务 / 零售 */
  label: string;
  /** 话术生成的角色设定：语气口语化、突出卖点与价格、200-300 字、不夸大不违规 */
  systemPrompt: string;
  /** 商品字段说明：字段名 → 中文含义 */
  productFields: Record<string, string>;
}

/** 行业模板表：POST generate 的 industry 必须落在其中 */
export const scriptTemplates: Record<string, ScriptIndustryTemplate> = {
  restaurant: {
    code: 'restaurant',
    label: '餐饮',
    systemPrompt:
      '你是一名本地团购商家的 AI 直播话术写手。根据用户提供的团购商品信息，写一段用于无人直播的口播话术。要求：语气自然口语化，像真人主播在讲解；突出套餐内容、价格与卖点；全文控制在 200-300 字；不夸大宣传，不出现广告法极限词，内容真实合规。',
    productFields: {
      name: '团购券名',
      package: '套餐内容',
      price: '价格',
      sellingPoints: '卖点',
    },
  },
  local_service: {
    code: 'local_service',
    label: '到店服务',
    systemPrompt:
      '你是一名本地生活团购商家的 AI 直播话术写手。根据用户提供的到店服务商品信息，写一段用于无人直播的口播话术。要求：语气自然口语化，像真人主播在讲解；突出服务内容、价格与卖点；全文控制在 200-300 字；不夸大宣传，不出现广告法极限词，内容真实合规。',
    productFields: {
      name: '服务名',
      package: '服务内容',
      price: '价格',
      sellingPoints: '卖点',
    },
  },
  retail: {
    code: 'retail',
    label: '零售',
    systemPrompt:
      '你是一名零售商品的 AI 直播话术写手。根据用户提供的商品信息，写一段用于无人直播的口播话术。要求：语气自然口语化，像真人主播在讲解；突出商品规格、价格与卖点；全文控制在 200-300 字；不夸大宣传，不出现广告法极限词，内容真实合规。',
    productFields: {
      name: '商品名',
      package: '规格',
      price: '价格',
      sellingPoints: '卖点',
    },
  },
};

/** 判断行业是否在 3 个模板内（路由校验用） */
export function isScriptIndustry(value: string): boolean {
  return Object.prototype.hasOwnProperty.call(scriptTemplates, value);
}

// ---------- 错误类型 ----------

export type ScriptErrorCode = 'GENERATION_FAILED';

/** DeepSeek 话术生成服务业务错误：由路由层翻译成 HTTP 状态（502） */
export class ScriptError extends Error {
  readonly code: ScriptErrorCode;

  constructor(code: ScriptErrorCode, message: string) {
    super(message);
    this.name = 'ScriptError';
    this.code = code;
  }
}

// ---------- 接口定义 ----------

export interface GenerateScriptInput {
  industry: string;
  product: Record<string, string>;
}

/** 改写入参：携带被拦截的初稿与命中词，让 AI 知道要绕开哪些表述 */
export interface RewriteScriptInput extends GenerateScriptInput {
  /** 上一版被拦截的话术初稿 */
  draft: string;
  /** 初稿命中的拦截用语 */
  matchedWords: string[];
}

/**
 * DeepSeek 话术生成服务接口。
 * T7 起必须真实调用 DeepSeek，不提供 mock 降级；未来换其他模型时保持接口不变。
 */
export interface DeepSeekScriptService {
  generateScript(input: GenerateScriptInput): Promise<string>;
  /** 针对被拦截初稿的整段改写（命中 → 重写 → 复扫，供路由重试链路使用） */
  rewriteScript(input: RewriteScriptInput): Promise<string>;
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

export class DeepSeekScriptServiceImpl implements DeepSeekScriptService {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;

  constructor(options: { apiKey: string; baseUrl: string; model: string }) {
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl;
    this.model = options.model;
  }

  async generateScript(input: GenerateScriptInput): Promise<string> {
    return this.complete(this.buildMessages(input.industry, input.product));
  }

  async rewriteScript(input: RewriteScriptInput): Promise<string> {
    const messages = this.buildMessages(input.industry, input.product);
    messages.push({ role: 'assistant', content: input.draft });
    messages.push({
      role: 'user',
      content:
        `你上一版话术被平台敏感词扫描拦截（命中：${input.matchedWords.join('、')}），不能开播。` +
        '请整段重写一版：保持行业风格、商品信息与大致字数不变，只把违规表述替换成合规的自然口播，' +
        '并确保全文不含上述任何被拦截用语。只输出重写后的话术正文，不要解释。',
    });
    return this.complete(messages);
  }

  /** 组装对话前缀：system = 行业模板 + 禁用语清单，user = 商品信息 */
  private buildMessages(
    industry: string,
    product: Record<string, string>,
  ): DeepSeekChatMessage[] {
    const template = scriptTemplates[industry];
    if (!template) {
      throw new ScriptError('GENERATION_FAILED', `未知行业：${industry}`);
    }
    return [
      {
        role: 'system',
        content: `${template.systemPrompt}\n\n${SENSITIVE_GUARD_PROMPT}`,
      },
      { role: 'user', content: `商品信息：${JSON.stringify(product)}` },
    ];
  }

  /** 统一发起 chat/completions 并解析为非空纯文本 */
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
          max_tokens: 1024,
        }),
      });
    } catch (err) {
      throw new ScriptError('GENERATION_FAILED', `调用 DeepSeek 失败：${(err as Error).message}`);
    }

    if (!response.ok) {
      throw new ScriptError('GENERATION_FAILED', `DeepSeek 返回异常状态：${response.status}`);
    }

    let data: DeepSeekChatCompletion;
    try {
      data = (await response.json()) as DeepSeekChatCompletion;
    } catch {
      throw new ScriptError('GENERATION_FAILED', 'DeepSeek 响应解析失败');
    }

    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || content.trim().length === 0) {
      throw new ScriptError('GENERATION_FAILED', 'DeepSeek 未返回话术内容');
    }
    return content.trim();
  }
}

// ---------- 安全兜底文案（改写仍失败时的最后防线）----------

/**
 * 各行业纯通用兜底文案：不含任何商品字面量，逐字避开拦截词表，
 * 仅在「带商品字面量的拼接稿仍被拦截」时使用（例如商品名/价格本身含极限词）。
 */
const SAFE_FALLBACK_TEXT = {
  restaurant:
    '欢迎来到直播间，今天给大家介绍店里的招牌套餐，菜品新鲜实在、分量很足，价格也很有诚意。想吃的朋友点击下方团购入口下单，到店出示团购券就能使用，期待大家的光临！',
  local_service:
    '欢迎来到直播间，今天给大家推荐店里的人气服务，服务专业细致、流程顺畅，价格也很实惠。感兴趣的朋友点击下方团购入口下单，到店出示团购券就能核销，期待大家的体验！',
  retail:
    '欢迎来到直播间，今天给大家推荐店里的热卖商品，品质有保障、性价比高，用起来很省心。喜欢的家人们点击下方购物车下单，优惠活动进行中，收到货不满意也能安心退换！',
} as const;

/** 拼接带商品字面量的兜底稿（name / package / price 逐段带入） */
function buildFallbackProductCopy(product: Record<string, string>): string {
  const name = product['name']?.trim();
  const pkg = product['package']?.trim();
  const price = product['price']?.trim();
  const parts: string[] = [];
  if (name) {
    parts.push(`今天给大家介绍的是「${name}」`);
  }
  if (pkg) {
    parts.push(pkg);
  }
  if (price) {
    parts.push(`现在只要${price}`);
  }
  const body = parts.length > 0 ? `，${parts.join('，')}。` : '。';
  return (
    `欢迎来到直播间${body}喜欢的家人们点击下方团购入口下单，` +
    '到店出示团购券即可使用，期待大家的光临！'
  );
}

/**
 * 生成 AI 多次未过审后的服务端兜底文案：
 * 先尝试带商品字面量的通用稿，扫描仍不过则退回纯通用文案（保证最终内容必过扫描）。
 */
export function buildSafeScriptFallback(
  industry: string,
  product: Record<string, string>,
): string {
  const withProduct = buildFallbackProductCopy(product);
  if (scanSensitive(withProduct).status === 'pass') {
    return withProduct;
  }
  // industry 已在路由层校验落在 3 个模板内，未知行业退回餐饮通用文案
  const key = industry as keyof typeof SAFE_FALLBACK_TEXT;
  return SAFE_FALLBACK_TEXT[key] ?? SAFE_FALLBACK_TEXT.restaurant;
}

// ---------- 工厂 + 单例 ----------

/**
 * DeepSeek 话术服务工厂。
 * 与 T5 voice 工厂「未配置走 mock」不同：话术生成没有 mock，
 * DEEPSEEK_API_KEY 未配置时直接抛错，避免把假数据当真实话术入库。
 */
export function createScriptService(): DeepSeekScriptService {
  const { apiKey, baseUrl, model } = env.deepseek;
  if (!apiKey) {
    throw new Error(
      '未配置 DEEPSEEK_API_KEY：话术生成必须真实调用 DeepSeek，本任务不提供 mock 降级',
    );
  }
  return new DeepSeekScriptServiceImpl({ apiKey, baseUrl, model });
}

// 全局单例：话术生成路由共用同一实现
export const scriptService = createScriptService();
