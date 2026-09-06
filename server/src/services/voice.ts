import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { env } from '../config/env';

// ---------- 常量 ----------

// mock 克隆返回的 voice_id 前缀：真实 CosyVoice 每次克隆都返回新 voice_id，mock 用前缀便于识别
export const MOCK_VOICE_ID_PREFIX = 'mock-voice-';

// DashScope CosyVoice 非流式 TTS 默认服务地址（COSYVOICE_BASE_URL 留空时使用）
const DASHSCOPE_BASE_URL = 'https://dashscope.aliyuncs.com';

// TTS 合成采样率：wav 输出统一 22050
const COSYVOICE_TTS_SAMPLE_RATE = 22050;

// ---------- 错误类型 ----------

export type VoiceErrorCode = 'CLONE_FAILED' | 'TTS_SYNTHESIZE_FAILED';

/** CosyVoice 服务业务错误：携带机器可读错误码，由路由层翻译成 HTTP 状态 */
export class VoiceError extends Error {
  readonly code: VoiceErrorCode;

  constructor(code: VoiceErrorCode, message: string) {
    super(message);
    this.name = 'VoiceError';
    this.code = code;
  }
}

// ---------- 接口定义 ----------

export interface CreateCloneTaskInput {
  userId: string;
  name: string;
  sampleDurationSeconds: number;
  sampleFingerprint?: string;
}

/** 口播 TTS 合成入参：话术全文 + 已就绪音色的 CosyVoice voice_id */
export interface SynthesizeSpeechInput {
  /** 口播话术全文（对应 live 绑定 script 的 content） */
  text: string;
  /** 音色在 CosyVoice 侧的 voice_id（voices.provider_voice_id） */
  providerVoiceId: string;
}

/**
 * CosyVoice 服务接口：声音克隆 + 口播 TTS 合成。
 * 真实 CosyVoice 克隆是异步任务：createCloneTask 提交后立即返回 voice_id，
 * 克隆进度由路由层轮询推进。TTS 合成是同步请求：synthesizeSpeech 返回 wav 文件路径。
 * mock / 真实实现都遵循同一接口，由工厂函数按环境切换。
 */
export interface CosyVoiceService {
  /** 提交克隆任务，立即返回 CosyVoice voice_id */
  createCloneTask(input: CreateCloneTaskInput): Promise<{ providerVoiceId: string }>;
  /**
   * 用指定音色把话术全文合成为 wav，返回产物绝对路径。
   * 产物为临时文件，调用方用完后负责清理。
   */
  synthesizeSpeech(input: SynthesizeSpeechInput): Promise<{ wavPath: string }>;
}

// ---------- 通用工具 ----------

/** mock 克隆 voice_id：真实声音克隆接入（后续任务）前，统一返回可识别的占位 id */
function mockCloneVoiceId(): string {
  return `${MOCK_VOICE_ID_PREFIX}${randomUUID()}`;
}

// ---------- mock 实现 ----------

/**
 * mock CosyVoice：
 * - createCloneTask 每次返回全新的 mock-voice- 前缀 voice_id；
 * - 异步状态流转（pending → processing → ready）不在 service 里用 setTimeout 推进
 *   （服务重启丢任务、测试难控制），改由路由层在轮询时按创建时间惰性推进；
 * - synthesizeSpeech 不具备真实合成能力，调用即抛错：mock 模式下合成应回退占位音轨。
 */
export class MockCosyVoiceService implements CosyVoiceService {
  async createCloneTask(_input: CreateCloneTaskInput): Promise<{ providerVoiceId: string }> {
    return { providerVoiceId: mockCloneVoiceId() };
  }

  async synthesizeSpeech(_input: SynthesizeSpeechInput): Promise<{ wavPath: string }> {
    throw new VoiceError(
      'TTS_SYNTHESIZE_FAILED',
      'mock 模式不支持真实语音合成：请配置 COSYVOICE_API_KEY 并关闭 MOCK_COSYVOICE 后重试',
    );
  }
}

// ---------- 真实实现（阿里云 DashScope CosyVoice 非流式 TTS）----------

/** DashScope 非流式 TTS 响应中需要的最小结构 */
interface DashScopeTtsResponse {
  output?: {
    audio?: { url?: unknown };
    finish_reason?: string;
  };
}

/**
 * 真实 CosyVoice 服务（G1 范围只接真实口播 TTS 合成）：
 * - synthesizeSpeech：调 DashScope SpeechSynthesizer 非流式接口，下载 wav 到系统临时目录；
 * - createCloneTask：真实声音克隆尚未接入，暂沿用 mock 占位 voice_id，避免真实模式下克隆链路不可用。
 */
export class DashScopeCosyVoiceService implements CosyVoiceService {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;

  constructor(options: { apiKey: string; baseUrl: string; model: string }) {
    this.apiKey = options.apiKey;
    // 去掉尾部斜杠，避免拼接 URL 出现双斜杠
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.model = options.model;
  }

  async createCloneTask(_input: CreateCloneTaskInput): Promise<{ providerVoiceId: string }> {
    return { providerVoiceId: mockCloneVoiceId() };
  }

  async synthesizeSpeech(input: SynthesizeSpeechInput): Promise<{ wavPath: string }> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/api/v1/services/audio/tts/SpeechSynthesizer`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.model,
          input: {
            text: input.text,
            voice: input.providerVoiceId,
            format: 'wav',
            sample_rate: COSYVOICE_TTS_SAMPLE_RATE,
          },
        }),
      });
    } catch (err) {
      throw new VoiceError('TTS_SYNTHESIZE_FAILED', `调用 CosyVoice TTS 失败：${(err as Error).message}`);
    }

    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).trim().slice(0, 300);
      throw new VoiceError(
        'TTS_SYNTHESIZE_FAILED',
        `CosyVoice TTS 返回异常状态 ${response.status}${detail ? `：${detail}` : ''}`,
      );
    }

    let data: DashScopeTtsResponse;
    try {
      data = (await response.json()) as DashScopeTtsResponse;
    } catch {
      throw new VoiceError('TTS_SYNTHESIZE_FAILED', 'CosyVoice TTS 响应解析失败');
    }
    const audioUrl = data.output?.audio?.url;
    if (typeof audioUrl !== 'string' || audioUrl.length === 0) {
      throw new VoiceError('TTS_SYNTHESIZE_FAILED', 'CosyVoice TTS 未返回音频下载地址');
    }

    let audioResponse: Response;
    try {
      audioResponse = await fetch(audioUrl);
    } catch (err) {
      throw new VoiceError('TTS_SYNTHESIZE_FAILED', `下载 CosyVoice 音频失败：${(err as Error).message}`);
    }
    if (!audioResponse.ok) {
      throw new VoiceError('TTS_SYNTHESIZE_FAILED', `下载 CosyVoice 音频失败：HTTP ${audioResponse.status}`);
    }
    const contentType = audioResponse.headers.get('content-type') ?? '';
    if (!contentType.includes('audio')) {
      throw new VoiceError('TTS_SYNTHESIZE_FAILED', `CosyVoice 音频内容类型异常：${contentType || '未知'}`);
    }

    let bytes: Buffer;
    try {
      bytes = Buffer.from(await audioResponse.arrayBuffer());
    } catch (err) {
      throw new VoiceError('TTS_SYNTHESIZE_FAILED', `读取 CosyVoice 音频失败：${(err as Error).message}`);
    }
    if (bytes.byteLength === 0) {
      throw new VoiceError('TTS_SYNTHESIZE_FAILED', 'CosyVoice 下载的音频为空文件');
    }

    const wavPath = join(tmpdir(), `starvoice-tts-${randomUUID()}.wav`);
    try {
      await writeFile(wavPath, bytes);
    } catch (err) {
      throw new VoiceError('TTS_SYNTHESIZE_FAILED', `写入 CosyVoice 音频失败：${(err as Error).message}`);
    }
    return { wavPath };
  }
}

// ---------- 工厂 + 单例 ----------

/** 是否真实 CosyVoice 模式：已配置 key 且未开 mock（决定 streaming 合成是否走真实 TTS） */
export function isCosyVoiceReal(): boolean {
  return Boolean(env.cosyvoice.apiKey && !env.cosyvoice.forceMock);
}

/**
 * CosyVoice 服务工厂：
 * - COSYVOICE_API_KEY 未配置 或 MOCK_COSYVOICE=true → mock（克隆占位 + 合成抛错）；
 * - 配置了真实 key 且未开 mock → 真实 DashScope 实现（真实口播 TTS，克隆仍为 mock 占位）。
 */
export function createCosyVoiceService(): CosyVoiceService {
  const { apiKey, baseUrl, model, forceMock } = env.cosyvoice;
  if (!apiKey || forceMock) {
    return new MockCosyVoiceService();
  }
  return new DashScopeCosyVoiceService({
    apiKey,
    baseUrl: baseUrl ?? DASHSCOPE_BASE_URL,
    model,
  });
}

// 全局单例：克隆 / 合成流程各处共用同一实现
export const cosyVoiceService = createCosyVoiceService();
