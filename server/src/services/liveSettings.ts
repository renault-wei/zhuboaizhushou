// 账号级直播设置（R21/R27）：智能回复开关与频次、补充知识、自定义违禁词、语速默认档。
//
// 决策来源（2026-09-17 用户拍板，见 docs/LIVE-SETTINGS-PLAN.md §4）：
//   * 配置放**账号级**（不是场次级）—— 一个商家一份
//   * **绑定话术优先**，补充知识只作更正补充、不覆盖
//   * 自定义违禁词命中后**整条丢弃不播**（区别于平台内置词库的「改兜底话术」）
//   * 语速：账号级默认 + 场次可覆盖

import { eq } from 'drizzle-orm';
import { db } from '../db/client';
import { userLiveSettings as userLiveSettingsTable } from '../db/schema';

/** 回复间隔（秒）上下限：对齐竞品 replyOptions 的「自定义 1~60s」 */
export const REPLY_INTERVAL_MIN_SECONDS = 1;
export const REPLY_INTERVAL_MAX_SECONDS = 60;
/** 与旧硬编码 DEFAULT_REPLY_INTERVAL_MS = 5000 同值，避免存量行为突变 */
export const DEFAULT_REPLY_INTERVAL_SECONDS = 5;

/** 定时关播（分钟）：最低 10 对齐竞品；上限 24 小时 */
export const AUTO_END_MIN_MINUTES = 10;
export const AUTO_END_MAX_MINUTES = 1440;

/** 补充知识 / 违禁词表的长度上限（违禁词沿用竞品 maxlength=2000） */
export const MAX_SETTINGS_TEXT_LENGTH = 2000;

/** 语速档（火山 speech_rate 口径）：与场次滑块同一区间 */
export const SPEECH_RATE_MIN = -20;
export const SPEECH_RATE_MAX = 60;

export interface UserLiveSettings {
  replyEnabled: boolean;
  replyIntervalSeconds: number;
  replyExtraKnowledge: string | null;
  bannedWords: string | null;
  defaultSpeechRate: number | null;
}

/** 无记录时的默认值：保持与「上线前硬编码」完全一致，存量行为零突变 */
export const DEFAULT_USER_LIVE_SETTINGS: UserLiveSettings = {
  replyEnabled: true,
  replyIntervalSeconds: DEFAULT_REPLY_INTERVAL_SECONDS,
  replyExtraKnowledge: null,
  bannedWords: null,
  defaultSpeechRate: null,
};

/** 读账号级设置：无记录返回默认值（不写库 —— 读路径不该有副作用） */
export async function loadUserLiveSettings(userId: string): Promise<UserLiveSettings> {
  const rows = await db
    .select()
    .from(userLiveSettingsTable)
    .where(eq(userLiveSettingsTable.userId, userId))
    .limit(1);
  const row = rows[0];
  if (!row) {
    return { ...DEFAULT_USER_LIVE_SETTINGS };
  }
  return {
    replyEnabled: row.replyEnabled,
    replyIntervalSeconds: row.replyIntervalSeconds,
    replyExtraKnowledge: row.replyExtraKnowledge,
    bannedWords: row.bannedWords,
    defaultSpeechRate: row.defaultSpeechRate,
  };
}

/** 写账号级设置：整行 upsert（PATCH 语义在路由层合并后再调用） */
export async function saveUserLiveSettings(
  userId: string,
  settings: UserLiveSettings,
): Promise<UserLiveSettings> {
  const rows = await db
    .insert(userLiveSettingsTable)
    .values({
      userId,
      replyEnabled: settings.replyEnabled,
      replyIntervalSeconds: settings.replyIntervalSeconds,
      replyExtraKnowledge: settings.replyExtraKnowledge,
      bannedWords: settings.bannedWords,
      defaultSpeechRate: settings.defaultSpeechRate,
    })
    .onConflictDoUpdate({
      target: userLiveSettingsTable.userId,
      set: {
        replyEnabled: settings.replyEnabled,
        replyIntervalSeconds: settings.replyIntervalSeconds,
        replyExtraKnowledge: settings.replyExtraKnowledge,
        bannedWords: settings.bannedWords,
        defaultSpeechRate: settings.defaultSpeechRate,
        updatedAt: new Date(),
      },
    })
    .returning();
  const row = rows[0];
  if (!row) {
    throw new Error('保存直播设置失败');
  }
  return {
    replyEnabled: row.replyEnabled,
    replyIntervalSeconds: row.replyIntervalSeconds,
    replyExtraKnowledge: row.replyExtraKnowledge,
    bannedWords: row.bannedWords,
    defaultSpeechRate: row.defaultSpeechRate,
  };
}

/**
 * 解析商家自定义违禁词：**中文顿号**（也兼容英文逗号 / 换行，容错输入）分隔。
 *
 * **单字符词直接丢弃** —— 对齐竞品口径（"后台会直接忽略填写的单字符违禁词"）。
 * 理由：单个汉字几乎必然误伤（"的""了"），一旦生效会让整场话术无法出声。
 */
export function parseBannedWords(raw: string | null | undefined): string[] {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return [];
  }
  const words = raw
    .split(/[、,\n]/)
    .map((word) => word.trim())
    .filter((word) => word.length > 1);
  return [...new Set(words)];
}

/** 命中的自定义违禁词（空表 / 无命中都返回空数组） */
export function matchBannedWords(text: string, words: readonly string[]): string[] {
  if (words.length === 0 || text.length === 0) {
    return [];
  }
  return words.filter((word) => text.includes(word));
}
