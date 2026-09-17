// R41 弹幕质量分类单测：纯函数，不碰 DB / 网络 / AI。
// 用户 2026-09-17 定调：「闲聊算无效」，有效的尽量都回、无效的一条都不回。

import { describe, expect, it } from 'vitest';
import { classifyDanmaku, isWorthReplying, REPLY_WORTHY_QUALITIES } from '../src/services/danmakuQuality';

describe('R41 classifyDanmaku 分类', () => {
  it('提问：问号或疑问词都算', () => {
    for (const text of [
      '多少钱？',
      '这个多少钱',
      '你们几点营业',
      '店在哪里',
      '可以核销吗',
      '有优惠吗',
      '能便宜点吗',
      'how much?',
    ]) {
      expect(classifyDanmaku(text)).toBe('question');
    }
  });

  it('需求表达：已经在表达购买意愿', () => {
    // 注意：「能便宜点吗」带疑问助词「吗」→ 归 question（两者都值得回，只是分类不同）
    for (const text of ['我想要这个', '给我来一份', '下单了']) {
      expect(classifyDanmaku(text)).toBe('need');
    }
  });

  it('问候单独成一类（**不占互动名额**，交给氛围语）', () => {
    for (const text of ['主播好', '你好', '哈喽', '晚上好', '我来了']) {
      expect(classifyDanmaku(text)).toBe('greeting');
    }
  });

  it('灌水：纯符号 / 重复字符 / 纯语气词', () => {
    for (const text of ['66666666', '哈哈哈哈哈', '🎉🎉🎉', '啊啊啊啊', '......']) {
      expect(classifyDanmaku(text)).toBe('spam');
    }
  });

  it('广告引流：特征词与联系方式形态', () => {
    for (const text of ['加微信详聊', 'vx12345678', '互关互粉', '私信我带货']) {
      expect(classifyDanmaku(text)).toBe('spam');
    }
  });

  it('闲聊：与商品无关的唠嗑 —— **用户拍板算无效**', () => {
    for (const text of ['今天天气不错', '我家猫也叫豆豆', '刚吃完饭']) {
      expect(classifyDanmaku(text)).toBe('smalltalk');
    }
  });

  it('带内容的语气词不算灌水（避免误伤）', () => {
    // 「哈哈」开头但后面有实质内容 → 不该被判 spam
    expect(classifyDanmaku('哈哈这个套餐我要了')).toBe('need');
    expect(classifyDanmaku('哈哈哈多少钱')).toBe('question');
  });

  it('空内容算灌水', () => {
    expect(classifyDanmaku('')).toBe('spam');
    expect(classifyDanmaku('   ')).toBe('spam');
  });

  it('只有 question / need 值得占用互动名额', () => {
    expect(REPLY_WORTHY_QUALITIES).toEqual(['question', 'need']);
    expect(isWorthReplying('question')).toBe(true);
    expect(isWorthReplying('need')).toBe(true);
    for (const quality of ['greeting', 'smalltalk', 'spam'] as const) {
      expect(isWorthReplying(quality)).toBe(false);
    }
  });
});
