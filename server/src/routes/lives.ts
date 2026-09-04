import type { FastifyPluginAsync } from 'fastify';
import {
  createLive,
  deleteLive,
  getLiveById,
  listLives,
  LiveError,
  LiveStatus,
  updateLive,
} from '../services/live';

// 直播状态全集：用于列表 ?status= 过滤校验（与服务端 live_status 枚举一致）
const LIVE_STATUSES: LiveStatus[] = ['idle', 'ready', 'live', 'ended', 'failed'];

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
 * 职责边界：T10 仅做配置草稿的增删改查，不含推流 / RTMP / 合成逻辑。
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

  // 删除开播配置：仅 idle/ended/failed 可删；live/ready 返回 409（删除保护）
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
};
