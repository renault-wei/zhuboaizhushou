import { afterAll, afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { pool } from '../src/db/client';
import { danmakuGateway, onDanmaku, type LiveDanmakuRecord } from '../src/services/danmaku';

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
const PHONE_DM_IDEM = '13920000311'; // R1 采集通道幂等
const PHONE_DM_NULLKEY = '13920000312'; // R1 注入路径（无 msg_key）

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
// ---------- R1：采集通道字段与幂等去重（自研采集重启） ----------

dbIt('采集通道幂等：同 (platform, msgKey) 重放只落一行、且不二次广播', async () => {
  const token = await registerAndGetToken(PHONE_DM_IDEM);
  await resetUserData(PHONE_DM_IDEM);
  const liveId = await createLiveDraft(token);
  await setLiveStatus(liveId, 'live');
  const userId = await userIdOf(PHONE_DM_IDEM);

  const received: LiveDanmakuRecord[] = [];
  const unsubscribe = onDanmaku((message) => received.push(message));
  try {
    const first = await danmakuGateway.ingest(userId, liveId, {
      content: '这条平台会重放',
      senderNickname: '重放测试',
      platform: 'douyin',
      roomRef: '7123456789012345678',
      msgKey: 'msg-abc-1',
      msgType: 'chat',
    });
    expect(received).toHaveLength(1);

    // 断线重连后平台把同一条消息又推了一遍（msgKey 相同）
    const second = await danmakuGateway.ingest(userId, liveId, {
      content: '这条平台会重放',
      senderNickname: '重放测试',
      platform: 'douyin',
      roomRef: '7123456789012345678',
      msgKey: 'msg-abc-1',
      msgType: 'chat',
    });

    // 幂等：返回同一条记录；【关键】不二次广播 —— 否则 G4 引擎重复回复，观众听到两次口播
    expect(second.id).toBe(first.id);
    expect(received).toHaveLength(1);

    // 库里也只有一行，且采集字段落到位
    const rows = await pool.query(
      'SELECT platform, room_ref, msg_key, msg_type FROM live_danmaku WHERE live_id = $1',
      [liveId],
    );
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0]).toMatchObject({
      platform: 'douyin',
      room_ref: '7123456789012345678',
      msg_key: 'msg-abc-1',
      msg_type: 'chat',
    });

    // 换一个 msgKey 仍应正常写入并广播（唯一索引不能误伤新消息）
    await danmakuGateway.ingest(userId, liveId, {
      content: '另一条真的新消息',
      platform: 'douyin',
      roomRef: '7123456789012345678',
      msgKey: 'msg-abc-2',
      msgType: 'chat',
    });
    expect(received).toHaveLength(2);
  } finally {
    unsubscribe();
  }
});

dbIt('注入路径不带采集字段：msg_key 为 NULL，多条并存不被唯一索引拦', async () => {
  const token = await registerAndGetToken(PHONE_DM_NULLKEY);
  await resetUserData(PHONE_DM_NULLKEY);
  const liveId = await createLiveDraft(token);
  await setLiveStatus(liveId, 'live');

  for (const content of ['第一条', '第二条', '第三条']) {
    const res = await app.inject({
      method: 'POST',
      url: '/api/lives/' + liveId + '/danmaku',
      headers: bearer(token),
      payload: { content },
    });
    expect(res.statusCode).toBe(201);
  }

  const rows = await pool.query(
    'SELECT count(*)::int AS n FROM live_danmaku WHERE live_id = $1 AND msg_key IS NULL',
    [liveId],
  );
  expect(rows.rows[0]).toMatchObject({ n: 3 });
});
