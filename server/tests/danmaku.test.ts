import { afterAll, afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { pool } from '../src/db/client';
import { onDanmaku, type LiveDanmakuRecord } from '../src/services/danmaku';

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

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await app.close();
  await pool.end().catch(() => undefined);
});

// 各场景固定手机号（与 live_session 测试互不重叠）
const PHONE_DM = '13920000307'; // 写入成功
const PHONE_DM_IDLE = '13920000308'; // 非直播中场次
const PHONE_OWNER_A = '13920000309'; // 归属隔离 A
const PHONE_OWNER_B = '13920000310'; // 归属隔离 B

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

/** 复位：清空该用户的 lives（级联清 live_danmaku） */
async function resetUserData(phone: string): Promise<void> {
  const userId = await userIdOf(phone);
  await pool.query('DELETE FROM lives WHERE user_id = $1', [userId]);
}

function bearer(token: string): { authorization: string } {
  return { authorization: `Bearer ${token}` };
}

/** 用一个已登录 token 创建一条开播配置草稿（断言 201），返回 live.id */
async function createLiveDraft(token: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/lives',
    headers: bearer(token),
    payload: { title: '弹幕网关测试直播' },
  });
  expect(res.statusCode).toBe(201);
  const body = res.json() as { live: { id: string } };
  return body.live.id;
}

/** 直接把草稿置为指定状态（绕过 prepare/FFmpeg） */
async function setLiveStatus(liveId: string, status: string): Promise<void> {
  await pool.query('UPDATE lives SET status = $1 WHERE id = $2', [status, liveId]);
}

// ---------- 未登录 401 ----------

it('未带 token POST 弹幕写入返回 401', async () => {
  const id = randomUUID();
  const res = await app.inject({
    method: 'POST',
    url: `/api/lives/${id}/danmaku`,
    payload: { content: '你好' },
  });
  expect(res.statusCode).toBe(401);
  expect(res.json()).toMatchObject({ error: 'UNAUTHORIZED' });
});

// ---------- 弹幕网关写入 ----------

dbIt('写入成功：直播中 POST → 201 入库 + 事件广播 + GET 可读回', async () => {
  const token = await registerAndGetToken(PHONE_DM);
  await resetUserData(PHONE_DM);
  const liveId = await createLiveDraft(token);
  await setLiveStatus(liveId, 'live');

  const received: LiveDanmakuRecord[] = [];
  const unsubscribe = onDanmaku((message) => received.push(message));
  try {
    const res = await app.inject({
      method: 'POST',
      url: `/api/lives/${liveId}/danmaku`,
      headers: bearer(token),
      payload: { content: '  老板，这个双人餐怎么卖？  ', senderNickname: '吃货小王' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { danmaku: LiveDanmakuRecord };
    expect(body.danmaku.content).toBe('老板，这个双人餐怎么卖？');
    expect(body.danmaku.senderNickname).toBe('吃货小王');
    expect(body.danmaku.liveId).toBe(liveId);
    expect(new Date(body.danmaku.sentAt).getTime()).not.toBeNaN();

    // 事件广播：G4 引擎订阅点应收到同一记录
    expect(received).toHaveLength(1);
    expect(received[0].id).toBe(body.danmaku.id);

    // 读侧：GET 可读回刚写入的弹幕
    const read = await app.inject({
      method: 'GET',
      url: `/api/lives/${liveId}/danmaku`,
      headers: bearer(token),
    });
    expect(read.statusCode).toBe(200);
    const rows = read.json() as LiveDanmakuRecord[];
    expect(rows.some((row) => row.id === body.danmaku.id)).toBe(true);
  } finally {
    unsubscribe();
  }
});

dbIt('非直播中场次（idle 草稿）写入返回 409 LIVE_NOT_LIVE', async () => {
  const token = await registerAndGetToken(PHONE_DM_IDLE);
  await resetUserData(PHONE_DM_IDLE);
  const liveId = await createLiveDraft(token);

  const res = await app.inject({
    method: 'POST',
    url: `/api/lives/${liveId}/danmaku`,
    headers: bearer(token),
    payload: { content: '还没开播也能发吗' },
  });
  expect(res.statusCode).toBe(409);
  expect(res.json()).toMatchObject({ error: 'LIVE_NOT_LIVE' });
});

dbIt('归属隔离：B 用户向 A 的场次写入返回 404', async () => {
  const tokenA = await registerAndGetToken(PHONE_OWNER_A);
  await resetUserData(PHONE_OWNER_A);
  const tokenB = await registerAndGetToken(PHONE_OWNER_B);
  await resetUserData(PHONE_OWNER_B);

  const liveId = await createLiveDraft(tokenA);
  await setLiveStatus(liveId, 'live');

  const res = await app.inject({
    method: 'POST',
    url: `/api/lives/${liveId}/danmaku`,
    headers: bearer(tokenB),
    payload: { content: '别人的直播间' },
  });
  expect(res.statusCode).toBe(404);
  expect(res.json()).toMatchObject({ error: 'LIVE_NOT_FOUND' });
});

dbIt('内容校验：空 / 超长 / 非字符串返回 400 CONTENT_INVALID，昵称超长截断到 50', async () => {
  const token = await registerAndGetToken(PHONE_DM);
  const liveId = await createLiveDraft(token);
  await setLiveStatus(liveId, 'live');

  for (const payload of [
    { content: '' },
    { content: '   ' },
    { content: 123 },
    { content: '长'.repeat(201) },
  ]) {
    const res = await app.inject({
      method: 'POST',
      url: `/api/lives/${liveId}/danmaku`,
      headers: bearer(token),
      payload,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'CONTENT_INVALID' });
  }

  const longNickname = '王'.repeat(60);
  const ok = await app.inject({
    method: 'POST',
    url: `/api/lives/${liveId}/danmaku`,
    headers: bearer(token),
    payload: { content: '昵称会被截断', senderNickname: longNickname },
  });
  expect(ok.statusCode).toBe(201);
  const saved = (ok.json() as { danmaku: { senderNickname: string | null } }).danmaku;
  expect(saved.senderNickname?.length).toBe(50);
});