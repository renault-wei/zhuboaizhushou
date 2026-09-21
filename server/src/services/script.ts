import { env } from '../config/env';
import { scanSensitive, SENSITIVE_GUARD_PROMPT } from './sensitive';

// ---------- 行业模板常量（导出，供路由校验与客户端复用）----------

export interface ScriptIndustryTemplate {
  /** 行业 code：restaurant / local_service / retail */
  code: string;
  /** 中文名：餐饮 / 到店服务 / 零售 */
  label: string;
  /** 话术生成的角色设定：行业口吻 + 公共骨架（800 字左右、八段结构、不编造、不违规） */
  systemPrompt: string;
  /** 商品字段说明：字段名 → 中文含义 */
  productFields: Record<string, string>;
}

/**
 * 话术生成的**公共骨架**（R52）：三个行业共用，只有开头的角色设定不同。
 *
 * 为什么抽出来：2026-09-18 客户方反馈「**生成的话术很简陋**」。定位结果
 * （docs/SCRIPT-GENERATION-UPGRADE.md）：旧提示词要「写**一段**、全文 **200-300 字**」，
 * **信息量上限与结构都被这一句框死** —— 真实产出 474 字一整段，
 * 而客户手写的样例是约 1500 字、8 个带小标题的段落。
 *
 * 新骨架按用户拍板把目标定在 **800 字左右**，并规定段落结构；
 * 段落与 `LOOP_ITEM_KINDS` 对齐，将来可按小标题直接拆成循环台本（同源）。
 */
const SCRIPT_STRUCTURE_PROMPT = [
  '写作要求：',
  '1. **按下面的段落顺序输出，每段以【小标题】开头**，不要写成一大段：',
  '【开场】80-120 字：欢迎观众 + 给一个停留理由 + 品牌与价格承诺。',
  '【引出商品】120-160 字：先从场景或情绪切入（天气、聚餐、嘴馋），点出痛点，再自然引出今天的商品。',
  '【适用人群和场景】60-90 字：这件商品适合谁、什么时候用。',
  '【产品卖点】180-240 字：**讲具体** —— 分量、食材、工艺、口感，用能看见画面的描述（例如「纹理像大理石」「一咬肉汁就出来」），不要只堆「很好」「很棒」这类空词。',
  '【核销注意事项】60-90 字：到店怎么用、要不要预约、能不能退、门店范围。',
  '【价格福利】80-120 字：原价与直播间价的对比、折扣力度，把「划算」落到具体数字上。',
  '【鼓励下单】80-120 字：明确的行动号召 + 下单路径，可以提一句销量或口碑。',
  '【结束语】40-60 字：简短收尾，让观众有问题找客服。',
  '2. 全文 **800 字左右**（700-1000 字之间）。',
  '3. 语气像真人在直播间说话：口语化、有热情，但不轻浮。',
  '4. **只依据给定的商品信息来写**：资料里没有的内容（人群、核销规则、品牌背书、原价等）',
  '   **宁可省略那一段，也绝对不要编造**；省略时保持其余段落连贯。',
  '5. 不夸大宣传，不出现广告法极限词（最、第一、顶级、全网最低、百分百、100% 等），内容真实合规。',
  // R54（D3）：输入字段补齐后，必须**明确告诉模型哪段用哪个字段** ——
  // 否则字段加了也不会被用上，「简陋」照旧。
  '6. 各段的素材出处（**对应字段为空时，那段就整段省略**，别用泛泛的话凑数）：',
  '   【开场】的品牌承诺 ←「品牌背书」；【适用人群和场景】←「适用人群」「使用场景」；',
  '   【核销注意事项】←「核销规则」；【价格福利】的对比 ←「门店原价」与「直播间价」。',
].join('\n');

/** 行业模板表：POST generate 的 industry 必须落在其中 */
export const scriptTemplates: Record<string, ScriptIndustryTemplate> = {
  restaurant: {
    code: 'restaurant',
    label: '餐饮',
    systemPrompt:
      '你是一名本地团购商家的 AI 直播话术写手，为无人直播写一段口播话术。' +
      '素材是团购商品信息，重点讲清套餐内容、价格与卖点。\n\n' +
      SCRIPT_STRUCTURE_PROMPT,
    productFields: {
      name: '团购券名',
      package: '套餐内容',
      priceOriginal: '门店原价',
      price: '价格',
      sellingPoints: '卖点',
    },
  },
  local_service: {
    code: 'local_service',
    label: '到店服务',
    systemPrompt:
      '你是一名本地生活团购商家的 AI 直播话术写手，为无人直播写一段口播话术。' +
      '素材是到店服务商品信息，重点讲清服务内容、价格与卖点。\n\n' +
      SCRIPT_STRUCTURE_PROMPT,
    productFields: {
      name: '服务名',
      package: '服务内容',
      priceOriginal: '门店原价',
      price: '价格',
      sellingPoints: '卖点',
    },
  },
  retail: {
    code: 'retail',
    label: '零售',
    systemPrompt:
      '你是一名零售商品的 AI 直播话术写手，为无人直播写一段口播话术。' +
      '素材是商品信息，重点讲清规格、价格与卖点。\n\n' +
      SCRIPT_STRUCTURE_PROMPT,
    productFields: {
      name: '商品名',
      package: '规格',
      priceOriginal: '原价',
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
          // R52：目标从 200-300 字提到 800 字左右，需要留足空间。
        // max_tokens 只是**上限、不是成本**（按实际生成计费），所以给宽一点更稳。
        max_tokens: 2048,
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
