import type { FastifyPluginAsync } from 'fastify';
import { createReadStream } from 'node:fs';
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

  /**
   * ★★R72：**取一条 —— 但只回 URL，不回字节**。
   *
   * 为什么改（2026-09-22 定案，对照竞品反编译包）：
   *   原实现把 wav 字节流回给 App，App 再用 Dart 写磁盘/读磁盘。
   *   而竞品 `app-service.js` 的播放路径是：
   *       bgAudio.src = t.url; bgAudio.play();
   *   —— **把 URL 直接交给原生播放器，JS 侧完全不碰字节** ✓
   *   （它的 `saveFile` / `getFileSystemManager` 计数都是 0 ✓）
   *
   *   我们的做法把「HTTP 拉取 + 写磁盘 + 读磁盘」全塞进了 Dart 热路径 ✗；
   *   在一台 load 60~83 的过载手机上，`path_provider` 的平台通道会**挂起** ✓，
   *   于是播放循环永久卡死、每秒空转 20 次 ✗（R71 只修了其中一处 await）。
   *
   * 本端点的语义变化：
   *   · 返回值从「wav 字节流」变成 `{ jobId, audioUrl }` ✓
   *   · **不再在交付时删文件** ✗ —— App 是稍后才去 GET 那个 URL 的，
   *     删早了就是死链 ✓；删除权统一归 TTL（见 remoteSpeechQueue 的 files 回收 ✓）
   */
  app.get('/api/out/speech/next', { preHandler: app.authenticate }, async (request, reply) => {
    const liveId = readLiveIdQuery(request.query);
    if (liveId) {
      recordSpeakerPull(liveId);
    }
    const job = remoteSpeechQueue.take(liveId);
    if (!job) {
      return reply.code(204).send();
    }
    return reply.send({
      jobId: job.id,
      liveId: job.liveId ?? null,
      audioUrl: `${SPEECH_AUDIO_PATH}/${job.id}`,
    });
  });

  /**
   * ★R72：**受鉴权的音频下载端点** —— 原生播放器直接 GET 它 ✓
   *
   * 为什么单独一个端点而不是复用 /next：
   *   /next 是「取号」（会出队 ✓），这里是「取货」（可重复 GET ✓）。
   *   两者语义不同，分开后 /next 保持原子的出队语义 ✓，
   *   而播放器侧的重试/预取都不会干扰队列 ✓
   */
  // ★注意：**不走 preHandler 鉴权** ✗ —— 原生播放器（MediaPlayer / ExoPlayer）
  //   发不了自定义请求头 ✓，所以鉴权凭证只能放查询串 ✓。
  //   这里接受 `?token=<JWT>`，与 `Authorization: Bearer` 同源同校验 ✓
  app.get(`${SPEECH_AUDIO_PATH}/:jobId`, async (request, reply) => {
    const query = request.query as Record<string, unknown>;
    const token = typeof query.token === 'string' ? query.token : '';
    try {
      await request.jwtVerify({ onlyCookie: false });
    } catch {
      // header 没有就试查询串（jwtVerify 默认只认 header）
      if (token === '') {
        return reply.code(401).send({ error: 'UNAUTHORIZED', message: '缺少访问凭证' });
      }
      try {
        app.jwt.verify(token);
      } catch {
        return reply.code(401).send({ error: 'UNAUTHORIZED', message: '访问凭证无效或已过期' });
      }
    }
    const params = request.params as { jobId?: string };
    const jobId = typeof params.jobId === 'string' ? params.jobId.trim() : '';
    if (jobId === '') {
      return reply.code(400).send({ error: 'SPEECH_JOB_ID_REQUIRED', message: '缺少音频标识' });
    }
    const wavPath = remoteSpeechQueue.findPath(jobId);
    if (!wavPath) {
      // 过期被回收 / 从未存在：都是 404，客户端按「这条没了」跳过即可 ✓
      return reply
        .code(404)
        .send({ error: 'SPEECH_AUDIO_NOT_FOUND', message: '该条语音已过期或不存在' });
    }
    return reply
      .header('cache-control', 'no-store')
      .type('audio/wav')
      .send(createReadStream(wavPath));
  });
};

/** R72：音频下载端点的路径前缀（与 /next 返回的 audioUrl 必须一致） */
export const SPEECH_AUDIO_PATH = '/api/out/speech/audio';

/** 读取可选 liveId 查询参数：非字符串 / 空白按「不限场次」处理 */
function readLiveIdQuery(query: unknown): string | undefined {
  if (typeof query !== 'object' || query === null) {
    return undefined;
  }
  const value = (query as Record<string, unknown>).liveId;
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}
