import { describe, expect, it } from 'vitest';
import {
  ATMOSPHERE_CATEGORIES,
  isAtmosphereCategory,
  NICKNAME_PLACEHOLDER,
  renderAtmosphereText,
} from '../src/services/atmosphere';

describe('atmosphere 氛围台词纯函数', () => {
  it('类别白名单完整且可判定', () => {
    expect(ATMOSPHERE_CATEGORIES).toEqual(['welcome', 'follow', 'thumb', 'clock', 'custom']);
    for (const category of ATMOSPHERE_CATEGORIES) {
      expect(isAtmosphereCategory(category)).toBe(true);
    }
    expect(isAtmosphereCategory('evil')).toBe(false);
    expect(isAtmosphereCategory(undefined)).toBe(false);
  });

  it('无昵称上下文把 {昵称} 替换为空，避免念出占位符', () => {
    expect(renderAtmosphereText('欢迎{昵称}来到直播间', null)).toBe('欢迎来到直播间');
    expect(renderAtmosphereText('欢迎{昵称}来到直播间', '')).toBe('欢迎来到直播间');
  });

  it('有昵称时替换占位符，原文本不变', () => {
    expect(renderAtmosphereText('欢迎{昵称}来到直播间', '老王')).toBe('欢迎老王来到直播间');
  });

  it('不含占位符的文本原样返回', () => {
    expect(renderAtmosphereText('感谢点赞支持', '老王')).toBe('感谢点赞支持');
  });

  it('多个占位符全部替换', () => {
    expect(renderAtmosphereText('{昵称}您好，欢迎{昵称}～', '小美')).toBe('小美您好，欢迎小美～');
    expect(NICKNAME_PLACEHOLDER).toBe('{昵称}');
  });
});