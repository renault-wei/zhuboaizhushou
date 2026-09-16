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
    content: '老板，这个双人套餐多少钱？',
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

  const message = makeMessage({ content: '双人餐怎么卖？' });
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

  const outcome = await engine.handle(makeMessage({ content: '哈哈哈' }));
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
