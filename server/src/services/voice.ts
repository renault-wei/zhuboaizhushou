import { randomUUID } from 'node:crypto';
import { env } from '../config/env';

// ---------- 常量 ----------

// mock 克隆返回的 voice_id 前缀：真实 CosyVoice 每次克隆都返回新 voice_id，mock 用前缀便于识别
export const MOCK_VOICE_ID_PREFIX = 'mock-voice-';

// ---------- 错误类型 ----------

export type VoiceErrorCode = 'CLONE_FAILED';

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

/**
 * CosyVoice 声音克隆服务接口。
 * 真实 CosyVoice 是异步克隆：createCloneTask 提交任务后立即返回 voice_id，
 * 克隆进度由路由层轮询推进。MVP 阶段用 mock 实现，未来接真实 CosyVoice
 * 时保持该接口不变，仅在工厂函数中切换实现。
 */
export interface CosyVoiceService {
  /** 提交克隆任务，立即返回 CosyVoice voice_id */
  createCloneTask(input: CreateCloneTaskInput): Promise<{ providerVoiceId: string }>;
}

// ---------- mock 实现 ----------

/**
 * 内存 mock CosyVoice：
 * - createCloneTask 每次返回全新的 mock-voice- 前缀 voice_id；
 * - 异步状态流转（pending → processing → ready）不在 service 里用 setTimeout 推进
 *   （服务重启丢任务、测试难控制），改由路由层在轮询时按创建时间惰性推进。
 */
export class MockCosyVoiceService implements CosyVoiceService {
  async createCloneTask(_input: CreateCloneTaskInput): Promise<{ providerVoiceId: string }> {
    return { providerVoiceId: `${MOCK_VOICE_ID_PREFIX}${randomUUID()}` };
  }
}

/**
 * CosyVoice 服务工厂。
 * - COSYVOICE_API_KEY 未配置 或 MOCK_COSYVOICE=true → 返回 mock；
 * - 配置了真实 key 且未开 mock → 抛错提示真实实现尚未接入（T5 仅 mock），
 *   避免把 mock 当真实服务使用。
 */
export function createCosyVoiceService(): CosyVoiceService {
  const useMock = !env.cosyvoice.apiKey || env.cosyvoice.forceMock;
  if (!useMock) {
    throw new Error(
      '已配置 COSYVOICE_API_KEY 且未开启 MOCK_COSYVOICE：真实 CosyVoice 尚未接入（T5 仅 mock），请先设置 MOCK_COSYVOICE=true',
    );
  }
  return new MockCosyVoiceService();
}

// 全局单例：克隆流程各处共用同一实现
export const cosyVoiceService = createCosyVoiceService();
