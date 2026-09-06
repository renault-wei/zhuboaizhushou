import { afterAll, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildVolcTtsRequestBody,
  collectVolcSseAudio,
  createVolcTtsSynth,
  VOLC_TTS_SSE_PATH,
  VolcTtsError,
  VolcTtsSynth,
  type VolcTranscoder,
} from '../src/services/volcTTS';

// 火山 TTS 旁路单元测试：fetch / ffmpeg 转码全部注入替身，不发真实请求、不落真实文件。

/** 每个用例独立的临时目录，afterAll 统一清理 */
const tempRoot = mkdtempSync(join(tmpdir(), 'starvoice-volc-test-'));

/** 记录异常的便捷工具：断言异常类型与错误码 */
function expectVolcError(promise: Promise<unknown>, code: string): Promise<void> {
  return promise.then(
    () => {
      throw new Error('应当抛出 VolcTtsError，但没有抛');
    },
    (err: unknown) => {
      expect(err).toBeInstanceOf(VolcTtsError);
      expect((err as VolcTtsError).code).toBe(code);
    },
  );
}

/** 造一个往 wavPath 写占位内容的假转码器（模拟 ffmpeg 产物） */
function makeFakeTranscoder(): VolcTranscoder & { calls: Array<{ mp3Path: string; wavPath: string; sampleRate: number }> } {
  const calls: Array<{ mp3Path: string; wavPath: string; sampleRate: number }> = [];
  const transcode: VolcTranscoder = async (mp3Path, wavPath, sampleRate) => {
    calls.push({ mp3Path, wavPath, sampleRate });
    writeFileSync(wavPath, Buffer.from('RIFF-test-wav'));
  };
  return Object.assign(transcode, { calls });
}

afterAll(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

// ---------- 请求体构造 ----------

it('请求体包含文本/音色/采样率/语速/音频格式与扩展参数', () => {
  const body = JSON.parse(
    buildVolcTtsRequestBody({
      text: '欢迎光临本店',
      speaker: 'zh_test_voice',
      sampleRate: 24000,
      speechRate: 0,
    }),
  ) as {
    user?: { uid?: string };
    req_params?: {
      text?: string;
      speaker?: string;
      sample_rate?: number;
      audio_params?: { format?: string; speech_rate?: number };
      additions?: string;
    };
  };
  expect(body.user?.uid).toBeTruthy();
  expect(body.req_params?.text).toBe('欢迎光临本店');
  expect(body.req_params?.speaker).toBe('zh_test_voice');
  expect(body.req_params?.sample_rate).toBe(24000);
  expect(body.req_params?.audio_params?.format).toBe('mp3');
  expect(body.req_params?.audio_params?.speech_rate).toBe(0);
  const additions = JSON.parse(body.req_params?.additions ?? '{}') as {
    disable_markdown_filter?: boolean;
    enable_latex_tn?: boolean;
    post_process?: { pitch?: number };
  };
  expect(additions.disable_markdown_filter).toBe(true);
  expect(additions.enable_latex_tn).toBe(false);
  expect(additions.post_process?.pitch).toBe(0);
});

it('语速越界自动钳制到 [-50, 100]', () => {
  const over = JSON.parse(
    buildVolcTtsRequestBody({ text: '测试', speaker: 's', sampleRate: 24000, speechRate: 999 }),
  ) as { req_params?: { audio_params?: { speech_rate?: number } } };
  const under = JSON.parse(
    buildVolcTtsRequestBody({ text: '测试', speaker: 's', sampleRate: 24000, speechRate: -999 }),
  ) as { req_params?: { audio_params?: { speech_rate?: number } } };
  expect(over.req_params?.audio_params?.speech_rate).toBe(100);
  expect(under.req_params?.audio_params?.speech_rate).toBe(-50);
});

// ---------- SSE 解析 ----------

it('SSE 正常返回：多段 base64 音频按序拼接，忽略非 data 行', () => {
  const first = Buffer.from('abc');
  const second = Buffer.from('defg');
  const sseText = [
    'event: message',
    `data: ${JSON.stringify({ code: 0, data: first.toString('base64') })}`,
    ': 注释行（应忽略）',
    `data: ${JSON.stringify({ code: 20000000, data: second.toString('base64') })}`,
    `data: ${JSON.stringify({ code: 20000000, message: 'ok' })}`,
    '',
  ].join('\n');
  const audio = collectVolcSseAudio(sseText);
  expect(audio.toString('utf8')).toBe('abcdefg');
});

it('SSE 业务错误码：抛 VOLC_TTS_BUSINESS_ERROR 且带服务端提示', () => {
  const sseText = `data: ${JSON.stringify({ code: 401, message: 'invalid api key' })}\n`;
  expect(() => collectVolcSseAudio(sseText)).toThrowError(VolcTtsError);
  try {
    collectVolcSseAudio(sseText);
  } catch (err) {
    expect((err as VolcTtsError).code).toBe('VOLC_TTS_BUSINESS_ERROR');
    expect((err as VolcTtsError).message).toContain('401');
    expect((err as VolcTtsError).message).toContain('invalid api key');
  }
});

it('SSE data 行不是合法 JSON：抛 VOLC_TTS_STREAM_PARSE_FAILED', () => {
  try {
    collectVolcSseAudio('data: not-json\n');
  } catch (err) {
    expect((err as VolcTtsError).code).toBe('VOLC_TTS_STREAM_PARSE_FAILED');
  }
});

it('SSE 全程没有音频 data：抛 VOLC_TTS_NO_AUDIO', () => {
  try {
    collectVolcSseAudio(`data: ${JSON.stringify({ code: 20000000, message: 'done' })}\n`);
  } catch (err) {
    expect((err as VolcTtsError).code).toBe('VOLC_TTS_NO_AUDIO');
  }
});

// ---------- 合成全链路（注入 fetch + 转码）----------

it('未配置 API Key：抛 VOLC_TTS_NOT_CONFIGURED（不发起请求）', async () => {
  const synth = new VolcTtsSynth({ apiKey: '' });
  await expectVolcError(synth.synthesize('测试'), 'VOLC_TTS_NOT_CONFIGURED');
});

it('待合成文本为空：抛 VOLC_TTS_INVALID_PARAMS', async () => {
  const synth = createVolcTtsSynth({
    apiKey: 'test-key',
    fetchFn: async () => new Response('', { status: 200 }),
    transcode: makeFakeTranscoder(),
    outDir: tempRoot,
  });
  await expectVolcError(synth.synthesize('   '), 'VOLC_TTS_INVALID_PARAMS');
});

it('采样率不在官方可选范围：抛 VOLC_TTS_INVALID_PARAMS', async () => {
  const synth = createVolcTtsSynth({
    apiKey: 'test-key',
    sampleRate: 12345,
    transcode: makeFakeTranscoder(),
    outDir: tempRoot,
  });
  await expectVolcError(synth.synthesize('测试'), 'VOLC_TTS_INVALID_PARAMS');
});

it('合成成功：请求头正确、mp3 中间产物被清理、返回可播放的 wav', async () => {
  const audio = Buffer.from('fake-mp3-bytes');
  const sseText = [
    `data: ${JSON.stringify({ code: 0, data: audio.subarray(0, 5).toString('base64') })}`,
    `data: ${JSON.stringify({ code: 20000000, data: audio.subarray(5).toString('base64') })}`,
  ].join('\n');
  const captured: { url?: string; headers?: Record<string, string>; body?: string } = {};
  const fetchFn = async (url: string, init: { headers?: Record<string, string>; body?: string }) => {
    captured.url = url;
    captured.headers = init.headers;
    captured.body = init.body;
    return new Response(sseText, { status: 200 });
  };
  const caseDir = join(tempRoot, 'success');
  mkdirSync(caseDir, { recursive: true });
  const transcoder = makeFakeTranscoder();
  const synth = createVolcTtsSynth({
    apiKey: 'test-key',
    baseUrl: 'https://openspeech.example.com',
    resourceId: 'seed-tts-2.0',
    speaker: 'zh_test_voice',
    sampleRate: 24000,
    fetchFn,
    outDir: caseDir,
    transcode: transcoder,
  });

  const result = await synth.synthesize('  你好，欢迎光临  ');

  expect(result.wavPath.endsWith('.wav')).toBe(true);
  expect(existsSync(result.wavPath)).toBe(true);
  expect(readFileSync(result.wavPath).toString('utf8')).toBe('RIFF-test-wav');
  expect(transcoder.calls).toHaveLength(1);
  expect(transcoder.calls[0]?.sampleRate).toBe(24000);
  expect(transcoder.calls[0]?.wavPath).toBe(result.wavPath);
  // mp3 中间产物在成功返回前已被清理
  const mp3Path = transcoder.calls[0]?.mp3Path;
  expect(mp3Path).toBeTruthy();
  expect(existsSync(mp3Path ?? '')).toBe(false);

  expect(captured.url).toBe(`https://openspeech.example.com${VOLC_TTS_SSE_PATH}`);
  expect(captured.headers?.['X-Api-Key']).toBe('test-key');
  expect(captured.headers?.['X-Api-Resource-Id']).toBe('seed-tts-2.0');
  expect(captured.headers?.['X-Api-Request-Id']).toBeTruthy();
  const requestBody = JSON.parse(captured.body ?? '{}') as {
    req_params?: { text?: string; speaker?: string; sample_rate?: number };
  };
  expect(requestBody.req_params?.text).toBe('你好，欢迎光临');
  expect(requestBody.req_params?.speaker).toBe('zh_test_voice');
  expect(requestBody.req_params?.sample_rate).toBe(24000);
});

it('HTTP 非 2xx：抛 VOLC_TTS_HTTP_FAILED 且带状态码', async () => {
  const fetchFn = async () => new Response('forbidden', { status: 403 });
  const synth = createVolcTtsSynth({
    apiKey: 'test-key',
    fetchFn,
    outDir: tempRoot,
    transcode: makeFakeTranscoder(),
  });
  try {
    await synth.synthesize('测试');
  } catch (err) {
    expect((err as VolcTtsError).code).toBe('VOLC_TTS_HTTP_FAILED');
    expect((err as VolcTtsError).message).toContain('403');
  }
});
