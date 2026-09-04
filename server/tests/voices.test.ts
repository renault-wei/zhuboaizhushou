import { afterAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { pool } from '../src/db/client';
import { getLatestVoiceAgreement } from '../src/services/agreement';
import { MOCK_VOICE_ID_PREFIX } from '../src/services/voice';

const app: FastifyInstance = buildApp();

// 提前探测数据库连通性，决定依赖数据库的用例是否执行
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

/** 各场景固定手机号（互不共用，避免短信重发限制与历史数据串扰） */
const PHONE_UNSIGNED = '13900000001';
const PHONE_SHORT = '13900000002';
const PHONE_CREATE = '13900000003';
const PHONE_LIST_A = '13900000004';
const PHONE_LIST_B = '13900000005';
const PHONE_OTHER = '13900000006';
const PHONE_FLOW = '13900000007';
const PHONE_READY = '13900000008';
const PHONE_DELETE_OWNER = '13900000009';
const PHONE_DELETE_OTHER = '13900000010';

const LATEST_VERSION = getLatestVoiceAgreement().version;

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

/** 复位：清空该用户的音色与协议签署记录，保证用例之间互不影响 */
async function resetUserData(phone: string): Promise<void> {
  const userId = await userIdOf(phone);
  await pool.query('DELETE FROM voices WHERE user_id = $1', [userId]);
  await pool.query('DELETE FROM voice_agreements WHERE user_id = $1', [userId]);
}

function bearer(token: string): { authorization: string } {
  return { authorization: `Bearer ${token}` };
}
/** 签署最新版协议（版本号与签署路由强校验一致，直接走签署接口落库存档） */
async function signAgreement(token: string): Promise<void> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/agreements/voice/sign',
    headers: bearer(token),
    payload: { version: LATEST_VERSION, agreed: true },
  });
  expect(res.statusCode).toBe(200);
}

/** 回拨音色 created_at，模拟时间推进以验证克隆进度 */
async function backdateVoice(voiceId: string, secondsAgo: number): Promise<void> {
  await pool.query(
    'UPDATE voices SET created_at = now() - ($1 * interval \'1 second\') WHERE id = $2',
    [secondsAgo, voiceId],
  );
}

// ---------- 未登录 401 ----------

describe('声音克隆接口鉴权', () => {
  it('未带 token 访问四个接口均返回 401', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/api/voices',
      payload: { name: '音色', sampleDurationSeconds: 180 },
    });
    expect(create.statusCode).toBe(401);
    expect(create.json()).toMatchObject({ error: 'UNAUTHORIZED' });

    const list = await app.inject({ method: 'GET', url: '/api/voices' });
    expect(list.statusCode).toBe(401);

    const single = await app.inject({ method: 'GET', url: `/api/voices/${randomUUID()}` });
    expect(single.statusCode).toBe(401);

    const remove = await app.inject({
      method: 'DELETE',
      url: `/api/voices/${randomUUID()}`,
      payload: {},
    });
    expect(remove.statusCode).toBe(401);
  });

  it('非法 token 访问返回 401', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/voices',
      headers: { authorization: 'Bearer not-a-valid-jwt' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: 'UNAUTHORIZED' });
  });
});

// ---------- 协议校验（合规红线）----------

dbIt('未签署《声音授权协议》直接克隆返回 403 AGREEMENT_REQUIRED', async () => {
  const token = await registerAndGetToken(PHONE_UNSIGNED);
  await resetUserData(PHONE_UNSIGNED);

  const res = await app.inject({
    method: 'POST',
    url: '/api/voices',
    headers: bearer(token),
    payload: { name: '未签协议音色', sampleDurationSeconds: 180 },
  });
  expect(res.statusCode).toBe(403);
  expect(res.json()).toMatchObject({
    error: 'AGREEMENT_REQUIRED',
    message: '克隆声音前需先签署《声音授权协议》',
  });
});

// ---------- 时长校验 ----------

dbIt('签署协议后录音时长不足 3 分钟返回 400 DURATION_TOO_SHORT', async () => {
  const token = await registerAndGetToken(PHONE_SHORT);
  await resetUserData(PHONE_SHORT);
  await signAgreement(token);

  const res = await app.inject({
    method: 'POST',
    url: '/api/voices',
    headers: bearer(token),
    payload: { name: '时长不足音色', sampleDurationSeconds: 60 },
  });
  expect(res.statusCode).toBe(400);
  expect(res.json()).toMatchObject({
    error: 'DURATION_TOO_SHORT',
    message: '录音时长不足 3 分钟',
  });
});

// ---------- 创建克隆任务 ----------

dbIt('签署协议后创建成功返回 201，状态为 pending 且 providerVoiceId 为 mock 前缀', async () => {
  const token = await registerAndGetToken(PHONE_CREATE);
  await resetUserData(PHONE_CREATE);
  await signAgreement(token);

  const res = await app.inject({
    method: 'POST',
    url: '/api/voices',
    headers: bearer(token),
    payload: {
      name: '我的主播音色',
      sampleDurationSeconds: 180,
      sampleFingerprint: 'sha256:demo-fingerprint',
    },
  });
  expect(res.statusCode).toBe(201);
  const body = res.json();
  expect(body).toMatchObject({
    name: '我的主播音色',
    provider: 'cosyvoice',
    status: 'pending',
    sampleDurationSeconds: 180,
    sampleFingerprint: 'sha256:demo-fingerprint',
    userId: await userIdOf(PHONE_CREATE),
  });
  expect(typeof body.providerVoiceId).toBe('string');
  expect(body.providerVoiceId.startsWith(MOCK_VOICE_ID_PREFIX)).toBe(true);
  expect(body.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
});

// ---------- 我的音色列表 + 归属隔离 ----------

dbIt('列表返回当前用户全部音色（新创建在前），其他用户查不到我的音色', async () => {
  const tokenA = await registerAndGetToken(PHONE_LIST_A);
  await resetUserData(PHONE_LIST_A);
  await signAgreement(tokenA);

  const tokenB = await registerAndGetToken(PHONE_LIST_B);
  await resetUserData(PHONE_LIST_B);
  await signAgreement(tokenB);

  const first = await app.inject({
    method: 'POST',
    url: '/api/voices',
    headers: bearer(tokenA),
    payload: { name: '列表音色一', sampleDurationSeconds: 180 },
  });
  expect(first.statusCode).toBe(201);
  const firstName = first.json().name as string;

  const second = await app.inject({
    method: 'POST',
    url: '/api/voices',
    headers: bearer(tokenA),
    payload: { name: '列表音色二', sampleDurationSeconds: 200 },
  });
  expect(second.statusCode).toBe(201);
  const secondId = second.json().id as string;
  const secondName = second.json().name as string;

  const listA = await app.inject({ method: 'GET', url: '/api/voices', headers: bearer(tokenA) });
  expect(listA.statusCode).toBe(200);
  const voicesA = listA.json() as Array<Record<string, unknown>>;
  expect(voicesA.map((voice) => voice.name)).toContain(firstName);
  expect(voicesA.map((voice) => voice.name)).toContain(secondName);
  // 新创建的排在列表最前
  expect(voicesA[0].id).toBe(secondId);
  expect(voicesA[0]).toMatchObject({
    id: expect.any(String),
    name: secondName,
    status: 'pending',
    providerVoiceId: expect.stringMatching(/^mock-voice-/),
    sampleDurationSeconds: 200,
    createdAt: expect.any(String),
  });

  // 归属隔离：用户 B 查不到用户 A 的任何音色
  const listB = await app.inject({ method: 'GET', url: '/api/voices', headers: bearer(tokenB) });
  expect(listB.statusCode).toBe(200);
  const voicesB = listB.json() as Array<Record<string, unknown>>;
  expect(voicesB.map((voice) => voice.name)).not.toContain(firstName);
  expect(voicesB.map((voice) => voice.name)).not.toContain(secondName);
});

// ---------- 单条查询的归属校验 404 ----------

dbIt('查询不存在的音色或属于其他用户的音色返回 404 VOICE_NOT_FOUND', async () => {
  const tokenOwner = await registerAndGetToken(PHONE_LIST_A);
  await resetUserData(PHONE_LIST_A);
  await signAgreement(tokenOwner);

  const created = await app.inject({
    method: 'POST',
    url: '/api/voices',
    headers: bearer(tokenOwner),
    payload: { name: '归属校验音色', sampleDurationSeconds: 180 },
  });
  expect(created.statusCode).toBe(201);
  const voiceId = created.json().id as string;

  const tokenOther = await registerAndGetToken(PHONE_OTHER);
  await resetUserData(PHONE_OTHER);
  await signAgreement(tokenOther);

  // 随机 id 不存在
  const missing = await app.inject({
    method: 'GET',
    url: `/api/voices/${randomUUID()}`,
    headers: bearer(tokenOwner),
  });
  expect(missing.statusCode).toBe(404);
  expect(missing.json()).toMatchObject({ error: 'VOICE_NOT_FOUND' });

  // 其他用户访问我的音色
  const others = await app.inject({
    method: 'GET',
    url: `/api/voices/${voiceId}`,
    headers: bearer(tokenOther),
  });
  expect(others.statusCode).toBe(404);
  expect(others.json()).toMatchObject({ error: 'VOICE_NOT_FOUND' });
});

// ---------- 删除音色 ----------

dbIt('删除自己的音色成功：返回 ok:true 且音色从库中消失', async () => {
  const token = await registerAndGetToken(PHONE_DELETE_OWNER);
  await resetUserData(PHONE_DELETE_OWNER);
  await signAgreement(token);

  const created = await app.inject({
    method: 'POST',
    url: '/api/voices',
    headers: bearer(token),
    payload: { name: '待删除音色', sampleDurationSeconds: 180 },
  });
  expect(created.statusCode).toBe(201);
  const voiceId = created.json().id as string;

  const removed = await app.inject({
    method: 'DELETE',
    url: `/api/voices/${voiceId}`,
    headers: bearer(token),
  });
  expect(removed.statusCode).toBe(200);
  expect(removed.json()).toEqual({ ok: true });

  // 删除后：单查 404，列表不再包含该音色
  const single = await app.inject({
    method: 'GET',
    url: `/api/voices/${voiceId}`,
    headers: bearer(token),
  });
  expect(single.statusCode).toBe(404);
  const list = await app.inject({ method: 'GET', url: '/api/voices', headers: bearer(token) });
  expect(list.statusCode).toBe(200);
  const voices = list.json() as Array<Record<string, unknown>>;
  expect(voices.map((voice) => voice.id)).not.toContain(voiceId);
});

dbIt('删除其他用户的音色返回 404 VOICE_NOT_FOUND', async () => {
  const tokenOwner = await registerAndGetToken(PHONE_DELETE_OWNER);
  await resetUserData(PHONE_DELETE_OWNER);
  await signAgreement(tokenOwner);

  const created = await app.inject({
    method: 'POST',
    url: '/api/voices',
    headers: bearer(tokenOwner),
    payload: { name: '他人不可删音色', sampleDurationSeconds: 180 },
  });
  expect(created.statusCode).toBe(201);
  const voiceId = created.json().id as string;

  const tokenOther = await registerAndGetToken(PHONE_DELETE_OTHER);
  await resetUserData(PHONE_DELETE_OTHER);
  await signAgreement(tokenOther);

  const removed = await app.inject({
    method: 'DELETE',
    url: `/api/voices/${voiceId}`,
    headers: bearer(tokenOther),
  });
  expect(removed.statusCode).toBe(404);
  expect(removed.json()).toMatchObject({ error: 'VOICE_NOT_FOUND' });

  // 他人删除失败不影响本人音色
  const single = await app.inject({
    method: 'GET',
    url: `/api/voices/${voiceId}`,
    headers: bearer(tokenOwner),
  });
  expect(single.statusCode).toBe(200);
});

dbIt('删除不存在的音色返回 404 VOICE_NOT_FOUND', async () => {
  const token = await registerAndGetToken(PHONE_DELETE_OTHER);
  await resetUserData(PHONE_DELETE_OTHER);
  await signAgreement(token);

  const removed = await app.inject({
    method: 'DELETE',
    url: `/api/voices/${randomUUID()}`,
    headers: bearer(token),
  });
  expect(removed.statusCode).toBe(404);
  expect(removed.json()).toMatchObject({ error: 'VOICE_NOT_FOUND' });
});

// ---------- 克隆进度状态流转 ----------

dbIt('克隆状态按创建时间推进：pending → processing → ready', async () => {
  const token = await registerAndGetToken(PHONE_FLOW);
  await resetUserData(PHONE_FLOW);
  await signAgreement(token);

  const created = await app.inject({
    method: 'POST',
    url: '/api/voices',
    headers: bearer(token),
    payload: { name: '状态流转音色', sampleDurationSeconds: 180 },
  });
  expect(created.statusCode).toBe(201);
  const voiceId = created.json().id as string;
  const providerVoiceId = created.json().providerVoiceId as string;

  // 刚创建：pending
  const pending = await app.inject({
    method: 'GET',
    url: `/api/voices/${voiceId}`,
    headers: bearer(token),
  });
  expect(pending.statusCode).toBe(200);
  expect(pending.json().status).toBe('pending');

  // 回拨到 5 秒前：processing
  await backdateVoice(voiceId, 5);
  const processing = await app.inject({
    method: 'GET',
    url: `/api/voices/${voiceId}`,
    headers: bearer(token),
  });
  expect(processing.statusCode).toBe(200);
  expect(processing.json().status).toBe('processing');

  // 回拨到 10 秒前：ready，providerVoiceId 保持不变
  await backdateVoice(voiceId, 10);
  const ready = await app.inject({
    method: 'GET',
    url: `/api/voices/${voiceId}`,
    headers: bearer(token),
  });
  expect(ready.statusCode).toBe(200);
  expect(ready.json().status).toBe('ready');
  expect(ready.json().providerVoiceId).toBe(providerVoiceId);
});

// ---------- ready 终态不回退 ----------

dbIt('进入 ready 后回拨创建时间仍保持 ready，providerVoiceId 不变', async () => {
  const token = await registerAndGetToken(PHONE_READY);
  await resetUserData(PHONE_READY);
  await signAgreement(token);

  const created = await app.inject({
    method: 'POST',
    url: '/api/voices',
    headers: bearer(token),
    payload: { name: '不回退音色', sampleDurationSeconds: 180 },
  });
  expect(created.statusCode).toBe(201);
  const voiceId = created.json().id as string;
  const providerVoiceId = created.json().providerVoiceId as string;

  // 先回拨到 10 秒前推进到 ready
  await backdateVoice(voiceId, 10);
  const ready = await app.inject({
    method: 'GET',
    url: `/api/voices/${voiceId}`,
    headers: bearer(token),
  });
  expect(ready.statusCode).toBe(200);
  expect(ready.json().status).toBe('ready');

  // 再回拨到当前时间（elapsed 归零）：终态 ready 不应回退
  await backdateVoice(voiceId, 0);
  const again = await app.inject({
    method: 'GET',
    url: `/api/voices/${voiceId}`,
    headers: bearer(token),
  });
  expect(again.statusCode).toBe(200);
  expect(again.json().status).toBe('ready');
  expect(again.json().providerVoiceId).toBe(providerVoiceId);
});
