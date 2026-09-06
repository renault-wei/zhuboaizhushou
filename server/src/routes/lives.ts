import type { FastifyPluginAsync } from 'fastify';
import {
  createLive,
  deleteLive,
  getLiveById,
  getLiveComposeContext,
  listLives,
  LiveError,
  LiveStatus,
  updateLive,
  updateLiveInternal,
} from '../services/live';
import { createWriteStream, mkdirSync, rmSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { streamingService } from '../services/streaming';
import { endLive, getLiveMonitor, listDanmaku, startLive } from '../services/liveSession';

// 直播状态全集：用于列表 ?status= 过滤校验（与服务端 live_status 枚举一致）
const LIVE_STATUSES: LiveStatus[] = ['idle', 'processing', 'ready', 'live', 'ended', 'failed'];

interface LiveIdParams {
  id: string;
}

/** 读取 POST 创建请求体：只收白名单字段，status / aiBadgeShown 一律忽略（合规角标不可篡改） */
function readCreateBody(body: unknown): {
  title: string;
  voiceId: string | null;
  scriptId: string | null;
  couponId: string | null;
  videoSourceUrl?: string;
} {
  if (typeof body !== 'object' || body === null) {
    return { title: '', voiceId: null, scriptId: null, couponId: null };
  }
  const record = body as Record<string, unknown>;
  const rawTitle = record.title;
  const title = typeof rawTitle === 'string' ? rawTitle : '';
  const voiceId = readOptionalId(record.voiceId);
  const scriptId = readOptionalId(record.scriptId);
  const couponId = readOptionalText(record.couponId);
  const rawVideo = record.videoSourceUrl;
  // videoSourceUrl 非字符串一律回退空串，避免脏数据入库
  const videoSourceUrl = typeof rawVideo === 'string' ? rawVideo : '';
  return { title, voiceId, scriptId, couponId, videoSourceUrl };
}

/** 读取 PATCH 更新请求体：字段缺省为 undefined（保留原值）；status/aiBadgeShown 字段一律忽略 */
function readUpdateBody(body: unknown): {
  title: string | undefined;
  voiceId: string | null | undefined;
  scriptId: string | null | undefined;
  couponId: string | null | undefined;
  videoSourceUrl: string | undefined;
} {
  if (typeof body !== 'object' || body === null) {
    return {
      title: undefined,
      voiceId: undefined,
      scriptId: undefined,
      couponId: undefined,
      videoSourceUrl: undefined,
    };
  }
  const record = body as Record<string, unknown>;
  let title: string | undefined;
  if (Object.prototype.hasOwnProperty.call(record, 'title')) {
    title = typeof record.title === 'string' ? record.title : '';
  }
  let voiceId: string | null | undefined;
  if (Object.prototype.hasOwnProperty.call(record, 'voiceId')) {
    voiceId = readOptionalId(record.voiceId);
  }
  let scriptId: string | null | undefined;
  if (Object.prototype.hasOwnProperty.call(record, 'scriptId')) {
    scriptId = readOptionalId(record.scriptId);
  }
  let couponId: string | null | undefined;
  if (Object.prototype.hasOwnProperty.call(record, 'couponId')) {
    couponId = readOptionalText(record.couponId);
  }
  let videoSourceUrl: string | undefined;
  if (Object.prototype.hasOwnProperty.call(record, 'videoSourceUrl')) {
    videoSourceUrl = typeof record.videoSourceUrl === 'string' ? record.videoSourceUrl : '';
  }
  return { title, voiceId, scriptId, couponId, videoSourceUrl };
}

/** 可选 uuid 字段：非空字符串才接收，其余一律视为 null */
function readOptionalId(raw: unknown): string | null {
  return typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : null;
}

/** 可选文本字段：非空字符串才接收，其余一律视为 null */
function readOptionalText(raw: unknown): string | null {
  return typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : null;
}

/** 读取 prepare 请求体：durationSeconds 可选，clamp 到 [10, 3600]，缺省 30 */
function readPrepareBody(body: unknown): number {
  if (typeof body !== 'object' || body === null) {
    return 30;
  }
  const record = body as Record<string, unknown>;
  const raw = record.durationSeconds;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    return 30;
  }
  const seconds = Math.floor(raw);
  if (seconds < 10) {
    return 10;
  }
  if (seconds > 3600) {
    return 3600;
  }
  return seconds;
}

/** 本地视频文件根目录：以服务进程工作目录为基准（测试 / 生产均从 server/ 启动） */
function uploadsPath(...segments: string[]): string {
  return resolve(process.cwd(), 'uploads', ...segments);
}

/** 把业务错误码翻译成 HTTP 状态码（400 / 404 / 409） */
function statusCodeOf(code: string): number {
  switch (code) {
    case 'LIVE_NOT_FOUND':
      return 404;
    case 'LIVE_IN_PROGRESS':
      return 409;
    default:
      return 400;
  }
}

/**
 * 开播配置（lives）CRUD 路由：全部要求登录态。
 * 职责边界：T10 配置草稿增删改查；T11 新增实景视频上传、合成准备（prepare）、流状态查询。
 * 不含实际推流（RTMP / 抖音）逻辑，合成产物为本地 mp4 文件，推流留 T12。
 * 合规红线：aiBadgeShown 由服务端写死 true（强制叠加'AI 智能直播'角标、不提供关闭入口），
 * 请求体即使传 false / status 等字段也一律忽略，防止篡改合规标记。
 */
export const livesRoutes: FastifyPluginAsync = async (app) => {
  // 我的开播配置列表：默认按 updatedAt desc，最多 50 条，支持 ?status= 过滤
  app.get('/api/lives', { preHandler: app.authenticate }, async (request, reply) => {
    const query = request.query as Record<string, unknown> | undefined;
    let status: LiveStatus | undefined;
    let limit: number | undefined;
    if (query && query.status !== undefined && query.status !== null) {
      const rawStatus = String(query.status);
      if (!(LIVE_STATUSES as string[]).includes(rawStatus)) {
        return reply
          .code(400)
          .send({ error: 'STATUS_INVALID', message: '不支持的状态过滤条件' });
      }
      status = rawStatus as LiveStatus;
    }
    if (query && query.limit !== undefined && query.limit !== null) {
      const rawLimit = Number(query.limit);
      if (!Number.isInteger(rawLimit) || rawLimit < 1) {
        return reply.code(400).send({ error: 'LIMIT_INVALID', message: 'limit 必须为正整数' });
      }
      limit = rawLimit;
    }
    return listLives(request.user.userId, { limit, status });
  });

  // 单查：归属隔离，非本人或不存在统一返回 404
  app.get('/api/lives/:id', { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = request.params as LiveIdParams;
    const live = await getLiveById(request.user.userId, id);
    if (!live) {
      return reply.code(404).send({ error: 'LIVE_NOT_FOUND', message: '开播配置不存在' });
    }
    return live;
  });

  // 创建开播配置草稿：201 { live }；标题/音色/话术归属校验失败返回 400
  app.post('/api/lives', { preHandler: app.authenticate }, async (request, reply) => {
    const input = readCreateBody(request.body);
    try {
      const live = await createLive(request.user.userId, input);
      return reply.code(201).send({ live });
    } catch (err) {
      if (err instanceof LiveError) {
        return reply.code(statusCodeOf(err.code)).send({ error: err.code, message: err.message });
      }
      throw err;
    }
  });

  // 更新开播配置：归属隔离 + 标题/引用校验；非本人或不存在统一 404
  app.patch('/api/lives/:id', { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = request.params as LiveIdParams;
    const patch = readUpdateBody(request.body);
    try {
      const live = await updateLive(request.user.userId, id, patch);
      if (!live) {
        return reply.code(404).send({ error: 'LIVE_NOT_FOUND', message: '开播配置不存在' });
      }
      return { live };
    } catch (err) {
      if (err instanceof LiveError) {
        return reply.code(statusCodeOf(err.code)).send({ error: err.code, message: err.message });
      }
      throw err;
    }
  });

  // 删除开播配置：仅 idle/ended/failed 可删；live/ready/processing 返回 409（删除保护）
  app.delete('/api/lives/:id', { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = request.params as LiveIdParams;
    try {
      const deleted = await deleteLive(request.user.userId, id);
      if (!deleted) {
        return reply.code(404).send({ error: 'LIVE_NOT_FOUND', message: '开播配置不存在' });
      }
      return { ok: true };
    } catch (err) {
      if (err instanceof LiveError) {
        return reply.code(statusCodeOf(err.code)).send({ error: err.code, message: err.message });
      }
      throw err;
    }
  });

  // 上传实景视频（multipart 字段 video，仅 mp4，≤200MB）：落盘 uploads/videos/{id}.mp4 并回填 videoSourceUrl
  app.post('/api/lives/:id/video', { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = request.params as LiveIdParams;
    const live = await getLiveById(request.user.userId, id);
    if (!live) {
      return reply.code(404).send({ error: 'LIVE_NOT_FOUND', message: '开播配置不存在' });
    }
    if (!request.isMultipart()) {
      return reply.code(400).send({ error: 'VIDEO_REQUIRED', message: '请用 multipart 上传 mp4 视频' });
    }
    const file = await request.file();
    if (!file || file.fieldname !== 'video') {
      return reply.code(400).send({ error: 'VIDEO_REQUIRED', message: '缺少 video 文件字段' });
    }
    const fileName = file.filename ?? '';
    const mimetype = file.mimetype ?? '';
    const isMp4 = fileName.toLowerCase().endsWith('.mp4') || mimetype === 'video/mp4';
    if (!isMp4) {
      return reply.code(400).send({ error: 'VIDEO_TYPE_INVALID', message: '仅支持 mp4 视频' });
    }
    try {
      mkdirSync(uploadsPath('videos'), { recursive: true });
      const destination = uploadsPath('videos', `${id}.mp4`);
      await pipeline(file.file, createWriteStream(destination));
      const stats = statSync(destination);
      if (!stats.isFile() || stats.size <= 0) {
        rmSync(destination, { force: true });
        return reply.code(400).send({ error: 'VIDEO_EMPTY', message: '上传的视频为空文件' });
      }
      const updated = await updateLive(request.user.userId, id, {
        videoSourceUrl: `/uploads/videos/${id}.mp4`,
      });
      if (!updated) {
        rmSync(destination, { force: true });
        return reply.code(404).send({ error: 'LIVE_NOT_FOUND', message: '开播配置不存在' });
      }
      return { live: updated };
    } catch (err) {
      // 任何写盘 / 更新失败：清理半成品文件，避免残留脏数据
      rmSync(uploadsPath('videos', `${id}.mp4`), { force: true });
      throw err;
    }
  });

  // 触发合成（prepare）：前置校验（视频已传 / 话术 ready+pass / 已选音色）→ processing → 合成 → ready/failed
  app.post('/api/lives/:id/prepare', { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = request.params as LiveIdParams;
    const durationSeconds = readPrepareBody(request.body);
    const context = await getLiveComposeContext(request.user.userId, id);
    if (!context) {
      return reply.code(404).send({ error: 'LIVE_NOT_FOUND', message: '开播配置不存在' });
    }
    const { live, script } = context;
    if (!live.videoSourceUrl) {
      return reply.code(400).send({ error: 'VIDEO_NOT_UPLOADED', message: '请先上传实景视频' });
    }
    const scriptReady =
      script !== null && script.status === 'ready' && script.sensitiveCheckStatus === 'pass';
    if (!scriptReady) {
      return reply.code(400).send({ error: 'SCRIPT_NOT_READY', message: '请先生成已通过敏感词扫描的话术' });
    }
    if (!live.voiceId) {
      return reply.code(400).send({ error: 'VOICE_NOT_SELECTED', message: '请先选择克隆音色' });
    }
    const processing = await updateLiveInternal(request.user.userId, id, { status: 'processing' });
    if (!processing) {
      return reply.code(404).send({ error: 'LIVE_NOT_FOUND', message: '开播配置不存在' });
    }
    try {
      await streamingService.composeLive({
        sourceVideoPath: uploadsPath('videos', `${id}.mp4`),
        scriptText: script?.content ?? '',
        outputPath: uploadsPath('lives', `${id}.mp4`),
        durationSeconds,
      });
    } catch (err) {
      // 合成失败：状态置 failed，把 ffmpeg 错误摘要带回给前端排查
      await updateLiveInternal(request.user.userId, id, { status: 'failed' });
      const message =
        err instanceof Error && err.message ? err.message.slice(0, 500) : '合成失败，请稍后重试';
      return reply.code(500).send({ error: 'COMPOSE_FAILED', message });
    }
    const updated = await updateLiveInternal(request.user.userId, id, {
      status: 'ready',
      videoSourceUrl: `/uploads/lives/${id}.mp4`,
    });
    if (!updated) {
      return reply.code(404).send({ error: 'LIVE_NOT_FOUND', message: '开播配置不存在' });
    }
    return { live: updated };
  });

  // 合成 / 直播状态查询：供客户端轮询使用
  app.get('/api/lives/:id/stream-status', { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = request.params as LiveIdParams;
    const live = await getLiveById(request.user.userId, id);
    if (!live) {
      return reply.code(404).send({ error: 'LIVE_NOT_FOUND', message: '开播配置不存在' });
    }
    return {
      status: live.status,
      videoSourceUrl: live.videoSourceUrl,
      aiBadgeShown: live.aiBadgeShown,
    };
  });

  // 一键开播：ready → live（T13 状态机流转 + 记录 startedAt；不接 RTMP，推流留 T12）
  app.post('/api/lives/:id/start', { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = request.params as LiveIdParams;
    try {
      const live = await startLive(request.user.userId, id);
      if (!live) {
        return reply.code(404).send({ error: 'LIVE_NOT_FOUND', message: '开播配置不存在' });
      }
      return { live };
    } catch (err) {
      if (err instanceof LiveError) {
        return reply.code(statusCodeOf(err.code)).send({ error: err.code, message: err.message });
      }
      throw err;
    }
  });

  // 结束直播：live → ended（记录 endedAt）
  app.post('/api/lives/:id/end', { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = request.params as LiveIdParams;
    try {
      const live = await endLive(request.user.userId, id);
      if (!live) {
        return reply.code(404).send({ error: 'LIVE_NOT_FOUND', message: '开播配置不存在' });
      }
      return { live };
    } catch (err) {
      if (err instanceof LiveError) {
        return reply.code(statusCodeOf(err.code)).send({ error: err.code, message: err.message });
      }
      throw err;
    }
  });

  // 直播中监控快照：状态 + 已播时长 + 弹幕计数（客户端轮询）
  app.get('/api/lives/:id/monitor', { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = request.params as LiveIdParams;
    const monitor = await getLiveMonitor(request.user.userId, id);
    if (!monitor) {
      return reply.code(404).send({ error: 'LIVE_NOT_FOUND', message: '开播配置不存在' });
    }
    return monitor;
  });

  // 弹幕日志（只读）：按 sentAt 倒序返回最近 N 条
  app.get('/api/lives/:id/danmaku', { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = request.params as LiveIdParams;
    const query = request.query as Record<string, unknown> | undefined;
    let limit: number | undefined;
    if (query && query.limit !== undefined && query.limit !== null) {
      const rawLimit = Number(query.limit);
      if (!Number.isInteger(rawLimit) || rawLimit < 1) {
        return reply.code(400).send({ error: 'LIMIT_INVALID', message: 'limit 必须为正整数' });
      }
      limit = rawLimit;
    }
    const danmaku = await listDanmaku(request.user.userId, id, limit ?? 50);
    if (danmaku === null) {
      return reply.code(404).send({ error: 'LIVE_NOT_FOUND', message: '开播配置不存在' });
    }
    return danmaku;
  });
};
