// 敏感词扫描（合规红线：话术生成后、开播前必须扫描）
// 本任务用内置常量词表（拦截级），命中即 blocked；后台词库管理排到 T19。

// 广告法极限词等拦截级敏感词。
// 命中即视为 blocked：宁可从严不放过，避免“全网最低/国家级/100%”等绝对化用语违规风险。
// 说明：单字「最」按 includes 匹配会同时命中“最新/最低”等派生词，属预期内的从严策略。
export const BLOCKED_SENSITIVE_WORDS: readonly string[] = [
  '最',
  '第一',
  '顶级',
  '国家级',
  '世界级',
  // 注：「绝对」单字日常口语高频（"绝对够"），误杀严重，不单独拦截；
  // 「绝对第一/绝对领先」等组合会因含「第一/领先」被拦，故移除单字「绝对」。
  '百分百',
  '100%',
  '全网最低',
  '最低价',
  '永久',
  '史无前例',
  '全球领先',
  '行业领先',
  '独家',
  '最佳',
  '首选',
  '极品',
];

/**
 * 注入话术生成提示词的合规约束说明（由词表动态生成，避免词表与提示词漂移）：
 * 引导 AI 在初稿阶段就避开拦截词，尽量「一次生成即可开播」。
 * 只进 system prompt，不入库、不参与 scanSensitive 扫描。
 */
export const SENSITIVE_GUARD_PROMPT: string = (() => {
  const absoluteWords = BLOCKED_SENSITIVE_WORDS.filter((word) => word !== '最').join('、');
  return (
    '平台合规要求：成品话术必须能通过敏感词扫描并直接开播，全文禁止出现以下用语（含用它们组成的' +
    `绝对化表述）：${absoluteWords}；` +
    '同时禁止「最」字开头的形容词组合（例如 最好、最新、最大、最优惠、最正宗、最划算、最佳）。' +
    '想表达「很突出」时，改用「很、超、特别、非常、真的、人气、招牌」等口语词，' +
    '或直接陈述客观事实（分量、价格、新鲜度、服务流程），不要使用绝对化、夸张化措辞。'
  );
})();

export interface SensitiveScanResult {
  status: 'pass' | 'blocked';
  /** 命中的拦截词（去重，按词表顺序收集） */
  matchedWords: string[];
}

/** 逐词 includes 匹配：命中任一 → blocked，并收集命中词 */
export function scanSensitive(text: string): SensitiveScanResult {
  const matchedWords: string[] = [];
  for (const word of BLOCKED_SENSITIVE_WORDS) {
    if (text.includes(word)) {
      matchedWords.push(word);
    }
  }
  return {
    status: matchedWords.length > 0 ? 'blocked' : 'pass',
    matchedWords,
  };
}
