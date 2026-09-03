import { randomInt, randomUUID } from 'node:crypto';
import { env } from '../config/env';

// ---------- 验证码规则常量 ----------

// 验证码有效期：5 分钟
export const SMS_CODE_TTL_MS = 5 * 60 * 1000;
// 同一手机号重发间隔：60 秒
export const SMS_RESEND_INTERVAL_MS = 60 * 1000;

// ---------- 错误类型 ----------

export type SmsErrorCode = 'SEND_TOO_FREQUENT' | 'CODE_INVALID' | 'CODE_EXPIRED';

/** 短信服务业务错误：携带机器可读错误码，由路由层翻译成对应 HTTP 状态 */
export class SmsError extends Error {
  readonly code: SmsErrorCode;
  /** 仅重发受限时携带：建议客户端等待的秒数 */
  readonly retryAfterSeconds?: number;

  constructor(code: SmsErrorCode, message: string, retryAfterSeconds?: number) {
    super(message);
    this.name = 'SmsError';
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

// ---------- 接口定义 ----------

export interface SendCodeResult {
  requestId: string;
  /** 距下次可重发的时间（秒），固定 60 */
  resendAfterSeconds: number;
  /** 验证码有效期（秒），固定 300 */
  expiresInSeconds: number;
  /** 仅开发/测试环境返回验证码，便于本地联调；生产环境不返回 */
  code?: string;
}

/**
 * 短信服务接口。
 * MVP 阶段用内存 mock 实现；未来接入真实短信渠道（如阿里云短信）时
 * 保持该接口不变，仅在工厂函数中切换实现。
 */
export interface SmsService {
  sendCode(phone: string): Promise<SendCodeResult>;
  verifyCode(phone: string, code: string): Promise<boolean>;
}

// ---------- 内存 mock 实现 ----------

interface MockSmsRecord {
  code: string;
  requestId: string;
  lastSentAt: number;
  expiresAt: number;
}

/** 内存版短信服务：验证码存进程内存，进程重启即失效（MVP mock） */
export class MockSmsService implements SmsService {
  private readonly records = new Map<string, MockSmsRecord>();

  constructor(private readonly devMode: boolean) {}

  async sendCode(phone: string): Promise<SendCodeResult> {
    const now = Date.now();
    const existing = this.records.get(phone);

    // 60 秒重发限制：命中直接报错，且不覆盖旧验证码
    if (existing && now - existing.lastSentAt < SMS_RESEND_INTERVAL_MS) {
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((existing.lastSentAt + SMS_RESEND_INTERVAL_MS - now) / 1000),
      );
      throw new SmsError(
        'SEND_TOO_FREQUENT',
        `发送太频繁，请 ${retryAfterSeconds} 秒后重试`,
        retryAfterSeconds,
      );
    }

    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const requestId = randomUUID();
    this.records.set(phone, {
      code,
      requestId,
      lastSentAt: now,
      expiresAt: now + SMS_CODE_TTL_MS,
    });

    return {
      requestId,
      resendAfterSeconds: SMS_RESEND_INTERVAL_MS / 1000,
      expiresInSeconds: SMS_CODE_TTL_MS / 1000,
      // 仅在非生产环境回传验证码，方便联调
      ...(this.devMode ? { code } : {}),
    };
  }

  async verifyCode(phone: string, code: string): Promise<boolean> {
    const record = this.records.get(phone);
    if (!record) {
      throw new SmsError('CODE_INVALID', '验证码错误，请重新输入');
    }

    // 过期记录直接清理，提示用户重新获取
    if (Date.now() > record.expiresAt) {
      this.records.delete(phone);
      throw new SmsError('CODE_EXPIRED', '验证码已过期，请重新获取');
    }

    if (record.code !== code) {
      throw new SmsError('CODE_INVALID', '验证码错误，请重新输入');
    }

    // 验证码一次性使用：校验成功后立即作废
    this.records.delete(phone);
    return true;
  }
}

/**
 * 短信服务工厂。
 * MVP 阶段统一使用内存 mock（S1 验收允许短信 mock）；生产环境同样不返回验证码明文。
 */
export function createSmsService(): SmsService {
  return new MockSmsService(env.NODE_ENV !== 'production');
}

// 全局单例：内存验证码跨请求共享，保证同一手机号的重发限制在多次请求间生效
export const smsService = createSmsService();
