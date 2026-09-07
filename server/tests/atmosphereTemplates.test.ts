import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { pool } from '../src/db/client';

const app: FastifyInstance = buildApp();

// 探测数据库连通性：不可用时整组跳过（与本仓既有集成测试口径一致）
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

// 本文件独享手机号段（13940000xxx）
const PHONE_CREATE = '13940000001';
const PHONE_OWNER = '13940000002';
const PHONE_OTHER = '13940000003';
const PHONE_BLOCKED = '13940000004';

async function registerAndGetToken(phone: string): Promise<string> {
  const send = await app.inject({
    method: 'POST',
    url: '/api/auth/send-code',
    payload: { phone },
  });
  const code = send.json().code as string;
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
  await pool.query('DELETE FROM atmosphere_templates WHERE user_id = $1', [userId]);
}

function bearer(token: string): { authorization: string } {
  return { authorization: `Bearer ${token}` };
}

async function createTemplate(token: string, category = 'welcome', text = '欢迎新朋友来到直播间'): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/atmosphere-templates',
    headers: bearer(token),
    payload: { category, text },
  });
  expect(res.statusCode).toBe(201);
  const body = res.json() as { id: string };
  return body.id;
}

describe('氛围台词库 CRUD', () => {
  dbIt('未登录访问一律 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/atmosphere-templates' });
    expect(res.statusCode).toBe(401);
  });

  dbIt('新建/列表/详情/替换/删除全链路', async () => {
    const token = await registerAndGetToken(PHONE_CREATE);
    await resetUserData(PHONE_CREATE);

    const created = await app.inject({
      method: 'POST',
      url: '/api/atmosphere-templates',
      headers: bearer(token),
      payload: { category: 'welcome', text: '欢迎{昵称}来到直播间，今天想吃点什么？', enabled: false },
    });
    expect(created.statusCode).toBe(201);
    const row = created.json() as { id: string; category: string; enabled: boolean };
    expect(row.category).toBe('welcome');
    expect(row.enabled).toBe(false);

    const list = await app.inject({
      method: 'GET',
      url: '/api/atmosphere-templates?category=welcome',
      headers: bearer(token),
    });
    expect(list.statusCode).toBe(200);
    const items = list.json() as Array<{ id: string }>;
    expect(items.some((item) => item.id === row.id)).toBe(true);

    const detail = await app.inject({
      method: 'GET',
      url: `/api/atmosphere-templates/${row.id}`,
      headers: bearer(token),
    });
    expect(detail.statusCode).toBe(200);
    expect((detail.json() as { text: string }).text).toContain('{昵称}');

    const replaced = await app.inject({
      method: 'PUT',
      url: `/api/atmosphere-templates/${row.id}`,
      headers: bearer(token),
      payload: { category: 'follow', text: '感谢关注，下次开播不迷路', enabled: true },
    });
    expect(replaced.statusCode).toBe(200);
    expect((replaced.json() as { category: string }).category).toBe('follow');

    const removed = await app.inject({
      method: 'DELETE',
      url: `/api/atmosphere-templates/${row.id}`,
      headers: bearer(token),
    });
    expect(removed.statusCode).toBe(200);
    const afterDelete = await app.inject({
      method: 'GET',
      url: `/api/atmosphere-templates/${row.id}`,
      headers: bearer(token),
    });
    expect(afterDelete.statusCode).toBe(404);
  });

  dbIt('类别白名单 / 空文本 / 超长 → 400', async () => {
    const token = await registerAndGetToken(PHONE_CREATE);
    const bad = await app.inject({
      method: 'POST',
      url: '/api/atmosphere-templates',
      headers: bearer(token),
      payload: { category: 'banner', text: '违规类别' },
    });
    expect(bad.statusCode).toBe(400);
    expect((bad.json() as { error: string }).error).toBe('CATEGORY_INVALID');

    const empty = await app.inject({
      method: 'POST',
      url: '/api/atmosphere-templates',
      headers: bearer(token),
      payload: { category: 'clock', text: '   ' },
    });
    expect(empty.statusCode).toBe(400);
    expect((empty.json() as { error: string }).error).toBe('TEXT_REQUIRED');

    const tooLong = await app.inject({
      method: 'POST',
      url: '/api/atmosphere-templates',
      headers: bearer(token),
      payload: { category: 'clock', text: '整'.repeat(201) },
    });
    expect(tooLong.statusCode).toBe(400);
    expect((tooLong.json() as { error: string }).error).toBe('TEXT_TOO_LONG');
  });

  dbIt('命中拦截级敏感词 → 400 且不落库', async () => {
    const token = await registerAndGetToken(PHONE_BLOCKED);
    await resetUserData(PHONE_BLOCKED);
    const res = await app.inject({
      method: 'POST',
      url: '/api/atmosphere-templates',
      headers: bearer(token),
      payload: { category: 'custom', text: '本店全网最低价，快来抢' },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { error: string; matchedWords: string[] };
    expect(body.error).toBe('SENSITIVE_BLOCKED');
    expect(body.matchedWords.length).toBeGreaterThan(0);

    const list = await app.inject({
      method: 'GET',
      url: '/api/atmosphere-templates',
      headers: bearer(token),
    });
    expect((list.json() as unknown[]).length).toBe(0);
  });

  dbIt('归属隔离：他人详情 / 替换 / 删除 → 404', async () => {
    const tokenOwner = await registerAndGetToken(PHONE_OWNER);
    const tokenOther = await registerAndGetToken(PHONE_OTHER);
    await resetUserData(PHONE_OWNER);
    await resetUserData(PHONE_OTHER);
    const id = await createTemplate(tokenOwner);

    const detail = await app.inject({
      method: 'GET',
      url: `/api/atmosphere-templates/${id}`,
      headers: bearer(tokenOther),
    });
    expect(detail.statusCode).toBe(404);

    const replaced = await app.inject({
      method: 'PUT',
      url: `/api/atmosphere-templates/${id}`,
      headers: bearer(tokenOther),
      payload: { category: 'custom', text: '越权替换' },
    });
    expect(replaced.statusCode).toBe(404);

    const removed = await app.inject({
      method: 'DELETE',
      url: `/api/atmosphere-templates/${id}`,
      headers: bearer(tokenOther),
    });
    expect(removed.statusCode).toBe(404);

    const stillThere = await app.inject({
      method: 'GET',
      url: `/api/atmosphere-templates/${id}`,
      headers: bearer(tokenOwner),
    });
    expect(stillThere.statusCode).toBe(200);
  });
});
