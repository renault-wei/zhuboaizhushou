import { expect, it, vi } from 'vitest';
import { createLinkResolver } from '../src/collectors/linkResolver';
import {
  createDouyinTtwidFetcher,
  createHttpShortLinkExpander,
  ShortLinkExpandError,
} from '../src/collectors/shortLinkExpander';

// 短链展开器（全离线，注入替身 fetch）：验证 302 跟随 / Location 兜底 / 正文兜底 / ttwid 提取 / 失败语义，
// 以及「linkResolver 带不带展开器」对短链分享的差别 —— 后者是 R5 能否只靠链接跑通的关键。

const SHORT_URL = 'https://v.douyin.com/iAbCdEf/';
const ROOM_URL = 'https://live.douyin.com/7312345678912345678';

/** 造一个最小的 Response 替身：只有 url / headers / text 三处被用到 */
function fakeResponse(init: { url?: string; location?: string; body?: string; setCookies?: string[] }): Response {
  const headers = new Headers();
  if (init.location) {
    headers.set('location', init.location);
  }
  for (const one of init.setCookies ?? []) {
    headers.append('set-cookie', one);
  }
  return {
    url: init.url ?? '',
    headers,
    text: async () => init.body ?? '',
  } as unknown as Response;
}

const TTWID = '1%7CrsRVfMWF5_zXqsDU3FwgeI8hHcByhBOVJOHKmr4cLNg%7C1789563891%7C3e3d9844';

it('302 跟随后取最终地址（response.url 已变化）', async () => {
  const fetchImpl = vi.fn(async () => fakeResponse({ url: ROOM_URL })) as unknown as typeof fetch;
  const expand = createHttpShortLinkExpander({ fetchImpl });
  await expect(expand(SHORT_URL)).resolves.toEqual({ url: ROOM_URL });
});

it('顺带取出 ttwid —— 抖音 wss 握手必须要它，而它只在这条跳转链上下发', async () => {
  const fetchImpl = vi.fn(async () =>
    fakeResponse({ url: ROOM_URL, setCookies: [`ttwid=${TTWID}; Domain=.amemv.com; Path=/; HttpOnly`] }),
  ) as unknown as typeof fetch;
  const expand = createHttpShortLinkExpander({ fetchImpl });
  await expect(expand(SHORT_URL)).resolves.toEqual({ url: ROOM_URL, cookie: `ttwid=${TTWID}` });
});

it('没有 Set-Cookie 时 cookie 字段缺省（不编造空串）', async () => {
  const fetchImpl = vi.fn(async () => fakeResponse({ url: ROOM_URL })) as unknown as typeof fetch;
  const expand = createHttpShortLinkExpander({ fetchImpl });
  const result = await expand(SHORT_URL);
  expect(result).toEqual({ url: ROOM_URL });
  expect('cookie' in result).toBe(false);
});

it('没跟到时读 Location 头（相对地址按原链接补全）', async () => {
  const fetchImpl = vi.fn(async () =>
    fakeResponse({ location: '/7312345678912345678' }),
  ) as unknown as typeof fetch;
  const expand = createHttpShortLinkExpander({ fetchImpl });
  await expect(expand('https://live.douyin.com/x')).resolves.toEqual({ url: ROOM_URL });
});

it('页面不跳转时从正文兜底捞房间号（meta / JS 跳转场景）', async () => {
  const fetchImpl = vi.fn(async () =>
    fakeResponse({
      url: SHORT_URL,
      body: '<html><script>window.__RENDER_DATA__={"web_rid":"7312345678912345678"}</script></html>',
    }),
  ) as unknown as typeof fetch;
  const expand = createHttpShortLinkExpander({ fetchImpl });
  await expect(expand(SHORT_URL)).resolves.toEqual({ url: ROOM_URL });
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

it('网络类失败会重试：第一次超时、第二次成功 → 整体成功', async () => {
  let calls = 0;
  const fetchImpl = vi.fn(async () => {
    calls += 1;
    if (calls === 1) {
      throw new Error('This operation was aborted');
    }
    return fakeResponse({ url: ROOM_URL });
  }) as unknown as typeof fetch;
  const expand = createHttpShortLinkExpander({ fetchImpl, retries: 2 });
  await expect(expand(SHORT_URL)).resolves.toEqual({ url: ROOM_URL });
  expect(calls).toBe(2);
});

it('确定性失败不重试（跳转正常但页面里没有房间号 → 只请求一次）', async () => {
  let calls = 0;
  const fetchImpl = vi.fn(async () => {
    calls += 1;
    return fakeResponse({ url: SHORT_URL, body: '<html>该链接已失效</html>' });
  }) as unknown as typeof fetch;
  const expand = createHttpShortLinkExpander({ fetchImpl, retries: 2 });
  await expect(expand(SHORT_URL)).rejects.toBeInstanceOf(ShortLinkExpandError);
  expect(calls).toBe(1);
});

it('重试次数用尽后抛出可重试标记的错误', async () => {
  const fetchImpl = vi.fn(async () => {
    throw new Error('socket hang up');
  }) as unknown as typeof fetch;
  const expand = createHttpShortLinkExpander({ fetchImpl, retries: 1 });
  await expect(expand(SHORT_URL)).rejects.toMatchObject({ retryable: true });
  expect(vi.mocked(fetchImpl)).toHaveBeenCalledTimes(2);
});

it('端到端解析：只给抖音分享文本（含短链）也能解出房间号', async () => {
  const resolver = createLinkResolver({
    expandShortLink: async () => ({ url: ROOM_URL, cookie: `ttwid=${TTWID}` }),
  });
  const shareText = '7.32 复制打开抖音，看看【某某火锅的直播】' + SHORT_URL + ' 复制此链接，打开Dou音搜索！';
  const resolved = await resolver.resolveShareText(shareText);
  expect(resolved.ok).toBe(true);
  if (!resolved.ok) {
    return;
  }
  expect(resolved.room.platform).toBe('douyin');
  expect(resolved.room.roomRef).toBe('7312345678912345678');
  // 连接提示必须一路带到 ResolvedRoom：否则接线层拿不到 ttwid，wss 握手会被回 HTTP 200
  expect(resolved.room.connectHints).toEqual({ cookie: `ttwid=${TTWID}` });
});

it('端到端解析：分享短链的真实落点是 webcast.amemv.com/reflow/<房间号>（2026-09-16 真链接实测形态）', async () => {
  const resolver = createLinkResolver({
    expandShortLink: async () => ({
      url: 'https://webcast.amemv.com/douyin/webcast/reflow/7686117195721837352?u_code=27705a1dk723&did=MS4wLjABAAAA',
    }),
  });
  const resolved = await resolver.resolveShareText('看看直播 ' + SHORT_URL);
  expect(resolved.ok).toBe(true);
  if (!resolved.ok) {
    return;
  }
  expect(resolved.room.roomRef).toBe('7686117195721837352');
});


it('按房间号现取 ttwid：完整链接 / 纯房间号路径也能拿到连接 Cookie', async () => {
  const fetchImpl = vi.fn(async (url: string) => {
    expect(String(url)).toBe('https://live.douyin.com/369324308707');
    return fakeResponse({ setCookies: [`ttwid=${TTWID}; Domain=.douyin.com; Path=/`], body: '<html></html>' });
  }) as unknown as typeof fetch;
  const fetchTtwid = createDouyinTtwidFetcher({ fetchImpl, retries: 0 });
  await expect(fetchTtwid('369324308707')).resolves.toBe(`ttwid=${TTWID}`);
});

it('现取 ttwid：页面没下发 Set-Cookie 时返回 null（不阻断，交由 wss 报错）', async () => {
  const fetchImpl = vi.fn(async () =>
    fakeResponse({ body: '<html></html>' }),
  ) as unknown as typeof fetch;
  const fetchTtwid = createDouyinTtwidFetcher({ fetchImpl, retries: 0 });
  await expect(fetchTtwid('369324308707')).resolves.toBeNull();
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
