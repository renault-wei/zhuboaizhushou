import { describe, expect, it } from 'vitest';
import {
  ATMOSPHERE_CATEGORIES,
  ATMOSPHERE_DEFAULT_TEMPLATES,
  ATMOSPHERE_FREQUENCY_DISABLED_SECONDS,
  ATMOSPHERE_FREQUENCY_RULES,
  ATMOSPHERE_INSERT_PRIORITY,
  ATMOSPHERE_PLACEHOLDERS,
  LEGACY_NICKNAME_PLACEHOLDER,
  MAX_ATMOSPHERE_TEXT_LENGTH,
  formatClockTime,
  isAtmosphereCategory,
  isValidAtmosphereInterval,
  pickAtmosphereText,
  renderAtmosphereLine,
  splitAtmosphereLines,
} from '../src/services/atmosphere';
import { scanSensitive } from '../src/services/sensitive';

// M10-A1 氛围语模板引擎纯函数测试：全注入固定随机源，不碰 DB、不出真实声音。

/** 固定随机源：始终取第一个候选（可预测） */
const pickFirst = () => 0;
/** 固定随机源：始终取最后一个候选 */
const pickLast = () => 0.999999;

describe('M10-A1 atmosphere 氛围语模板引擎', () => {
  it('类别白名单与插播优先级一致，且覆盖全部类别', () => {
    expect(ATMOSPHERE_CATEGORIES).toEqual(['welcome', 'follow', 'thumb', 'clock', 'custom']);
    for (const category of ATMOSPHERE_CATEGORIES) {
      expect(isAtmosphereCategory(category)).toBe(true);
    }
    expect(isAtmosphereCategory('evil')).toBe(false);
    expect(isAtmosphereCategory(undefined)).toBe(false);
    // 优先级表不重不漏（空档插播按此顺序扫描）
    expect([...ATMOSPHERE_INSERT_PRIORITY].sort()).toEqual([...ATMOSPHERE_CATEGORIES].sort());
    expect(new Set(ATMOSPHERE_INSERT_PRIORITY).size).toBe(ATMOSPHERE_INSERT_PRIORITY.length);
  });

  it('多行模板按行拆候选：trim + 丢空行 + 兼容 CRLF', () => {
    expect(splitAtmosphereLines('  第一句  \n\n第二句\r\n   \n第三句')).toEqual([
      '第一句',
      '第二句',
      '第三句',
    ]);
    expect(splitAtmosphereLines('   ')).toEqual([]);
  });

  it('占位符渲染：[昵称] 与历史别名 {昵称} 等价', () => {
    expect(renderAtmosphereLine('欢迎[昵称]来到直播间', { nickname: '老王' })).toBe(
      '欢迎老王来到直播间',
    );
    expect(renderAtmosphereLine(`欢迎${LEGACY_NICKNAME_PLACEHOLDER}来到直播间`, { nickname: '老王' })).toBe(
      '欢迎老王来到直播间',
    );
    expect(
      renderAtmosphereLine('{A|B}您好，欢迎[昵称]～', { nickname: '小美' }, pickFirst),
    ).toBe('A您好，欢迎小美～');
  });

  it('占位符取不到值 → 该行不可用（返回 null，绝不念出占位符）', () => {
    expect(renderAtmosphereLine('欢迎[昵称]来到直播间', {})).toBeNull();
    expect(renderAtmosphereLine('欢迎[昵称]来到直播间', { nickname: '   ' })).toBeNull();
    expect(renderAtmosphereLine('现在是[时间]啦', {})).toBeNull();
    expect(renderAtmosphereLine('在线[在线人数]位朋友', { onlineCount: 0 })).toBeNull();
    // 不含占位符的行始终可渲染
    expect(renderAtmosphereLine('感谢点赞支持', {})).toBe('感谢点赞支持');
  });

  it('时间与在线人数渲染', () => {
    const at = new Date();
    at.setHours(9, 5, 30, 0);
    expect(renderAtmosphereLine('现在是[时间]啦', { nowMs: at.getTime() })).toBe('现在是09:05啦');
    expect(renderAtmosphereLine('在线[在线人数]位朋友', { onlineCount: 42 })).toBe('在线42位朋友');
    expect(formatClockTime(at.getTime())).toBe('09:05');
  });

  it('随机词 {A|B|C} 按随机源取词，空选项丢弃', () => {
    expect(renderAtmosphereLine('{咱们|本店}的套餐', {}, pickFirst)).toBe('咱们的套餐');
    expect(renderAtmosphereLine('{咱们|本店}的套餐', {}, pickLast)).toBe('本店的套餐');
    expect(renderAtmosphereLine('{|本店|}的套餐', {}, pickFirst)).toBe('本店的套餐');
    // 无竖线不是随机词，原样保留（与 {昵称} 别名区分）
    expect(renderAtmosphereLine('{昵称}点点关注', {})).toBeNull();
  });

  it('多行模板随机挑一行：跳过不可用行，全部不可用返回 null', () => {
    const text = ['欢迎[昵称]来到直播间', '感谢点赞支持', '现在是[时间]啦'].join('\n');
    // 随机起点 0：第一行需要昵称 → 跳过，落到第二行
    expect(pickAtmosphereText(text, {}, pickFirst)).toBe('感谢点赞支持');
    expect(pickAtmosphereText('欢迎[昵称]来到直播间\n谢谢[昵称]的关注', {}, pickFirst)).toBeNull();
    expect(pickAtmosphereText('   \n  ', {}, pickFirst)).toBeNull();
  });

  it('频率取值校验：0 = 不插播，其余按类别范围', () => {
    expect(ATMOSPHERE_FREQUENCY_DISABLED_SECONDS).toBe(0);
    expect(isValidAtmosphereInterval('welcome', 0)).toBe(true);
    expect(isValidAtmosphereInterval('welcome', 60)).toBe(true);
    expect(isValidAtmosphereInterval('welcome', 300)).toBe(true);
    expect(isValidAtmosphereInterval('welcome', 301)).toBe(false);
    expect(isValidAtmosphereInterval('welcome', -1)).toBe(false);
    expect(isValidAtmosphereInterval('welcome', 1.5)).toBe(false);
    expect(isValidAtmosphereInterval('clock', 30)).toBe(false);
    expect(isValidAtmosphereInterval('clock', 60)).toBe(true);
    expect(isValidAtmosphereInterval('clock', 3000)).toBe(true);
    expect(isValidAtmosphereInterval('clock', '60')).toBe(false);
  });

  it('默认模板：五类齐全、每类至少一条可在「无昵称」定时插播下渲染、全部合规且不超上限', () => {
    for (const category of ATMOSPHERE_CATEGORIES) {
      const text = ATMOSPHERE_DEFAULT_TEMPLATES[category];
      expect(text.length).toBeGreaterThan(0);
      expect(text.length).toBeLessThanOrEqual(MAX_ATMOSPHERE_TEXT_LENGTH);
      // 采集器（B1）到位前，定时插播只有无昵称候选行可用 —— 每类都必须留一条
      const at = new Date();
      at.setHours(10, 30, 0, 0);
      expect(pickAtmosphereText(text, { nowMs: at.getTime() })).not.toBeNull();
      // 默认文案同样要过开播前的敏感词扫描（开箱即用）
      expect(scanSensitive(text).status).toBe('pass');
    }
    expect(ATMOSPHERE_FREQUENCY_RULES.welcome.defaultSeconds).toBe(60);
    expect(ATMOSPHERE_PLACEHOLDERS).toEqual(['昵称', '问题', '答案', '时间', '在线人数']);
  });
});
