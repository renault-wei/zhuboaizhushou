import { afterAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { pool } from '../src/db/client';

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

// 各场景固定手机号（互不共用，避免短信重发限制与历史数据串扰）
const PHONE_CRUD = '13920000001';
const PHONE_TAMPER = '13920000002';
const PHONE_VOICE_OWNER = '13920000003';
const PHONE_CROSS_USER = '13920000004';
const PHONE_SCRIPT_OWNER = '13920000005';
const PHONE_ISOLATION_A = '13920000006';
const PHONE_ISOLATION_B = '13920000007';
const PHONE_DELETE_LIVE = '13920000008';
const PHONE_FILTER = '13920000009';
const PHONE_TITLE = '13920000010';
const PHONE_NO_FIELDS = '13920000011';

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

/** 复位：清空该用户的 lives / voices / scripts / 协议记录，保证用例互不影响 */
async function resetUserData(phone: string): Promise<void> {
  const userId = await userIdOf(phone);
  await pool.query('DELETE FROM lives WHERE user_id = $1', [userId]);
  await pool.query('DELETE FROM scripts WHERE user_id = $1', [userId]);
  await pool.query('DELETE FROM voices WHERE user_id = $1', [userId]);
  await pool.query('DELETE FROM voice_agreements WHERE user_id = $1', [userId]);
}

function bearer(token: string): { authorization: string } {
  return { authorization: `Bearer ${token}` };
}

/** 直接给某用户种一条归属其名下的 ready 音色（绕过克隆流程，仅作 lives 引用校验用） */
async function seedOwnedVoice(phone: string, name = '测试音色'): Promise<string> {
  const userId = await userIdOf(phone);
  const id = randomUUID();
  await pool.query(
    `INSERT INTO voices (id, user_id, name, provider, provider_voice_id, status, sample_duration_seconds)
     VALUES ($1, $2, $3, 'cosyvoice', $4, 'ready', 180)`,
    [id, userId, name, `cosy-live-test-${id}`],
  );
  return id;
}

/** 直接给某用户种一条归属其名下的 ready 话术（绕过 DeepSeek 调用，绝不在测试中真实调用第三方） */
async function seedOwnedScript(phone: string, title = '火锅店话术'): Promise<string> {
  const userId = await userIdOf(phone);
  const id = randomUUID();
  await pool.query(
    `INSERT INTO scripts
       (id, user_id, industry, title, product_snapshot, content, status, sensitive_check_status,
        sensitive_matched_words, sensitive_scanned_at)
     VALUES ($1, $2, 'restaurant', $3, '{"name":"测试商品"}'::jsonb, $4, 'ready', 'pass',
        '[]'::jsonb, now())`,
    [id, userId, title, '干净的话术内容。'],
  );
  return id;
}

/** 用一个已登录 token 创建一条开播配置草稿（断言 201），返回 live.id */
async function createLiveDraft(token: string, overrides: Record<string, unknown> = {}) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/lives',
    headers: bearer(token),
    payload: { title: '火锅店午市循环直播', ...overrides },
  });
  expect(res.statusCode).toBe(201);
  const body = res.json() as { live: { id: string } };
  return body.live.id;
}

// ---------- 未登录 401 ----------

describe('开播配置接口鉴权', () => {
  it('未带 token 访问五个接口均返回 401', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/api/lives',
      payload: { title: '未登录创建' },
    });
    expect(create.statusCode).toBe(401);
    expect(create.json()).toMatchObject({ error: 'UNAUTHORIZED' });

    const list = await app.inject({ method: 'GET', url: '/api/lives' });
    expect(list.statusCode).toBe(401);

    const single = await app.inject({ method: 'GET', url: `/api/lives/${randomUUID()}` });
    expect(single.statusCode).toBe(401);

    const patch = await app.inject({
      method: 'PATCH',
      url: `/api/lives/${randomUUID()}`,
      payload: { title: '改标题' },
    });
    expect(patch.statusCode).toBe(401);

    const remove = await app.inject({
      method: 'DELETE',
      url: `/api/lives/${randomUUID()}`,
      payload: {},
    });
    expect(remove.statusCode).toBe(401);
  });
});

// ---------- 标题校验 ----------

dbIt('标题为空 / 纯空白返回 400 LIVE_TITLE_INVALID', async () => {
  const token = await registerAndGetToken(PHONE_TITLE);
  await resetUserData(PHONE_TITLE);

  const empty = await app.inject({
    method: 'POST',
    url: '/api/lives',
    headers: bearer(token),
    payload: { title: '' },
  });
  expect(empty.statusCode).toBe(400);
  expect(empty.json()).toMatchObject({ error: 'LIVE_TITLE_INVALID' });

  const blank = await app.inject({
    method: 'POST',
    url: '/api/lives',
    headers: bearer(token),
    payload: { title: '   ' },
  });
  expect(blank.statusCode).toBe(400);
  expect(blank.json()).toMatchObject({ error: 'LIVE_TITLE_INVALID' });

  // 标题缺失也按空串处理，同样返回 400
  const missing = await app.inject({
    method: 'POST',
    url: '/api/lives',
    headers: bearer(token),
    payload: {},
  });
  expect(missing.statusCode).toBe(400);
  expect(missing.json()).toMatchObject({ error: 'LIVE_TITLE_INVALID' });
});

dbIt('标题超过 100 字返回 400 LIVE_TITLE_INVALID', async () => {
  const token = await registerAndGetToken(PHONE_TITLE);
  await resetUserData(PHONE_TITLE);

  const res = await app.inject({
    method: 'POST',
    url: '/api/lives',
    headers: bearer(token),
    payload: { title: '甲'.repeat(101) },
  });
  expect(res.statusCode).toBe(400);
  expect(res.json()).toMatchObject({ error: 'LIVE_TITLE_INVALID' });
});

// ---------- 引用归属校验（音色 / 话术跨用户）----------

dbIt('引用他人音色创建 live 返回 400 VOICE_NOT_OWNED', async () => {
  await registerAndGetToken(PHONE_VOICE_OWNER);
  await resetUserData(PHONE_VOICE_OWNER);
  const voiceId = await seedOwnedVoice(PHONE_VOICE_OWNER, '他人音色');

  const tokenOther = await registerAndGetToken(PHONE_CROSS_USER);
  await resetUserData(PHONE_CROSS_USER);
  const res = await app.inject({
    method: 'POST',
    url: '/api/lives',
    headers: bearer(tokenOther),
    payload: { title: '借用音色', voiceId },
  });
  expect(res.statusCode).toBe(400);
  expect(res.json()).toMatchObject({ error: 'VOICE_NOT_OWNED' });
});

dbIt('引用他人话术创建 live 返回 400 SCRIPT_NOT_OWNED', async () => {
  await registerAndGetToken(PHONE_SCRIPT_OWNER);
  await resetUserData(PHONE_SCRIPT_OWNER);
  const scriptId = await seedOwnedScript(PHONE_SCRIPT_OWNER, '他人话术');

  const tokenOther = await registerAndGetToken(PHONE_CROSS_USER);
  await resetUserData(PHONE_CROSS_USER);
  const res = await app.inject({
    method: 'POST',
    url: '/api/lives',
    headers: bearer(tokenOther),
    payload: { title: '借用话术', scriptId },
  });
  expect(res.statusCode).toBe(400);
  expect(res.json()).toMatchObject({ error: 'SCRIPT_NOT_OWNED' });
});

dbIt('更新时引用他人音色返回 400 VOICE_NOT_OWNED', async () => {
  await registerAndGetToken(PHONE_VOICE_OWNER);
  await resetUserData(PHONE_VOICE_OWNER);
  const voiceId = await seedOwnedVoice(PHONE_VOICE_OWNER);

  const tokenOther = await registerAndGetToken(PHONE_CROSS_USER);
  await resetUserData(PHONE_CROSS_USER);
  const liveId = await createLiveDraft(tokenOther, { title: '本人草稿' });
  const res = await app.inject({
    method: 'PATCH',
    url: `/api/lives/${liveId}`,
    headers: bearer(tokenOther),
    payload: { voiceId },
  });
  expect(res.statusCode).toBe(400);
  expect(res.json()).toMatchObject({ error: 'VOICE_NOT_OWNED' });
});

// ---------- CRUD 完整流程 ----------

dbIt('CRUD 完整流程：create → get → list → patch → delete → get 404', async () => {
  const token = await registerAndGetToken(PHONE_CRUD);
  await resetUserData(PHONE_CRUD);
  const voiceId = await seedOwnedVoice(PHONE_CRUD, '我的音色');
  const scriptId = await seedOwnedScript(PHONE_CRUD, '我的话术');

  // create：标题自动 trim，videoSourceUrl 默认空串，状态 idle，角标 true
  const created = await app.inject({
    method: 'POST',
    url: '/api/lives',
    headers: bearer(token),
    payload: {
      title: '  火锅店午市循环直播  ',
      voiceId,
      scriptId,
      couponId: 'coupon-1234abcd',
    },
  });
  expect(created.statusCode).toBe(201);
  const createdLive = created.json().live as Record<string, unknown>;
  expect(createdLive.title).toBe('火锅店午市循环直播');
  expect(createdLive.voiceId).toBe(voiceId);
  expect(createdLive.scriptId).toBe(scriptId);
  expect(createdLive.couponId).toBe('coupon-1234abcd');
  expect(createdLive.videoSourceUrl).toBe('');
  expect(createdLive.status).toBe('idle');
  expect(createdLive.aiBadgeShown).toBe(true);
  const liveId = createdLive.id as string;

  // get：返回与创建一致
  const got = await app.inject({
    method: 'GET',
    url: `/api/lives/${liveId}`,
    headers: bearer(token),
  });
  expect(got.statusCode).toBe(200);
  expect(got.json()).toMatchObject({
    id: liveId,
    title: '火锅店午市循环直播',
    status: 'idle',
    aiBadgeShown: true,
  });

  // list：包含这条
  const list = await app.inject({ method: 'GET', url: '/api/lives', headers: bearer(token) });
  expect(list.statusCode).toBe(200);
  const rows = list.json() as Array<{ id: string }>;
  expect(rows.map((row) => row.id)).toContain(liveId);

  // patch：改标题
  const patched = await app.inject({
    method: 'PATCH',
    url: `/api/lives/${liveId}`,
    headers: bearer(token),
    payload: { title: '改名后的直播标题' },
  });
  expect(patched.statusCode).toBe(200);
  const patchedLive = patched.json().live as Record<string, unknown>;
  expect(patchedLive.title).toBe('改名后的直播标题');
  expect(patchedLive.id).toBe(liveId);

  // patch：引用不存在的音色 → 400 VOICE_NOT_OWNED，且原数据不变
  const badPatch = await app.inject({
    method: 'PATCH',
    url: `/api/lives/${liveId}`,
    headers: bearer(token),
    payload: { voiceId: randomUUID() },
  });
  expect(badPatch.statusCode).toBe(400);
  expect(badPatch.json()).toMatchObject({ error: 'VOICE_NOT_OWNED' });

  // delete → ok:true
  const removed = await app.inject({
    method: 'DELETE',
    url: `/api/lives/${liveId}`,
    headers: bearer(token),
  });
  expect(removed.statusCode).toBe(200);
  expect(removed.json()).toEqual({ ok: true });

  // 删除后再查 / 再删均为 404
  const afterGet = await app.inject({
    method: 'GET',
    url: `/api/lives/${liveId}`,
    headers: bearer(token),
  });
  expect(afterGet.statusCode).toBe(404);
  expect(afterGet.json()).toMatchObject({ error: 'LIVE_NOT_FOUND' });

  const afterDelete = await app.inject({
    method: 'DELETE',
    url: `/api/lives/${liveId}`,
    headers: bearer(token),
  });
  expect(afterDelete.statusCode).toBe(404);
  expect(afterDelete.json()).toMatchObject({ error: 'LIVE_NOT_FOUND' });
});

// ---------- 归属隔离 ----------

dbIt('他人不能 GET / PATCH / DELETE 我的 live（统一 404 LIVE_NOT_FOUND）', async () => {
  const tokenOwner = await registerAndGetToken(PHONE_ISOLATION_A);
  await resetUserData(PHONE_ISOLATION_A);
  const liveId = await createLiveDraft(tokenOwner, { title: 'A 的直播草稿' });

  const tokenOther = await registerAndGetToken(PHONE_ISOLATION_B);
  await resetUserData(PHONE_ISOLATION_B);
  const otherGet = await app.inject({
    method: 'GET',
    url: `/api/lives/${liveId}`,
    headers: bearer(tokenOther),
  });
  expect(otherGet.statusCode).toBe(404);
  expect(otherGet.json()).toMatchObject({ error: 'LIVE_NOT_FOUND' });

  const otherPatch = await app.inject({
    method: 'PATCH',
    url: `/api/lives/${liveId}`,
    headers: bearer(tokenOther),
    payload: { title: '篡改标题' },
  });
  expect(otherPatch.statusCode).toBe(404);

  const otherDelete = await app.inject({
    method: 'DELETE',
    url: `/api/lives/${liveId}`,
    headers: bearer(tokenOther),
  });
  expect(otherDelete.statusCode).toBe(404);

  // 他人操作失败不影响 A 的草稿
  const stillMine = await app.inject({
    method: 'GET',
    url: `/api/lives/${liveId}`,
    headers: bearer(tokenOwner),
  });
  expect(stillMine.statusCode).toBe(200);
  expect(stillMine.json().title).toBe('A 的直播草稿');
});

// ---------- 删除保护（进行中不可删）----------

dbIt('status=live 的 live 删除返回 409；置回 ended 后可删除', async () => {
  const token = await registerAndGetToken(PHONE_DELETE_LIVE);
  await resetUserData(PHONE_DELETE_LIVE);
  const liveId = await createLiveDraft(token);

  // 手动构造 status=live（T10 无开播路由，仅测试删除保护）
  await pool.query(`UPDATE lives SET status = 'live' WHERE id = $1`, [liveId]);
  const blocked = await app.inject({
    method: 'DELETE',
    url: `/api/lives/${liveId}`,
    headers: bearer(token),
  });
  expect(blocked.statusCode).toBe(409);
  expect(blocked.json()).toMatchObject({ error: 'LIVE_IN_PROGRESS' });

  // 409 后记录仍存在（未被误删）
  const stillThere = await app.inject({
    method: 'GET',
    url: `/api/lives/${liveId}`,
    headers: bearer(token),
  });
  expect(stillThere.statusCode).toBe(200);

  // 手动置回 ended（直播结束后允许删除归档）
  await pool.query(`UPDATE lives SET status = 'ended' WHERE id = $1`, [liveId]);
  const removed = await app.inject({
    method: 'DELETE',
    url: `/api/lives/${liveId}`,
    headers: bearer(token),
  });
  expect(removed.statusCode).toBe(200);
  expect(removed.json()).toEqual({ ok: true });
});

// ---------- 合规：角标不可篡改 ----------

dbIt('POST/PATCH 传 aiBadgeShown=false、status=live 等一律忽略，角标恒为 true', async () => {
  const token = await registerAndGetToken(PHONE_TAMPER);
  await resetUserData(PHONE_TAMPER);

  // POST 尝试关角标 / 伪造成直播中
  const created = await app.inject({
    method: 'POST',
    url: '/api/lives',
    headers: bearer(token),
    payload: {
      title: '合规角标测试',
      aiBadgeShown: false,
      status: 'live',
      rtmpUrl: 'rtmp://fake',
      videoSourceUrl: 'http://fake-video/1.mp4',
    },
  });
  expect(created.statusCode).toBe(201);
  const createdLive = created.json().live as Record<string, unknown>;
  expect(createdLive.aiBadgeShown).toBe(true);
  expect(createdLive.status).toBe('idle');
  // 非白名单字段 rtmpUrl 不入库；合法字段 videoSourceUrl 正常保存
  expect(createdLive.rtmpUrl).toBeNull();
  expect(createdLive.videoSourceUrl).toBe('http://fake-video/1.mp4');
  const liveId = createdLive.id as string;

  // PATCH 同样忽略 status / aiBadgeShown 覆盖
  const patched = await app.inject({
    method: 'PATCH',
    url: `/api/lives/${liveId}`,
    headers: bearer(token),
    payload: {
      title: '改名后仍带角标',
      aiBadgeShown: false,
      status: 'live',
    },
  });
  expect(patched.statusCode).toBe(200);
  const patchedLive = patched.json().live as Record<string, unknown>;
  expect(patchedLive.title).toBe('改名后仍带角标');
  expect(patchedLive.aiBadgeShown).toBe(true);
  expect(patchedLive.status).toBe('idle');
});

dbIt('PATCH body 只含非法字段（仅 aiBadgeShown）时返回 400，而非 500', async () => {
  const token = await registerAndGetToken(PHONE_NO_FIELDS);
  await resetUserData(PHONE_NO_FIELDS);
  const liveId = await createLiveDraft(token);

  // 只传 aiBadgeShown（白名单外字段）：所有字段被忽略，changes 为空 → 应 400 LIVE_NO_FIELDS_TO_UPDATE
  const patched = await app.inject({
    method: 'PATCH',
    url: `/api/lives/${liveId}`,
    headers: bearer(token),
    payload: { aiBadgeShown: false },
  });
  expect(patched.statusCode).toBe(400);
  expect(patched.json()).toMatchObject({ error: 'LIVE_NO_FIELDS_TO_UPDATE' });
});

// ---------- 列表过滤 ----------

dbIt('GET /api/lives 默认返回全部，?status=idle 只返回草稿；非法状态返回 400', async () => {
  const token = await registerAndGetToken(PHONE_FILTER);
  await resetUserData(PHONE_FILTER);
  const firstId = await createLiveDraft(token, { title: '草稿一' });
  const secondId = await createLiveDraft(token, { title: '草稿二' });
  await pool.query(`UPDATE lives SET status = 'ended' WHERE id = $1`, [secondId]);

  const all = await app.inject({ method: 'GET', url: '/api/lives', headers: bearer(token) });
  expect(all.statusCode).toBe(200);
  const allRows = all.json() as Array<{ id: string }>;
  expect(allRows.map((row) => row.id).sort()).toEqual([firstId, secondId].sort());

  const idle = await app.inject({
    method: 'GET',
    url: '/api/lives?status=idle',
    headers: bearer(token),
  });
  expect(idle.statusCode).toBe(200);
  const idleRows = idle.json() as Array<{ id: string }>;
  expect(idleRows).toHaveLength(1);
  expect(idleRows[0]?.id).toBe(firstId);

  const badStatus = await app.inject({
    method: 'GET',
    url: '/api/lives?status=bogus',
    headers: bearer(token),
  });
  expect(badStatus.statusCode).toBe(400);
  expect(badStatus.json()).toMatchObject({ error: 'STATUS_INVALID' });
});
