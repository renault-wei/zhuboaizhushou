import { afterAll, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { pool } from '../src/db/client';
import type { LiveDanmakuRecord } from '../src/services/danmaku';
import {
  createInteractionEngine,
  type InteractionReply,
  type LiveInteractionContext,
} from '../src/services/interactionEngine';
import { scanSensitive } from '../src/services/sensitive';

const app: FastifyInstance = buildApp();

// 探测数据库连通性，决定依赖数据库的用例是否执行
let dbAvailable = false;
try {
  await pool.query('SELECT 1');
  dbAvailable = true;
} catch {
  dbAvailable = false;
}
const dbIt = dbAvailable ? it : it.skip;

afterAll(async () => {
  await app.close();
  await pool.end().catch(() => undefined);
});

// ---------- 单元测试替身 ----------

const FIXED_LIVE_ID = 'live-unit-1';
const FIXED_USER_ID = 'user-unit-1';

function makeMessage(overrides: Partial<LiveDanmakuRecord> = {}): LiveDanmakuRecord {
  return {
    id: randomUUID(),
    liveId: FIXED_LIVE_ID,
    // 注意：默认弹幕**刻意不命中第 1 层固定回复**（不说「多少钱/怎么卖」这类词），
    // 好让既有用例继续测它们本来要测的 AI 路径。固定回复有专门用例覆盖。
    content: '你们几点开始营业呀？',
    senderNickname: '吃货小王',
    sentAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeContext(
  overrides: Partial<LiveInteractionContext> = {},
): LiveInteractionContext {
  return {
    liveId: FIXED_LIVE_ID,
    userId: FIXED_USER_ID,
    liveTitle: '火锅店午市直播',
    status: 'live',
    scriptContent: '欢迎光临本店，双人火锅套餐 99 元，锅底现炒食材新鲜。',
    productSnapshot: { name: '双人火锅套餐', price: '99 元' },
    ...overrides,
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('等待条件超时');
}

// ---------- 决策：场次/状态/空弹幕 ----------

it('场次不存在 → skip LIVE_NOT_FOUND，不触发生成器', async () => {
  const loadContext = vi.fn(async () => null);
  const generateReply = vi.fn(async () => '不需要这条回复');
  const engine = createInteractionEngine({ loadContext, generateReply });

  const outcome = await engine.handle(makeMessage());
  expect(outcome).toEqual({ action: 'skip', reason: 'LIVE_NOT_FOUND' });
  expect(generateReply).not.toHaveBeenCalled();
});

it('场次未直播（ended/ready）→ skip LIVE_NOT_LIVE', async () => {
  const loadContext = vi.fn(async () => makeContext({ status: 'ended' }));
  const generateReply = vi.fn(async () => '不需要这条回复');
  const engine = createInteractionEngine({ loadContext, generateReply });

  const outcome = await engine.handle(makeMessage());
  expect(outcome).toEqual({ action: 'skip', reason: 'LIVE_NOT_LIVE' });
  expect(generateReply).not.toHaveBeenCalled();
});

it('空弹幕 → skip DANMAKU_EMPTY（引擎侧兜底）', async () => {
  const engine = createInteractionEngine({
    loadContext: vi.fn(async () => makeContext()),
    generateReply: vi.fn(async () => '不需要这条回复'),
  });
  const outcome = await engine.handle(makeMessage({ content: '   ' }));
  expect(outcome).toEqual({ action: 'skip', reason: 'DANMAKU_EMPTY' });
});

// ---------- 生成与出口 ----------

it('直播中弹幕 → DeepSeek 生成回复并交出口（source=generated）', async () => {
  const replies: InteractionReply[] = [];
  const generateReply = vi.fn(async () => '这个双人套餐 99 元，欢迎下单～');
  const engine = createInteractionEngine({
    loadContext: vi.fn(async () => makeContext()),
    generateReply,
    onReply: (reply) => {
      replies.push(reply);
    },
    globalIntervalMs: 0,
    senderIntervalMs: 0,
  });

  // 刻意避开「怎么卖」等固定回复问法：本用例测的是 **AI 生成路径**
  const message = makeMessage({ content: '你们店里能坐多少人？' });
  const outcome = await engine.handle(message);
  expect(outcome.action).toBe('reply');
  if (outcome.action !== 'reply') {
    return;
  }
  expect(outcome.reply.source).toBe('generated');
  expect(outcome.reply.liveId).toBe(FIXED_LIVE_ID);
  expect(outcome.reply.userId).toBe(FIXED_USER_ID);
  expect(outcome.reply.danmakuId).toBe(message.id);
  expect(outcome.reply.text).toContain('99 元');
  expect(replies).toHaveLength(1);

  // 商家知识（直播标题/话术/商品快照）应完整传给生成器
  const input = generateReply.mock.calls[0]?.[0];
  expect(input?.knowledge.liveTitle).toBe('火锅店午市直播');
  expect(input?.knowledge.productSnapshot).toMatchObject({ name: '双人火锅套餐' });
});

it('生成器返回 NONE/空 → skip NO_REPLY_NEEDED，不触发出口', async () => {
  const onReply = vi.fn();
  const generateReply = vi.fn(async () => null);
  const engine = createInteractionEngine({
    loadContext: vi.fn(async () => makeContext()),
    generateReply,
    onReply,
    globalIntervalMs: 0,
    senderIntervalMs: 0,
  });

  // 注意：不能再用「哈哈哈」—— R41 起那类灌水会在**最前面**被判 INVALID_DANMAKU，
  // 根本到不了生成器。本用例要测的是「生成器返回 NONE」这条路径，所以喂一条有效弹幕。
  const outcome = await engine.handle(makeMessage({ content: '你们能坐多少人？' }));
  expect(outcome).toEqual({ action: 'skip', reason: 'NO_REPLY_NEEDED' });
  expect(onReply).not.toHaveBeenCalled();
});

it('生成器异常 → skip GENERATION_FAILED，不影响后续弹幕', async () => {
  const generateReply = vi.fn(async () => {
    throw new Error('DeepSeek 超时');
  });
  const engine = createInteractionEngine({
    loadContext: vi.fn(async () => makeContext()),
    generateReply,
    globalIntervalMs: 0,
    senderIntervalMs: 0,
  });
  const outcome = await engine.handle(makeMessage());
  expect(outcome).toEqual({ action: 'skip', reason: 'GENERATION_FAILED' });
});

// ---------- 敏感词兜底 ----------

it('生成内容命中敏感词 → 改念兜底话术（source=fallback，兜底文案干净）', async () => {
  const replies: InteractionReply[] = [];
  const engine = createInteractionEngine({
    loadContext: vi.fn(async () => makeContext()),
    generateReply: vi.fn(async () => '本店第一好吃，顶级食材包您满意！'),
    onReply: (reply) => {
      replies.push(reply);
    },
    globalIntervalMs: 0,
    senderIntervalMs: 0,
  });

  const outcome = await engine.handle(makeMessage({ content: '你家好吃吗？' }));
  expect(outcome.action).toBe('reply');
  if (outcome.action !== 'reply') {
    return;
  }
  expect(outcome.reply.source).toBe('fallback');
  expect(scanSensitive(outcome.reply.text).status).toBe('pass');
  expect(outcome.reply.text).not.toContain('第一');
  expect(replies[0]?.source).toBe('fallback');
});

// ---------- 频控 ----------

it('场次级频控：间隔内第二条 skip GLOBAL_THROTTLED，超过间隔恢复回复', async () => {
  let clock = 0;
  const generateReply = vi.fn(async () => '这是回复');
  const engine = createInteractionEngine({
    loadContext: vi.fn(async () => makeContext()),
    generateReply,
    now: () => clock,
    globalIntervalMs: 1000,
    senderIntervalMs: 1000,
  });

  const first = await engine.handle(makeMessage({ id: 'm-1' }));
  expect(first.action).toBe('reply');

  // 同一时刻又来一条 → 被场次级频控挡下，不调用生成器
  const throttled = await engine.handle(makeMessage({ id: 'm-2' }));
  expect(throttled).toEqual({ action: 'skip', reason: 'GLOBAL_THROTTLED' });
  expect(generateReply).toHaveBeenCalledTimes(1);

  clock = 1000;
  const third = await engine.handle(makeMessage({ id: 'm-3' }));
  expect(third.action).toBe('reply');
  expect(generateReply).toHaveBeenCalledTimes(2);
});

it('用户级频控：同昵称刷屏只回一次，其他用户不受影响', async () => {
  let clock = 0;
  const generateReply = vi.fn(async () => '这是回复');
  const engine = createInteractionEngine({
    loadContext: vi.fn(async () => makeContext()),
    generateReply,
    now: () => clock,
    globalIntervalMs: 0,
    senderIntervalMs: 5000,
  });

  const first = await engine.handle(makeMessage({ senderNickname: '刷屏哥' }));
  expect(first.action).toBe('reply');

  // 同一昵称 2 秒后再刷 → 用户级频控挡下（场次级为 0 不影响判断）
  clock = 2000;
  const sameUser = await engine.handle(makeMessage({ senderNickname: '刷屏哥' }));
  expect(sameUser).toEqual({ action: 'skip', reason: 'SENDER_THROTTLED' });
  expect(generateReply).toHaveBeenCalledTimes(1);

  // 换一个昵称 → 正常回复
  clock = 2500;
  const otherUser = await engine.handle(makeMessage({ senderNickname: '路人乙' }));
  expect(otherUser.action).toBe('reply');
  expect(generateReply).toHaveBeenCalledTimes(2);
});

// ---------- R22 / R27：账号级配置生效 ----------

it('R22：账号级关掉智能回复 → skip REPLY_DISABLED，且一次生成器都不调', async () => {
  const generateReply = vi.fn(async () => '不该被调用');
  const engine = createInteractionEngine({
    loadContext: async () => makeContext({ replyEnabled: false }),
    generateReply,
    onReply: () => undefined,
  });
  const outcome = await engine.handle(makeMessage());
  expect(outcome).toEqual({ action: 'skip', reason: 'REPLY_DISABLED' });
  // 关掉就不该花钱：DEEPSEEK 一次都不调
  expect(generateReply).not.toHaveBeenCalled();
});

it('R22：回复间隔取账号级设置，压过注入的默认值', async () => {
  let clock = 0;
  const engine = createInteractionEngine({
    loadContext: async () => makeContext({ replyIntervalSeconds: 1 }),
    // 故意注入 60s：若它赢了，第二条必被挡 —— 这就是优先级的判别式
    globalIntervalMs: 60_000,
    senderIntervalMs: 0,
    now: () => clock,
    generateReply: async () => '好的，双人套餐 99 元～',
    onReply: () => undefined,
  });

  expect((await engine.handle(makeMessage())).action).toBe('reply');

  clock = 500; // 0.5s < 账号级 1s → 挡
  expect(await engine.handle(makeMessage())).toEqual({
    action: 'skip',
    reason: 'GLOBAL_THROTTLED',
  });

  clock = 1500; // 1.5s ≥ 账号级 1s → 放行
  expect((await engine.handle(makeMessage())).action).toBe('reply');
});

it('R27：命中商家自定义违禁词 → 整条丢弃（BANNED_WORD），不改兜底话术', async () => {
  const onReply = vi.fn();
  const engine = createInteractionEngine({
    loadContext: async () => makeContext({ bannedWords: ['最低价'] }),
    generateReply: async () => '咱们家最低价只要 99 元哦',
    onReply,
  });
  const outcome = await engine.handle(makeMessage());
  expect(outcome).toEqual({ action: 'skip', reason: 'BANNED_WORD' });
  // 关键区别（用户拍板 D4）：不是改念兜底话术，而是**整条不播** —— 出口一次都不该被调用
  expect(onReply).not.toHaveBeenCalled();
});

// ---------- R32/R33：第 1 层固定回复（零 AI）----------

it('R33：命中固定回复 → source=faq，且**一次 DeepSeek 都不调**', async () => {
  const generateReply = vi.fn(async () => '这条不该被用上');
  const engine = createInteractionEngine({
    loadContext: async () => makeContext(),
    generateReply,
    onReply: () => undefined,
  });
  // makeContext 的快照是 { name: '双人火锅套餐', price: '99 元' }
  const outcome = await engine.handle(makeMessage({ content: '多少钱？' }));
  expect(outcome.action).toBe('reply');
  if (outcome.action !== 'reply') {
    return;
  }
  expect(outcome.reply.source).toBe('faq');
  expect(outcome.reply.text).toBe('咱家双人火锅套餐是99 元');
  // 省钱的证据：AI 一次都没调
  expect(generateReply).not.toHaveBeenCalled();
});

it('R33：未命中固定回复 → 回落 AI，并把固定回复口径一并交给它', async () => {
  const generateReply = vi.fn(async () => '咱家的毛肚是招牌～');
  const engine = createInteractionEngine({
    loadContext: async () => makeContext(),
    generateReply,
    onReply: () => undefined,
  });
  const outcome = await engine.handle(makeMessage({ content: '你们店里能坐多少人？' }));
  expect(outcome.action).toBe('reply');
  if (outcome.action !== 'reply') {
    return;
  }
  expect(outcome.reply.source).toBe('generated');
  expect(generateReply).toHaveBeenCalledTimes(1);
  // 口径一致性（用户拍板 D3 的配套）：未命中时把固定答案作为提示交给模型，
  // 避免「固定回复说 99、AI 说 99 起」
  const input = generateReply.mock.calls[0]?.[0] as {
    knowledge: { faqHints?: readonly string[] };
  };
  expect(input.knowledge.faqHints).toContain('咱家双人火锅套餐是99 元');
});

it('R33：固定答案自身命中商家违禁词 → 当作未命中，回落 AI（不把那个词照念出来）', async () => {
  const generateReply = vi.fn(async () => '咱们这个套餐很划算～');
  const engine = createInteractionEngine({
    // 商家把「99」设成违禁词，而它正好出现在自己的价格字段里
    loadContext: async () => makeContext({ bannedWords: ['99'] }),
    generateReply,
    onReply: () => undefined,
  });
  const outcome = await engine.handle(makeMessage({ content: '多少钱？' }));
  expect(outcome.action).toBe('reply');
  if (outcome.action !== 'reply') {
    return;
  }
  expect(outcome.reply.source).toBe('generated');
  expect(outcome.reply.text).not.toContain('99');
});

it('R32：没有商品快照 → 固定回复为空，正常走 AI（不会凭空编答案）', async () => {
  const generateReply = vi.fn(async () => '好的呢～');
  const engine = createInteractionEngine({
    loadContext: async () => makeContext({ productSnapshot: null }),
    generateReply,
    onReply: () => undefined,
  });
  const outcome = await engine.handle(makeMessage({ content: '多少钱？' }));
  expect(outcome.action).toBe('reply');
  if (outcome.action !== 'reply') {
    return;
  }
  expect(outcome.reply.source).toBe('generated');
  expect(generateReply).toHaveBeenCalledTimes(1);
});

// ---------- R28/R29：并发正确性与状态回收 ----------

it('R28：并发 10 条弹幕只产生 1 次 AI 调用与 1 条回复（频控竞态回归）', async () => {
  const generateReply = vi.fn(async () => {
    // 刻意留出生成耗时，把 check-then-act 的竞态窗口放大
    await new Promise((resolve) => setTimeout(resolve, 20));
    return '咱家套餐 99 元～';
  });
  const onReply = vi.fn();
  const engine = createInteractionEngine({
    loadContext: async () => makeContext({ replyIntervalSeconds: 5 }),
    generateReply,
    onReply,
    senderIntervalMs: 5000,
    // 时钟不前进：10 条全在同一瞬间，正是真实直播间刷屏的形态
    now: () => 0,
  });

  await Promise.all(
    Array.from({ length: 10 }, (_, index) =>
      engine.handle(
        makeMessage({
          id: `race-${index}`,
          content: '你们店里能坐多少人？',
          senderNickname: `观众${index}`,
        }),
      ),
    ),
  );

  // 修复前：10 次 AI 调用 + 10 条回复（频控被完全绕过，成本放大 10 倍）
  // 修复后：每场次串行 → 第一条落账后其余全部被频控挡下
  expect(generateReply).toHaveBeenCalledTimes(1);
  expect(onReply).toHaveBeenCalledTimes(1);
});

it('R28：串行粒度是**场次** —— 两个场次各自并发，各回 1 条（互不拖累）', async () => {
  const generateReply = vi.fn(async () => '咱家套餐 99 元～');
  const engine = createInteractionEngine({
    loadContext: async () => makeContext({ replyIntervalSeconds: 5 }),
    generateReply,
    onReply: () => undefined,
    senderIntervalMs: 5000,
    now: () => 0,
  });

  await Promise.all([
    ...Array.from({ length: 5 }, (_, index) =>
      engine.handle(makeMessage({ id: `a-${index}`, liveId: 'live-a', content: '你们能坐多少人？' })),
    ),
    ...Array.from({ length: 5 }, (_, index) =>
      engine.handle(makeMessage({ id: `b-${index}`, liveId: 'live-b', content: '你们能坐多少人？' })),
    ),
  ]);

  // 两个场次各 1 次 —— 证明串行链是按场次分的，不是全局串行
  expect(generateReply).toHaveBeenCalledTimes(2);
});

it('R29：forgetLive 清掉本场记账后，立刻能再回一条（场次结束的回收路径）', async () => {
  const engine = createInteractionEngine({
    loadContext: async () => makeContext({ replyIntervalSeconds: 3600 }), // 间隔一小时
    generateReply: async () => '咱家套餐 99 元～',
    onReply: () => undefined,
    senderIntervalMs: 5000,
    now: () => 0,
  });

  expect((await engine.handle(makeMessage({ content: '你们能坐多少人？' }))).action).toBe('reply');
  expect((await engine.handle(makeMessage({ content: '你们能坐多少人？' }))).action).toBe('skip');

  // 场次结束 → 回收该场记账 → 下一场同 id 立刻可回
  engine.forgetLive(FIXED_LIVE_ID);
  expect((await engine.handle(makeMessage({ content: '你们能坐多少人？' }))).action).toBe('reply');
});

// ---------- R41/R45：无效弹幕前置过滤 + 互动统计 ----------

it('R41：灌水/闲聊在**最前面**就被挡掉 —— 一次 DeepSeek 都不调、不占名额', async () => {
  const generateReply = vi.fn(async () => '不该被调用');
  const engine = createInteractionEngine({
    loadContext: async () => makeContext(),
    generateReply,
    onReply: () => undefined,
    globalIntervalMs: 0,
    senderIntervalMs: 0,
  });

  // 灌水、闲聊、问候 —— 用户拍板「闲聊算无效」
  for (const content of ['66666666', '哈哈哈哈哈', '今天天气不错', '我来了', '加微信 abc12345']) {
    const outcome = await engine.handle(makeMessage({ content }));
    expect(outcome).toEqual({ action: 'skip', reason: 'INVALID_DANMAKU' });
  }
  // 省钱的证据：一条都没进生成器
  expect(generateReply).not.toHaveBeenCalled();
});

it('R41：提问与需求表达能穿过过滤（有效的要放行）', async () => {
  const generateReply = vi.fn(async () => '咱家套餐 99 元～');
  const engine = createInteractionEngine({
    loadContext: async () => makeContext({ productSnapshot: null }),
    generateReply,
    onReply: () => undefined,
    globalIntervalMs: 0,
    senderIntervalMs: 0,
  });

  for (const content of ['你们几点营业', '我想要这个套餐', '能便宜点吗']) {
    expect((await engine.handle(makeMessage({ content }))).action).toBe('reply');
  }
  expect(generateReply).toHaveBeenCalledTimes(3);
});

it('R41：无效弹幕**不占用频控名额** —— 挡掉之后真问题照样能回', async () => {
  const generateReply = vi.fn(async () => '咱家套餐 99 元～');
  const engine = createInteractionEngine({
    loadContext: async () => makeContext({ productSnapshot: null }),
    generateReply,
    onReply: () => undefined,
    senderIntervalMs: 0,
    now: () => 0,
  });
  // 先来 5 条灌水（修复前它们会把时间窗名额抢光）
  for (let index = 0; index < 5; index += 1) {
    expect((await engine.handle(makeMessage({ content: '66666666' }))).action).toBe('skip');
  }
  // 真问题紧接着来：仍然回得出去
  expect((await engine.handle(makeMessage({ content: '你们能坐多少人？' }))).action).toBe('reply');
  expect(generateReply).toHaveBeenCalledTimes(1);
});

// ---------- G4 联调：G3 写入 → 广播 → 引擎回复 ----------

// 固定手机号（与 danmaku / live_session 测试互不重叠）
const PHONE_G4 = '13920000401';

async function registerAndGetToken(phone: string): Promise<string> {
  const send = await app.inject({
    method: 'POST',
    url: '/api/auth/send-code',
    payload: { phone },
  });
  const code = send.json().code as string;
  expect(code).toMatch(/^\d{6}$/);

  const verify = await app.inject({
    method: 'POST',
    url: '/api/auth/verify-code',
    payload: { phone, code },
  });
  expect(verify.statusCode).toBe(200);
  return verify.json().token as string;
}

async function userIdOf(phone: string): Promise<string> {
  const res = await pool.query('SELECT id FROM users WHERE phone = $1 LIMIT 1', [phone]);
  const row = res.rows[0] as { id: string } | undefined;
  if (!row) {
    throw new Error(`测试用户不存在：${phone}`);
  }
  return row.id;
}

async function resetUserData(phone: string): Promise<void> {
  const userId = await userIdOf(phone);
  await pool.query('DELETE FROM lives WHERE user_id = $1', [userId]);
}

function bearer(token: string): { authorization: string } {
  return { authorization: `Bearer ${token}` };
}

async function createLiveDraft(token: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/lives',
    headers: bearer(token),
    payload: { title: '实时互动引擎联调直播' },
  });
  expect(res.statusCode).toBe(201);
  const body = res.json() as { live: { id: string } };
  return body.live.id;
}

async function setLiveStatus(liveId: string, status: string): Promise<void> {
  await pool.query('UPDATE lives SET status = $1 WHERE id = $2', [status, liveId]);
}

dbIt('联调：POST 弹幕 → onDanmaku 广播 → 引擎产出回复', async () => {
  const token = await registerAndGetToken(PHONE_G4);
  await resetUserData(PHONE_G4);
  const liveId = await createLiveDraft(token);
  await setLiveStatus(liveId, 'live');
  // R22 起「场次级频控」由**账号级设置**决定，注入的 globalIntervalMs 只是缺省回落。
  // 本用例走真实上下文加载，所以下面断言的是**真实优先级**：连续弹幕会被账号级间隔挡下。

  const replies: InteractionReply[] = [];
  const engine = createInteractionEngine({
    // 注意：这里传 0 **不会**生效 —— 真实上下文里的账号级间隔优先（见 handle 的优先级注释）
    globalIntervalMs: 0,
    senderIntervalMs: 0,
    generateReply: vi.fn(async () => '咱家套餐详情可以看直播间团购链接，欢迎下单～'),
    onReply: (reply) => {
      replies.push(reply);
    },
  });
  const unsubscribe = engine.subscribe();
  try {
    const post = async (content: string): Promise<void> => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/lives/${liveId}/danmaku`,
        headers: bearer(token),
        payload: { content, senderNickname: '吃货小王' },
      });
      expect(res.statusCode).toBe(201);
    };

    // 第 1 条：走完整链路（入库 → 广播 → 真实上下文 → 生成 → 出口）
    await post('老板这个双人餐多少钱？');
    await waitFor(() => replies.length >= 1);
    expect(replies).toHaveLength(1);
    expect(replies[0]?.liveId).toBe(liveId);
    expect(replies[0]?.source).toBe('generated');

    // 后 4 条紧接着发：账号级间隔（默认 5s）把它们挡下 —— 这就是新优先级的可见证据
    await post('你们几点营业？');
    await post('店在哪里？');
    await post('可以到店直接核销吗？');
    await post('有辣锅底吗？');
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(replies).toHaveLength(1);
  } finally {
    unsubscribe();
  }
});
