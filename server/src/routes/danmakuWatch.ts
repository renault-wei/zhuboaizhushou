// 独立弹幕监控 API（R16）：**不绑场次、不落库**，贴一段分享链接就能看弹幕流水。
//
// 与 /api/lives/:id/danmaku-source 的区别（这就是「监听源与场次解耦」的落点）：
//   * 场次采集：绑定在某场直播下，事件经 danmakuGateway 落 live_danmaku 并触发 AI 回复；
//   * 独立监控：无场次，事件只进**服务端内存环形缓冲**（上限 200 条），供接口读取。
//     用途 = 「我就想先看看这个直播间的弹幕长什么样」，无需先开一场直播。
//
// 归属：监控绑定自带 userId，只有创建者能读 / 停（非本人一律 404，不泄露存在性）。

import type { FastifyPluginAsync } from 'fastify';
import { CollectorSourceError, liveCollector, type CollectorSourceErrorCode } from '../services/liveCollector';

interface WatchIdParams {
  id: string;
}

/** 采集源业务错误 → HTTP 状态码（与 danmakuSource 保持同一口径） */
function sourceStatusOf(code: CollectorSourceErrorCode): number {
  switch (code) {
    case 'RESOLVE_FAILED':
      return 400;
    case 'SOURCE_DISABLED':
    case 'START_FAILED':
      return 503;
  }
}

/** 读取请求体：shareText 与 roomRef 二选一，空白视为未提供 */
function readWatchBody(body: unknown): { roomRef: string | undefined; shareText: string | undefined } {
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

export const danmakuWatchRoutes: FastifyPluginAsync = async (app) => {
  // 起一个独立监控
  app.post('/api/danmaku-watch', { preHandler: app.authenticate }, async (request, reply) => {
    const body = readWatchBody(request.body);
    try {
      const watch = await liveCollector.startMonitor({
        userId: request.user.userId,
        ...(body.roomRef ? { roomRef: body.roomRef } : {}),
        ...(body.shareText ? { shareText: body.shareText } : {}),
      });
      return reply.code(201).send({ watch });
    } catch (err) {
      if (err instanceof CollectorSourceError) {
        return reply.code(sourceStatusOf(err.code)).send({ error: err.code, message: err.message });
      }
      throw err;
    }
  });

  // 列出我的独立监控
  app.get('/api/danmaku-watch', { preHandler: app.authenticate }, async (request) => {
    return { watches: liveCollector.listMonitors(request.user.userId) };
  });

  // 读弹幕流水（since 增量：只回 seq 更大的；缺省回全部缓冲）
  app.get('/api/danmaku-watch/:id/events', { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = request.params as WatchIdParams;
    const query = request.query as Record<string, unknown> | undefined;
    let sinceSeq: number | undefined;
    if (query && query.since !== undefined && query.since !== null) {
      const raw = Number(query.since);
      if (!Number.isInteger(raw) || raw < 0) {
        return reply.code(400).send({ error: 'SINCE_INVALID', message: 'since 必须为非负整数' });
      }
      sinceSeq = raw;
    }
    const events = liveCollector.monitorEvents(id, request.user.userId, sinceSeq);
    if (events === null) {
      return reply.code(404).send({ error: 'WATCH_NOT_FOUND', message: '监控不存在' });
    }
    const lastSeq = events.length > 0 ? (events[events.length - 1]?.seq ?? 0) : (sinceSeq ?? 0);
    return { events, lastSeq };
  });

  // 停止并移除（幂等）
  app.delete('/api/danmaku-watch/:id', { preHandler: app.authenticate }, async (request) => {
    const { id } = request.params as WatchIdParams;
    const stopped = await liveCollector.stopMonitor(id, request.user.userId);
    return { stopped };
  });
};
