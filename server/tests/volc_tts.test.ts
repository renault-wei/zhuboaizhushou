import { afterAll, expect, it } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildVolcTtsRequestBody,
  collectVolcSseAudio,
  createVolcTtsSynth,
  splitTtsSegments,
  VOLC_TTS_MAX_CHARS_PER_REQUEST,
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

it('单次合成覆盖 speaker/语速：请求体带覆盖值（缺省回落构造值）', async () => {
  const audio = Buffer.from('fake-mp3-bytes');
  const sseText = [
    `data: ${JSON.stringify({ code: 0, data: audio.toString('base64') })}`,
    `data: ${JSON.stringify({ code: 20000000, message: 'ok' })}`,
  ].join('\n');
  const captured: { body?: string } = {};
  const fetchFn = async (_url: string, init: { body?: string }) => {
    captured.body = init.body;
    return new Response(sseText, { status: 200 });
  };
  const caseDir = join(tempRoot, 'override');
  mkdirSync(caseDir, { recursive: true });
  const synth = createVolcTtsSynth({
    apiKey: 'test-key',
    baseUrl: 'https://openspeech.example.com',
    sampleRate: 24000,
    fetchFn,
    outDir: caseDir,
    transcode: makeFakeTranscoder(),
  });
  await synth.synthesize('帮我覆盖音色', {
    speaker: 'zh_male_m191_uranus_bigtts',
    speechRate: 30,
  });
  const body = JSON.parse(captured.body ?? '{}') as {
    req_params?: { speaker?: string; audio_params?: { speech_rate?: number } };
  };
  expect(body.req_params?.speaker).toBe('zh_male_m191_uranus_bigtts');
  expect(body.req_params?.audio_params?.speech_rate).toBe(30);
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

// ---------- 超长文本分段合成 + 拼装 ----------

it('splitTtsSegments：不丢字不改写，标点优先断开、超长硬切', () => {
  const plain = 'a'.repeat(450);
  const hardCut = splitTtsSegments(plain, 200);
  expect(hardCut.map((segment) => segment.length)).toEqual([200, 200, 50]);
  expect(hardCut.join('')).toBe(plain);

  const punctuated = '欢迎光临本店，今天有团购优惠。'.repeat(20);
  const segments = splitTtsSegments(punctuated, 200);
  expect(segments.length).toBeGreaterThan(1);
  expect(segments.every((segment) => segment.length <= 200)).toBe(true);
  expect(segments.join('')).toBe(punctuated);
  // 优先在句末标点后断开：除末段外都以句号收尾
  expect(segments.slice(0, -1).every((segment) => segment.endsWith('。'))).toBe(true);

  expect(splitTtsSegments('短文本', 200)).toEqual(['短文本']);
  expect(splitTtsSegments('', 200)).toEqual([]);
});

it('短文本：只发一次请求、只转码一次，不触发拼装', async () => {
  const audio = Buffer.from('single-segment-mp3');
  const sseText = [
    `data: ${JSON.stringify({ code: 0, data: audio.toString('base64') })}`,
    `data: ${JSON.stringify({ code: 20000000 })}`,
  ].join('\n');
  let fetchCount = 0;
  const fetchFn = async () => {
    fetchCount += 1;
    return new Response(sseText, { status: 200 });
  };
  const caseDir = join(tempRoot, 'single-segment');
  mkdirSync(caseDir, { recursive: true });
  const transcoder = makeFakeTranscoder();
  let concatCount = 0;
  const synth = createVolcTtsSynth({
    apiKey: 'test-key',
    sampleRate: 24000,
    fetchFn,
    outDir: caseDir,
    transcode: transcoder,
    concatMp3: async () => {
      concatCount += 1;
    },
  });

  const result = await synth.synthesize('你好，欢迎光临');

  expect(fetchCount).toBe(1);
  expect(concatCount).toBe(0);
  expect(transcoder.calls).toHaveLength(1);
  expect(transcoder.calls[0]?.mp3Path.endsWith('.mp3')).toBe(true);
  expect(transcoder.calls[0]?.mp3Path).not.toContain('merged');
  expect(existsSync(result.wavPath)).toBe(true);
  // mp3 中间产物已清理，只剩交付的 wav
  expect(readdirSync(caseDir).filter((name) => name.endsWith('.mp3'))).toEqual([]);
  expect(readdirSync(caseDir).filter((name) => name.endsWith('.wav'))).toHaveLength(1);
});

it('超长文本：逐段请求、拼装一次、只转码一次，中间产物全部清理', async () => {
  const text = '欢迎光临本店，今天有团购优惠。'.repeat(20);
  const expectedSegments = splitTtsSegments(text, VOLC_TTS_MAX_CHARS_PER_REQUEST);
  expect(expectedSegments.length).toBeGreaterThan(1);
  const requestedTexts: string[] = [];
  const fetchFn = async (_url: string, init: { body?: string }) => {
    const body = JSON.parse(init.body ?? '{}') as { req_params?: { text?: string } };
    requestedTexts.push(body.req_params?.text ?? '');
    const audio = Buffer.from(`mp3-${requestedTexts.length}`);
    const sseText = [
      `data: ${JSON.stringify({ code: 0, data: audio.toString('base64') })}`,
      `data: ${JSON.stringify({ code: 20000000 })}`,
    ].join('\n');
    return new Response(sseText, { status: 200 });
  };
  const caseDir = join(tempRoot, 'multi-segment');
  mkdirSync(caseDir, { recursive: true });
  const transcoder = makeFakeTranscoder();
  const concatCalls: Array<{ inputs: string[]; outPath: string }> = [];
  const synth = createVolcTtsSynth({
    apiKey: 'test-key',
    sampleRate: 24000,
    fetchFn,
    outDir: caseDir,
    transcode: transcoder,
    concatMp3: async (inputs, outPath) => {
      concatCalls.push({ inputs: [...inputs], outPath });
    },
  });

  const result = await synth.synthesize(text);

  // 每段请求文本与分段一致，拼起来不丢字
  expect(requestedTexts).toEqual(expectedSegments);
  expect(requestedTexts.join('')).toBe(text);
  expect(requestedTexts.every((segment) => segment.length <= VOLC_TTS_MAX_CHARS_PER_REQUEST)).toBe(true);

  // 段数 >1：拼装一次，且只转码一次（转的是拼装产物）
  expect(concatCalls).toHaveLength(1);
  expect(concatCalls[0]?.inputs).toHaveLength(expectedSegments.length);
  expect(concatCalls[0]?.outPath.endsWith('-merged.mp3')).toBe(true);
  expect(transcoder.calls).toHaveLength(1);
  expect(transcoder.calls[0]?.mp3Path).toBe(concatCalls[0]?.outPath);

  expect(existsSync(result.wavPath)).toBe(true);
  expect(readFileSync(result.wavPath).toString('utf8')).toBe('RIFF-test-wav');
  // 分段 mp3 + 拼装 mp3 全部清理
  expect(readdirSync(caseDir).filter((name) => name.endsWith('.mp3'))).toEqual([]);
});

it('拼装失败：抛 VOLC_TTS_TRANSCODE_FAILED 且不残留任何中间件', async () => {
  const text = '欢迎光临本店，今天有团购优惠。'.repeat(20);
  const audio = Buffer.from('multi-segment-mp3');
  const sseText = [
    `data: ${JSON.stringify({ code: 0, data: audio.toString('base64') })}`,
    `data: ${JSON.stringify({ code: 20000000 })}`,
  ].join('\n');
  const fetchFn = async () => new Response(sseText, { status: 200 });
  const caseDir = join(tempRoot, 'concat-failed');
  mkdirSync(caseDir, { recursive: true });
  const synth = createVolcTtsSynth({
    apiKey: 'test-key',
    sampleRate: 24000,
    fetchFn,
    outDir: caseDir,
    transcode: makeFakeTranscoder(),
    concatMp3: async () => {
      throw new Error('ffmpeg concat 失败');
    },
  });

  await expectVolcError(synth.synthesize(text), 'VOLC_TTS_TRANSCODE_FAILED');

  expect(readdirSync(caseDir)).toEqual([]);
});