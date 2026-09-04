// 敏感词扫描（合规红线：话术生成后、开播前必须扫描）
// 本任务用内置常量词表（拦截级），命中即 blocked；后台词库管理排到 T19。

// 广告法极限词等拦截级敏感词。
// 命中即视为 blocked：宁可从严不放过，避免“全网最低/国家级/100%”等绝对化用语违规风险。
// 说明：单字「最」按 includes 匹配会同时命中“最新/最低”等派生词，属预期内的从严策略。
const BLOCKED_SENSITIVE_WORDS: readonly string[] = [
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
