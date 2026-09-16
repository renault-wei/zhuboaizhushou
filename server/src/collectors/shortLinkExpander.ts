// 短链展开器（D1.2 收尾 / R5 前置）：把 v.douyin.com 这类分享短链跟到真实直播页地址。
//
// 定位：这是整条采集链路里**唯一需要网络的解析环节**（linkResolver 注释亦如此描述）。
// 它只做「跟着 HTTP 跳转走」一件事 —— 不抓包、不逆向、不带登录态，合规边界与 PLAN §7 一致。
//
// 为什么必须补：抖音 App 分享出来的就是短链（v.douyin.com/xxxx），而直播间身份只存在于
// 跳转后的 live.douyin.com/<房间号>（2026-09-16 真链接实测落点其实是
// webcast.amemv.com/douyin/webcast/reflow/<房间号>）里。
//
// 为什么还要顺带取 Cookie：抖音 wss 握手**必须**带 `Cookie: ttwid=…`，而 ttwid 只在这条
// 跳转链上下发一次 —— 「解析房间号」与「取 ttwid」本来就是同一次请求（实测：不带即回 HTTP 200）。

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/** 短链展开失败（网络 / 超时 / 形态不认识）；上层翻成可读原因给接口调用方 */
export class ShortLinkExpandError extends Error {
  /**
   * 是否值得重试。
   * - true：网络中断、超时等**瞬时可恢复**故障（实测偶发）；
   * - false：跳转正常但页面里找不到房间号等**确定性**失败，重试只是白等。
   */
  readonly retryable: boolean;

  constructor(message: string, retryable = false) {
    super(message);
    this.name = 'ShortLinkExpandError';
    this.retryable = retryable;
  }
}

/** 展开结果：最终地址 + 顺带取到的连接 Cookie（抖音要的 ttwid 就在这条跳转链上） */
export interface ShortLinkExpansion {
  url: string;
  /** 形如 `ttwid=…`；未取到则无此字段 */
  cookie?: string;
}

export type ShortLinkExpander = (url: string) => Promise<ShortLinkExpansion>;

export interface ShortLinkExpanderDeps {
  /** 可注入：单测用替身，全离线 */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  userAgent?: string;
  /** 兜底正则只看正文前 N 字节，避免把整页拉下来 */
  maxBodyBytes?: number;
  /** 失败重试次数（不含首次）。默认 2：实测冷启动 TLS + 多跳链路会偶发打满超时 */
  retries?: number;
}

/**
 * 从 HTML 正文兜底捞房间号。
 * 存在这种情形：短链不返回 302，而是返回一个带 meta refresh / JS 跳转的页面 —— 此时
 * fetch 的 redirect:'follow' 跟不到任何东西，只能从正文里找线索。
 */
function roomRefFromHtml(html: string): string | null {
  const patterns = [
    /live\.douyin\.com\/(\d{5,})/i,
    /"web_rid"\s*:\s*"(\d{5,})"/i,
    /"roomId"\s*:\s*"(\d{5,})"/i,
    /"room_id"\s*:\s*"?(\d{5,})"?/i,
  ];
  for (const pattern of patterns) {
    const matched = pattern.exec(html);
    if (matched?.[1]) {
      return matched[1];
    }
  }
  return null;
}

/** 从 Set-Cookie 里挑出 ttwid（值含 % 编码与竖线，不能按分号粗暴切完就丢） */
function ttwidOf(setCookies: readonly string[]): string | null {
  for (const one of setCookies) {
    const matched = /(?:^|[;,\s])ttwid=([^;]+)/.exec(one);
    if (matched?.[1]) {
      return `ttwid=${matched[1]}`;
    }
  }
  return null;
}

/**
 * 按房间号现取 ttwid（**不带跳转链的场景**）。
 *
 * 为什么需要它：ttwid 只在下发分享短链的那次跳转里出现。但用户完全可能直接给
 * 「完整直播链接 `live.douyin.com/<房间号>`」或「纯房间号」——此时 linkResolver 第一遍
 * 静态就解析出来了，**根本不会发那次网络请求**，于是拿不到 ttwid，wss 握手被回 HTTP 200。
 * 2026-09-16 真机对照实验实测踩到。
 *
 * 只访问公开直播页、只取它下发的 Cookie，不抓包、不逆向、不带登录态。
 */
export function createDouyinTtwidFetcher(
  deps: ShortLinkExpanderDeps = {},
): (roomRef: string) => Promise<string | null> {
  const doFetch = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.timeoutMs ?? 15000;
  const userAgent = deps.userAgent ?? DEFAULT_USER_AGENT;
  const retries = deps.retries ?? 2;

  async function attempt(roomRef: string): Promise<string | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await doFetch(`https://live.douyin.com/${roomRef}`, {
        method: 'GET',
        redirect: 'follow',
        headers: { 'User-Agent': userAgent, Accept: 'text/html,*/*' },
        signal: controller.signal,
      });
      const setCookies =
        typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
      // 主动读掉正文，避免 keep-alive 连接悬挂
      await response.text().catch(() => '');
      return ttwidOf(setCookies);
    } finally {
      clearTimeout(timer);
    }
  }

  return async (roomRef: string): Promise<string | null> => {
    for (let i = 0; i <= retries; i += 1) {
      try {
        const cookie = await attempt(roomRef);
        if (cookie) {
          return cookie;
        }
      } catch {
        // 网络抖动：重试；仍失败则返回 null 由上层决定（不阻断，wss 会自己报错）
      }
    }
    return null;
  };
}

export function createHttpShortLinkExpander(deps: ShortLinkExpanderDeps = {}): ShortLinkExpander {
  const doFetch = deps.fetchImpl ?? fetch;
  // 常态实测 <1s；8s 在冷启动 TLS + 多跳链路下偶发被打满（2026-09-16 真机实测一次
  // "This operation was aborted"），放宽到 15s 作兜底。
  const timeoutMs = deps.timeoutMs ?? 15000;
  const userAgent = deps.userAgent ?? DEFAULT_USER_AGENT;
  const maxBodyBytes = deps.maxBodyBytes ?? 200_000;
  const retries = deps.retries ?? 2;

  async function attemptOnce(url: string): Promise<ShortLinkExpansion> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await doFetch(url, {
        method: 'GET',
        redirect: 'follow',
        headers: { 'User-Agent': userAgent, Accept: 'text/html,application/xhtml+xml,*/*' },
        signal: controller.signal,
      });

      // 顺带取出连接 Cookie：抖音 wss 握手必须要 ttwid，而它只在这条跳转链上发一次
      const setCookies =
        typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
      const cookie = ttwidOf(setCookies);
      const withCookie = (finalUrl: string): ShortLinkExpansion =>
        cookie ? { url: finalUrl, cookie } : { url: finalUrl };

      // 常规情形：302 跟随后 response.url 已是最终地址
      if (response.url && response.url !== url) {
        return withCookie(response.url);
      }
      const location = response.headers.get('location');
      if (location) {
        return withCookie(new URL(location, url).toString());
      }

      // 兜底：正文里捞房间号，合成一个静态可解的直播页地址交给 linkResolver 二次解析
      const html = (await response.text()).slice(0, maxBodyBytes);
      const roomRef = roomRefFromHtml(html);
      if (roomRef) {
        return withCookie(`https://live.douyin.com/${roomRef}`);
      }
      // 确定性失败：跳转拿到了、页面也读了，就是没有直播间号 —— 重试无意义
      throw new ShortLinkExpandError(
        '短链未发生跳转，且页面里找不到直播间号（可能已失效，或该链接不是直播分享）',
      );
    } catch (err) {
      if (err instanceof ShortLinkExpandError) {
        throw err;
      }
      const message = err instanceof Error ? err.message : String(err);
      // 网络 / 超时类：标记可重试
      throw new ShortLinkExpandError(`短链展开请求失败：${message}`, true);
    } finally {
      clearTimeout(timer);
    }
  }

  return async (url: string): Promise<ShortLinkExpansion> => {
    let lastError: ShortLinkExpandError | null = null;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        return await attemptOnce(url);
      } catch (err) {
        if (!(err instanceof ShortLinkExpandError) || !err.retryable) {
          throw err;
        }
        lastError = err;
      }
    }
    throw lastError ?? new ShortLinkExpandError('短链展开失败：重试次数已用尽', true);
  };
}
