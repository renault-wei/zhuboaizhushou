import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db } from '../db/client';
import { lives as livesTable, scripts as scriptsTable } from '../db/schema';
import { onDanmaku, type LiveDanmakuRecord } from './danmaku';
import type { LiveStatus } from './live';
import { replyProvider, type GenerateReplyInput } from './reply';
import { scanSensitive } from './sensitive';
import { liveSpeaker } from './liveSpeaker';

// 实时互动引擎（G4）：订阅 G3 弹幕事件 → 加载商家上下文 → 决策（频控/是否回复）
// → DeepSeek 生成 1~2 句口播 → 敏感词兜底 → 交给出口（G5 TTS/播放队列）。
// 引擎只做「决策 + 生成 + 校验」：回复的排队/打断/播放属于 G5，本任务不引入消息队列。

// ---------- 常量 ----------

/** 同一场次两条回复的最小间隔（ms）：防止连续弹幕刷屏，默认 1 条 / 5 秒 */
export const DEFAULT_REPLY_INTERVAL_MS = 5000;
/** 同一观众两条回复的最小间隔（ms）：防止单用户刷屏，默认与场次级一致 */
export const DEFAULT_SENDER_INTERVAL_MS = 5000;

/** 命中敏感词后的兜底话术（轮换使用，避免连续重复同一句） */
const DEFAULT_FALLBACK_REPLIES: readonly string[] = [
  '您问的这个问题我帮您记下了，稍等我确认好再为您解答～',
  '您说的这个情况我了解啦，欢迎先看看我们套餐详情，我马上为您补充介绍～',
];

// ---------- 类型定义 ----------

/** 引擎可用的商家上下文：由 live + 绑定话术拼装（status 供引擎判断是否直播中） */
export interface LiveInteractionContext {
  liveId: string;
  userId: string;
  liveTitle: string;
  status: LiveStatus;
  /** 绑定话术全文：商家知识主来源，可为 null */
  scriptContent: string | null;
  /** 话术商品快照：回答价格/套餐类问题的依据，可为 null */
  productSnapshot: Record<string, string> | null;
}

/** 引擎产出的一条待播回复（出口交给 G5 TTS/播放队列） */
export interface InteractionReply {
  id: string;
  liveId: string;
  userId: string;
  /** 触发本回复的弹幕 id */
  danmakuId: string;
  senderNickname: string | null;
  /** 待口播文案 */
  text: string;
  /** generated = DeepSeek 正常回复；fallback = 命中敏感词改兜底话术 */
  source: 'generated' | 'fallback';
  /** 生成完成时间（ISO8601） */
  createdAt: string;
}

export type InteractionSkipReason =
  | 'LIVE_NOT_FOUND'
  | 'LIVE_NOT_LIVE'
  | 'DANMAKU_EMPTY'
  | 'GLOBAL_THROTTLED'
  | 'SENDER_THROTTLED'
  | 'NO_REPLY_NEEDED'
  | 'GENERATION_FAILED';

export type InteractionOutcome =
  | { action: 'reply'; reply: InteractionReply }
  | { action: 'skip'; reason: InteractionSkipReason };

/** 引擎依赖：生产用默认实现（真实 DB + DeepSeek），测试可整体注入替身 */
export interface InteractionEngineOptions {
  /** 按 liveId 加载商家上下文（默认查库；返回 null 视为场次不存在） */
  loadContext(liveId: string): Promise<LiveInteractionContext | null>;
  /** 生成口播回复（默认 DeepSeek；返回 null 表示无需回复） */
  generateReply(input: GenerateReplyInput): Promise<string | null>;
  /** 回复出口：G5 在此接入 TTS/播放队列；当前阶段默认空实现 */
  onReply(reply: InteractionReply): void | Promise<void>;
  /** 时钟注入（测试用），生产默认 Date.now */
  now(): number;
  /** 场次级最小回复间隔（ms） */
  globalIntervalMs: number;
  /** 同用户最小回复间隔（ms） */
  senderIntervalMs: number;
  /** 敏感词兜底话术池 */
  fallbackReplies: readonly string[];
}

export interface InteractionEngine {
  /** 处理一条已入库弹幕：决策 + 生成 + 校验 + 出口，返回处理结果 */
  handle(message: LiveDanmakuRecord): Promise<InteractionOutcome>;
  /** 订阅全局弹幕事件（G3 onDanmaku）；返回退订函数 */
  subscribe(): () => void;
}

// ---------- 商家上下文加载（默认实现）----------

/** 弹幕带的是 liveId：反查 live 归属（userId/status）与绑定话术知识 */
export async function loadLiveInteractionContext(
  liveId: string,
): Promise<LiveInteractionContext | null> {
  const rows = await db
    .select({
      userId: livesTable.userId,
      liveTitle: livesTable.title,
      status: livesTable.status,
      scriptContent: scriptsTable.content,
      productSnapshot: scriptsTable.productSnapshot,
    })
    .from(livesTable)
    .leftJoin(scriptsTable, eq(livesTable.scriptId, scriptsTable.id))
    .where(eq(livesTable.id, liveId))
    .limit(1);
  const row = rows[0];
  if (!row) {
    return null;
  }
  return {
    liveId,
    userId: row.userId,
    liveTitle: row.liveTitle ?? '',
    status: row.status,
    scriptContent: row.scriptContent ?? null,
    productSnapshot: readProductSnapshot(row.productSnapshot),
  };
}

/** jsonb 商品快照兜底清洗：只收 string 字段，空对象按无商品知识处理 */
function readProductSnapshot(value: unknown): Record<string, string> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  const product: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'string') {
      product[key] = item;
    }
  }
  return Object.keys(product).length > 0 ? product : null;
}

// ---------- 引擎实现 ----------

class InteractionEngineImpl implements InteractionEngine {
  private readonly options: InteractionEngineOptions;
  /** 场次维度：最近一次实际回复时间 */
  private readonly lastReplyAtByLive = new Map<string, number>();
  /** 用户维度：最近一次实际回复时间（key = liveId:nickname） */
  private readonly lastReplyAtBySender = new Map<string, number>();
  /** 兜底话术轮换游标 */
  private fallbackIndex = 0;

  constructor(options: InteractionEngineOptions) {
    this.options = options;
  }

  async handle(message: LiveDanmakuRecord): Promise<InteractionOutcome> {
    const content = message.content.trim();
    if (content.length === 0) {
      return { action: 'skip', reason: 'DANMAKU_EMPTY' };
    }

    const context = await this.options.loadContext(message.liveId);
    if (!context) {
      return { action: 'skip', reason: 'LIVE_NOT_FOUND' };
    }
    // 只对直播中的场次互动：结束/就绪状态一律不产生回复
    if (context.status !== 'live') {
      return { action: 'skip', reason: 'LIVE_NOT_LIVE' };
    }

    // 场次级频控：与上一条实际回复间隔不足则丢弃（防连续弹幕刷屏）
    const now = this.options.now();
    const lastGlobalReplyAt = this.lastReplyAtByLive.get(context.liveId);
    if (lastGlobalReplyAt !== undefined && now - lastGlobalReplyAt < this.options.globalIntervalMs) {
      return { action: 'skip', reason: 'GLOBAL_THROTTLED' };
    }
    // 用户级频控：同一昵称刷屏只回一次（匿名为空昵称时不做单用户限制）
    const senderKey = message.senderNickname
      ? `${context.liveId}:${message.senderNickname}`
      : null;
    if (senderKey) {
      const lastSenderReplyAt = this.lastReplyAtBySender.get(senderKey);
      if (
        lastSenderReplyAt !== undefined &&
        now - lastSenderReplyAt < this.options.senderIntervalMs
      ) {
        return { action: 'skip', reason: 'SENDER_THROTTLED' };
      }
    }

    let generatedText: string | null;
    try {
      generatedText = await this.options.generateReply({
        content,
        senderNickname: message.senderNickname,
        knowledge: {
          liveTitle: context.liveTitle,
          scriptContent: context.scriptContent,
          productSnapshot: context.productSnapshot,
        },
      });
    } catch {
      // 单条生成失败直接跳过，不让上游弹幕链路感知（日志/统计排后续任务）
      return { action: 'skip', reason: 'GENERATION_FAILED' };
    }
    if (!generatedText) {
      return { action: 'skip', reason: 'NO_REPLY_NEEDED' };
    }

    // 合规兜底：命中拦截级敏感词不直接播，改念安全兜底话术
    const scanned = scanSensitive(generatedText);
    const useFallback = scanned.status === 'blocked';
    const replyText = useFallback ? this.pickFallbackText() : generatedText;
    const repliedAt = this.options.now();
    const reply: InteractionReply = {
      id: randomUUID(),
      liveId: context.liveId,
      userId: context.userId,
      danmakuId: message.id,
      senderNickname: message.senderNickname,
      text: replyText,
      source: useFallback ? 'fallback' : 'generated',
      createdAt: new Date(repliedAt).toISOString(),
    };

    // 记频控时间点（以实际产出回复为准，期间失败的生成不占额度）
    this.lastReplyAtByLive.set(context.liveId, repliedAt);
    if (senderKey) {
      this.lastReplyAtBySender.set(senderKey, repliedAt);
    }
    try {
      await this.options.onReply(reply);
    } catch {
      // 出口消费者（G5）异常不影响引擎状态与频控
    }
    return { action: 'reply', reply };
  }

  subscribe(): () => void {
    return onDanmaku((message) => {
      void this.handle(message).catch(() => undefined);
    });
  }

  /** 轮换取兜底话术：降低连续回复同一句的机械感 */
  private pickFallbackText(): string {
    const list = this.options.fallbackReplies;
    const fallback = list[this.fallbackIndex % list.length];
    this.fallbackIndex += 1;
    return fallback ?? list[0] ?? '欢迎看看咱们的团购套餐详情～';
  }
}

// ---------- 工厂 + 单例 ----------

/** 引擎工厂：默认接真实 DB 上下文 + DeepSeek 生成；测试可注入替身 */
export function createInteractionEngine(
  options: Partial<InteractionEngineOptions> = {},
): InteractionEngine {
  return new InteractionEngineImpl({
    loadContext: loadLiveInteractionContext,
    generateReply: (input) => replyProvider.generateReply(input),
    onReply: () => undefined,
    now: () => Date.now(),
    globalIntervalMs: DEFAULT_REPLY_INTERVAL_MS,
    senderIntervalMs: DEFAULT_SENDER_INTERVAL_MS,
    fallbackReplies: DEFAULT_FALLBACK_REPLIES,
    ...options,
  });
}

// 全局单例：index.ts 启动时 subscribe() 即接入实时链路
// G5：引擎出口接现场口播 —— 回复文字 → 本机语音合成 → 播放队列（失败由引擎吞掉，不影响直播主线）
export const interactionEngine = createInteractionEngine({
  onReply: (reply) => liveSpeaker.speak(reply.text).then(() => undefined),
});
