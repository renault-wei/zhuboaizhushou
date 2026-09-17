// R32 第 1 层固定回复单测：纯函数，不碰 DB、不碰网络、不调 AI。
// 这一层的价值就是「零 AI、零延迟、零幻觉」—— 所以它一个测试都不该需要模型。

import { describe, expect, it } from 'vitest';
import {
  buildBuiltinFaq,
  FAQ_ANSWER_MAX_LENGTH,
  FAQ_HIGH_CONFIDENCE_MAX_DANMAKU_LENGTH,
  matchFaq,
} from '../src/services/faq';

const SNAPSHOT = {
  name: '双人火锅套餐',
  package: '毛肚 + 鸭肠 + 两份主食',
  price: '99 元',
  sellingPoints: '锅底现炒，食材新鲜',
};

describe('R32 buildBuiltinFaq 由商品快照构建固定回复', () => {
  it('四个结构化字段各出一条，答案用商家自己填的值（不是猜的）', () => {
    const entries = buildBuiltinFaq(SNAPSHOT);
    expect(entries.map((entry) => entry.field).sort()).toEqual([
      'name',
      'package',
      'price',
      'sellingPoints',
    ]);
    const price = entries.find((entry) => entry.field === 'price');
    expect(price?.answer).toBe('咱家双人火锅套餐是99 元');
    const pkg = entries.find((entry) => entry.field === 'package');
    expect(pkg?.answer).toBe('套餐里是毛肚 + 鸭肠 + 两份主食');
  });

  it('快照为空 / 字段缺失 → 不产生条目（**绝不凭空编答案**）', () => {
    expect(buildBuiltinFaq(null)).toEqual([]);
    expect(buildBuiltinFaq({})).toEqual([]);
    expect(buildBuiltinFaq({ price: '   ' })).toEqual([]);
    expect(buildBuiltinFaq({ price: '99 元' })).toHaveLength(1);
  });

  it('答案超长会被裁剪（用户拍板 D5：短答案，说错了伤害小）', () => {
    const entries = buildBuiltinFaq({ sellingPoints: '好'.repeat(200) });
    expect(entries[0]?.answer.length).toBeLessThanOrEqual(FAQ_ANSWER_MAX_LENGTH + 1);
    expect(entries[0]?.answer.endsWith('…')).toBe(true);
  });
});

describe('R32 matchFaq 匹配', () => {
  const entries = buildBuiltinFaq(SNAPSHOT);

  it('同义问法成组：多种问价方式都能命中', () => {
    for (const ask of ['多少钱？', '多钱', '什么价', '怎么卖', '几块', '贵不贵', '价格是多少']) {
      expect(matchFaq(ask, entries)?.entry.field).toBe('price');
    }
  });

  it('不相关的话不命中', () => {
    expect(matchFaq('主播声音真好听', entries)).toBeNull();
    expect(matchFaq('', entries)).toBeNull();
  });

  it('高置信门槛：**长句里夹带关键词不算命中**（用户在叙述，不是在问）', () => {
    // 这句包含「多少钱」但语境完全不是问价
    const long = '上次那个多少钱的套餐我买过了，不过我今天还想再问一下有没有别的活动';
    expect(long.length).toBeGreaterThan(FAQ_HIGH_CONFIDENCE_MAX_DANMAKU_LENGTH);
    expect(matchFaq(long, entries)).toBeNull();
    // 同一句话截短到门槛内就会命中 —— 证明门槛确实在起作用，不是别的分支挡的
    expect(matchFaq('那个多少钱', entries)?.entry.field).toBe('price');
  });

  it('多条命中时取**问法最长**的那条（越长越具体）', () => {
    // 「什么套餐」与「套餐」都在 package 组；构造同时含两组问法的句子
    const hit = matchFaq('你们这个包含什么', entries);
    expect(hit?.entry.field).toBe('package');
    expect(hit?.pattern).toBe('包含什么');
  });

  it('命中结果回带**实际命中的问法**（便于商家分析哪条问法总在误命中）', () => {
    const hit = matchFaq('这个几块', entries);
    expect(hit?.pattern).toBe('几块');
  });
});
