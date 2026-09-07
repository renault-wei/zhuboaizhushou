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

// 各场景固定手机号（互不共用，避免历史数据串扰）
const PHONE_INVALID_INDUSTRY = '13900000022';
const PHONE_NO_PRODUCT = '13900000023';
const PHONE_CLEAN = '13900000024';
const PHONE_BLOCKED = '13900000025';
const PHONE_LIST_A = '13900000026';
const PHONE_LIST_B = '13900000027';
const PHONE_DETAIL_OWNER = '13900000028';
const PHONE_DETAIL_OTHER = '13900000029';
const PHONE_EDIT = '13900000030';
const PHONE_FAIL = '13900000031';
const PHONE_REWRITE_FALLBACK = '13900000032';
const PHONE_GENERIC_FALLBACK = '13900000033';

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

/** 复位：清空该用户的话术记录，保证用例之间互不影响 */
async function resetUserData(phone: string): Promise<void> {
  const userId = await userIdOf(phone);
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

const hotpotProduct = {
  name: '双人火锅套餐',
  package: '锅底任选 + 毛肚一份 + 两份荤菜 + 两份素菜',
  price: '99 元',
  sellingPoints: '锅底现炒，食材新鲜',
};

beforeEach(() => {
  // 每个用例默认 mock 掉网络：测试绝不真实调用 DeepSeek（花钱 + 不稳定）
  vi.spyOn(globalThis, 'fetch');
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------- 未登录 401 ----------

describe('话术接口鉴权', () => {
  it('未带 token 访问四个接口均返回 401', async () => {
    const generate = await app.inject({
      method: 'POST',
      url: '/api/scripts/generate',
      payload: { industry: 'restaurant', product: hotpotProduct },
    });
    expect(generate.statusCode).toBe(401);
    expect(generate.json()).toMatchObject({ error: 'UNAUTHORIZED' });

    const list = await app.inject({ method: 'GET', url: '/api/scripts' });
    expect(list.statusCode).toBe(401);

    const single = await app.inject({ method: 'GET', url: `/api/scripts/${randomUUID()}` });
    expect(single.statusCode).toBe(401);

    const edit = await app.inject({
      method: 'PUT',
      url: `/api/scripts/${randomUUID()}`,
      payload: { content: '编辑内容' },
    });
    expect(edit.statusCode).toBe(401);
  });
});

// ---------- 参数校验（不触发 DeepSeek 调用）----------

dbIt('industry 不在模板内返回 400 INDUSTRY_INVALID', async () => {
  const token = await registerAndGetToken(PHONE_INVALID_INDUSTRY);
  await resetUserData(PHONE_INVALID_INDUSTRY);

  const res = await app.inject({
    method: 'POST',
    url: '/api/scripts/generate',
    headers: bearer(token),
    payload: { industry: 'unknown_industry', product: hotpotProduct },
  });
  expect(res.statusCode).toBe(400);
  expect(res.json()).toMatchObject({ error: 'INDUSTRY_INVALID' });
  expect(vi.mocked(fetch)).not.toHaveBeenCalled();
});

dbIt('product 缺失或为空返回 400', async () => {
  const token = await registerAndGetToken(PHONE_NO_PRODUCT);
  await resetUserData(PHONE_NO_PRODUCT);

  const missing = await app.inject({
    method: 'POST',
    url: '/api/scripts/generate',
    headers: bearer(token),
    payload: { industry: 'restaurant' },
  });
  expect(missing.statusCode).toBe(400);
  expect(missing.json()).toMatchObject({ error: 'PRODUCT_INVALID' });

  const empty = await app.inject({
    method: 'POST',
    url: '/api/scripts/generate',
    headers: bearer(token),
    payload: { industry: 'restaurant', product: {} },
  });
  expect(empty.statusCode).toBe(400);
  expect(vi.mocked(fetch)).not.toHaveBeenCalled();
});

// ---------- 生成话术 ----------

dbIt('生成成功：真实调用被 mock，返回 201 且 status=ready、敏感词 pass', async () => {
  const token = await registerAndGetToken(PHONE_CLEAN);
  await resetUserData(PHONE_CLEAN);
  const cleanContent = '锅底现炒、毛肚脆嫩，双人套餐只要 99 元，欢迎到店品尝。';
  vi.mocked(fetch).mockResolvedValue(fakeDeepSeekResponse(cleanContent));

  const res = await app.inject({
    method: 'POST',
    url: '/api/scripts/generate',
    headers: bearer(token),
    payload: { industry: 'restaurant', title: '火锅套餐话术', product: hotpotProduct },
  });
  expect(res.statusCode).toBe(201);
  const script = res.json();
  expect(script.id).toBeTruthy();
  expect(script.industry).toBe('restaurant');
  expect(script.title).toBe('火锅套餐话术');
  expect(script.content).toBe(cleanContent);
  expect(script.status).toBe('ready');
  expect(script.sensitiveCheckStatus).toBe('pass');
  expect(script.sensitiveMatchedWords).toEqual([]);
  expect(script.productSnapshot).toEqual(hotpotProduct);
  expect(script.sensitiveScannedAt).toBeTruthy();

  // 确实请求了 DeepSeek chat/completions（走真实实现，只是网络被 mock）
  expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  const [url, init] = vi.mocked(fetch).mock.calls[0] ?? [];
  expect(String(url)).toMatch(/\/chat\/completions$/);
  const headers = init?.headers as Record<string, string> | undefined;
  expect(headers?.Authorization).toMatch(/^Bearer /);
});

dbIt('生成含敏感词：自动改写一版通过 → ready+pass 且附 generationNote', async () => {
  const token = await registerAndGetToken(PHONE_BLOCKED);
  await resetUserData(PHONE_BLOCKED);
  const dirtyContent = '这是全网最实惠的火锅套餐，快来抢购。';
  const cleanRewritten = '这是很实惠的火锅套餐，分量很足，快来抢购。';
  vi.mocked(fetch)
    .mockResolvedValueOnce(fakeDeepSeekResponse(dirtyContent))
    .mockResolvedValue(fakeDeepSeekResponse(cleanRewritten));

  const res = await app.inject({
    method: 'POST',
    url: '/api/scripts/generate',
    headers: bearer(token),
    payload: { industry: 'restaurant', product: hotpotProduct },
  });
  expect(res.statusCode).toBe(201);
  const script = res.json();
  expect(script.status).toBe('ready');
  expect(script.sensitiveCheckStatus).toBe('pass');
  expect(script.sensitiveMatchedWords).toEqual([]);
  expect(script.content).toBe(cleanRewritten);
  expect(script.generationNote).toContain('自动改写');

  // 生成 + 1 次改写 = 2 次 DeepSeek 调用
  expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
  // 改写请求携带被拦截初稿并说明命中词；system 提示词注入了禁用语清单
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
  expect(secondBody.messages[2]?.content).toBe(dirtyContent);
  expect(secondBody.messages[3]?.content).toContain('最');
  expect(secondBody.messages[0]?.content).toContain(SENSITIVE_GUARD_PROMPT);
});

dbIt('改写两版仍含敏感词 → 安全模板兜底：依旧 ready+pass', async () => {
  const token = await registerAndGetToken(PHONE_REWRITE_FALLBACK);
  await resetUserData(PHONE_REWRITE_FALLBACK);
  const dirtyContent = '这是全网最低的火锅套餐，快来抢购。';
  // 每次调用返回新的 Response：fetch Response body 只能读一次，复用会解析失败
  vi.mocked(fetch).mockImplementation(() =>
    Promise.resolve(fakeDeepSeekResponse(dirtyContent)),
  );

  const res = await app.inject({
    method: 'POST',
    url: '/api/scripts/generate',
    headers: bearer(token),
    payload: { industry: 'restaurant', product: hotpotProduct },
  });
  expect(res.statusCode).toBe(201);
  const script = res.json();
  expect(script.status).toBe('ready');
  expect(script.sensitiveCheckStatus).toBe('pass');
  expect(script.sensitiveMatchedWords).toEqual([]);
  // 商品字面量干净 → 兜底稿带商品信息且可开播
  expect(script.content).toContain('双人火锅套餐');
  expect(script.generationNote).toContain('安全模板');
  // 生成 + 2 次改写均被拦截 = 3 次调用后兜底
  expect(vi.mocked(fetch)).toHaveBeenCalledTimes(3);
});

dbIt('商品字面量本身含极限词 → 兜底回退纯通用文案且不含该词', async () => {
  const token = await registerAndGetToken(PHONE_GENERIC_FALLBACK);
  await resetUserData(PHONE_GENERIC_FALLBACK);
  const dirtyContent = '这是最顶级的火锅套餐，快来抢购。';
  vi.mocked(fetch).mockImplementation(() =>
    Promise.resolve(fakeDeepSeekResponse(dirtyContent)),
  );

  const res = await app.inject({
    method: 'POST',
    url: '/api/scripts/generate',
    headers: bearer(token),
    payload: {
      industry: 'restaurant',
      product: {
        name: '全网最低火锅套餐',
        package: '锅底+毛肚，两人份',
        price: '99 元',
      },
    },
  });
  expect(res.statusCode).toBe(201);
  const script = res.json();
  expect(script.status).toBe('ready');
  expect(script.sensitiveCheckStatus).toBe('pass');
  expect(script.sensitiveMatchedWords).toEqual([]);
  // 商品名含极限词 → 带商品字面量的兜底稿也被拦，回退到纯通用文案
  expect(script.content).toContain('招牌套餐');
  expect(script.content).not.toContain('全网最低');
  expect(script.generationNote).toContain('安全模板');
});

dbIt('DeepSeek 调用失败：非 2xx / 网络异常 → 502 GENERATION_FAILED', async () => {
  const token = await registerAndGetToken(PHONE_FAIL);
  await resetUserData(PHONE_FAIL);

  // 服务端 5xx
  vi.mocked(fetch).mockResolvedValue(fakeDeepSeekResponse('', 500));
  const badStatus = await app.inject({
    method: 'POST',
    url: '/api/scripts/generate',
    headers: bearer(token),
    payload: { industry: 'restaurant', product: hotpotProduct },
  });
  expect(badStatus.statusCode).toBe(502);
  expect(badStatus.json()).toMatchObject({ error: 'GENERATION_FAILED' });

  // 网络层抛错
  vi.mocked(fetch).mockRejectedValue(new Error('connection reset'));
  const networkError = await app.inject({
    method: 'POST',
    url: '/api/scripts/generate',
    headers: bearer(token),
    payload: { industry: 'restaurant', product: hotpotProduct },
  });
  expect(networkError.statusCode).toBe(502);
  expect(networkError.json()).toMatchObject({ error: 'GENERATION_FAILED' });
});

// ---------- 列表与归属隔离 ----------

dbIt('列表归属隔离：用户 B 看不到用户 A 的话术', async () => {
  const tokenA = await registerAndGetToken(PHONE_LIST_A);
  await resetUserData(PHONE_LIST_A);
  vi.mocked(fetch).mockResolvedValue(fakeDeepSeekResponse('A 的干净话术内容。'));
  const createdA = await app.inject({
    method: 'POST',
    url: '/api/scripts/generate',
    headers: bearer(tokenA),
    payload: { industry: 'retail', product: { name: 'A 的商品', price: '10 元' } },
  });
  expect(createdA.statusCode).toBe(201);

  const tokenB = await registerAndGetToken(PHONE_LIST_B);
  await resetUserData(PHONE_LIST_B);
  const listB = await app.inject({ method: 'GET', url: '/api/scripts', headers: bearer(tokenB) });
  expect(listB.statusCode).toBe(200);
  expect(listB.json()).toEqual([]);

  const listA = await app.inject({ method: 'GET', url: '/api/scripts', headers: bearer(tokenA) });
  expect(listA.statusCode).toBe(200);
  const rows = listA.json() as Array<{ id: string; content: string }>;
  expect(rows).toHaveLength(1);
  expect(rows[0]?.content).toBe('A 的干净话术内容。');
});

dbIt('详情/编辑归属校验：他人或不存在的话术返回 404 SCRIPT_NOT_FOUND', async () => {
  const tokenOwner = await registerAndGetToken(PHONE_DETAIL_OWNER);
  await resetUserData(PHONE_DETAIL_OWNER);
  vi.mocked(fetch).mockResolvedValue(fakeDeepSeekResponse('详情归属干净话术。'));
  const created = await app.inject({
    method: 'POST',
    url: '/api/scripts/generate',
    headers: bearer(tokenOwner),
    payload: { industry: 'restaurant', product: hotpotProduct },
  });
  expect(created.statusCode).toBe(201);
  const scriptId = created.json().id as string;

  // 不存在
  const missing = await app.inject({
    method: 'GET',
    url: `/api/scripts/${randomUUID()}`,
    headers: bearer(tokenOwner),
  });
  expect(missing.statusCode).toBe(404);
  expect(missing.json()).toMatchObject({ error: 'SCRIPT_NOT_FOUND' });

  // 他人访问
  const tokenOther = await registerAndGetToken(PHONE_DETAIL_OTHER);
  await resetUserData(PHONE_DETAIL_OTHER);
  const otherGet = await app.inject({
    method: 'GET',
    url: `/api/scripts/${scriptId}`,
    headers: bearer(tokenOther),
  });
  expect(otherGet.statusCode).toBe(404);

  const otherPut = await app.inject({
    method: 'PUT',
    url: `/api/scripts/${scriptId}`,
    headers: bearer(tokenOther),
    payload: { content: '篡改内容' },
  });
  expect(otherPut.statusCode).toBe(404);
});

// ---------- 编辑保存后重新扫描 ----------

dbIt('编辑保存后重新扫描：改出敏感词 → blocked，改干净 → ready', async () => {
  const token = await registerAndGetToken(PHONE_EDIT);
  await resetUserData(PHONE_EDIT);
  vi.mocked(fetch).mockResolvedValue(fakeDeepSeekResponse('编辑前干净话术内容。'));
  const created = await app.inject({
    method: 'POST',
    url: '/api/scripts/generate',
    headers: bearer(token),
    payload: { industry: 'restaurant', product: hotpotProduct },
  });
  expect(created.statusCode).toBe(201);
  const scriptId = created.json().id as string;

  // 编辑引入「顶级」→ blocked
  const blockedEdit = await app.inject({
    method: 'PUT',
    url: `/api/scripts/${scriptId}`,
    headers: bearer(token),
    payload: { content: '顶级食材，快来品尝。' },
  });
  expect(blockedEdit.statusCode).toBe(200);
  const blocked = blockedEdit.json();
  expect(blocked.status).toBe('blocked');
  expect(blocked.sensitiveCheckStatus).toBe('blocked');
  expect(blocked.sensitiveMatchedWords).toContain('顶级');

  // 再编辑干净 → 恢复 ready / pass，命中词清空
  const cleanEdit = await app.inject({
    method: 'PUT',
    url: `/api/scripts/${scriptId}`,
    headers: bearer(token),
    payload: { content: '食材新鲜现做，欢迎到店品尝。', title: '修改后的标题' },
  });
  expect(cleanEdit.statusCode).toBe(200);
  const cleaned = cleanEdit.json();
  expect(cleaned.status).toBe('ready');
  expect(cleaned.sensitiveCheckStatus).toBe('pass');
  expect(cleaned.sensitiveMatchedWords).toEqual([]);
  expect(cleaned.title).toBe('修改后的标题');
});

dbIt('编辑保存时 content 为空返回 400 CONTENT_REQUIRED', async () => {
  const token = await registerAndGetToken(PHONE_EDIT);
  await resetUserData(PHONE_EDIT);
  vi.mocked(fetch).mockResolvedValue(fakeDeepSeekResponse('待清空内容话术。'));
  const created = await app.inject({
    method: 'POST',
    url: '/api/scripts/generate',
    headers: bearer(token),
    payload: { industry: 'restaurant', product: hotpotProduct },
  });
  expect(created.statusCode).toBe(201);
  const scriptId = created.json().id as string;

  const res = await app.inject({
    method: 'PUT',
    url: `/api/scripts/${scriptId}`,
    headers: bearer(token),
    payload: { content: '   ' },
  });
  expect(res.statusCode).toBe(400);
  expect(res.json()).toMatchObject({ error: 'CONTENT_REQUIRED' });
});
