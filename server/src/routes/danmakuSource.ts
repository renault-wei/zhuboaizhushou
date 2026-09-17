// 采集源控制 API（R2b）：把「某场直播的弹幕采集」暴露成可绑 / 可停 / 可查的三个端点。
//
// 设计口径：
//   * 归属隔离复用既有 lives 语义：非本人 / 不存在一律 404，不泄露存在性；
//   * 只有「直播中」的场次才允许起采集 —— 与 danmakuGateway.ingest 的 LIVE_NOT_LIVE 口径一致，
//     否则采集会在入库处被反复拒绝、只留下一堆噪声告警；
//   * 未配置签名 Key 时返回 503（采集通道在本部署未启用），与 voices 试听「未配 key 503」口径一致；
//   * 采集源自 R47 起**持久化到场次**（原先只在内存，进程重启即丢 —— 那条老注释已被本需求反转）：
//     绑定成功写 lives.danmaku_source_url / danmaku_room_ref / danmaku_collect_enabled，
//     开播时由 routes/lives.ts 的 /start 按库里存的源自动恢复采集。

import type { FastifyPluginAsync } from 'fastify';
import { getLiveById, saveLiveDanmakuSource } from '../services/live';
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
    // 已结束 / 失败的场次不再接受登记；草稿与就绪态允许「先把直播间配好」（R4 开播联动的前置）
    if (live.status === 'ended' || live.status === 'failed') {
      return reply.code(409).send({
        error: 'LIVE_NOT_COLLECTABLE',
        message: `已结束 / 失败的场次不能再登记弹幕采集（当前：${live.status}）`,
      });
    }
    const body = readSourceBody(request.body);
    try {
      const input = {
        userId: request.user.userId,
        liveId: id,
        ...(body.roomRef ? { roomRef: body.roomRef } : {}),
        ...(body.shareText ? { shareText: body.shareText } : {}),
      };
      // 直播中 → 登记并立刻起采集；未开播 → 只登记，由 /start 联动拉起（见 routes/lives.ts）
      const running = live.status === 'live';
      const binding = running ? await liveCollector.start(input) : await liveCollector.bind(input);
      // R47：绑定成功即**落库**（原先只在内存，进程重启即丢、每次开播都要重粘链接）。
      // 原文（shareText）与解析结果（roomRef）都存：前者是开播重新解析的依据，
      // 后者是解析失败时的兜底与展示（用户拍板 D4）。落库失败不阻断响应 ——
      // 采集已经真的起来了，不该因为写库失败让商家以为没配上。
      try {
        await saveLiveDanmakuSource(request.user.userId, id, {
          sourceUrl: body.shareText ?? null,
          roomRef: binding.roomRef ?? null,
          enabled: true,
        });
      } catch (err) {
        request.log.warn({ err }, 'R47 弹幕采集源落库失败（采集已启动，仅开播自动恢复受影响）');
      }
      return reply.code(201).send({ source: binding, running });
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
    // R47：停采集只把「启用」置回 false，**保留链接** —— 下次开播还能预填（用户拍板 D3）
    try {
      await saveLiveDanmakuSource(request.user.userId, id, { enabled: false });
    } catch (err) {
      request.log.warn({ err }, 'R47 停采集后落库失败（会话已停）');
    }
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
