import type { FastifyPluginAsync } from 'fastify';
import { and, desc, eq } from 'drizzle-orm';
import { db } from '../db/client';
import { users, voiceAgreements, voices } from '../db/schema';
import { getLatestVoiceAgreement } from '../services/agreement';
import { cosyVoiceService } from '../services/voice';

// ---------- 常量 ----------

// mock 状态推进阈值：创建后 3 秒内保持 pending，3-8 秒为 processing，8 秒后 ready
const CLONE_PENDING_AFTER_MS = 3 * 1000;
const CLONE_READY_AFTER_MS = 8 * 1000;

// 录音样本最短时长（秒）：声音克隆前必须确认录音达到 3 分钟（合规/质量口径）
const MIN_SAMPLE_DURATION_SECONDS = 180;
// 音色名称长度上限（字），与 voices.name 的 varchar(50) 对齐
const MAX_NAME_LENGTH = 50;

interface VoiceIdParams {
  id: string;
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
        message: '录音时长不足 3 分钟',
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
};
