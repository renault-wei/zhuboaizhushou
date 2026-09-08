// 敏感词扫描（合规红线：话术生成后、开播前必须扫描）
// D2 两级词表 + 「最」类误杀治理：
// - L1 拦截级（BLOCKED_SENSITIVE_WORDS）：命中即 blocked，阻断开播 / 不落库，宁可从严。
// - L2 疑似级（SUGGESTED_SENSITIVE_WORDS）：可能违规、也可能依赖上下文合规（如「离得最近的分店」
//   「最多等 10 分钟」「最早 9 点营业」），命中不阻断，仅通过 warnWords 输出提示，供生成侧约束与复核。
//
// 「最」字治理口径：不再把单字「最」整字列为拦截词 —— 「最近/最新/最初/最终/最后/最早」等
// 时间/序数表达属于日常合规用语，此前按 includes 整字命中会把整段话术误拦，导致一次生成屡屡失败。
// 真正的高危点是「最 + 营销形容词」的固定搭配（最优惠/最低价/最好吃…），按固定搭配收进 L1，
// 命中依旧从严阻断；其余「最 X」形容性质感词进 L2 只提示，由生成提示词约束模型避开。
export const BLOCKED_SENSITIVE_WORDS: readonly string[] = [
  // 广告法极限词 / 平台绝对化用语（固定搭配，拦截级）
  '第一',
  '顶级',
  '国家级',
  '世界级',
  '百分百',
  '100%',
  '永久',
  '史无前例',
  '全球领先',
  '行业领先',
  '独家',
  '极品',
  '首选',
  '最佳',
  // 低价 / 排名绝对化
  '全网最低',
  '最低价',
  '史上最低',
  '全城最低',
  '全网第一',
  '全国第一',
  '销量第一',
  // 「最」+ 营销形容词固定搭配（替代单字「最」，避免「最近/最新/最终」误杀）
  '最优惠',
  '最实惠',
  '最划算',
  '最便宜',
  '最超值',
  '最正宗',
  '最地道',
  '最好吃',
  '最好喝',
  '最好用',
  '最新鲜',
  '最优质',
  '最专业',
  '最权威',
  '最先进',
  '最顶级',
  '最高级',
];

/**
 * L2 疑似级（只提示不阻断）：上下文敏感、单看未必违法的绝对化质感词。
 * 用途 = 生成提示词防患于未然 + scanSensitive().warnWords 输出给运营/复核；
 * 不作为开播阻断依据（避免「离得最近的分店 / 最多等 10 分钟」这类合规表达被硬拦）。
 */
export const SUGGESTED_SENSITIVE_WORDS: readonly string[] = [
  '最好',
  '最大',
  '最多',
  '最强',
  '最高',
  '最低',
  '最优',
  '最新',
  '最全',
  '最火',
  '最受欢迎',
  '最热门',
  '最值得',
  '最健康',
  '最安全',
  '全网',
];

/**
 * 注入话术生成提示词的合规约束说明（由 L1/L2 词表动态汇总，避免词表与提示词漂移）：
 * 引导 AI 在初稿阶段就避开拦截词，尽量「一次生成即可开播」。
 * 只进 system prompt，不入库、不参与 scanSensitive 的阻断判定。
 */
export const SENSITIVE_GUARD_PROMPT: string = (() => {
  const blockSamples = [
    '最优惠',
    '最划算',
    '最低价',
    '全网最低',
    '最好吃',
    '最正宗',
    '最佳',
    '顶级',
    '国家级',
    '世界级',
    '销量第一',
    '100%',
    '百分百',
    '永久',
    '独家',
  ];
  const warnSamples = [
    '最大',
    '最多',
    '最强',
    '最新',
    '最高',
    '最受欢迎',
    '最安全',
    '最健康',
  ];
  return (
    '平台合规要求：成品话术必须能通过敏感词扫描并直接开播，全文禁止出现绝对化/极限词固定搭配，' +
    `例如：${blockSamples.join('、')}；` +
    '也不要使用「最」字开头的品质或价格宣称（例如：' +
    `${warnSamples.join('、')}），不得声称自己超过全部同类商家。` +
    '时间与序数类的「最近、最新一批、最初、最终、最后」按事实描述可以使用，但不能用于抬高本店商品。' +
    '想表达「很突出」时，改用「很、超、特别、非常、人气、招牌、真材实料、物超所值」等口语词，' +
    '或直接陈述客观事实（分量、价格、新鲜度、服务流程），不要使用绝对化、夸张化措辞。'
  );
})();

export interface SensitiveScanResult {
  status: 'pass' | 'blocked';
  /** 命中的拦截词（去重，按词表顺序收集）；命中任一即 blocked */
  matchedWords: string[];
  /** L2 疑似级命中词（仅提示，不影响 status） */
  warnWords: string[];
}

/** 逐词 includes 匹配：L1 命中任一 → blocked；L2 命中只进 warnWords */
export function scanSensitive(text: string): SensitiveScanResult {
  const matchedWords: string[] = [];
  for (const word of BLOCKED_SENSITIVE_WORDS) {
    if (text.includes(word)) {
      matchedWords.push(word);
    }
  }
  const warnWords: string[] = [];
  for (const word of SUGGESTED_SENSITIVE_WORDS) {
    if (text.includes(word)) {
      warnWords.push(word);
    }
  }
  return {
    status: matchedWords.length > 0 ? 'blocked' : 'pass',
    matchedWords,
    warnWords,
  };
}

