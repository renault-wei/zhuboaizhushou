import { afterAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { pool } from '../src/db/client';

/**
 * 《声音授权协议》签署接口集成测试（fastify.inject，纯本地，不调用任何第三方）：
 * - 401 用例只依赖 JWT 插件，不依赖数据库；
 * - 正文/状态/签署用例落在 users 与 voice_agreements 表，数据库不可用时整体跳过。
 */

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

/** 各场景固定手机号（复用已有用户；每个用例先清空该用户签署记录复位） */
const PHONE_UNSIGNED = '13700000001';
const PHONE_SIGN = '13700000002';
const PHONE_IDEMPOTENT = '13700000003';
const PHONE_NOT_AGREED = '13700000004';
const PHONE_VERSION = '13700000005';

const SIGNED_UA = 'agreement-integration-test/1.0';

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

/** 复位：清空该用户历史签署记录，避免重复运行影响幂等/计数断言 */
async function resetAgreements(phone: string): Promise<void> {
  await pool.query('DELETE FROM voice_agreements WHERE user_id = $1', [await userIdOf(phone)]);
}

async function agreementRowCount(phone: string): Promise<number> {
  const res = await pool.query('SELECT count(*)::int AS count FROM voice_agreements WHERE user_id = $1', [
    await userIdOf(phone),
  ]);
  const row = res.rows[0] as { count: number };
  return row.count;
}

function bearer(token: string): { authorization: string } {
  return { authorization: `Bearer ${token}` };
}

// ---------- 未登录 401 ----------

describe('协议接口鉴权', () => {
  it('未带 token 访问三个协议接口均返回 401', async () => {
    const text = await app.inject({ method: 'GET', url: '/api/agreements/voice' });
    expect(text.statusCode).toBe(401);

    const status = await app.inject({ method: 'GET', url: '/api/agreements/voice/status' });
    expect(status.statusCode).toBe(401);

    const sign = await app.inject({
      method: 'POST',
      url: '/api/agreements/voice/sign',
      payload: { version: '1.0', agreed: true },
    });
    expect(sign.statusCode).toBe(401);
  });

  it('非法 token 访问返回 401', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/agreements/voice/status',
      headers: { authorization: 'Bearer not-a-valid-jwt' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: 'UNAUTHORIZED' });
  });
});

// ---------- 获取协议正文 ----------

dbIt('获取协议正文返回版本/标题/正文，且覆盖关键合规条款', async () => {
  const token = await registerAndGetToken(PHONE_UNSIGNED);
  const res = await app.inject({
    method: 'GET',
    url: '/api/agreements/voice',
    headers: bearer(token),
  });
  expect(res.statusCode).toBe(200);
  const body = res.json();
  expect(body).toMatchObject({
    version: '1.0',
    title: '声音授权协议',
    content: expect.any(String),
  });
  // 约 500-800 字的中文正文（此处放宽阈值防微调误伤）
  expect(body.content.length).toBeGreaterThan(400);
  expect(body.content.length).toBeLessThan(1000);
  // 关键合规条款均须覆盖
  expect(body.content).toContain('授权');
  expect(body.content).toContain('知情');
  expect(body.content).toContain('删除');
  expect(body.content).toContain('转授权');
  expect(body.content).toContain('未成年');
  expect(body.content).toContain('销毁');
});

// ---------- 未签署状态 ----------

dbIt('未签署时 status 返回 signed:false', async () => {
  const token = await registerAndGetToken(PHONE_UNSIGNED);
  await resetAgreements(PHONE_UNSIGNED);

  const res = await app.inject({
    method: 'GET',
    url: '/api/agreements/voice/status',
    headers: bearer(token),
  });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ signed: false });
});

// ---------- 签署成功 + 存档 ----------

dbIt('签署成功返回签署状态，落库一条含全文快照/IP/UA，status 同步更新', async () => {
  const token = await registerAndGetToken(PHONE_SIGN);
  await resetAgreements(PHONE_SIGN);

  const textRes = await app.inject({
    method: 'GET',
    url: '/api/agreements/voice',
    headers: bearer(token),
  });
  const content = textRes.json().content as string;

  const sign = await app.inject({
    method: 'POST',
    url: '/api/agreements/voice/sign',
    headers: { ...bearer(token), 'user-agent': SIGNED_UA },
    payload: { version: '1.0', agreed: true },
  });
  expect(sign.statusCode).toBe(200);
  const body = sign.json();
  expect(body).toMatchObject({ signed: true, version: '1.0' });
  expect(body.signedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

  // 数据库存档：仅一条记录，快照与正文一致，IP/UA 均落库
  const rows = await pool.query(
    'SELECT agreement_version, content_snapshot, signed_ip, user_agent FROM voice_agreements WHERE user_id = $1',
    [await userIdOf(PHONE_SIGN)],
  );
  expect(rows.rowCount).toBe(1);
  const row = rows.rows[0] as {
    agreement_version: string;
    content_snapshot: string;
    signed_ip: string;
    user_agent: string;
  };
  expect(row.agreement_version).toBe('1.0');
  expect(row.content_snapshot).toBe(content);
  expect(row.signed_ip.length).toBeGreaterThan(0);
  expect(row.user_agent).toBe(SIGNED_UA);

  // status 同步为已签署
  const status = await app.inject({
    method: 'GET',
    url: '/api/agreements/voice/status',
    headers: bearer(token),
  });
  expect(status.json()).toEqual(body);
});

// ---------- 重复签署幂等 ----------

dbIt('同版本重复签署幂等返回 200，数据库仍只有一条', async () => {
  const token = await registerAndGetToken(PHONE_IDEMPOTENT);
  await resetAgreements(PHONE_IDEMPOTENT);

  const first = await app.inject({
    method: 'POST',
    url: '/api/agreements/voice/sign',
    headers: bearer(token),
    payload: { version: '1.0', agreed: true },
  });
  expect(first.statusCode).toBe(200);

  const second = await app.inject({
    method: 'POST',
    url: '/api/agreements/voice/sign',
    headers: bearer(token),
    payload: { version: '1.0', agreed: true },
  });
  expect(second.statusCode).toBe(200);
  // 幂等：不重复插入，返回与首次一致（含相同 signedAt）
  expect(second.json()).toEqual(first.json());
  expect(await agreementRowCount(PHONE_IDEMPOTENT)).toBe(1);
});

// ---------- 未勾选同意 400 ----------

dbIt('agreed 不为 true 返回 400 NOT_AGREED 且不落库', async () => {
  const token = await registerAndGetToken(PHONE_NOT_AGREED);
  await resetAgreements(PHONE_NOT_AGREED);

  const notAgreed = await app.inject({
    method: 'POST',
    url: '/api/agreements/voice/sign',
    headers: bearer(token),
    payload: { version: '1.0', agreed: false },
  });
  expect(notAgreed.statusCode).toBe(400);
  expect(notAgreed.json()).toMatchObject({ error: 'NOT_AGREED' });

  // 缺 agreed 字段等同未同意
  const missingAgreed = await app.inject({
    method: 'POST',
    url: '/api/agreements/voice/sign',
    headers: bearer(token),
    payload: { version: '1.0' },
  });
  expect(missingAgreed.statusCode).toBe(400);
  expect(missingAgreed.json()).toMatchObject({ error: 'NOT_AGREED' });
  expect(await agreementRowCount(PHONE_NOT_AGREED)).toBe(0);
});

// ---------- 版本不匹配 400 ----------

dbIt('version 与最新版不一致返回 400 VERSION_MISMATCH 且不落库', async () => {
  const token = await registerAndGetToken(PHONE_VERSION);
  await resetAgreements(PHONE_VERSION);

  const oldVersion = await app.inject({
    method: 'POST',
    url: '/api/agreements/voice/sign',
    headers: bearer(token),
    payload: { version: '0.9', agreed: true },
  });
  expect(oldVersion.statusCode).toBe(400);
  expect(oldVersion.json()).toMatchObject({ error: 'VERSION_MISMATCH' });

  // 空对象等同版本缺失，同样返回版本不匹配
  const emptyBody = await app.inject({
    method: 'POST',
    url: '/api/agreements/voice/sign',
    headers: bearer(token),
    payload: {},
  });
  expect(emptyBody.statusCode).toBe(400);
  expect(emptyBody.json()).toMatchObject({ error: 'VERSION_MISMATCH' });
  expect(await agreementRowCount(PHONE_VERSION)).toBe(0);
});
