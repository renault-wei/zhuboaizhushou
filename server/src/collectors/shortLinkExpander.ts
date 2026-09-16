// 短链展开器（D1.2 收尾 / R5 前置）：把 v.douyin.com 这类分享短链跟到真实直播页地址。
//
// 定位：这是整条采集链路里**唯一需要网络的解析环节**（linkResolver 注释亦如此描述）。
// 它只做「跟着 HTTP 跳转走」一件事 —— 不抓包、不逆向、不带登录态，合规边界与 PLAN §7 一致。
//
// 为什么必须补：抖音 App 分享出来的就是短链（v.douyin.com/xxxx），而直播间身份只存在于
// 跳转后的 live.douyin.com/<房间号> 里。没有它，「只给链接」这条路根本走不通。

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/** 短链展开失败（网络 / 超时 / 形态不认识）；上层翻成可读原因给接口调用方 */
export class ShortLinkExpandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ShortLinkExpandError';
  }
}

export type ShortLinkExpander = (url: string) => Promise<string>;

export interface ShortLinkExpanderDeps {
  /** 可注入：单测用替身，全离线 */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  userAgent?: string;
  /** 兜底正则只看正文前 N 字节，避免把整页拉下来 */
  maxBodyBytes?: number;
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

export function createHttpShortLinkExpander(deps: ShortLinkExpanderDeps = {}): ShortLinkExpander {
  const doFetch = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.timeoutMs ?? 8000;
  const userAgent = deps.userAgent ?? DEFAULT_USER_AGENT;
  const maxBodyBytes = deps.maxBodyBytes ?? 200_000;

  return async (url: string): Promise<string> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await doFetch(url, {
        method: 'GET',
        redirect: 'follow',
        headers: { 'User-Agent': userAgent, Accept: 'text/html,application/xhtml+xml,*/*' },
        signal: controller.signal,
      });

      // 常规情形：302 跟随后 response.url 已是最终地址
      if (response.url && response.url !== url) {
        return response.url;
      }
      const location = response.headers.get('location');
      if (location) {
        return new URL(location, url).toString();
      }

      // 兜底：正文里捞房间号，合成一个静态可解的直播页地址交给 linkResolver 二次解析
      const html = (await response.text()).slice(0, maxBodyBytes);
      const roomRef = roomRefFromHtml(html);
      if (roomRef) {
        return `https://live.douyin.com/${roomRef}`;
      }
      throw new ShortLinkExpandError(
        '短链未发生跳转，且页面里找不到直播间号（可能已失效，或该链接不是直播分享）',
      );
    } catch (err) {
      if (err instanceof ShortLinkExpandError) {
        throw err;
      }
      const message = err instanceof Error ? err.message : String(err);
      throw new ShortLinkExpandError(`短链展开请求失败：${message}`);
    } finally {
      clearTimeout(timer);
    }
  };
}
