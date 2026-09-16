// TTS 分段预览（R19）：给定一段文本，回它在火山合成层会被**切成几段、切在哪**。
//
// 为什么需要暴露：A5-2（2026-09-17）放开了 200 字业务限制后，长话术走的是
// 「按标点切段 → 逐段合成 → ffmpeg 拼回单段音频」（A5-1）。用户需要能看见
// 「这份话术会被切成几份、断点落在哪」——**断点必须落在标点上，听感才不会有句中停顿**。
//
// 单一真相源：这里直接复用合成链路自己的 splitTtsSegments，
// 不在客户端另写一份（两份实现一定会漂移，届时看到的份数就不是实际合成的份数）。

import type { FastifyPluginAsync } from 'fastify';
import { MAX_LOOP_ITEM_TEXT_LENGTH } from '../services/loopScript';
import { splitTtsSegments, VOLC_TTS_MAX_CHARS_PER_REQUEST } from '../services/volcTTS';

/** 读取请求体里的 text 字段 */
function readText(body: unknown): string {
  if (typeof body !== 'object' || body === null) {
    return '';
  }
  const value = (body as Record<string, unknown>).text;
  return typeof value === 'string' ? value.trim() : '';
}

export const ttsRoutes: FastifyPluginAsync = async (app) => {
  app.post('/api/tts/segment-preview', { preHandler: app.authenticate }, async (request, reply) => {
    const text = readText(request.body);
    if (text.length === 0) {
      return reply.code(400).send({ error: 'TEXT_REQUIRED', message: '请输入要预览的文本' });
    }
    if (text.length > MAX_LOOP_ITEM_TEXT_LENGTH) {
      return reply.code(400).send({
        error: 'TEXT_TOO_LONG',
        message: `文本超过安全上限（${MAX_LOOP_ITEM_TEXT_LENGTH} 字）`,
      });
    }
    const segments = splitTtsSegments(text, VOLC_TTS_MAX_CHARS_PER_REQUEST);
    return {
      maxCharsPerRequest: VOLC_TTS_MAX_CHARS_PER_REQUEST,
      charCount: text.length,
      segmentCount: segments.length,
      segments: segments.map((one, index) => ({
        index: index + 1,
        chars: one.length,
        text: one,
      })),
    };
  });
};
