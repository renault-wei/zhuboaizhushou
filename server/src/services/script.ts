import { env } from '../config/env';

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

/**
 * DeepSeek 话术生成服务接口。
 * T7 起必须真实调用 DeepSeek，不提供 mock 降级；未来换其他模型时保持接口不变。
 */
export interface DeepSeekScriptService {
  generateScript(input: GenerateScriptInput): Promise<string>;
}

// ---------- 真实实现（DeepSeek chat/completions）----------

/** DeepSeek 兼容响应中需要的最小结构 */
interface DeepSeekChatCompletion {
  choices?: Array<{ message?: { content?: unknown } }>;
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
    const template = scriptTemplates[input.industry];
    if (!template) {
      throw new ScriptError('GENERATION_FAILED', `未知行业：${input.industry}`);
    }

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
          messages: [
            { role: 'system', content: template.systemPrompt },
            { role: 'user', content: `商品信息：${JSON.stringify(input.product)}` },
          ],
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
