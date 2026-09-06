import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { env } from '../config/env';
import { locateFfmpeg } from './ffmpeg';
import type { LocalWavSynth } from './liveSpeaker';

// G5 商用音色旁路（火山引擎 · 豆包语音合成大模型 2.0）：
// - 按官方「HTTP Chunked/SSE 单向流式-V3」接口实现（openspeech.bytedance.com/api/v3/tts/unidirectional/sse）；
// - 鉴权用新版控制台 API Key（X-Api-Key），资源 ID 默认 seed-tts-2.0；
// - 本轮只落地 provider 骨架 + 配置项：不接默认出声链路（liveSpeaker 仍用本机 SAPI 临时音色），
//   用户填好 VOLC_TTS_API_KEY 并把本 provider 注入 liveSpeaker 即可换商用音色，链路无需改动；
// - 播放器（System.Media.SoundPlayer）只认 PCM wav：请求官方默认 mp3 → ffmpeg 转 16bit 单声道 wav。

// ---------- 常量 ----------

// 官方 SSE 单向流式接口路径（基址默认 https://openspeech.bytedance.com）
export const VOLC_TTS_SSE_PATH = '/api/v3/tts/unidirectional/sse';
// 请求音频格式：mp3（官方默认，兼容性最好），服务端再转码成可播 wav
export const VOLC_TTS_AUDIO_FORMAT = 'mp3';
// SSE data 行 code 字段的成功值：0 与 20000000 均表示成功
export const VOLC_TTS_SUCCESS_CODES = new Set<number>([0, 20000000]);
// 官方可选采样率（超出即按无效参数拒绝）
export const VOLC_TTS_VALID_SAMPLE_RATES = new Set<number>([
  8000, 16000, 22050, 24000, 32000, 44100, 48000,
]);
// 语速合法区间：[-50, 100]，0 为正常语速
export const VOLC_TTS_MIN_SPEECH_RATE = -50;
export const VOLC_TTS_MAX_SPEECH_RATE = 100;
// 单次合成超时兜底（毫秒）：口播回复一般几秒返回，60s 足够
export const VOLC_TTS_TIMEOUT_MS = 60_000;

// ---------- 错误类型 ----------

export type VolcTtsErrorCode =
  | 'VOLC_TTS_NOT_CONFIGURED'
  | 'VOLC_TTS_INVALID_PARAMS'
  | 'VOLC_TTS_HTTP_FAILED'
  | 'VOLC_TTS_STREAM_PARSE_FAILED'
  | 'VOLC_TTS_BUSINESS_ERROR'
  | 'VOLC_TTS_NO_AUDIO'
  | 'VOLC_TTS_FFMPEG_NOT_FOUND'
  | 'VOLC_TTS_TRANSCODE_FAILED'
  | 'VOLC_TTS_WRITE_FAILED';

/** 火山 TTS 业务错误：携带机器可读错误码，由 liveSpeaker 出口按语义吞掉或上报 */
export class VolcTtsError extends Error {
  readonly code: VolcTtsErrorCode;

  constructor(code: VolcTtsErrorCode, message: string) {
    super(message);
    this.name = 'VolcTtsError';
    this.code = code;
  }
}

// ---------- 请求体构造（纯函数，便于单测）----------

export interface VolcTtsRequestBodyInput {
  text: string;
  speaker: string;
  sampleRate: number;
  speechRate: number;
}

/**
 * 组装 V3 SSE 请求体（对齐官方示例字段）：
 * - req_params：text / speaker / sample_rate / audio_params（format=mp3、speech_rate 越界自动钳制）；
 * - additions 为 JSON 字符串：保留 markdown 原文（disable_markdown_filter=true）、
 *   关闭 LaTeX 播报（口播场景用不到）、pitch=0 不调音调。
 */
export function buildVolcTtsRequestBody(input: VolcTtsRequestBodyInput): string {
  const speechRate = Math.min(
    VOLC_TTS_MAX_SPEECH_RATE,
    Math.max(VOLC_TTS_MIN_SPEECH_RATE, input.speechRate),
  );
  const additions = JSON.stringify({
    post_process: { pitch: 0 },
    disable_markdown_filter: true,
    enable_latex_tn: false,
    latex_parser: 'v2',
  });
  return JSON.stringify({
    user: { uid: 'starvoice-live' },
    req_params: {
      text: input.text,
      speaker: input.speaker,
      sample_rate: input.sampleRate,
      audio_params: {
        format: VOLC_TTS_AUDIO_FORMAT,
        speech_rate: speechRate,
      },
      additions,
    },
  });
}

// ---------- SSE 响应解析（纯函数，便于单测）----------

/** SSE data 行 JSON 的最小结构（code / message / data 均可能缺省） */
interface VolcSseEvent {
  code?: unknown;
  message?: unknown;
  data?: unknown;
}

/**
 * 逐行解析 SSE 响应文本，把 data: 行的音频 base64 按序解码拼接成一个 Buffer。
 * 规则（对齐官方文档与示例脚本）：
 * - 只认 data: 开头的行，其余行（事件注释 / 空行等）忽略；
 * - code 属于成功集合（0 / 20000000）才继续，否则抛业务错误并带服务端 message；
 * - 全部成功事件都没有 data 时抛 NO_AUDIO，避免把空结果当成合成成功。
 */
export function collectVolcSseAudio(sseText: string): Buffer {
  const parts: Buffer[] = [];
  for (const rawLine of sseText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith('data:')) {
      continue;
    }
    const payload = line.slice('data:'.length).trim();
    if (payload.length === 0) {
      continue;
    }
    let event: VolcSseEvent;
    try {
      event = JSON.parse(payload) as VolcSseEvent;
    } catch {
      throw new VolcTtsError(
        'VOLC_TTS_STREAM_PARSE_FAILED',
        `火山 TTS SSE data 行不是合法 JSON：${payload.slice(0, 120)}`,
      );
    }
    const code = typeof event.code === 'number' ? event.code : 0;
    if (!VOLC_TTS_SUCCESS_CODES.has(code)) {
      const message = (typeof event.message === 'string' ? event.message : '').slice(0, 300);
      throw new VolcTtsError(
        'VOLC_TTS_BUSINESS_ERROR',
        `火山 TTS 返回错误码 ${code}${message.length > 0 ? `：${message}` : ''}`,
      );
    }
    if (typeof event.data === 'string' && event.data.length > 0) {
      parts.push(Buffer.from(event.data, 'base64'));
    }
  }
  if (parts.length === 0) {
    throw new VolcTtsError('VOLC_TTS_NO_AUDIO', '火山 TTS 未返回任何音频数据');
  }
  return Buffer.concat(parts);
}

// ---------- 音频转码 ----------

/** mp3 → PCM wav 转码器：测试可注入假实现，生产默认走 ffmpeg */
export type VolcTranscoder = (
  mp3Path: string,
  wavPath: string,
  sampleRate: number,
) => Promise<void>;

/**
 * 生产转码器：ffmpeg 把火山返回的 mp3 转成 16bit 单声道 PCM wav
 * （SoundPlayer 可播格式；声道/采样率强制统一，避免播放器不认）。
 */
export const volcDefaultTranscoder: VolcTranscoder = async (
  mp3Path,
  wavPath,
  sampleRate,
) => {
  let ffmpegPath: string;
  try {
    ffmpegPath = locateFfmpeg();
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new VolcTtsError('VOLC_TTS_FFMPEG_NOT_FOUND', detail);
  }
  const result = spawnSync(
    ffmpegPath,
    ['-y', '-i', mp3Path, '-ac', '1', '-ar', String(sampleRate), '-c:a', 'pcm_s16le', wavPath],
    { encoding: 'utf8', windowsHide: true },
  );
  if (result.error) {
    throw new VolcTtsError('VOLC_TTS_TRANSCODE_FAILED', `启动 ffmpeg 转码失败：${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = (result.stderr ?? '').trim().slice(0, 300);
    throw new VolcTtsError(
      'VOLC_TTS_TRANSCODE_FAILED',
      `ffmpeg 转码失败${detail.length > 0 ? `：${detail}` : ''}`,
    );
  }
};

// ---------- 合成器（与 liveSpeaker 的 LocalWavSynth 同构）----------

export interface VolcTtsSynthOptions {
  /** 火山语音 API Key；缺省读环境变量 VOLC_TTS_API_KEY */
  apiKey?: string;
  /** 服务基址（一般保持官方默认即可） */
  baseUrl?: string;
  /** 合成资源 ID，默认 seed-tts-2.0 */
  resourceId?: string;
  /** 默认音色（发音人 ID），可被 synthesize 入参覆盖 */
  speaker?: string;
  /** 采样率：官方可选 8000/16000/22050/24000/32000/44100/48000 */
  sampleRate?: number;
  /** 语速：[-50, 100]，0 为正常语速 */
  speechRate?: number;
  /** 单次请求超时（毫秒），默认 60s */
  timeoutMs?: number;
  /** 测试注入 fetch；生产用全局 fetch */
  fetchFn?: typeof fetch;
  /** 测试指定临时输出目录；默认系统临时目录 */
  outDir?: string;
  /** 测试注入转码器；生产用 ffmpeg */
  transcode?: VolcTranscoder;
}

/**
 * 火山 TTS 合成器：
 * - 实现 LocalWavSynth.synthesize(text) → { wavPath }，与 liveSpeaker 现有合成器同构，
 *   key 到位后可整体注入 createLiveSpeaker 换下本机 SAPI 音色，链路代码不动；
 * - 任一配置项缺省都回落环境变量；全部缺省时 synthesize 抛 NOT_CONFIGURED。
 */
export class VolcTtsSynth implements LocalWavSynth {
  private readonly options: VolcTtsSynthOptions;

  constructor(options: VolcTtsSynthOptions = {}) {
    this.options = options;
  }

  /** 把一段文字合成为可直接播放的 PCM wav，返回临时文件绝对路径（调用方播完负责清理） */
  async synthesize(text: string): Promise<{ wavPath: string }> {
    const apiKey = this.options.apiKey ?? env.volcTTS.apiKey;
    if (!apiKey) {
      throw new VolcTtsError(
        'VOLC_TTS_NOT_CONFIGURED',
        '未配置 VOLC_TTS_API_KEY：火山 TTS 旁路暂不可用，配置后即可真连验证',
      );
    }
    const cleaned = text.trim();
    if (cleaned.length === 0) {
      throw new VolcTtsError('VOLC_TTS_INVALID_PARAMS', '待合成文本不能为空');
    }
    const baseUrl = (this.options.baseUrl ?? env.volcTTS.baseUrl).replace(/\/+$/, '');
    const resourceId = this.options.resourceId ?? env.volcTTS.resourceId;
    const speaker = this.options.speaker ?? env.volcTTS.speaker;
    const sampleRate = this.options.sampleRate ?? env.volcTTS.sampleRate;
    if (!VOLC_TTS_VALID_SAMPLE_RATES.has(sampleRate)) {
      throw new VolcTtsError(
        'VOLC_TTS_INVALID_PARAMS',
        `采样率 ${sampleRate} 不在火山官方可选范围（8000~48000）`,
      );
    }
    const speechRate = this.options.speechRate ?? env.volcTTS.speechRate;
    const timeoutMs = this.options.timeoutMs ?? VOLC_TTS_TIMEOUT_MS;
    const fetchFn = this.options.fetchFn ?? fetch;
    const outDir = this.options.outDir ?? tmpdir();
    const transcode = this.options.transcode ?? volcDefaultTranscoder;

    const url = `${baseUrl}${VOLC_TTS_SSE_PATH}`;
    const body = buildVolcTtsRequestBody({
      text: cleaned,
      speaker,
      sampleRate,
      speechRate,
    });

    let response: Response;
    try {
      response = await fetchFn(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Api-Key': apiKey,
          'X-Api-Resource-Id': resourceId,
          'X-Api-Request-Id': randomUUID(),
        },
        body,
        signal: buildAbortSignal(timeoutMs),
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new VolcTtsError('VOLC_TTS_HTTP_FAILED', `调用火山 TTS 失败：${detail}`);
    }

    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).trim().slice(0, 300);
      throw new VolcTtsError(
        'VOLC_TTS_HTTP_FAILED',
        `火山 TTS 返回异常状态 ${response.status}${detail.length > 0 ? `：${detail}` : ''}`,
      );
    }

    let sseText: string;
    try {
      sseText = await response.text();
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new VolcTtsError('VOLC_TTS_STREAM_PARSE_FAILED', `读取火山 TTS 响应失败：${detail}`);
    }
    const audioBytes = collectVolcSseAudio(sseText);

    const id = randomUUID();
    const mp3Path = join(outDir, `starvoice-volc-${id}.mp3`);
    const wavPath = join(outDir, `starvoice-volc-${id}.wav`);
    try {
      try {
        await writeFile(mp3Path, audioBytes);
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        throw new VolcTtsError('VOLC_TTS_WRITE_FAILED', `写入火山音频临时文件失败：${detail}`);
      }
      try {
        await transcode(mp3Path, wavPath, sampleRate);
      } catch (err) {
        if (err instanceof VolcTtsError) {
          throw err;
        }
        const detail = err instanceof Error ? err.message : String(err);
        throw new VolcTtsError('VOLC_TTS_TRANSCODE_FAILED', `火山音频转码失败：${detail}`);
      }
      if (!existsSync(wavPath) || statSync(wavPath).size <= 0) {
        throw new VolcTtsError('VOLC_TTS_TRANSCODE_FAILED', '转码产物为空或不存在');
      }
      return { wavPath };
    } catch (err) {
      // 失败时清理可能残留的半成品 wav；成功时 wav 是交付物，留给调用方播完清理
      await unlink(wavPath).catch(() => undefined);
      throw err;
    } finally {
      // mp3 中间产物不入库，无论成败都清理
      await unlink(mp3Path).catch(() => undefined);
    }
  }
}

/** 生成可选的超时信号：<=0 视为不设超时（测试注入的 fetch 无需真实信号） */
function buildAbortSignal(timeoutMs: number): AbortSignal | undefined {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return undefined;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('火山 TTS 请求超时')), timeoutMs);
  timer.unref?.();
  return controller.signal;
}

// ---------- 工厂 + 单例 ----------

/** 火山 TTS 合成器工厂：默认读环境变量；测试可注入 fetch / 转码 / 临时目录 */
export function createVolcTtsSynth(options: VolcTtsSynthOptions = {}): VolcTtsSynth {
  return new VolcTtsSynth(options);
}

// 全局单例：配置 VOLC_TTS_API_KEY 并真连验证通过后，作为 liveSpeaker 的音色 provider 注入
export const volcTtsSynth = createVolcTtsSynth();
