import { expect, it, vi } from 'vitest';
import { createLinkResolver } from '../src/collectors/linkResolver';
import {
  createHttpShortLinkExpander,
  ShortLinkExpandError,
} from '../src/collectors/shortLinkExpander';

// 短链展开器：全离线（注入替身 fetch），验证 302 跟随 / Location 兜底 / 正文兜底 / 失败语义，
// 以及「linkResolver 带不带展开器」对短链分享的差别 —— 后者是 R5 能否只靠链接跑通的关键。

/** 造一个最小的 Response 替身：只有 url / headers / text 三处被用到 */
function fakeResponse(init: { url?: string; location?: string; body?: string }): Response {
  const headers = new Headers();
  if (init.location) {
    headers.set('location', init.location);
  }
  return {
    url: init.url ?? '',
    headers,
    text: async () => init.body ?? '',
  } as unknown as Response;
}

const SHORT_URL = 'https://v.douyin.com/iAbCdEf/';

it('302 跟随后取最终地址（response.url 已变化）', async () => {
  const fetchImpl = vi.fn(async () =>
    fakeResponse({ url: 'https://live.douyin.com/7312345678912345678' }),
  ) as unknown as typeof fetch;
  const expand = createHttpShortLinkExpander({ fetchImpl });
  await expect(expand(SHORT_URL)).resolves.toBe('https://live.douyin.com/7312345678912345678');
});

it('没跟到时读 Location 头（相对地址按原链接补全）', async () => {
  const fetchImpl = vi.fn(async () =>
    fakeResponse({ location: '/7312345678912345678' }),
  ) as unknown as typeof fetch;
  const expand = createHttpShortLinkExpander({ fetchImpl });
  await expect(expand('https://live.douyin.com/x')).resolves.toBe('https://live.douyin.com/7312345678912345678');
});

it('页面不跳转时从正文兜底捞房间号（meta / JS 跳转场景）', async () => {
  const fetchImpl = vi.fn(async () =>
    fakeResponse({
      url: SHORT_URL,
      body: '<html><script>window.__RENDER_DATA__={"web_rid":"7312345678912345678"}</script></html>',
    }),
  ) as unknown as typeof fetch;
  const expand = createHttpShortLinkExpander({ fetchImpl });
  await expect(expand(SHORT_URL)).resolves.toBe('https://live.douyin.com/7312345678912345678');
});

it('既不跳转也捞不到房间号 → ShortLinkExpandError（带可读原因）', async () => {
  const fetchImpl = vi.fn(async () =>
    fakeResponse({ url: SHORT_URL, body: '<html>该链接已失效</html>' }),
  ) as unknown as typeof fetch;
  const expand = createHttpShortLinkExpander({ fetchImpl });
  await expect(expand(SHORT_URL)).rejects.toBeInstanceOf(ShortLinkExpandError);
});

it('请求抛错 → 包成 ShortLinkExpandError，不冒原始异常', async () => {
  const fetchImpl = vi.fn(async () => {
    throw new Error('socket hang up');
  }) as unknown as typeof fetch;
  const expand = createHttpShortLinkExpander({ fetchImpl });
  await expect(expand(SHORT_URL)).rejects.toThrow(/短链展开请求失败/);
});

it('端到端解析：只给抖音分享文本（含短链）也能解出房间号', async () => {
  const resolver = createLinkResolver({
    expandShortLink: async () => 'https://live.douyin.com/7312345678912345678',
  });
  const shareText = '7.32 复制打开抖音，看看【某某火锅的直播】' + SHORT_URL + ' 复制此链接，打开Dou音搜索！';
  const resolved = await resolver.resolveShareText(shareText);
  expect(resolved.ok).toBe(true);
  if (!resolved.ok) {
    return;
  }
  expect(resolved.room.platform).toBe('douyin');
  expect(resolved.room.roomRef).toBe('7312345678912345678');
});

it('不带展开器时短链返回 SHORT_LINK_ONLY —— 锁住「为什么必须注入展开器」', async () => {
  const resolver = createLinkResolver();
  const resolved = await resolver.resolveShareText('看看直播 ' + SHORT_URL);
  expect(resolved.ok).toBe(false);
  if (resolved.ok) {
    return;
  }
  expect(resolved.code).toBe('SHORT_LINK_ONLY');
});
