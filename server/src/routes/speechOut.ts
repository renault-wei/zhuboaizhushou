import type { FastifyPluginAsync } from 'fastify';
import { createReadStream } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { remoteSpeechQueue } from '../services/remoteSpeechQueue';
import { recordSpeakerPull } from '../services/speakerHeartbeat';

// P1 手机线：远程出声端轮询拉取接口（助播机 App / 二期客户端消费）。
// 语义：一次 GET = 交付队首一条 wav（拉取成功即视为已出声），流式返回后删除临时文件；
// 空队列返回 204。鉴权复用登录 token；当前单商家自用口径为全局队列，多门店化时再按用户 / 场次隔离。
// 带 ?liveId= 时只取该场次音频（多场并发互不插队）；不带则取全局队首（兼容旧客户端）。
//
// ★R53（2026-09-21）：带 liveId 时**记一次助播机心跳**（供工作台显示「掉线告警」）。
//   「这场还在不在播」的判断**不放在这里** —— 那会把一个纯交付接口变成 DB 依赖，
//   而助播机本来就要轮询场次状态；让它自己去问（见 App 的 AssistantSpeakerController），
//   这个接口保持纯粹：只交付、只记心跳。
/**
 * ★R61：单次清单上限。
 *
 * 手机据此分批拉 —— 一次问「最多 10 条」，避免一场积压几十条时
 * 一口气拉爆带宽与内存（队列本身的上界是 MAX_REMOTE_SPEECH_JOBS_PER_LIVE = 20）。
 */
export const MAX_PENDING_BATCH = 10;

export const speechOutRoutes: FastifyPluginAsync = async (app) => {
  /**
   * ★R61：**待播清单（只读）** —— 手机先问「有几条」，再逐条走 /next 下载。
   *
   * 为什么要有它（设计规格 docs/superpowers/specs/2026-09-21-speaker-local-buffer-design.md）：
   * 2026-09-21 实测「后台没声音」——App 切后台后 Dart 定时器被系统限流，
   * 拉取从 1 秒变成 8~22 秒，队列长期非空 → 服务端台本反复等满 30 秒让位 → 静音。
   * 有了清单，手机可以**一次拉走一批存本地**，播放与拉取解耦：拉得慢也不影响正在播的。
   *
   * 语义边界（规格 §11.3）：**看到清单 ≠ 已取走**。下载仍走 /next（take 原子取出），
   * 所以两条 App 同时拉也不会重复播。
   */
  app.get('/api/out/speech/pending', { preHandler: app.authenticate }, async (request, reply) => {
    const liveId = readLiveIdQuery(request.query);
    // 问清单同样算「助播机还活着」的证据（与 /next 共用同一份心跳）
    if (liveId) {
      recordSpeakerPull(liveId);
    }
    const items = remoteSpeechQueue.list(liveId, MAX_PENDING_BATCH).map((job) => ({
      jobId: job.id,
      liveId: job.liveId ?? null,
    }));
    return reply.send({ items, maxBatch: MAX_PENDING_BATCH });
  });

  app.get('/api/out/speech/next', { preHandler: app.authenticate }, async (request, reply) => {
    const liveId = readLiveIdQuery(request.query);
    if (liveId) {
      recordSpeakerPull(liveId);
    }
    const job = remoteSpeechQueue.take(liveId);
    if (!job) {
      return reply.code(204).send();
    }
    const stream = createReadStream(job.wavPath);
    // 流式返回完成后删除临时文件：交付即清理（无重试；回执 / 重试随二期客户端补上）
    stream.on('close', () => {
      void unlink(job.wavPath).catch(() => undefined);
    });
    return reply
      .header('x-speech-job-id', job.id)
      .header('cache-control', 'no-store')
      .type('audio/wav')
      .send(stream);
  });
};

/** 读取可选 liveId 查询参数：非字符串 / 空白按「不限场次」处理 */
function readLiveIdQuery(query: unknown): string | undefined {
  if (typeof query !== 'object' || query === null) {
    return undefined;
  }
  const value = (query as Record<string, unknown>).liveId;
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}
