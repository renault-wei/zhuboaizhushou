// 采集源控制 API（R2b）：把「某场直播的弹幕采集」暴露成可绑 / 可停 / 可查的三个端点。
//
// 设计口径：
//   * 归属隔离复用既有 lives 语义：非本人 / 不存在一律 404，不泄露存在性；
//   * 只有「直播中」的场次才允许起采集 —— 与 danmakuGateway.ingest 的 LIVE_NOT_LIVE 口径一致，
//     否则采集会在入库处被反复拒绝、只留下一堆噪声告警；
//   * 未配置签名 Key 时返回 503（采集通道在本部署未启用），与 voices 试听「未配 key 503」口径一致；
//   * 采集绑定是**内存态**：进程重启后需重新绑定（自用自测口径，不落库，见 PLAN §11.3）。

import type { FastifyPluginAsync } from 'fastify';
import { getLiveById } from '../services/live';
import { CollectorSourceError, liveCollector, type CollectorSourceErrorCode } from '../services/liveCollector';

interface LiveIdParams {
  id: string;
}

/** 采集源业务错误 → HTTP 状态码 */
function sourceStatusOf(code: CollectorSourceErrorCode): number {
  switch (code) {
    case 'RESOLVE_FAILED':
      return 400;
    case 'SOURCE_DISABLED':
    case 'START_FAILED':
      return 503;
  }
}

/** 读取请求体：roomRef（数字房间号）与 shareText（分享链接 / 文本）二选一，空白视为未提供 */
function readSourceBody(body: unknown): { roomRef: string | undefined; shareText: string | undefined } {
  if (typeof body !== 'object' || body === null) {
    return { roomRef: undefined, shareText: undefined };
  }
  const record = body as Record<string, unknown>;
  const pick = (value: unknown): string | undefined => {
    if (typeof value !== 'string') {
      return undefined;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  };
  return { roomRef: pick(record.roomRef), shareText: pick(record.shareText) };
}

export const danmakuSourceRoutes: FastifyPluginAsync = async (app) => {
  // 起采集：把分享链接 / 房间号绑到本场并开始监听（仅直播中）
  app.post('/api/lives/:id/danmaku-source', { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = request.params as LiveIdParams;
    const live = await getLiveById(request.user.userId, id);
    if (!live) {
      return reply.code(404).send({ error: 'LIVE_NOT_FOUND', message: '开播配置不存在' });
    }
    if (live.status !== 'live') {
      return reply.code(409).send({
        error: 'LIVE_NOT_LIVE',
        message: `只有直播中的场次才能起弹幕采集（当前：${live.status}）`,
      });
    }
    const body = readSourceBody(request.body);
    try {
      const binding = await liveCollector.start({
        userId: request.user.userId,
        liveId: id,
        ...(body.roomRef ? { roomRef: body.roomRef } : {}),
        ...(body.shareText ? { shareText: body.shareText } : {}),
      });
      return reply.code(201).send({ source: binding });
    } catch (err) {
      if (err instanceof CollectorSourceError) {
        return reply.code(sourceStatusOf(err.code)).send({ error: err.code, message: err.message });
      }
      throw err;
    }
  });

  // 停采集（幂等）：返回是否确实存在过绑定
  app.delete('/api/lives/:id/danmaku-source', { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = request.params as LiveIdParams;
    const live = await getLiveById(request.user.userId, id);
    if (!live) {
      return reply.code(404).send({ error: 'LIVE_NOT_FOUND', message: '开播配置不存在' });
    }
    const stopped = await liveCollector.stop(id);
    return { stopped };
  });

  // 采集状态（只读）：通道是否启用 + 本场绑定 + 运行态快照
  app.get('/api/lives/:id/danmaku-source', { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = request.params as LiveIdParams;
    const live = await getLiveById(request.user.userId, id);
    if (!live) {
      return reply.code(404).send({ error: 'LIVE_NOT_FOUND', message: '开播配置不存在' });
    }
    return liveCollector.statusOf(id);
  });
};
