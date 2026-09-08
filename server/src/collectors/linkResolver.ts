import type { DanmakuPlatform } from './types';

// D1 链接解析（DANMAKU-COLLECTOR-PLAN D1.1~D1.3 静态部分）：
// 直播间分享文本 / 口令 → 抽取 URL → 平台路由 → 解析直播间稳定身份（roomRef）。
// 合规边界：只做公开链接形态解析，不请求平台接口、不带登录态、不抓包；
// 短链展开是唯一需要网络的环节：默认不注入（返回 SHORT_LINK_ONLY），调用方可注入 expandShortLink。
// 真实平台协议适配器（D2.3/D2.4）仍受 D2.5 合规门约束，本模块不触达平台网络。

export type ResolveFailureCode =
  | 'NO_URL_FOUND'
  | 'UNSUPPORTED_PLATFORM'
  | 'ROOM_ID_MISSING'
  | 'SHORT_LINK_ONLY'
  | 'EXPAND_FAILED';

/** 解析成功的直播间身份（只有身份，不含连接；连接属适配器职责） */
export interface ResolvedRoom {
  platform: DanmakuPlatform;
  roomRef: string;
  /** 命中的原始链接（短链场景为待展开链接） */
  matchedUrl: string;
}

export type ResolveShareResult =
  | { ok: true; room: ResolvedRoom }
  | { ok: false; code: ResolveFailureCode; reason: string; platform?: DanmakuPlatform; shortUrl?: string };

export interface LinkResolverDeps {
  /** 短链展开（唯一网络点）：本期默认不注入；注入后由调用方负责超时与失败语义 */
  expandShortLink?(url: string): Promise<string>;
}

export interface LinkResolver {
  /** 解析分享文本；短链需要展开时返回 SHORT_LINK_ONLY（含 platform / shortUrl），由调用方决定下一步 */
  resolveShareText(text: string): Promise<ResolveShareResult>;
}

// ---------- 平台路由表 ----------

interface HostRule {
  platform: DanmakuPlatform;
  /** 是否短链域名（需要展开才能取房间号） */
  short: boolean;
}

const HOST_RULES: Array<{ host: string; rule: HostRule }> = [
  { host: 'live.douyin.com', rule: { platform: 'douyin', short: false } },
  { host: 'www.douyin.com', rule: { platform: 'douyin', short: false } },
  { host: 'v.douyin.com', rule: { platform: 'douyin', short: true } },
  { host: 'live.bilibili.com', rule: { platform: 'bilibili', short: false } },
  { host: 'b23.tv', rule: { platform: 'bilibili', short: true } },
  { host: 'live.kuaishou.com', rule: { platform: 'kuaishou', short: false } },
  { host: 'v.kuaishou.com', rule: { platform: 'kuaishou', short: true } },
];

export interface CandidateUrl {
  url: string;
  host: string;
  platform: DanmakuPlatform | null;
  short: boolean;
}

/** 从一段文本中抽取候选链接：优先 http(s) 完整 URL；无协议时兜底识别裸域名口令 */
export function extractCandidateUrls(text: string): CandidateUrl[] {
  if (typeof text !== 'string' || text.trim().length === 0) {
    return [];
  }
  const tokens = new Set<string>();
  const httpPattern = /https?:\/\/[^\s，。！？；、""''（）()【】[\]<>]+/gi;
  for (const match of text.matchAll(httpPattern)) {
    const token = match[0].replace(/[，。！？；、""''（）()]+$/, '');
    if (token.length > 0) {
      tokens.add(token);
    }
  }
  if (tokens.size === 0) {
    // 无协议裸口令兜底：补齐 https:// 后走同一解析
    const barePattern = /(?:v\.douyin\.com|b23\.tv|live\.douyin\.com|live\.bilibili\.com|v\.kuaishou\.com)\/[A-Za-z0-9_-]+/gi;
    for (const match of text.matchAll(barePattern)) {
      tokens.add(`https://${match[0]}`);
    }
  }
  const candidates: CandidateUrl[] = [];
  for (const url of tokens) {
    const { host, rule } = classifyHost(url);
    candidates.push({
      url,
      host: host.length > 0 ? host : url,
      platform: rule?.platform ?? null,
      short: rule?.short ?? false,
    });
  }
  return candidates;
}

function classifyHost(url: string): { host: string; rule: HostRule | null } {
  const matched = /^https?:\/\/([^/?#]+)/i.exec(url);
  if (!matched || !matched[1]) {
    return { host: '', rule: null };
  }
  const host = matched[1].toLowerCase().replace(/:\d+$/, '');
  const normalized = host.startsWith('www.') ? host.slice(4) : host;
  for (const entry of HOST_RULES) {
    const ruleHost = entry.host.startsWith('www.') ? entry.host.slice(4) : entry.host;
    if (normalized === ruleHost) {
      return { host, rule: entry.rule };
    }
  }
  return { host, rule: null };
}

/** 从完整直播页 URL 静态取房间号；无法静态取出返回 null（调用方按平台给可读原因） */
function staticRoomRefOf(url: string, host: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const hostKey = host.toLowerCase();
  if (hostKey === 'live.douyin.com' || hostKey === 'live.bilibili.com') {
    const digits = parsed.pathname.split('/').find((segment) => /^[0-9]+$/.test(segment));
    return digits ?? null;
  }
  if (hostKey === 'www.douyin.com' || hostKey === 'douyin.com') {
    // 抖音主页 / 作品页不含直播间身份；只有 live 路径（/root/live/{webRid} 等）才静态可解
    if (!/\/live\//i.test(parsed.pathname)) {
      return null;
    }
    const digits = parsed.pathname.split('/').find((segment) => /^[0-9]+$/.test(segment));
    return digits ?? null;
  }
  if (hostKey === 'live.kuaishou.com') {
    // 快手 live 主页形态（/u/{userId}）无数字房间号，spike 后再定（D1.4）
    return null;
  }
  return null;
}

function failure(
  code: ResolveFailureCode,
  reason: string,
  extra?: { platform?: DanmakuPlatform; shortUrl?: string },
): ResolveShareResult {
  return { ok: false, code, reason, ...extra };
}

/** 短链展开循环保护：最多展开 3 跳，仍落在短链则视为 EXPAND_FAILED */
const MAX_EXPAND_DEPTH = 3;

export function createLinkResolver(deps: LinkResolverDeps = {}): LinkResolver {
  const { expandShortLink } = deps;

  async function resolve(text: string, depth: number): Promise<ResolveShareResult> {
    const candidates = extractCandidateUrls(text);
    if (candidates.length === 0) {
      return failure('NO_URL_FOUND', '分享文本中未找到直播间链接');
    }

    // 第一遍：完整链接静态取房间号（首选，无需网络）
    for (const candidate of candidates) {
      if (candidate.short || !candidate.platform) {
        continue;
      }
      const roomRef = staticRoomRefOf(candidate.url, candidate.host);
      if (roomRef) {
        return { ok: true, room: { platform: candidate.platform, roomRef, matchedUrl: candidate.url } };
      }
    }

    // 第二遍：短链展开（需要网络；未注入 expander 时给出可读原因供上层引导）
    let attemptedShortUrl: string | undefined;
    for (const candidate of candidates) {
      if (!candidate.short || !candidate.platform) {
        continue;
      }
      if (!expandShortLink) {
        return failure('SHORT_LINK_ONLY', `${candidate.platform} 分享链接为短链，需要先展开`, {
          platform: candidate.platform,
          shortUrl: candidate.url,
        });
      }
      if (depth >= MAX_EXPAND_DEPTH) {
        return failure('EXPAND_FAILED', '短链展开超过最大跳数仍未解析出直播间', {
          platform: candidate.platform,
          shortUrl: candidate.url,
        });
      }
      try {
        const expanded = await expandShortLink(candidate.url);
        if (!expanded || expanded.trim().length === 0) {
          return failure('EXPAND_FAILED', '短链展开返回空内容', {
            platform: candidate.platform,
            shortUrl: candidate.url,
          });
        }
        attemptedShortUrl = candidate.url;
        const followed = await resolve(expanded, depth + 1);
        if (followed.ok || followed.code !== 'NO_URL_FOUND') {
          return followed;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return failure('EXPAND_FAILED', `短链展开失败：${message}`, {
          platform: candidate.platform,
          shortUrl: candidate.url,
        });
      }
    }
    if (attemptedShortUrl) {
      return failure('EXPAND_FAILED', '短链展开后未发现可解析的直播间链接', {
        platform: undefined,
        shortUrl: attemptedShortUrl,
      });
    }

    // 第三遍：完整链接存在但静态取不到房间号（主页 / 未知形态）
    const full = candidates.find((candidate) => !candidate.short && candidate.platform);
    if (full?.platform) {
      return failure(
        'ROOM_ID_MISSING',
        `${full.platform} 链接无法静态解析出直播间号（可能为主页 / 非直播链接）`,
        { platform: full.platform },
      );
    }

    const unsupported = candidates[0];
    return failure('UNSUPPORTED_PLATFORM', `暂不支持的链接：${unsupported?.host ?? '未知域名'}`, {
      ...(unsupported?.platform ? { platform: unsupported.platform } : {}),
    });
  }

  return { resolveShareText: (text) => resolve(text, 0) };
}

/** 全局单例：默认不注入短链展开器（安全默认），路由 / 演示层按需替换为带 expander 的实例 */
export const linkResolver = createLinkResolver();
