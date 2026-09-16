// 账号级直播设置 API（R21/R27）：智能回复开关/频次、补充知识、自定义违禁词、语速默认档。
//
// 为什么是账号级（用户 2026-09-17 拍板）：一个商家一套直播习惯，不该每开一场重配一次；
// 竞品是每次开播把 thisset 带上去，我们反过来把它沉淀在账号上。
//
// PATCH 语义：只改传来的字段，其余保持原值（先读当前 → 合并 → 整行 upsert）。

import type { FastifyPluginAsync } from 'fastify';
import {
  AUTO_END_MAX_MINUTES,
  loadUserLiveSettings,
  MAX_SETTINGS_TEXT_LENGTH,
  REPLY_INTERVAL_MAX_SECONDS,
  REPLY_INTERVAL_MIN_SECONDS,
  saveUserLiveSettings,
  SPEECH_RATE_MAX,
  SPEECH_RATE_MIN,
  type UserLiveSettings,
} from '../services/liveSettings';

/** 校验失败：带字段名，方便前端定位输入框 */
function invalid(message: string): { error: string; message: string } {
  return { error: 'SETTING_INVALID', message };
}

/** 读取可空文本字段：null / 空串都归一为 null（= 未设置） */
function readNullableText(value: unknown, limit: number): { ok: true; value: string | null } | { ok: false; error: string } {
  if (value === null || value === undefined || value === '') {
    return { ok: true, value: null };
  }
  if (typeof value !== 'string') {
    return { ok: false, error: '必须是文本' };
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return { ok: true, value: null };
  }
  if (trimmed.length > limit) {
    return { ok: false, error: `不能超过 ${limit} 字` };
  }
  return { ok: true, value: trimmed };
}

export const liveSettingsRoutes: FastifyPluginAsync = async (app) => {
  app.get('/api/me/live-settings', { preHandler: app.authenticate }, async (request) => {
    return { settings: await loadUserLiveSettings(request.user.userId) };
  });

  app.patch('/api/me/live-settings', { preHandler: app.authenticate }, async (request, reply) => {
    const raw = request.body;
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      return reply.code(400).send(invalid('请求体必须是对象'));
    }
    const body = raw as Record<string, unknown>;
    const current = await loadUserLiveSettings(request.user.userId);
    const next: UserLiveSettings = { ...current };

    if ('replyEnabled' in body) {
      if (typeof body.replyEnabled !== 'boolean') {
        return reply.code(400).send(invalid('replyEnabled 必须是布尔值'));
      }
      next.replyEnabled = body.replyEnabled;
    }

    if ('replyIntervalSeconds' in body) {
      const value = body.replyIntervalSeconds;
      if (
        typeof value !== 'number' ||
        !Number.isInteger(value) ||
        value < REPLY_INTERVAL_MIN_SECONDS ||
        value > REPLY_INTERVAL_MAX_SECONDS
      ) {
        return reply
          .code(400)
          .send(
            invalid(
              `replyIntervalSeconds 需为 ${REPLY_INTERVAL_MIN_SECONDS}-${REPLY_INTERVAL_MAX_SECONDS} 的整数`,
            ),
          );
      }
      next.replyIntervalSeconds = value;
    }

    if ('replyExtraKnowledge' in body) {
      const parsed = readNullableText(body.replyExtraKnowledge, MAX_SETTINGS_TEXT_LENGTH);
      if (!parsed.ok) {
        return reply.code(400).send(invalid(`replyExtraKnowledge ${parsed.error}`));
      }
      next.replyExtraKnowledge = parsed.value;
    }

    if ('bannedWords' in body) {
      const parsed = readNullableText(body.bannedWords, MAX_SETTINGS_TEXT_LENGTH);
      if (!parsed.ok) {
        return reply.code(400).send(invalid(`bannedWords ${parsed.error}`));
      }
      next.bannedWords = parsed.value;
    }

    if ('defaultSpeechRate' in body) {
      const value = body.defaultSpeechRate;
      if (value === null || value === undefined || value === '') {
        next.defaultSpeechRate = null;
      } else if (
        typeof value !== 'number' ||
        !Number.isInteger(value) ||
        value < SPEECH_RATE_MIN ||
        value > SPEECH_RATE_MAX
      ) {
        return reply
          .code(400)
          .send(invalid(`defaultSpeechRate 需为 ${SPEECH_RATE_MIN}~${SPEECH_RATE_MAX} 的整数或 null`));
      } else {
        next.defaultSpeechRate = value;
      }
    }

    const saved = await saveUserLiveSettings(request.user.userId, next);
    return { settings: saved };
  });

  // 定时关播的上下限对外暴露一次，避免前端硬编码（R26 会用到）
  app.get('/api/me/live-settings/limits', async () => {
    return {
      replyIntervalSeconds: {
        min: REPLY_INTERVAL_MIN_SECONDS,
        max: REPLY_INTERVAL_MAX_SECONDS,
      },
      autoEndMinutes: { min: 10, max: AUTO_END_MAX_MINUTES },
      defaultSpeechRate: { min: SPEECH_RATE_MIN, max: SPEECH_RATE_MAX },
      maxTextLength: MAX_SETTINGS_TEXT_LENGTH,
    };
  });
};
