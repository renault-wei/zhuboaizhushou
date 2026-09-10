import type { FastifyPluginAsync } from 'fastify';
import { readFile, unlink } from 'node:fs/promises';
import { and, desc, eq } from 'drizzle-orm';
import { db } from '../db/client';
import { users, voiceAgreements, voices } from '../db/schema';
import { getLatestVoiceAgreement } from '../services/agreement';
import { env } from '../config/env';
import { cosyVoiceService } from '../services/voice';
import {
  DEFAULT_VOLC_PRESET_ID,
  isVolcPresetId,
  VOLC_PRESET_GROUPS,
  VOLC_PRESET_VOICES,
} from '../services/volcPresets';
import { VolcTtsError, volcTtsSynth } from '../services/volcTTS';

// ---------- 常量 ----------

// mock 状态推进阈值：创建后 3 秒内保持 pending，3-8 秒为 processing，8 秒后 ready
const CLONE_PENDING_AFTER_MS = 3 * 1000;
const CLONE_READY_AFTER_MS = 8 * 1000;

// 录音样本最短时长（秒）：声音克隆前必须确认录音达到 1 分钟（MVP 口径：2 段念稿）
const MIN_SAMPLE_DURATION_SECONDS = 60;
// 音色名称长度上限（字），与 voices.name 的 varchar(50) 对齐
const MAX_NAME_LENGTH = 50;

interface VoiceIdParams {
  id: string;
}

// 音色 id 为数据库 uuid：形态不符时直接按「不存在」处理，
// 避免把非法字符串透传给 PostgreSQL 触发 uuid 转换 500。
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 试听演示短句：固定 30 字左右的小额演示调用，与正式口播话术无关 */
export const VOICE_PREVIEW_TEXT =
  '大家好，欢迎来到直播间，今天给大家介绍咱们的团购套餐，喜欢的可以点个关注。';

/** 读取试听请求体：{ presetId? , voiceId? }——预设与克隆二选一 */
function readPreviewBody(body: unknown): { presetId: string | null; voiceId: string | null } {
  if (typeof body !== 'object' || body === null) {
    return { presetId: null, voiceId: null };
  }
  const record = body as Record<string, unknown>;
  const read = (value: unknown): string | null =>
    typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
  return { presetId: read(record.presetId), voiceId: read(record.voiceId) };
}

/** 读取创建克隆任务请求体：{ name, sampleDurationSeconds, sampleFingerprint } */
function readCreateBody(body: unknown): {
  name: string | null;
  sampleDurationSeconds: number | null;
  sampleFingerprint: string | null;
} {
  if (typeof body !== 'object' || body === null) {
    return { name: null, sampleDurationSeconds: null, sampleFingerprint: null };
  }
  const record = body as Record<string, unknown>;
  const rawName = record.name;
  const name =
    typeof rawName === 'string' && rawName.trim().length > 0 ? rawName.trim() : null;
  const rawDuration = record.sampleDurationSeconds;
  const sampleDurationSeconds =
    typeof rawDuration === 'number' && Number.isInteger(rawDuration) ? rawDuration : null;
  const rawFingerprint = record.sampleFingerprint;
  const sampleFingerprint =
    typeof rawFingerprint === 'string' && rawFingerprint.trim().length > 0
      ? rawFingerprint.trim()
      : null;
  return { name, sampleDurationSeconds, sampleFingerprint };
}

/** 校验登录用户仍存在：token 可能有效但用户已被删除，统一返回 404 */
async function findUserById(userId: string): Promise<{ id: string } | undefined> {
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return rows[0];
}

/** 合规红线：确认当前用户已签署最新版《声音授权协议》 */
async function hasSignedLatestAgreement(userId: string): Promise<boolean> {
  const latest = getLatestVoiceAgreement();
  const rows = await db
    .select({ id: voiceAgreements.id })
    .from(voiceAgreements)
    .where(
      and(
        eq(voiceAgreements.userId, userId),
        eq(voiceAgreements.agreementVersion, latest.version),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/** 音色列表响应字段：只下发客户端需要的列，按 createdAt 倒序 */
const voiceListViewFields = {
  id: voices.id,
  name: voices.name,
  status: voices.status,
  providerVoiceId: voices.providerVoiceId,
  sampleDurationSeconds: voices.sampleDurationSeconds,
  createdAt: voices.createdAt,
} as const;

/**
 * 声音克隆任务路由：创建克隆 / 我的音色列表 / 单个音色状态（轮询）。
 * 全部要求登录态；mock 阶段由 GET :id 在轮询时按创建时间惰性推进状态。
 */
export const voicesRoutes: FastifyPluginAsync = async (app) => {
  // 创建克隆任务：协议校验（合规红线）→ 时长校验 → 名称校验 → 落库 pending
  app.post('/api/voices', { preHandler: app.authenticate }, async (request, reply) => {
    const user = await findUserById(request.user.userId);
    if (!user) {
      return reply.code(404).send({ error: 'USER_NOT_FOUND', message: '用户不存在' });
    }

    if (!(await hasSignedLatestAgreement(request.user.userId))) {
      return reply.code(403).send({
        error: 'AGREEMENT_REQUIRED',
        message: '克隆声音前需先签署《声音授权协议》',
      });
    }

    const { name, sampleDurationSeconds, sampleFingerprint } = readCreateBody(request.body);
    if (sampleDurationSeconds === null || sampleDurationSeconds < MIN_SAMPLE_DURATION_SECONDS) {
      return reply.code(400).send({
        error: 'DURATION_TOO_SHORT',
        message: '录音时长不足 1 分钟',
      });
    }
    if (!name || name.length > MAX_NAME_LENGTH) {
      return reply.code(400).send({
        error: 'NAME_INVALID',
        message: '音色名称不能为空且不超过 50 字',
      });
    }

    const { providerVoiceId } = await cosyVoiceService.createCloneTask({
      userId: request.user.userId,
      name,
      sampleDurationSeconds,
      sampleFingerprint: sampleFingerprint ?? undefined,
    });
    const inserted = await db
      .insert(voices)
      .values({
        userId: request.user.userId,
        name,
        provider: 'cosyvoice',
        providerVoiceId,
        status: 'pending',
        sampleDurationSeconds,
        sampleFingerprint,
      })
      .returning();
    const created = inserted[0];
    if (!created) {
      // 理论上插入成功必有返回，此处兜底避免静默失败
      throw new Error('创建声音克隆任务失败');
    }
    return reply.code(201).send(created);
  });

  // 我的音色列表：仅返回当前用户的音色，按创建时间倒序
  app.get('/api/voices', { preHandler: app.authenticate }, async (request) => {
    const rows = await db
      .select(voiceListViewFields)
      .from(voices)
      .where(eq(voices.userId, request.user.userId))
      .orderBy(desc(voices.createdAt));
    return rows;
  });

  // 火山预设音色目录（只读内置，不调火山接口）：须注册在 /api/voices/:id 之前，避免被 id 路由吞掉
  app.get('/api/voices/presets', { preHandler: app.authenticate }, async () => {
    return {
      presets: VOLC_PRESET_VOICES,
      groups: VOLC_PRESET_GROUPS,
      defaultPresetId: DEFAULT_VOLC_PRESET_ID,
    };
  });

  // 音色试听（档 A）：用固定演示短句做一次真实火山合成，直接回 wav 字节。
  // 计费口径：试听是固定短句的小额演示调用，不计入商家额度、不落 usage_logs
  // （T5 计量只覆盖正式口播合成链路）；克隆音色尚未接入真复刻，试听回落演示预设音色并回告知头。
  app.post('/api/voices/preview', { preHandler: app.authenticate }, async (request, reply) => {
    const { presetId, voiceId } = readPreviewBody(request.body);
    let speaker: string | null = presetId;
    let cloneFallback = false;
    if (!speaker && voiceId) {
      if (!UUID_PATTERN.test(voiceId)) {
        return reply.code(404).send({ error: 'VOICE_NOT_FOUND', message: '音色不存在' });
      }
      const owned = await db
        .select({ id: voices.id })
        .from(voices)
        .where(and(eq(voices.id, voiceId), eq(voices.userId, request.user.userId)))
        .limit(1);
      if (owned.length === 0) {
        return reply.code(404).send({ error: 'VOICE_NOT_FOUND', message: '音色不存在' });
      }
      speaker = DEFAULT_VOLC_PRESET_ID;
      cloneFallback = true;
    }
    if (!speaker || !isVolcPresetId(speaker)) {
      return reply
        .code(400)
        .send({ error: 'VOICE_INVALID', message: '音色不可试听，请选择内置预设音色' });
    }
    if (!env.volcTTS.apiKey) {
      return reply.code(503).send({
        error: 'TTS_NOT_CONFIGURED',
        message: '试听需要火山语音 API Key（VOLC_TTS_API_KEY），请先在服务端配置',
      });
    }

    let wavPath: string | null = null;
    try {
      const synthesized = await volcTtsSynth.synthesize(VOICE_PREVIEW_TEXT, { speaker });
      wavPath = synthesized.wavPath;
      const bytes = await readFile(wavPath);
      reply.header('Content-Type', 'audio/wav');
      if (cloneFallback) {
        reply.header('X-Voice-Preview-Fallback', 'demo-preset');
      }
      return reply.send(bytes);
    } catch (err) {
      const message = err instanceof VolcTtsError ? err.message : '试听合成失败，请稍后重试';
      return reply.code(503).send({ error: 'VOICE_PREVIEW_FAILED', message });
    } finally {
      if (wavPath) {
        await unlink(wavPath).catch(() => undefined);
      }
    }
  });

  // 单个音色状态（克隆进度轮询）：归属校验 + mock 状态惰性推进
  app.get('/api/voices/:id', { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = request.params as VoiceIdParams;
    const rows = await db
      .select()
      .from(voices)
      .where(and(eq(voices.id, id), eq(voices.userId, request.user.userId)))
      .limit(1);
    const voice = rows[0];
    if (!voice) {
      return reply.code(404).send({ error: 'VOICE_NOT_FOUND', message: '音色不存在' });
    }

    // 终态（ready/failed）直接返回，不做任何推进/回退
    if (voice.status === 'ready' || voice.status === 'failed') {
      return voice;
    }

    const elapsedMs = Date.now() - voice.createdAt.getTime();
    let nextStatus: 'pending' | 'processing' | 'ready';
    if (elapsedMs >= CLONE_READY_AFTER_MS) {
      nextStatus = 'ready';
    } else if (elapsedMs >= CLONE_PENDING_AFTER_MS) {
      nextStatus = 'processing';
    } else {
      nextStatus = 'pending';
    }

    if (nextStatus !== voice.status) {
      const updated = await db
        .update(voices)
        .set({ status: nextStatus })
        .where(and(eq(voices.id, voice.id), eq(voices.userId, request.user.userId)))
        .returning();
      const row = updated[0];
      if (!row) {
        throw new Error('声音克隆状态推进失败');
      }
      return row;
    }
    return voice;
  });

  // 删除音色：按「归属 + 存在性」合并删除条件，非本人或不存在统一返回 404
  app.delete('/api/voices/:id', { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = request.params as VoiceIdParams;
    const deleted = await db
      .delete(voices)
      .where(and(eq(voices.id, id), eq(voices.userId, request.user.userId)))
      .returning({ id: voices.id });
    if (deleted.length === 0) {
      return reply.code(404).send({ error: 'VOICE_NOT_FOUND', message: '音色不存在' });
    }
    return reply.code(200).send({ ok: true });
  });
};
