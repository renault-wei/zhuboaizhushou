import { describe, expect, it } from 'vitest';
import {
  BLOCKED_SENSITIVE_WORDS,
  SENSITIVE_GUARD_PROMPT,
  SUGGESTED_SENSITIVE_WORDS,
  scanSensitive,
} from '../src/services/sensitive';

// 敏感词两级词表 + 「最」类误杀治理（D2）纯函数单测：不依赖 DB / 网络。
describe('scanSensitive 两级词表', () => {
  it('拦截级命中 → blocked 并收集命中词', () => {
    const hit = scanSensitive('这是全网最低价，本店最正宗的老火锅。');
    expect(hit.status).toBe('blocked');
    expect(hit.matchedWords).toContain('全网最低');
    expect(hit.matchedWords).toContain('最低价');
    expect(hit.matchedWords).toContain('最正宗');
  });

  it('「最」类误杀治理：最近/最新/最初等时间序数表达不硬拦', () => {
    for (const text of [
      '最近新上架的锅底，欢迎来尝。',
      '这是最新一批到店的毛肚。',
      '最初只想做街坊生意，现在还是。',
      '打烊前最后 30 分钟还能进店。',
      '最早 9 点开始营业。',
    ]) {
      const scan = scanSensitive(text);
      expect(scan.status, text).toBe('pass');
      expect(scan.matchedWords, text).toEqual([]);
    }
  });

  it('L2 疑似级只提示不阻断', () => {
    const scan = scanSensitive('本店最多可同时接待 60 位客人；这是最新一批到店的毛肚。');
    expect(scan.status).toBe('pass');
    expect(scan.matchedWords).toEqual([]);
    expect(scan.warnWords).toContain('最多');
    expect(scan.warnWords).toContain('最新');
  });

  it('营销性固定搭配仍硬拦：最好吃/最优惠/100%/第一', () => {
    for (const text of [
      '全城最好吃的毛肚，快来尝。',
      '本店最优惠的双人套餐。',
      '锅底百分百牛油熬制。',
      '我们是这条街的第一家火锅店。',
    ]) {
      expect(scanSensitive(text).status, text).toBe('blocked');
    }
  });

  it('独立「最好」不进拦截级（避免「最好提前预约」被硬拦），但仍提示', () => {
    const scan = scanSensitive('周末人多，建议大家最好提前预约。');
    expect(scan.status).toBe('pass');
    expect(scan.matchedWords).toEqual([]);
    expect(scan.warnWords).toContain('最好');
  });

  it('干净话术 → pass 且两个命中数组皆空', () => {
    const clean = scanSensitive('锅底现炒、毛肚脆嫩，双人套餐 99 元，欢迎到店品尝。');
    expect(clean.status).toBe('pass');
    expect(clean.matchedWords).toEqual([]);
    expect(clean.warnWords).toEqual([]);
  });

  it('词表自洽：L1/L2 不重复（避免口径漂移）', () => {
    const l1 = new Set(BLOCKED_SENSITIVE_WORDS);
    const overlap = SUGGESTED_SENSITIVE_WORDS.filter((word) => l1.has(word));
    expect(overlap).toEqual([]);
    expect(BLOCKED_SENSITIVE_WORDS).not.toContain('最');
    expect(SUGGESTED_SENSITIVE_WORDS).toContain('最好');
  });

  it('生成提示词提及禁用语但不含单字「最」整字禁令（治理后口径）', () => {
    expect(SENSITIVE_GUARD_PROMPT).toContain('最优惠');
    expect(SENSITIVE_GUARD_PROMPT).toContain('最近');
    expect(SENSITIVE_GUARD_PROMPT).not.toContain('禁止「最」字开头');
  });
});

