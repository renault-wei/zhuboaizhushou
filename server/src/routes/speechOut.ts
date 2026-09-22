import type { FastifyPluginAsync } from 'fastify';
import { createReadStream } from 'node:fs';
import { remoteSpeechQueue } from '../services/remoteSpeechQueue';
import { recordSpeakerPull, recordSpeakerSeq } from '../services/speakerHeartbeat';
// ★C：按序号取音频 / 取插播 —— 服务端从「循环的驱动者」退回「合成器」✓
import {
  DEFAULT_ITEM_GAP_SECONDS,
  loadBoundLoopItems,
  type LoopCastItem,
} from '../services/loopCaster';
import { synthesizeSpeechFile } from '../services/liveSpeaker';
import { getLiveSpeech, loadLiveTtsCacheContext } from '../services/liveVoice';
import { takePendingReply } from '../services/pendingReplies';
import { atmosphereScheduler } from '../services/atmosphereScheduler';
import type { AtmosphereInsertion } from '../services/atmosphere';

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
 * 一口气拉爆带宽与内存（队列本身的**硬上界**是 MAX_REMOTE_SPEECH_JOBS_PER_LIVE = 60；
 * **节奏水位**是 MAX_REMOTE_SPEECH_LOOKAHEAD_PER_LIVE = 3，见 remoteSpeechQueue）。
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
      // ★R77：本条播完后的间隔秒数 —— 助播机在**播放端**等待它（见 remoteSpeechQueue）
      gapAfterSeconds: job.gapAfterSeconds,
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
  // ★★R72：**这是个「能力型 URL」（capability URL），刻意不走 Bearer 鉴权** ✓
  //
  // 为什么：原生播放器（Android MediaPlayer / ExoPlayer）**发不了自定义请求头** ✗，
  //   所以凭证只能进查询串 ✓ —— 但那会把 JWT 泄进日志 / Referer，**是个更糟的做法** ✗。
  //
  // 为什么可以不用凭证：
  //   · jobId 是 **UUIDv4**（不可枚举、不可猜）✓
  //   · 文件只活 **10 分钟**（TTL 回收 ✓）
  //   · 内容是**一段几分钟内就会过期的 TTS 语音**，不含用户隐私 ✓
  //   —— 这与「对象存储的预签名 URL」是同一类安全模型 ✓
  //
  // 要收紧时的升级路径（本轮不做）：
  //   换成服务端签名的短时链接（`?exp=..&sig=..`），把 TTL 与签名绑在一起 ✓
  app.get(`${SPEECH_AUDIO_PATH}/:jobId`, async (request, reply) => {
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

  /**
   * ★★C：**按序号取音频** —— 客户端持游标、按台本顺序点名要货 ✓
   *
   * 与 /next 的根本区别（这就是 C 的全部要害）：
   *   /next          生产端灌队列、客户端取队首 ✗
   *                  → 「第几条」由**生产端**决定，显示的位置 ≠ 听众的位置 ✗
   *   /item?seq=N    **客户端点名要第 N 条** ✓
   *                  → 「第几条」归**客户端**，服务端只负责「给这段文本一段音频」✓
   *
   * 对照竞品（app-service.js 的 sendtxtAudio → POST makeAudio）：
   *   它的请求体里就带着 `xuhao`（要第几条）与 `daudio`（当前水位），
   *   序号同样是**客户端点名**的 ✓；开播时显式要 0..6 把开头铺满 ✓
   *
   * 合成走 synthesizeSpeechFile —— **命中 R69 的预生成缓存就一次都不碰火山** ✓
   * （开播前已把整本台本备好，所以直播期间正常都是命中）
   */
  app.get('/api/out/speech/item', { preHandler: app.authenticate }, async (request, reply) => {
    const liveId = readLiveIdQuery(request.query);
    if (!liveId) {
      return reply.code(400).send({ error: 'LIVE_ID_REQUIRED', message: '缺少场次标识' });
    }
    const rawSeq = (request.query as Record<string, unknown>).seq;
    const seq = typeof rawSeq === 'string' ? Number.parseInt(rawSeq, 10) : Number.NaN;
    if (!Number.isInteger(seq) || seq < 1) {
      return reply.code(400).send({ error: 'SEQ_INVALID', message: '序号需为从 1 开始的整数' });
    }
    recordSpeakerPull(liveId);

    let items: LoopCastItem[] | null;
    try {
      items = await loadBoundLoopItems(liveId);
    } catch {
      return reply
        .code(500)
        .send({ error: 'LOOP_SCRIPT_LOAD_FAILED', message: '台本读取失败' });
    }
    if (!items || items.length === 0) {
      return reply
        .code(409)
        .send({ error: 'LOOP_SCRIPT_REQUIRED', message: '本场未绑定循环台本' });
    }
    if (seq > items.length) {
      // 客户端据此回绕到第 1 条（竞品用 last_audio_xuhao 回绕，同一个意思）✓
      return reply.code(409).send({
        error: 'SEQ_OUT_OF_RANGE',
        message: `第 ${seq} 条超出本场台本（共 ${items.length} 条）`,
        total: items.length,
      });
    }
    const item = items[seq - 1];
    if (!item) {
      return reply.code(400).send({ error: 'SEQ_INVALID', message: '序号无效' });
    }

    const overrides = await getLiveSpeech(liveId).catch(() => null);
    const cache = (await loadLiveTtsCacheContext(liveId).catch(() => null)) ?? undefined;
    let wavPath: string;
    try {
      wavPath = await synthesizeSpeechFile(item.text, overrides ?? undefined, cache);
    } catch {
      return reply
        .code(500)
        .send({ error: 'SPEECH_SYNTH_FAILED', message: '本条语音合成失败' });
    }
    recordSpeakerSeq(liveId, seq, items.length);
    const jobId = remoteSpeechQueue.registerFile(wavPath);
    return reply.send({
      seq,
      total: items.length,
      text: item.text,
      audioUrl: `${SPEECH_AUDIO_PATH}/${jobId}`,
      gapAfterSeconds: item.gapAfterSeconds ?? DEFAULT_ITEM_GAP_SECONDS,
    });
  });

  /**
   * ★★C：**取一条插播**（AI 回复优先，其次氛围语）；没有就 204 ✓
   *
   * 为什么需要它：C 之后循环位置在客户端，服务端**不知道「什么时候是空档」** ✗ ——
   *   所以改成**客户端每次空档来要一条** ✓
   *   （竞品是服务端用 socket 推 suiaRes / suiafuRes；我们用轮询，语义等价 ✓）
   *
   * 优先级照旧：**回复 > 氛围语**（观众的真问题比暖场词重要）✓；
   * 氛围语仍由 atmosphereScheduler.pickDue 自己控频次 —— 没到期就返回 null，
   * 不会因为「客户端来问」就多插 ✓
   */
  app.get('/api/out/speech/insertion', { preHandler: app.authenticate }, async (request, reply) => {
    const liveId = readLiveIdQuery(request.query);
    if (!liveId) {
      return reply.code(400).send({ error: 'LIVE_ID_REQUIRED', message: '缺少场次标识' });
    }
    recordSpeakerPull(liveId);

    // ① 弹幕回复优先（取出来就算用掉 —— 与 loopCaster.tryInsertReply 同口径）
    let text: string | null = null;
    let kind: 'reply' | 'atmosphere' = 'reply';
    try {
      text = takePendingReply(liveId)?.text ?? null;
    } catch {
      text = null;
    }
    // ② 没有回复 → 看氛围语到期没（到点才给）
    let insertion: AtmosphereInsertion | null = null;
    if (text === null) {
      kind = 'atmosphere';
      try {
        insertion = atmosphereScheduler.pickDue(liveId, Date.now());
      } catch {
        insertion = null;
      }
      text = insertion?.text ?? null;
    }
    if (text === null) {
      return reply.code(204).send();
    }

    const overrides = await getLiveSpeech(liveId).catch(() => null);
    const cache = (await loadLiveTtsCacheContext(liveId).catch(() => null)) ?? undefined;
    let wavPath: string;
    try {
      wavPath = await synthesizeSpeechFile(text, overrides ?? undefined, cache);
    } catch {
      return reply
        .code(500)
        .send({ error: 'SPEECH_SYNTH_FAILED', message: '插播语音合成失败' });
    }
    if (insertion) {
      atmosphereScheduler.markSpoken(liveId, insertion.category, Date.now());
    }
    const jobId = remoteSpeechQueue.registerFile(wavPath);
    return reply.send({
      kind,
      text,
      audioUrl: `${SPEECH_AUDIO_PATH}/${jobId}`,
      // 插播不额外停顿：回复要「接得住」，停一拍反而怪 ✓
      gapAfterSeconds: 0,
    });
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
