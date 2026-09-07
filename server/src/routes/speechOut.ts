import type { FastifyPluginAsync } from 'fastify';
import { createReadStream } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { remoteSpeechQueue } from '../services/remoteSpeechQueue';

// P1 手机线：远程出声端轮询拉取接口（助播机 App / 二期客户端消费）。
// 语义：一次 GET = 交付队首一条 wav（拉取成功即视为已出声），流式返回后删除临时文件；
// 空队列返回 204。鉴权复用登录 token；当前单商家自用口径为全局队列，多门店化时再按用户 / 场次隔离。
export const speechOutRoutes: FastifyPluginAsync = async (app) => {
  app.get('/api/out/speech/next', { preHandler: app.authenticate }, async (_request, reply) => {
    const job = remoteSpeechQueue.take();
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
