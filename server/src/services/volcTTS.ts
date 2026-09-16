import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { env } from '../config/env';
import { locateFfmpeg } from './ffmpeg';
import type { LocalWavSynth } from './liveSpeaker';

// G5 商用音色旁路（火山引擎 · 豆包语音合成大模型 2.0）：
// - 按官方「HTTP Chunked/SSE 单向流式-V3」接口实现（openspeech.bytedance.com/api/v3/tts/unidirectional/sse）；
// - 鉴权用新版控制台 API Key（X-Api-Key），资源 ID 默认 seed-tts-2.0；
// - 接入方式：liveSpeaker 在 LIVE_TTS_PROVIDER=volc 且 VOLC_TTS_API_KEY 已配置时换用本 provider 出声；
//   默认 local / 未配 key / 火山模型服务未开通时回退本机 SAPI 保出声，链路代码无需改动；
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
// 单次请求文本上限（字符数）：超长文本在合成层先分段、逐段合成再把音频拼回一条，
// 避免撞上官方单请求长度限制导致整段话术合成失败（对外仍是「一次 synthesize 一条 wav」）。
export const VOLC_TTS_MAX_CHARS_PER_REQUEST = 200;

// ---------- 文本分段（纯函数，便于单测）----------

/** 句末标点：优先在此断开，标点归前一段 */
const TTS_SEGMENT_PRIMARY_BREAKS = new Set(['。', '！', '？', '；', '…', '!', '?', ';', '\n']);
/** 次级标点：句末标点切完仍超长时，退而在此断开 */
const TTS_SEGMENT_SECONDARY_BREAKS = new Set(['，', '、', ',']);

/**
 * 把一段长文本切成若干不超过 maxChars 个字符的片段（纯函数）：
 * - 优先在句末标点后断开（标点随前一段），其次在逗号/顿号后断开，仍超长则硬切；
 * - 不丢字、不加字、不改写，不变式 segments.join('') === text；
 * - maxChars <= 0 或文本本身不超长时返回单段（空文本返回空数组）。
 */
export function splitTtsSegments(text: string, maxChars: number): string[] {
  const limit = Math.floor(maxChars);
  if (!Number.isFinite(limit) || limit <= 0 || text.length <= limit) {
    return text.length === 0 ? [] : [text];
  }
  const segments: string[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const hardEnd = cursor + limit;
    if (hardEnd >= text.length) {
      segments.push(text.slice(cursor));
      break;
    }
    let cut = -1;
    for (let i = hardEnd - 1; i >= cursor; i -= 1) {
      if (TTS_SEGMENT_PRIMARY_BREAKS.has(text[i] ?? '')) {
        cut = i + 1;
        break;
      }
    }
    if (cut <= cursor) {
      for (let i = hardEnd - 1; i >= cursor; i -= 1) {
        if (TTS_SEGMENT_SECONDARY_BREAKS.has(text[i] ?? '')) {
          cut = i + 1;
          break;
        }
      }
    }
    if (cut <= cursor) {
      cut = hardEnd;
      // 硬切时避免把代理对（emoji 等）拦腰截断
      const prev = text.charCodeAt(cut - 1);
      if (prev >= 0xd800 && prev <= 0xdbff && cut - 1 > cursor) {
        cut -= 1;
      }
    }
    segments.push(text.slice(cursor, cut));
    cursor = cut;
  }
  return segments;
}

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

// ---------- 多段音频拼接 ----------

/** 多段 mp3 拼装器：测试可注入假实现，生产默认走 ffmpeg concat */
export type VolcMp3Concatenator = (mp3Paths: string[], outPath: string) => Promise<void>;

/**
 * 生产拼装器：ffmpeg concat demuxer 把同一音色/同一参数下发返回的多段 mp3 拼成一条。
 * - 分段出自同一编码器与同一参数，可 -c copy 直接拼接，无需二次编码；
 * - 清单内路径统一转正斜杠（Windows 绝对路径的反斜杠会被 concat 清单当转义符吃掉）；
 * - 清单文件与分段 mp3 一样属中间产物，无论成败就地清理。
 */
export const volcDefaultConcatMp3: VolcMp3Concatenator = async (mp3Paths, outPath) => {
  let ffmpegPath: string;
  try {
    ffmpegPath = locateFfmpeg();
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new VolcTtsError('VOLC_TTS_FFMPEG_NOT_FOUND', detail);
  }
  // concat 清单语法：file '<路径>'；路径内反斜杠先转正斜杠，单引号按 ffmpeg 规则转义
  const toListLine = (one: string): string =>
    `file '${one.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`;
  const listPath = join(dirname(outPath), `starvoice-volc-concat-${randomUUID()}.txt`);
  try {
    await writeFile(listPath, `${mp3Paths.map(toListLine).join('\n')}\n`, 'utf8');
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new VolcTtsError('VOLC_TTS_WRITE_FAILED', `写入音频拼接清单失败：${detail}`);
  }
  try {
    const result = spawnSync(
      ffmpegPath,
      ['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', outPath],
      { encoding: 'utf8', windowsHide: true },
    );
    if (result.error) {
      throw new VolcTtsError(
        'VOLC_TTS_TRANSCODE_FAILED',
        `启动 ffmpeg 拼接失败：${result.error.message}`,
      );
    }
    if (result.status !== 0) {
      const detail = (result.stderr ?? '').trim().slice(0, 300);
      throw new VolcTtsError(
        'VOLC_TTS_TRANSCODE_FAILED',
        `ffmpeg 拼接分段音频失败${detail.length > 0 ? `：${detail}` : ''}`,
      );
    }
  } finally {
    await unlink(listPath).catch(() => undefined);
  }
};

// ---------- 合成器（与 liveSpeaker 的 LocalWavSynth 同构）----------

/** 单次合成覆盖项：缺省回落构造/环境变量默认值，liveSpeaker 现有调用（只传 text）行为完全不变 */
export interface VolcTtsTextOverrides {
  /** 本次合成音色（发音人 ID） */
  speaker?: string;
  /** 本次合成语速：[-50, 100]，0 为正常语速 */
  speechRate?: number;
}

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
  /** 测试注入多段拼装器；生产用 ffmpeg concat */
  concatMp3?: VolcMp3Concatenator;
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
  async synthesize(text: string, overrides: VolcTtsTextOverrides = {}): Promise<{ wavPath: string }> {
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
    const speaker = overrides.speaker ?? this.options.speaker ?? env.volcTTS.speaker;
    const sampleRate = this.options.sampleRate ?? env.volcTTS.sampleRate;
    if (!VOLC_TTS_VALID_SAMPLE_RATES.has(sampleRate)) {
      throw new VolcTtsError(
        'VOLC_TTS_INVALID_PARAMS',
        `采样率 ${sampleRate} 不在火山官方可选范围（8000~48000）`,
      );
    }
    const speechRate = overrides.speechRate ?? this.options.speechRate ?? env.volcTTS.speechRate;
    const timeoutMs = this.options.timeoutMs ?? VOLC_TTS_TIMEOUT_MS;
    const fetchFn = this.options.fetchFn ?? fetch;
    const outDir = this.options.outDir ?? tmpdir();
    const transcode = this.options.transcode ?? volcDefaultTranscoder;
    const concatMp3 = this.options.concatMp3 ?? volcDefaultConcatMp3;

    const url = `${baseUrl}${VOLC_TTS_SSE_PATH}`;
    // 超长文本先按标点分段，逐段合成 mp3，再拼回一条，最后只转码一次
    const segments = splitTtsSegments(cleaned, VOLC_TTS_MAX_CHARS_PER_REQUEST);

    /** 合成单个片段：请求 + 收流，返回该段 mp3 字节（错误语义与原单请求一致） */
    const requestSegment = async (segmentText: string): Promise<Buffer> => {
      const body = buildVolcTtsRequestBody({
        text: segmentText,
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
      return collectVolcSseAudio(sseText);
    };

    const id = randomUUID();
    const wavPath = join(outDir, `starvoice-volc-${id}.wav`);
    /** 已落盘的分段 mp3（中间产物，无论成败都要清理） */
    const segmentMp3Paths: string[] = [];
    /** 分段拼出的中间 mp3（仅多段时存在） */
    let mergedMp3Path: string | undefined;
    try {
      for (let i = 0; i < segments.length; i += 1) {
        const audioBytes = await requestSegment(segments[i] ?? '');
        const segmentPath = join(outDir, `starvoice-volc-${id}-${i}.mp3`);
        try {
          await writeFile(segmentPath, audioBytes);
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          throw new VolcTtsError('VOLC_TTS_WRITE_FAILED', `写入火山音频临时文件失败：${detail}`);
        }
        segmentMp3Paths.push(segmentPath);
      }

      // 单段直接转码；多段先用 ffmpeg concat 拼成一条 mp3，再统一转码（只转一次）
      let sourceMp3Path = segmentMp3Paths[0];
      if (sourceMp3Path === undefined) {
        throw new VolcTtsError('VOLC_TTS_INVALID_PARAMS', '待合成文本不能为空');
      }
      if (segmentMp3Paths.length > 1) {
        const mergedPath = join(outDir, `starvoice-volc-${id}-merged.mp3`);
        try {
          await concatMp3(segmentMp3Paths, mergedPath);
        } catch (err) {
          if (err instanceof VolcTtsError) {
            throw err;
          }
          const detail = err instanceof Error ? err.message : String(err);
          throw new VolcTtsError('VOLC_TTS_TRANSCODE_FAILED', `拼接分段音频失败：${detail}`);
        }
        mergedMp3Path = mergedPath;
        sourceMp3Path = mergedPath;
      }

      try {
        await transcode(sourceMp3Path, wavPath, sampleRate);
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
      // mp3 中间产物不入库，无论成败都清理（含分段件与拼接件）
      for (const segmentPath of segmentMp3Paths) {
        await unlink(segmentPath).catch(() => undefined);
      }
      if (mergedMp3Path !== undefined) {
        await unlink(mergedMp3Path).catch(() => undefined);
      }
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

// 全局单例：liveSpeaker 在配置了 VOLC_TTS_API_KEY 时自动用它作为出声音色
export const volcTtsSynth = createVolcTtsSynth();
