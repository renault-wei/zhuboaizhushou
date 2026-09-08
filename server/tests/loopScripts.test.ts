import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { pool } from '../src/db/client';
import { SENSITIVE_GUARD_PROMPT } from '../src/services/sensitive';

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

// 各场景固定手机号（13930000xxx 段为本文件独享，避免跨文件串扰）
const PHONE_CREATE = '13930000001';
const PHONE_BLOCKED = '13930000002';
const PHONE_ITEM_INVALID = '13930000003';
const PHONE_LIST_A = '13930000005';
const PHONE_LIST_B = '13930000006';
const PHONE_DETAIL_OWNER = '13930000007';
const PHONE_DETAIL_OTHER = '13930000008';
const PHONE_REPLACE = '13930000009';
const PHONE_DELETE = '13930000010';
const PHONE_GEN_OK = '13930000011';
const PHONE_GEN_COUNT = '13930000012';
const PHONE_GEN_REWRITE = '13930000013';
const PHONE_GEN_FAIL = '13930000014';
const PHONE_GEN_ERROR = '13930000015';
const PHONE_GEN_NOT_READY = '13930000017';
const PHONE_SOURCE_OTHER = '13930000018';

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

/** 复位：清空该用户的 lives / 循环台本 / 话术记录，保证用例之间互不影响 */
async function resetUserData(phone: string): Promise<void> {
  const userId = await userIdOf(phone);
  await pool.query('DELETE FROM loop_scripts WHERE user_id = $1', [userId]);
  await pool.query('DELETE FROM lives WHERE user_id = $1', [userId]);
  await pool.query('DELETE FROM scripts WHERE user_id = $1', [userId]);
}

function bearer(token: string): { authorization: string } {
  return { authorization: `Bearer ${token}` };
}

/** 构造符合 DeepSeek chat/completions 响应结构的 fake Response */
function fakeDeepSeekResponse(content: string, status = 200): Response {
  return new Response(
    JSON.stringify({
      choices: [{ message: { role: 'assistant', content } }],
    }),
    { status, headers: { 'content-type': 'application/json' } },
  );
}

/** 干净的台本 JSON（默认 6 条，均可安全过审） */
function cleanLoopJson(count = 6): string {
  const items = Array.from({ length: count }, (_, index) => {
    const kinds = ['opening', 'product', 'coupon', 'warmup', 'closing', 'custom'];
    return JSON.stringify({
      kind: kinds[index % kinds.length],
      text: `欢迎光临本店，第 ${index + 1} 句介绍我们的招牌套餐，欢迎到店品尝。`,
      gapAfterSeconds: index === 0 ? 5 : undefined,
    });
  });
  return `[${items.join(',')}]`;
}

/** 直接给某用户种一条归属其名下的 ready 话术（绕过 DeepSeek 调用，绝不在测试中真实调用第三方） */
async function seedOwnedScript(
  phone: string,
  overrides: { title?: string; content?: string; status?: string; sensitiveCheckStatus?: string } = {},
): Promise<string> {
  const userId = await userIdOf(phone);
  const id = randomUUID();
  await pool.query(
    `INSERT INTO scripts
       (id, user_id, industry, title, product_snapshot, content, status, sensitive_check_status,
        sensitive_matched_words, sensitive_scanned_at)
     VALUES ($1, $2, 'restaurant', $3, '{"name":"测试商品"}'::jsonb, $4, $5, $6,
        '[]'::jsonb, now())`,
    [
      id,
      userId,
      overrides.title ?? '火锅店循环话术',
      overrides.content ?? '锅底现炒、毛肚脆嫩，双人套餐只要 99 元，欢迎到店品尝。',
      overrides.status ?? 'ready',
      overrides.sensitiveCheckStatus ?? 'pass',
    ],
  );
  return id;
}

beforeEach(() => {
  // 每个用例默认 mock 掉网络：测试绝不真实调用 DeepSeek（花钱 + 不稳定）
  vi.spyOn(globalThis, 'fetch');
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------- 未登录 401 ----------

describe('循环台本接口鉴权', () => {
  it('未带 token 访问六个接口均返回 401', async () => {
    const generate = await app.inject({
      method: 'POST',
      url: '/api/loop-scripts/generate',
      payload: { sourceScriptId: randomUUID() },
    });
    expect(generate.statusCode).toBe(401);
    expect(generate.json()).toMatchObject({ error: 'UNAUTHORIZED' });

    const list = await app.inject({ method: 'GET', url: '/api/loop-scripts' });
    expect(list.statusCode).toBe(401);

    const single = await app.inject({ method: 'GET', url: `/api/loop-scripts/${randomUUID()}` });
    expect(single.statusCode).toBe(401);

    const create = await app.inject({
      method: 'POST',
      url: '/api/loop-scripts',
      payload: { title: '未登录台本', items: [] },
    });
    expect(create.statusCode).toBe(401);

    const edit = await app.inject({
      method: 'PUT',
      url: `/api/loop-scripts/${randomUUID()}`,
      payload: { title: '编辑标题', items: [] },
    });
    expect(edit.statusCode).toBe(401);

    const remove = await app.inject({ method: 'DELETE', url: `/api/loop-scripts/${randomUUID()}` });
    expect(remove.statusCode).toBe(401);
  });
});

// ---------- 新建 / 参数校验（不触发 DeepSeek 调用）----------

dbIt('新建台本成功：kind/间隔归一化、sourceScriptId 归属校验后落库', async () => {
  const token = await registerAndGetToken(PHONE_CREATE);
  await resetUserData(PHONE_CREATE);
  const sourceScriptId = await seedOwnedScript(PHONE_CREATE, { title: '来源话术' });

  const res = await app.inject({
    method: 'POST',
    url: '/api/loop-scripts',
    headers: bearer(token),
    payload: {
      title: '  午市循环台本  ',
      sourceScriptId,
      items: [
        { kind: 'opening', text: '欢迎光临，今天是午市特惠，欢迎到店。', gapAfterSeconds: 5 },
        // 未知 kind → null；非法间隔 61 / -1 / 2.5 → null
        { kind: 'weird', text: '介绍招牌毛肚，脆嫩现切。', gapAfterSeconds: 61 },
        { kind: 'closing', text: '感谢观看，欢迎下次再来。', gapAfterSeconds: -1 },
      ],
    },
  });
  expect(res.statusCode).toBe(201);
  const created = res.json();
  expect(created.title).toBe('午市循环台本');
  expect(created.sourceScriptId).toBe(sourceScriptId);
  expect(created.items).toHaveLength(3);
  expect(created.items[0]).toMatchObject({
    seq: 1,
    kind: 'opening',
    text: '欢迎光临，今天是午市特惠，欢迎到店。',
    gapAfterSeconds: 5,
  });
  // 未知 kind 与非法间隔按口径归一化为 null
  expect(created.items[1]?.kind).toBeNull();
  expect(created.items[1]?.gapAfterSeconds).toBeNull();
  expect(created.items[2]?.kind).toBe('closing');
  expect(vi.mocked(fetch)).not.toHaveBeenCalled();
});

dbIt('新建/替换含敏感词的台本返回 400 SENSITIVE_BLOCKED，且不落库', async () => {
  const token = await registerAndGetToken(PHONE_BLOCKED);
  await resetUserData(PHONE_BLOCKED);

  const dirty = await app.inject({
    method: 'POST',
    url: '/api/loop-scripts',
    headers: bearer(token),
    payload: {
      title: '含违禁词台本',
      items: [{ kind: 'product', text: '这是顶级食材，本店最优惠。', gapAfterSeconds: null }],
    },
  });
  expect(dirty.statusCode).toBe(400);
  const blocked = dirty.json();
  expect(blocked.error).toBe('SENSITIVE_BLOCKED');
  expect(blocked.matchedWords).toContain('顶级');
  expect(blocked.matchedWords).toContain('最优惠');

  const list = await app.inject({ method: 'GET', url: '/api/loop-scripts', headers: bearer(token) });
  expect(list.statusCode).toBe(200);
  expect(list.json()).toEqual([]);
});

dbIt('条目数/单条字数/空文本/标题非法返回对应 400，且不触发 AI', async () => {
  const token = await registerAndGetToken(PHONE_ITEM_INVALID);
  await resetUserData(PHONE_ITEM_INVALID);

  // 空数组
  const empty = await app.inject({
    method: 'POST',
    url: '/api/loop-scripts',
    headers: bearer(token),
    payload: { title: '标题', items: [] },
  });
  expect(empty.statusCode).toBe(400);
  expect(empty.json()).toMatchObject({ error: 'ITEMS_INVALID' });

  // 超过 12 条
  const tooManyItems = Array.from({ length: 13 }, (_, index) => ({
    kind: 'custom' as const,
    text: `第 ${index + 1} 句干净台词。`,
    gapAfterSeconds: null,
  }));
  const tooMany = await app.inject({
    method: 'POST',
    url: '/api/loop-scripts',
    headers: bearer(token),
    payload: { title: '标题', items: tooManyItems },
  });
  expect(tooMany.statusCode).toBe(400);
  expect(tooMany.json()).toMatchObject({ error: 'ITEMS_INVALID' });

  // 单条空文本
  const noText = await app.inject({
    method: 'POST',
    url: '/api/loop-scripts',
    headers: bearer(token),
    payload: { title: '标题', items: [{ kind: 'custom', text: '   ', gapAfterSeconds: null }] },
  });
  expect(noText.statusCode).toBe(400);
  expect(noText.json()).toMatchObject({ error: 'ITEM_TEXT_REQUIRED' });

  // 单条超过 200 字
  const longText = await app.inject({
    method: 'POST',
    url: '/api/loop-scripts',
    headers: bearer(token),
    payload: {
      title: '标题',
      items: [{ kind: 'custom', text: '字'.repeat(201), gapAfterSeconds: null }],
    },
  });
  expect(longText.statusCode).toBe(400);
  expect(longText.json()).toMatchObject({ error: 'ITEM_TEXT_TOO_LONG' });

  // 标题空 / 超长
  const badTitle = await app.inject({
    method: 'POST',
    url: '/api/loop-scripts',
    headers: bearer(token),
    payload: { title: '  ', items: [{ kind: 'custom', text: '干净台词。', gapAfterSeconds: null }] },
  });
  expect(badTitle.statusCode).toBe(400);
  expect(badTitle.json()).toMatchObject({ error: 'TITLE_INVALID' });
  expect(vi.mocked(fetch)).not.toHaveBeenCalled();
});

dbIt('引用他人来源话术新建台本返回 404 SCRIPT_NOT_FOUND', async () => {
  await registerAndGetToken(PHONE_SOURCE_OTHER);
  await resetUserData(PHONE_SOURCE_OTHER);
  const otherScriptId = await seedOwnedScript(PHONE_SOURCE_OTHER);

  const tokenOther = await registerAndGetToken(PHONE_DETAIL_OTHER);
  await resetUserData(PHONE_DETAIL_OTHER);
  const res = await app.inject({
    method: 'POST',
    url: '/api/loop-scripts',
    headers: bearer(tokenOther),
    payload: {
      title: '借用来源话术',
      sourceScriptId: otherScriptId,
      items: [{ kind: 'opening', text: '干净台词。', gapAfterSeconds: null }],
    },
  });
  expect(res.statusCode).toBe(404);
  expect(res.json()).toMatchObject({ error: 'SCRIPT_NOT_FOUND' });
});

// ---------- 列表 / 详情 / 替换 / 删除 ----------

dbIt('列表只返回本人台本且带条数摘要', async () => {
  const tokenA = await registerAndGetToken(PHONE_LIST_A);
  await resetUserData(PHONE_LIST_A);
  const first = await app.inject({
    method: 'POST',
    url: '/api/loop-scripts',
    headers: bearer(tokenA),
    payload: {
      title: 'A 的午市台本',
      items: [
        { kind: 'opening', text: '欢迎光临午市直播。', gapAfterSeconds: null },
        { kind: 'closing', text: '欢迎下次再来。', gapAfterSeconds: null },
      ],
    },
  });
  expect(first.statusCode).toBe(201);

  const second = await app.inject({
    method: 'POST',
    url: '/api/loop-scripts',
    headers: bearer(tokenA),
    payload: {
      title: 'A 的晚市台本',
      items: [{ kind: 'opening', text: '欢迎光临晚市直播。', gapAfterSeconds: 3 }],
    },
  });
  expect(second.statusCode).toBe(201);

  const tokenB = await registerAndGetToken(PHONE_LIST_B);
  await resetUserData(PHONE_LIST_B);
  const listB = await app.inject({ method: 'GET', url: '/api/loop-scripts', headers: bearer(tokenB) });
  expect(listB.statusCode).toBe(200);
  expect(listB.json()).toEqual([]);

  const listA = await app.inject({ method: 'GET', url: '/api/loop-scripts', headers: bearer(tokenA) });
  expect(listA.statusCode).toBe(200);
  const rows = listA.json() as Array<{ id: string; title: string; itemCount: number }>;
  expect(rows).toHaveLength(2);
  expect(rows.find((row) => row.title === 'A 的午市台本')?.itemCount).toBe(2);
  expect(rows.find((row) => row.title === 'A 的晚市台本')?.itemCount).toBe(1);
});

dbIt('详情归属校验：他人或不存在返回 404 LOOP_SCRIPT_NOT_FOUND', async () => {
  const tokenOwner = await registerAndGetToken(PHONE_DETAIL_OWNER);
  await resetUserData(PHONE_DETAIL_OWNER);
  const created = await app.inject({
    method: 'POST',
    url: '/api/loop-scripts',
    headers: bearer(tokenOwner),
    payload: {
      title: '归属校验台本',
      items: [
        { kind: 'opening', text: '欢迎光临，介绍本店招牌。', gapAfterSeconds: null },
        { kind: 'closing', text: '欢迎下次再来。', gapAfterSeconds: null },
      ],
    },
  });
  expect(created.statusCode).toBe(201);
  const loopScriptId = created.json().id as string;

  const missing = await app.inject({
    method: 'GET',
    url: `/api/loop-scripts/${randomUUID()}`,
    headers: bearer(tokenOwner),
  });
  expect(missing.statusCode).toBe(404);
  expect(missing.json()).toMatchObject({ error: 'LOOP_SCRIPT_NOT_FOUND' });

  const detail = await app.inject({
    method: 'GET',
    url: `/api/loop-scripts/${loopScriptId}`,
    headers: bearer(tokenOwner),
  });
  expect(detail.statusCode).toBe(200);
  const body = detail.json();
  expect(body.title).toBe('归属校验台本');
  expect(body.items).toHaveLength(2);
  expect(body.items.map((item: { seq: number }) => item.seq)).toEqual([1, 2]);

  const tokenOther = await registerAndGetToken(PHONE_DETAIL_OTHER);
  await resetUserData(PHONE_DETAIL_OTHER);
  const otherGet = await app.inject({
    method: 'GET',
    url: `/api/loop-scripts/${loopScriptId}`,
    headers: bearer(tokenOther),
  });
  expect(otherGet.statusCode).toBe(404);
});

dbIt('整体替换：换标题与条目重新扫描；他人台本不可替换', async () => {
  const tokenOwner = await registerAndGetToken(PHONE_REPLACE);
  await resetUserData(PHONE_REPLACE);
  const created = await app.inject({
    method: 'POST',
    url: '/api/loop-scripts',
    headers: bearer(tokenOwner),
    payload: {
      title: '待替换台本',
      items: [{ kind: 'opening', text: '旧的开场白，欢迎光临。', gapAfterSeconds: null }],
    },
  });
  expect(created.statusCode).toBe(201);
  const loopScriptId = created.json().id as string;

  const replaced = await app.inject({
    method: 'PUT',
    url: `/api/loop-scripts/${loopScriptId}`,
    headers: bearer(tokenOwner),
    payload: {
      title: '替换后的台本',
      items: [
        { kind: 'warmup', text: '新的暖场句，和大家聊聊天。', gapAfterSeconds: 8 },
        { kind: 'product', text: '介绍招牌双人套餐，分量很足。', gapAfterSeconds: null },
      ],
    },
  });
  expect(replaced.statusCode).toBe(200);
  const updated = replaced.json();
  expect(updated.title).toBe('替换后的台本');
  expect(updated.items).toHaveLength(2);
  expect(updated.items[0]).toMatchObject({ seq: 1, kind: 'warmup', gapAfterSeconds: 8 });

  // 替换成含违禁词 → blocked
  const dirty = await app.inject({
    method: 'PUT',
    url: `/api/loop-scripts/${loopScriptId}`,
    headers: bearer(tokenOwner),
    payload: {
      title: '仍用原标题',
      items: [{ kind: 'product', text: '全网最低价的套餐，快来抢。', gapAfterSeconds: null }],
    },
  });
  expect(dirty.statusCode).toBe(400);
  expect(dirty.json()).toMatchObject({ error: 'SENSITIVE_BLOCKED' });

  // 他人替换 → 404
  const tokenOther = await registerAndGetToken(PHONE_DETAIL_OTHER);
  await resetUserData(PHONE_DETAIL_OTHER);
  const otherPut = await app.inject({
    method: 'PUT',
    url: `/api/loop-scripts/${loopScriptId}`,
    headers: bearer(tokenOther),
    payload: { title: '篡改标题', items: [{ kind: 'opening', text: '篡改内容。', gapAfterSeconds: null }] },
  });
  expect(otherPut.statusCode).toBe(404);
  expect(otherPut.json()).toMatchObject({ error: 'LOOP_SCRIPT_NOT_FOUND' });
});

dbIt('删除台本：先解引场次再删除，绑定场次 loopScriptId 自动置空', async () => {
  const token = await registerAndGetToken(PHONE_DELETE);
  await resetUserData(PHONE_DELETE);
  const created = await app.inject({
    method: 'POST',
    url: '/api/loop-scripts',
    headers: bearer(token),
    payload: {
      title: '待删除台本',
      items: [{ kind: 'opening', text: '绑定后删除的台词。', gapAfterSeconds: null }],
    },
  });
  expect(created.statusCode).toBe(201);
  const loopScriptId = created.json().id as string;

  // 建一条绑定该台本的场次
  const live = await app.inject({
    method: 'POST',
    url: '/api/lives',
    headers: bearer(token),
    payload: { title: '绑定台本的直播', loopScriptId },
  });
  expect(live.statusCode).toBe(201);
  const liveId = live.json().live.id as string;

  const removed = await app.inject({
    method: 'DELETE',
    url: `/api/loop-scripts/${loopScriptId}`,
    headers: bearer(token),
  });
  expect(removed.statusCode).toBe(200);
  expect(removed.json()).toEqual({ ok: true });

  const afterDelete = await app.inject({
    method: 'GET',
    url: `/api/lives/${liveId}`,
    headers: bearer(token),
  });
  expect(afterDelete.statusCode).toBe(200);
  expect(afterDelete.json().loopScriptId).toBeNull();

  const missing = await app.inject({
    method: 'GET',
    url: `/api/loop-scripts/${loopScriptId}`,
    headers: bearer(token),
  });
  expect(missing.statusCode).toBe(404);
});

// ---------- 生成台本（M2 一次过审链路，DeepSeek 被 mock）----------

dbIt('生成要求指定来源话术：缺失 400、他人/不存在 404、非 ready+pass 422', async () => {
  const token = await registerAndGetToken(PHONE_GEN_NOT_READY);
  await resetUserData(PHONE_GEN_NOT_READY);

  const missing = await app.inject({
    method: 'POST',
    url: '/api/loop-scripts/generate',
    headers: bearer(token),
    payload: {},
  });
  expect(missing.statusCode).toBe(400);
  expect(missing.json()).toMatchObject({ error: 'SCRIPT_REQUIRED' });

  const notOwned = await app.inject({
    method: 'POST',
    url: '/api/loop-scripts/generate',
    headers: bearer(token),
    payload: { sourceScriptId: randomUUID() },
  });
  expect(notOwned.statusCode).toBe(404);
  expect(notOwned.json()).toMatchObject({ error: 'SCRIPT_NOT_FOUND' });

  // 未就绪（blocked）话术不能作为生成来源
  const blockedScriptId = await seedOwnedScript(PHONE_GEN_NOT_READY, {
    status: 'blocked',
    sensitiveCheckStatus: 'blocked',
  });
  const notReady = await app.inject({
    method: 'POST',
    url: '/api/loop-scripts/generate',
    headers: bearer(token),
    payload: { sourceScriptId: blockedScriptId },
  });
  expect(notReady.statusCode).toBe(422);
  expect(notReady.json()).toMatchObject({ error: 'SCRIPT_REQUIRED' });
  expect(vi.mocked(fetch)).not.toHaveBeenCalled();
});

dbIt('生成成功：默认 6 条、JSON 解析归一化、一次通过即返回', async () => {
  const token = await registerAndGetToken(PHONE_GEN_OK);
  await resetUserData(PHONE_GEN_OK);
  const sourceScriptId = await seedOwnedScript(PHONE_GEN_OK, { title: '生成来源' });
  vi.mocked(fetch).mockResolvedValue(fakeDeepSeekResponse(cleanLoopJson()));

  const res = await app.inject({
    method: 'POST',
    url: '/api/loop-scripts/generate',
    headers: bearer(token),
    payload: { sourceScriptId },
  });
  expect(res.statusCode).toBe(200);
  const body = res.json();
  expect(body.items).toHaveLength(6);
  expect(body.items[0]).toMatchObject({ kind: 'opening' });
  expect(body.generationNote).toBeUndefined();
  expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  const [url, init] = vi.mocked(fetch).mock.calls[0] ?? [];
  expect(String(url)).toMatch(/\/chat\/completions$/);
  const headers = init?.headers as Record<string, string> | undefined;
  expect(headers?.Authorization).toMatch(/^Bearer /);
});

dbIt('期望条目数：itemCount 生效且越界返回 400 ITEM_COUNT_INVALID', async () => {
  const token = await registerAndGetToken(PHONE_GEN_COUNT);
  await resetUserData(PHONE_GEN_COUNT);
  const sourceScriptId = await seedOwnedScript(PHONE_GEN_COUNT);
  vi.mocked(fetch).mockResolvedValue(fakeDeepSeekResponse(cleanLoopJson(3)));

  const ok = await app.inject({
    method: 'POST',
    url: '/api/loop-scripts/generate',
    headers: bearer(token),
    payload: { sourceScriptId, itemCount: 3 },
  });
  expect(ok.statusCode).toBe(200);
  expect(ok.json().items).toHaveLength(3);

  for (const itemCount of [0, 13, 1.5, 'abc']) {
    const invalid = await app.inject({
      method: 'POST',
      url: '/api/loop-scripts/generate',
      headers: bearer(token),
      payload: { sourceScriptId, itemCount },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({ error: 'ITEM_COUNT_INVALID' });
  }
  // 校验失败不触发 AI
  expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
});

dbIt('生成命中敏感词：自动改写一版通过 → 200 + generationNote', async () => {
  const token = await registerAndGetToken(PHONE_GEN_REWRITE);
  await resetUserData(PHONE_GEN_REWRITE);
  const sourceScriptId = await seedOwnedScript(PHONE_GEN_REWRITE);
  const dirtyJson = JSON.stringify([
    { kind: 'product', text: '本店最优惠的招牌套餐，欢迎到店。', gapAfterSeconds: 5 },
  ]);
  const cleanJson = JSON.stringify([
    { kind: 'product', text: '本店招牌套餐分量足，价格实在，欢迎到店。', gapAfterSeconds: 5 },
  ]);
  vi.mocked(fetch)
    .mockResolvedValueOnce(fakeDeepSeekResponse(dirtyJson))
    .mockResolvedValue(fakeDeepSeekResponse(cleanJson));

  const res = await app.inject({
    method: 'POST',
    url: '/api/loop-scripts/generate',
    headers: bearer(token),
    payload: { sourceScriptId },
  });
  expect(res.statusCode).toBe(200);
  const body = res.json();
  expect(body.items).toHaveLength(1);
  expect(body.items[0]?.text).toBe('本店招牌套餐分量足，价格实在，欢迎到店。');
  expect(body.generationNote).toContain('自动改写');

  // 生成 + 1 次改写 = 2 次 DeepSeek 调用
  expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
  const [, secondCall] = vi.mocked(fetch).mock.calls[1] ?? [];
  const secondBody = JSON.parse(String(secondCall?.body)) as {
    messages: Array<{ role: string; content: string }>;
  };
  expect(secondBody.messages.map((message) => message.role)).toEqual([
    'system',
    'user',
    'assistant',
    'user',
  ]);
  expect(secondBody.messages[2]?.content).toContain('本店最优惠的招牌套餐');
  expect(secondBody.messages[3]?.content).toContain('最');
  expect(secondBody.messages[0]?.content).toContain(SENSITIVE_GUARD_PROMPT);
});

dbIt('改写两版仍含敏感词 → 502 GENERATION_FAILED 且不落库', async () => {
  const token = await registerAndGetToken(PHONE_GEN_FAIL);
  await resetUserData(PHONE_GEN_FAIL);
  const sourceScriptId = await seedOwnedScript(PHONE_GEN_FAIL);
  const dirtyJson = JSON.stringify([
    { kind: 'product', text: '顶级食材、最优惠的价格，快来下单。', gapAfterSeconds: null },
  ]);
  // 每次调用返回新的 Response：fetch Response body 只能读一次，复用会解析失败
  vi.mocked(fetch).mockImplementation(() => Promise.resolve(fakeDeepSeekResponse(dirtyJson)));

  const res = await app.inject({
    method: 'POST',
    url: '/api/loop-scripts/generate',
    headers: bearer(token),
    payload: { sourceScriptId },
  });
  expect(res.statusCode).toBe(502);
  expect(res.json()).toMatchObject({ error: 'GENERATION_FAILED' });
  // 生成 + 2 次改写 = 3 次调用后仍失败
  expect(vi.mocked(fetch)).toHaveBeenCalledTimes(3);

  const list = await app.inject({ method: 'GET', url: '/api/loop-scripts', headers: bearer(token) });
  expect(list.statusCode).toBe(200);
  expect(list.json()).toEqual([]);
});

dbIt('DeepSeek 异常 / 非 JSON 返回 → 502 GENERATION_FAILED', async () => {
  const token = await registerAndGetToken(PHONE_GEN_ERROR);
  await resetUserData(PHONE_GEN_ERROR);
  const sourceScriptId = await seedOwnedScript(PHONE_GEN_ERROR);

  vi.mocked(fetch).mockResolvedValue(fakeDeepSeekResponse('', 500));
  const badStatus = await app.inject({
    method: 'POST',
    url: '/api/loop-scripts/generate',
    headers: bearer(token),
    payload: { sourceScriptId },
  });
  expect(badStatus.statusCode).toBe(502);
  expect(badStatus.json()).toMatchObject({ error: 'GENERATION_FAILED' });

  // 网络异常
  vi.mocked(fetch).mockRejectedValue(new Error('connection reset'));
  const networkError = await app.inject({
    method: 'POST',
    url: '/api/loop-scripts/generate',
    headers: bearer(token),
    payload: { sourceScriptId },
  });
  expect(networkError.statusCode).toBe(502);
  expect(networkError.json()).toMatchObject({ error: 'GENERATION_FAILED' });

  // 返回非 JSON 数组（解析失败）
  vi.mocked(fetch).mockResolvedValue(fakeDeepSeekResponse('抱歉，我写不出数组。'));
  const parseError = await app.inject({
    method: 'POST',
    url: '/api/loop-scripts/generate',
    headers: bearer(token),
    payload: { sourceScriptId },
  });
  expect(parseError.statusCode).toBe(502);
  expect(parseError.json()).toMatchObject({ error: 'GENERATION_FAILED' });
});
