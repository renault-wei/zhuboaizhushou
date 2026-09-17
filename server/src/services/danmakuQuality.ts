// 弹幕质量分类（R41）：把「无效弹幕」挡在互动链路之前。
//
// 为什么必须在**最前面**（docs/INTERACTION-VS-SCRIPT-PRODUCT-2.md §1）：
//   现在的判定顺序是「时间窗限流 → 固定回复 → LLM 判断该不该回」，于是无效弹幕会：
//     ① 抢走时间窗名额，把真问题挤掉（真问题直接消失、永不再来）；
//     ② 照样触发一次 DeepSeek 调用，模型读完返回 NONE —— **花钱买了一句「不说话」**。
//   前置过滤同时解决这两件事，且不依赖任何其它改动。
//
// 用户 2026-09-17 拍板：「闲聊算无效」，其余按推荐（规则 + 长度启发式）。

export type DanmakuQuality =
  /** 提问：问号或疑问词 */
  | 'question'
  /** 需求表达：想要 / 下单 / 便宜点 */
  | 'need'
  /** 问候：主播好 / 来了 —— **不占互动名额**，应交给氛围语的欢迎语（R44） */
  | 'greeting'
  /** 闲聊：与商品无关的唠嗑 —— **用户拍板：无效** */
  | 'smalltalk'
  /** 灌水 / 广告 / 刷屏 */
  | 'spam';

/** 只有这两类才值得占用互动名额（用户定调：有效的尽量都回，无效的一条都不回） */
export const REPLY_WORTHY_QUALITIES: readonly DanmakuQuality[] = ['question', 'need'];

/** 分类结果是否值得回复 */
export function isWorthReplying(quality: DanmakuQuality): boolean {
  return REPLY_WORTHY_QUALITIES.includes(quality);
}

// ---------- 规则表 ----------

/** 疑问词：命中即视为提问（覆盖「多少钱」这类不带问号的问法） */
const QUESTION_MARKERS: readonly string[] = [
  '多少钱', '多钱', '价格', '什么价', '怎么卖', '几块', '贵不贵', '售价',
  '怎么', '如何', '哪里', '在哪', '几点', '多久', '多大', '多少',
  '能不能', '可不可以', '可以吗', '行不行', '是不是', '有没有', '有吗', '好吗',
  '包邮', '地址', '位置', '电话', '营业', '预约', '核销', '退款', '发票',
];

/** 需求表达：已经在表达购买意愿 */
const NEED_MARKERS: readonly string[] = [
  '想要', '我要', '我想', '给我', '来一', '来份', '下单', '买了', '买一',
  '便宜', '优惠', '折扣', '划算',
];

/** 问候：短且无实质内容 */
const GREETING_MARKERS: readonly string[] = [
  '主播好', '你好', '您好', '哈喽', '哈罗', '早上好', '中午好', '晚上好',
  '来了', '我来了', 'hello', 'hi', '嗨',
];

/** 广告 / 引流特征 */
const SPAM_MARKERS: readonly string[] = [
  '加微信', '加我', '私聊', '私信', 'vx', 'wx', 'qq', '威信', '扣扣',
  '互关', '互粉', '涨粉', '带货', '货源', '代发',
];

/** 广告里常见的联系方式形态：字母 + 一串数字 */
const CONTACT_PATTERN = /[a-z]{1,4}[\s_-]?\d{5,}/i;

/** 纯符号 / 纯表情（不含汉字、字母、数字） */
const PURE_SYMBOL_PATTERN = new RegExp('^[^\\p{Script=Han}a-zA-Z0-9]+$', 'u');

/** 同一字符连续重复 4 次以上：「哈哈哈哈哈」「666666」「啊啊啊」 */
const REPEATED_CHAR_PATTERN = /(.)\1{3,}/u;

/**
 * 几乎整句都是语气词：命中即灌水（只在这些词**构成整句**时判定，
 * 避免误伤「哈哈这个套餐我要了」这种带内容的句子）。
 */
const FILLER_PATTERN = /^[哈嘿嘻呵呜哇哦噢额嘤喵6em]+$/iu;

/** 去空白（判断「几乎整句都是语气词」用） */
function compact(text: string): string {
  return text.replace(/\s+/g, '');
}

/**
 * 弹幕质量分类。
 *
 * 判定顺序（**从强到弱**，先命中先返回）：
 *   spam → greeting → question → need → smalltalk
 * 顺序理由：灌水优先挡（最省钱）；问候优先于提问（「主播好，多少钱」算问候，
 * 但「问候不占互动名额」这个语义由上层决定，这里只做分类）。
 */
export function classifyDanmaku(content: string): DanmakuQuality {
  const text = compact(content);
  if (text.length === 0) {
    return 'spam';
  }

  // ---- spam：形态可判，优先挡掉 ----
  if (PURE_SYMBOL_PATTERN.test(text)) {
    return 'spam';
  }
  if (REPEATED_CHAR_PATTERN.test(text)) {
    return 'spam';
  }
  if (FILLER_PATTERN.test(text)) {
    return 'spam';
  }
  const lower = text.toLowerCase();
  if (SPAM_MARKERS.some((marker) => lower.includes(marker))) {
    return 'spam';
  }
  if (CONTACT_PATTERN.test(text)) {
    return 'spam';
  }

  // ---- greeting ----
  if (GREETING_MARKERS.some((marker) => lower.includes(marker))) {
    return 'greeting';
  }

  // ---- question：问号、中文疑问助词，或命中疑问词 ----
  // 疑问助词（吗/呢）是「在问」的语言标记：「有优惠吗」是提问，不该被归到需求表达。
  // 这条是单测抓出来的 —— 我最初只列了疑问词，漏了中文最常见的疑问标记。
  if (text.includes('?') || text.includes('？')) {
    return 'question';
  }
  if (text.includes('吗') || text.includes('呢')) {
    return 'question';
  }
  if (QUESTION_MARKERS.some((marker) => text.includes(marker))) {
    return 'question';
  }

  // ---- need ----
  if (NEED_MARKERS.some((marker) => text.includes(marker))) {
    return 'need';
  }

  // ---- 兜底：闲聊（用户拍板：无效） ----
  return 'smalltalk';
}
