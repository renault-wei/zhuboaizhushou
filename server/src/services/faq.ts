// 固定回复（第 1 层 · 结构化直答）：从 productSnapshot 直接映射出「问题 → 答案」。
//
// 设计要点（docs/FIXED-REPLY-PLAN.md §4，用户 2026-09-17 拍板）：
//   * **不建表、纯函数** —— productSnapshot 就在场次绑定的脚本上、每次回复都已加载。
//     无状态 = 永远不会和快照漂移（改了价格，答案立刻跟着改，不需要同步任务）。
//   * **零 AI** —— 答案不是"猜"出来的，是商家自己填的字段，因此**可以自动生效**。
//   * **短答案**（用户拍板 D5）：固定答案说错了伤害更大，短句伤害小。
//   * **高置信才命中**（见 matchFaq）：长句里夹带关键词更可能是误命中。
//
// 第 2 层（从话术正文拆解营业时间/地址这类）不在这里 —— 那需要 LLM，必须人工确认，
// 见 FIXED-REPLY-PLAN 的 R34。

/** 一条固定回复 */
export interface FaqEntry {
  /** 来源字段（productSnapshot 的键）：price / package / name / sellingPoints */
  field: string;
  /** 触发问法（任一命中即算命中） */
  patterns: readonly string[];
  /** 固定答案（已裁剪到 ANSWER_MAX_LENGTH 以内） */
  answer: string;
}

/** 命中结果 */
export interface FaqMatch {
  entry: FaqEntry;
  /** 实际命中的那个问法（排障与「哪条问法总在误命中」分析用） */
  pattern: string;
}

/**
 * 单条固定答案的长度上限。
 * 用户拍板 D5「短答案」：固定回复是确定性回答，**说不准的时候，说得越少错得越少**。
 */
export const FAQ_ANSWER_MAX_LENGTH = 60;

/**
 * 「高置信命中」的弹幕长度上限。
 *
 * 为什么需要它：观众说「上次那个多少钱的套餐我买过了」也会包含「多少钱」，
 * 但语境完全不是问价 —— 回一句「咱家 99 元」会显得像机器人。
 * 经验规则：**短句问价格，长句在叙述**。超过这个长度就不算高置信命中，交给 AI。
 */
export const FAQ_HIGH_CONFIDENCE_MAX_DANMAKU_LENGTH = 30;

/**
 * 四个结构化字段对应的问法组（每条 3~8 个，用户拍板 D4）。
 * 只挂一个词命中率会低到没意义；挂太多则误命中率飙升。
 */
const BUILTIN_FAQ_SPECS: ReadonlyArray<{ field: string; patterns: readonly string[]; wrap: (value: string, all: Record<string, string>) => string }> = [
  {
    field: 'price',
    // 「价格」是最高频的问法之一，绝不能漏（这条是被单测抓出来的：我最初只写了
    // 售价 / 价位，结果「价格是多少」不命中）。保持 8 个以内（用户拍板 D4）。
    patterns: ['多少钱', '多钱', '价格', '什么价', '怎么卖', '几块', '贵不贵', '售价'],
    wrap: (value, all) => (all.name ? `咱家${all.name}是${value}` : `咱家是${value}`),
  },
  {
    field: 'package',
    patterns: ['什么套餐', '套餐里', '包含什么', '包含哪些', '里面有什么', '都有啥', '套餐内容'],
    wrap: (value) => `套餐里是${value}`,
  },
  {
    field: 'name',
    patterns: ['卖的什么', '卖的是什么', '是什么商品', '什么产品', '这是啥'],
    wrap: (value) => `咱家卖的是${value}`,
  },
  {
    field: 'sellingPoints',
    patterns: ['有什么优惠', '有什么活动', '卖点', '有什么好', '优势', '特色', '亮点'],
    wrap: (value) => value,
  },
];

/** 裁剪答案：超长直接截断（宁可少说，也不要说一长串） */
function clampAnswer(text: string): string {
  const trimmed = text.trim();
  return trimmed.length <= FAQ_ANSWER_MAX_LENGTH
    ? trimmed
    : `${trimmed.slice(0, FAQ_ANSWER_MAX_LENGTH)}…`;
}

/**
 * 由商品快照构建内置固定回复。
 * 快照为空 / 字段缺失 → 对应条目直接不产生（不会凭空编答案）。
 */
export function buildBuiltinFaq(
  snapshot: Record<string, string> | null | undefined,
): FaqEntry[] {
  if (!snapshot) {
    return [];
  }
  const entries: FaqEntry[] = [];
  for (const spec of BUILTIN_FAQ_SPECS) {
    const raw = snapshot[spec.field];
    if (typeof raw !== 'string' || raw.trim().length === 0) {
      continue;
    }
    entries.push({
      field: spec.field,
      patterns: spec.patterns,
      answer: clampAnswer(spec.wrap(raw.trim(), snapshot)),
    });
  }
  return entries;
}

/**
 * 在弹幕里找固定回复。
 *
 * 高置信门槛（两道，任一不满足即视为未命中，交给 AI）：
 *   1. 弹幕长度 ≤ FAQ_HIGH_CONFIDENCE_MAX_DANMAKU_LENGTH —— 长句多半在叙述而非提问；
 *   2. 必须真的包含某个问法。
 *
 * 多条命中时取**问法最长**的那条（越长越具体，「什么套餐」比「什么」更准）。
 */
export function matchFaq(
  content: string,
  entries: readonly FaqEntry[],
): FaqMatch | null {
  const text = content.trim();
  if (text.length === 0 || text.length > FAQ_HIGH_CONFIDENCE_MAX_DANMAKU_LENGTH) {
    return null;
  }
  let best: FaqMatch | null = null;
  for (const entry of entries) {
    for (const pattern of entry.patterns) {
      if (!text.includes(pattern)) {
        continue;
      }
      if (best === null || pattern.length > best.pattern.length) {
        best = { entry, pattern };
      }
    }
  }
  return best;
}
