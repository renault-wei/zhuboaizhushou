import { describe, expect, it } from 'vitest';
import { createLinkResolver, extractCandidateUrls } from '../src/collectors/linkResolver';
import { anchorIdOf } from '../src/collectors/shortLinkExpander';

// D1 链接解析单测：覆盖抖音 / B站 / 快手分享形态、短链展开（注入假 expander）、
// 无 URL / 不支持平台 / 无法静态取房间号等失败分支；全程不触网。

const BILI_ROOM = '22625025';
const DOUYIN_RID = '7312834574980';

describe('D1.1 extractCandidateUrls URL 抽取', () => {
  it('从混合中文口令里抽出短链并识别平台', () => {
    const candidates = extractCandidateUrls(
      '5.13 复制打开抖音，看看【火锅店】的直播！ https://v.douyin.com/iRNb7m8R/ 复制此链接，打开Dou音搜索',
    );
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ platform: 'douyin', short: true });
    expect(candidates[0]?.url).toContain('v.douyin.com/iRNb7m8R');
  });

  it('支持无协议裸口令兜底（b23.tv）', () => {
    const candidates = extractCandidateUrls('来看直播 b23.tv/abCdEf1');
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ platform: 'bilibili', short: true });
  });

  it('无链接文本返回空数组', () => {
    expect(extractCandidateUrls('就随便聊聊天')).toEqual([]);
  });

  // 回归（2026-09-17）：用户报「粘贴链接有时候会失效」。
  // 根因 = 抽取用的是「排除空白与中文标点」黑名单，**汉字不在排除集里**：
  // URL 后紧贴中文时（很多分享模板就是这样）汉字会被吞进 URL，解析必然失败。
  it('回归：URL 后紧跟中文时不能把汉字吞进 URL', () => {
    const candidates = extractCandidateUrls('看看直播 https://v.douyin.com/AbC123/复制此链接打开抖音');
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.url).toBe('https://v.douyin.com/AbC123/');
    expect(candidates[0]).toMatchObject({ platform: 'douyin', short: true });
  });

  it('回归：URL 末尾的英文标点也要剥（此前只剥了中文标点）', () => {
    expect(extractCandidateUrls('https://v.douyin.com/AbC123/.')[0]?.url).toBe(
      'https://v.douyin.com/AbC123/',
    );
    expect(extractCandidateUrls('(https://v.douyin.com/AbC123/)')[0]?.url).toBe(
      'https://v.douyin.com/AbC123/',
    );
    expect(extractCandidateUrls('https://v.douyin.com/AbC123/,')[0]?.url).toBe(
      'https://v.douyin.com/AbC123/',
    );
  });

  it('回归：带查询串的真实落点地址不被截断（白名单须含 ? & = % - _ .）', () => {
    const url =
      'https://webcast.amemv.com/douyin/webcast/reflow/7686117195721837352?u_code=27705a1dk723&did=MS4wLjABAAAA-x_y&sec_user_id=MS4wLjABAAAA_MND';
    const candidates = extractCandidateUrls('直播 ' + url);
    expect(candidates[0]?.url).toBe(url);
  });
});

describe('D1.2/D1.3 静态解析完整直播链接', () => {
  const resolver = createLinkResolver();

  it('B站房间链接 live.bilibili.com/{roomId} → roomRef', async () => {
    const result = await resolver.resolveShareText(`https://live.bilibili.com/${BILI_ROOM}?is_raw=1`);
    expect(result).toEqual({
      ok: true,
      room: {
        platform: 'bilibili',
        roomRef: BILI_ROOM,
        matchedUrl: `https://live.bilibili.com/${BILI_ROOM}?is_raw=1`,
      },
    });
  });

  it('抖音 live 页 https://live.douyin.com/{webRid} → roomRef', async () => {
    const result = await resolver.resolveShareText(`直播间 https://live.douyin.com/${DOUYIN_RID} 欢迎`);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.room).toMatchObject({ platform: 'douyin', roomRef: DOUYIN_RID });
    }
  });

  it('抖音 /root/live/ 形态链接 → roomRef', async () => {
    const result = await resolver.resolveShareText(
      `https://www.douyin.com/root/live/${DOUYIN_RID}?enter_from_merge=web_live`,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.room).toMatchObject({ platform: 'douyin', roomRef: DOUYIN_RID });
    }
  });

  it('抖音主页 / 非直播链接 → ROOM_ID_MISSING 可读失败', async () => {
    const result = await resolver.resolveShareText('https://www.douyin.com/user/MS4wLjABAAAA_abc');
    expect(result).toMatchObject({ ok: false, code: 'ROOM_ID_MISSING', platform: 'douyin' });
  });
});

describe('D1.2 短链（无 expander → 安全默认）', () => {
  it('抖音 v.douyin.com 短链 → SHORT_LINK_ONLY，带 platform 与 shortUrl', async () => {
    const result = await createLinkResolver().resolveShareText(
      'https://v.douyin.com/iRNb7m8R/ 复制打开抖音',
    );
    expect(result).toMatchObject({
      ok: false,
      code: 'SHORT_LINK_ONLY',
      platform: 'douyin',
      shortUrl: 'https://v.douyin.com/iRNb7m8R/',
    });
  });

  it('B站 b23.tv 短链 → SHORT_LINK_ONLY（platform=bilibili）', async () => {
    const result = await createLinkResolver().resolveShareText('https://b23.tv/abCdEf1');
    expect(result).toMatchObject({ ok: false, code: 'SHORT_LINK_ONLY', platform: 'bilibili' });
  });

  it('快手 v.kuaishou.com 短链 → SHORT_LINK_ONLY（platform=kuaishou，spike 范围）', async () => {
    const result = await createLinkResolver().resolveShareText('https://v.kuaishou.com/abc123');
    expect(result).toMatchObject({ ok: false, code: 'SHORT_LINK_ONLY', platform: 'kuaishou' });
  });
});

describe('D1.2 短链展开（注入假 expander，全链路离线）', () => {
  const expander = async (url: string): Promise<string> => {
    if (url.includes('v.douyin.com')) {
      return `https://live.douyin.com/${DOUYIN_RID}`;
    }
    if (url.includes('b23.tv')) {
      return `https://live.bilibili.com/${BILI_ROOM}`;
    }
    return url;
  };

  it('抖音短链展开 → 解析出 douyin roomRef', async () => {
    const result = await createLinkResolver({ expandShortLink: expander }).resolveShareText(
      '复制打开抖音 https://v.douyin.com/iRNb7m8R/',
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.room).toMatchObject({ platform: 'douyin', roomRef: DOUYIN_RID });
    }
  });

  it('B站短链展开 → 解析出 bilibili roomRef', async () => {
    const result = await createLinkResolver({ expandShortLink: expander }).resolveShareText(
      'https://b23.tv/abCdEf1',
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.room).toMatchObject({ platform: 'bilibili', roomRef: BILI_ROOM });
    }
  });

  it('展开后仍是短链且超过最大跳数 → EXPAND_FAILED 防循环', async () => {
    const loop = async (url: string): Promise<string> => {
      if (url.includes('b23.tv')) {
        return 'https://b23.tv/another';
      }
      return url;
    };
    const result = await createLinkResolver({ expandShortLink: loop }).resolveShareText('https://b23.tv/a1');
    expect(result).toMatchObject({ ok: false, code: 'EXPAND_FAILED' });
  });

  it('展开抛错 → EXPAND_FAILED 且不透传异常', async () => {
    const boom = async (): Promise<string> => {
      throw new Error('网络超时');
    };
    const result = await createLinkResolver({ expandShortLink: boom }).resolveShareText(
      'https://v.douyin.com/iRNb7m8R/',
    );
    expect(result).toMatchObject({ ok: false, code: 'EXPAND_FAILED' });
    if (!result.ok) {
      expect(result.reason).toContain('网络超时');
    }
  });

  it('展开后页面无链接 → EXPAND_FAILED（不误报为不支持平台）', async () => {
    const empty = async (): Promise<string> => '这里没有链接';
    const result = await createLinkResolver({ expandShortLink: empty }).resolveShareText(
      'https://v.douyin.com/iRNb7m8R/',
    );
    expect(result).toMatchObject({ ok: false, code: 'EXPAND_FAILED' });
  });
});

describe('D1 失败分支与多链接', () => {
  it('整段文本无任何 URL → NO_URL_FOUND', async () => {
    const result = await createLinkResolver().resolveShareText('今天天气不错');
    expect(result).toMatchObject({ ok: false, code: 'NO_URL_FOUND' });
  });

  it('仅不支持的域名（小红书）→ UNSUPPORTED_PLATFORM', async () => {
    const result = await createLinkResolver().resolveShareText('https://xhslink.com/a/abc123');
    expect(result).toMatchObject({ ok: false, code: 'UNSUPPORTED_PLATFORM' });
  });

  it('完整 B站链接 + 抖音口令混排 → 取静态可解的第一条（B站）', async () => {
    const result = await createLinkResolver().resolveShareText(
      `https://live.bilibili.com/${BILI_ROOM} 同时 https://v.douyin.com/iRNb7m8R/`,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.room).toMatchObject({ platform: 'bilibili', roomRef: BILI_ROOM });
    }
  });
});

// ---------- R51：主播的**稳定身份**不能被丢掉 ----------
// 2026-09-18 生产事故（docs/LIVE-ROOM-LOCKING.md）：room_id 会随「下播重开」变，
// 而 sec_user_id 不变。原先解析结果里只有 roomRef，导致「是不是同一个主播」无从判断。
describe('R51 解析结果带上主播稳定身份（anchorId = sec_user_id）', () => {
  const ANCHOR = 'MS4wLjABAAAAo5mo95UUXE9q4SdValE0jKS--qEwGQ5EfDPOr0K4HHw';

  it('anchorIdOf 取 sec_user_id，并且**不会**误取分享者的 share_user_id', () => {
    const url =
      'https://webcast.amemv.com/douyin/webcast/reflow/123?sec_user_id=' +
      ANCHOR +
      '&share_user_id=92503310531';
    expect(anchorIdOf(url)).toBe(ANCHOR);
    // 只有 share_user_id 时应当取不到 —— 分享者随转发变化，不能用来标识主播
    expect(anchorIdOf('https://webcast.amemv.com/x?share_user_id=92503310531')).toBeUndefined();
    expect(anchorIdOf('https://v.douyin.com/AbC123/')).toBeUndefined();
    expect(anchorIdOf('这不是 URL')).toBeUndefined();
  });

  it('短链展开后 room.anchorId 被带出来（与 roomRef 并存）', async () => {
    const resolver = createLinkResolver({
      expandShortLink: async () => ({
        url: `https://webcast.amemv.com/douyin/webcast/reflow/${DOUYIN_RID}?sec_user_id=${ANCHOR}`,
      }),
    });
    const result = await resolver.resolveShareText('https://v.douyin.com/AbC123/');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.room.roomRef).toBe(DOUYIN_RID);
      expect(result.room.anchorId).toBe(ANCHOR);
    }
  });
});

