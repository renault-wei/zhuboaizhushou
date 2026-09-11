import type { FastifyPluginAsync } from 'fastify';
import { createReadStream } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { remoteSpeechQueue } from '../services/remoteSpeechQueue';

// P1 手机线：远程出声端轮询拉取接口（助播机 App / 二期客户端消费）。
// 语义：一次 GET = 交付队首一条 wav（拉取成功即视为已出声），流式返回后删除临时文件；
// 空队列返回 204。鉴权复用登录 token；当前单商家自用口径为全局队列，多门店化时再按用户 / 场次隔离。
// 带 ?liveId= 时只取该场次音频（多场并发互不插队）；不带则取全局队首（兼容旧客户端）。
export const speechOutRoutes: FastifyPluginAsync = async (app) => {
  app.get('/api/out/speech/next', { preHandler: app.authenticate }, async (_request, reply) => {
    const liveId = readLiveIdQuery(_request.query);
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
