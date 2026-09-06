import { env } from '../config/env';

// DeepSeek 实时互动回复服务（G4）：把「弹幕 + 商家知识」生成 1~2 句可直接口播的短回复。
// 与话术生成（script.ts）不同：这里面向「一条弹幕 → 一句口播」，输出短、单次调用便宜，
// 且模型需要自己判断「是否值得回复」，不需要回复时返回 NO_REPLY_MARKER。
// 第三方调用不提供 mock 降级：G4 起必须真实调用 DeepSeek（仓库口径与 script.ts 一致）。

// ---------- 常量 ----------

/** 模型判定「无需回复」时的输出标记：仅输出该标记表示不回复 */
export const NO_REPLY_MARKER = 'NONE';

// ---------- 类型定义 ----------

/** 单条弹幕实时回复的生成入参 */
export interface GenerateReplyInput {
  /** 观众弹幕原文（trim 后非空） */
  content: string;
  /** 发送者昵称（可为空） */
  senderNickname: string | null;
  /** 商家知识：直播标题 / 绑定话术全文 / 商品快照，用于支撑真实回答 */
  knowledge: {
    liveTitle: string;
    scriptContent: string | null;
    productSnapshot: Record<string, string> | null;
  };
}

/**
 * 实时回复生成器接口：返回口播文案；返回 null 表示模型判定无需回复。
 * 出口一致由 G4 引擎消费，未来换模型（火山/GLM 等）只换实现不换接口。
 */
export interface ReplyProvider {
  generateReply(input: GenerateReplyInput): Promise<string | null>;
}

// ---------- 错误类型 ----------

export type ReplyErrorCode = 'GENERATION_FAILED';

/** 实时回复生成错误：由引擎捕获转为 skip（单条失败不影响直播主线） */
export class ReplyError extends Error {
  readonly code: ReplyErrorCode;

  constructor(code: ReplyErrorCode, message: string) {
    super(message);
    this.name = 'ReplyError';
    this.code = code;
  }
}

// ---------- 系统提示词 ----------

/** 实时互动口播角色设定：短句、不编造、合规、需要时用 NONE 表示不回复 */
const REPLY_SYSTEM_PROMPT =
  '你是本地团购商家直播间里的 AI 实时口播助手。直播间画面始终叠加「AI 智能直播」角标，观众知道回复由 AI 驱动。' +
  '请判断每条观众弹幕是否需要回复：问候、商品咨询、价格/套餐/到店核销等提问 → 生成 1~2 句适合口播的短句回复；' +
  '纯表情、无意义刷屏、辱骂、广告推销或与你无关的内容 → 只输出 NONE 表示不回复。' +
  '口播要求：口语自然、像门店销售在说话，但不得自称真人；只依据给定的商家资料回答，资料里没有的信息不要编造，用引导话术代替；' +
  '不得使用广告法极限词或夸大宣传（如最、第一、顶级、全网最低、百分百、100% 等）。' +
  '输出格式：需要回复时只输出口播文案本身（不要引号与多余说明）；不需要回复时只输出 NONE。';

// ---------- DeepSeek 真实实现 ----------

/** DeepSeek 兼容响应中需要的最小结构 */
interface DeepSeekChatCompletion {
  choices?: Array<{ message?: { content?: unknown } }>;
}

export class DeepSeekReplyProvider implements ReplyProvider {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;

  constructor(options: { apiKey: string; baseUrl: string; model: string }) {
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl;
    this.model = options.model;
  }

  async generateReply(input: GenerateReplyInput): Promise<string | null> {
    const knowledgeJson = JSON.stringify({
      liveTitle: input.knowledge.liveTitle,
      scriptContent: input.knowledge.scriptContent,
      productSnapshot: input.knowledge.productSnapshot,
    });

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
            { role: 'system', content: REPLY_SYSTEM_PROMPT },
            { role: 'user', content: `商家资料：${knowledgeJson}\n观众弹幕：${input.content}` },
          ],
          // 实时回复求快：低 temperature 稳、小 max_tokens 防跑偏超长
          temperature: 0.6,
          max_tokens: 160,
        }),
      });
    } catch (err) {
      throw new ReplyError('GENERATION_FAILED', `调用 DeepSeek 失败：${(err as Error).message}`);
    }

    if (!response.ok) {
      throw new ReplyError('GENERATION_FAILED', `DeepSeek 返回异常状态：${response.status}`);
    }

    let data: DeepSeekChatCompletion;
    try {
      data = (await response.json()) as DeepSeekChatCompletion;
    } catch {
      throw new ReplyError('GENERATION_FAILED', 'DeepSeek 响应解析失败');
    }

    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || content.trim().length === 0) {
      throw new ReplyError('GENERATION_FAILED', 'DeepSeek 未返回回复内容');
    }
    const text = content.trim();
    // 模型判定无需回复：吞掉标记，返回 null 交给引擎 skip
    return text === NO_REPLY_MARKER ? null : text;
  }
}

// ---------- 工厂 + 单例 ----------

/** DeepSeek 实时回复工厂：未配置 key 直接抛错，避免把假回复当真实回复播出去 */
export function createReplyProvider(): ReplyProvider {
  const { apiKey, baseUrl, model } = env.deepseek;
  if (!apiKey) {
    throw new Error('未配置 DEEPSEEK_API_KEY：实时互动回复必须真实调用 DeepSeek，不提供 mock 降级');
  }
  return new DeepSeekReplyProvider({ apiKey, baseUrl, model });
}

// 全局单例：G4 引擎共用同一实现
export const replyProvider = createReplyProvider();
