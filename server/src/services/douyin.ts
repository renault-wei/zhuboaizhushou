import { createHash, randomUUID } from 'node:crypto';
import { env } from '../config/env';

// ---------- 常量 ----------

// mock 授权码前缀：真实抖音授权码是一段随机串，mock 阶段约定 mock- 开头即为合法
export const MOCK_CODE_PREFIX = 'mock-';
// access_token 有效期：固定 15 天（秒），与真实抖音 OAuth 一致
export const DOUYIN_TOKEN_TTL_SECONDS = 15 * 24 * 60 * 60;

// ---------- 错误类型 ----------

export type DouyinErrorCode = 'CODE_INVALID';

/** 抖音 OAuth 服务业务错误：携带机器可读错误码，由路由层翻译成 HTTP 状态 */
export class DouyinError extends Error {
  readonly code: DouyinErrorCode;

  constructor(code: DouyinErrorCode, message: string) {
    super(message);
    this.name = 'DouyinError';
    this.code = code;
  }
}

// ---------- 接口定义 ----------

export interface DouyinTokenResult {
  openId: string;
  accessToken: string;
  refreshToken: string;
  expiresInSeconds: number;
}

export interface DouyinUserInfo {
  nickname: string;
  avatarUrl: string;
}

/**
 * 抖音开放平台 OAuth 服务接口。
 * MVP 阶段用本地 mock 实现；未来接入真实抖音 API（open.douyinapi.com）时
 * 保持该接口不变，仅在工厂函数中切换实现。
 */
export interface DouyinOAuthService {
  /** 用授权 code 换取 access_token + open_id */
  exchangeCode(code: string): Promise<DouyinTokenResult>;
  /** 拉取用户公开信息（昵称/头像） */
  getUserInfo(accessToken: string, openId: string): Promise<DouyinUserInfo>;
}

// ---------- mock 实现 ----------

/**
 * 内存 mock 抖音开放平台：
 * - 任何 `mock-` 前缀的 code 都合法，其余抛 CODE_INVALID；
 * - open_id 由 code 确定性派生（sha256 前 8 位），保证同一 code 幂等；
 * - access_token / refresh_token 用随机串；有效期固定 15 天。
 */
export class MockDouyinOAuthService implements DouyinOAuthService {
  private deriveOpenId(code: string): string {
    const hash = createHash('sha256').update(code).digest('hex').slice(0, 8);
    return `mock-openid-${hash}`;
  }

  async exchangeCode(code: string): Promise<DouyinTokenResult> {
    if (!code.startsWith(MOCK_CODE_PREFIX)) {
      throw new DouyinError('CODE_INVALID', '授权码无效或已过期，请重新授权');
    }
    return {
      openId: this.deriveOpenId(code),
      accessToken: randomUUID(),
      refreshToken: randomUUID(),
      expiresInSeconds: DOUYIN_TOKEN_TTL_SECONDS,
    };
  }

  async getUserInfo(_accessToken: string, openId: string): Promise<DouyinUserInfo> {
    // mock：昵称/头像由 open_id 确定性生成，方便测试断言与联调展示
    return {
      nickname: `抖音用户${openId.slice(-4)}`,
      avatarUrl: `https://p3.douyinpic.com/avatar/${openId}.webp`,
    };
  }
}

/**
 * 抖音 OAuth 服务工厂。
 * - DOUYIN_CLIENT_KEY 未配置 → 强制 mock；
 * - 配置了真实 key 但 MOCK_DOUYIN=true → 也走 mock（真实 key 下仍可本地联调）；
 * - 配置了真实 key 且未开 mock → 真实实现尚未接入（T2 只做 mock），启动即报错提示，避免误当 mock 使用。
 */
export function createDouyinOAuthService(): DouyinOAuthService {
  const useMock = !env.douyin.clientKey || env.douyin.forceMock;
  if (!useMock) {
    throw new Error(
      '已配置 DOUYIN_CLIENT_KEY 且未开启 MOCK_DOUYIN：真实抖音开放平台实现尚未接入（T2 仅 mock），请先设置 MOCK_DOUYIN=true',
    );
  }
  return new MockDouyinOAuthService();
}

// 全局单例：绑定流程各处共用同一实现
export const douyinOAuthService = createDouyinOAuthService();
