// R21 / R27 账号级直播设置接口 + 违禁词解析单测。
// 纯解析用例不碰 DB；接口用例走真实 app.inject + 本地库（库不可用时自动跳过）。

import { afterAll, afterEach, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { pool } from '../src/db/client';
import { matchBannedWords, parseBannedWords } from '../src/services/liveSettings';

const app: FastifyInstance = buildApp();

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

// ---------- 违禁词解析（纯函数，对齐竞品口径）----------

it('R27：违禁词按中文顿号切分，并兼容英文逗号与换行', () => {
  expect(parseBannedWords('最低价、绝对、包治百病')).toEqual(['最低价', '绝对', '包治百病']);
  expect(parseBannedWords('最低价,绝对')).toEqual(['最低价', '绝对']);
  expect(parseBannedWords('最低价\n绝对')).toEqual(['最低价', '绝对']);
});

it('R27：单字符词被忽略（对齐竞品「后台会直接忽略单字符违禁词」，防误伤中文单字）', () => {
  expect(parseBannedWords('的、了、最低价')).toEqual(['最低价']);
});

it('R27：空值 / 纯分隔符 / 重复词都归一干净', () => {
  expect(parseBannedWords(null)).toEqual([]);
  expect(parseBannedWords('')).toEqual([]);
  expect(parseBannedWords('、、、')).toEqual([]);
  expect(parseBannedWords('最低价、最低价')).toEqual(['最低价']);
});

it('R27：命中判定按子串匹配，未命中返回空数组', () => {
  const words = parseBannedWords('最低价、包治百病');
  expect(matchBannedWords('咱们家最低价 99 元', words)).toEqual(['最低价']);
  expect(matchBannedWords('咱们家套餐 99 元', words)).toEqual([]);
  expect(matchBannedWords('随便什么', [])).toEqual([]);
});

// ---------- 接口 ----------

const PHONE = '13930001001';

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

function bearer(token: string): { authorization: string } {
  return { authorization: 'Bearer ' + token };
}

async function resetSettings(phone: string): Promise<void> {
  await pool.query(
    'DELETE FROM user_live_settings WHERE user_id = (SELECT id FROM users WHERE phone = $1)',
    [phone],
  );
}

dbIt('R21：首次读取返回默认值（且不写库 —— 读路径无副作用）', async () => {
  const token = await registerAndGetToken(PHONE);
  await resetSettings(PHONE);

  const res = await app.inject({
    method: 'GET',
    url: '/api/me/live-settings',
    headers: bearer(token),
  });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({
    settings: {
      replyEnabled: true,
      replyIntervalSeconds: 5,
      replyExtraKnowledge: null,
      bannedWords: null,
      defaultSpeechRate: null,
    },
  });

  const rows = await pool.query(
    'SELECT count(*)::int AS n FROM user_live_settings WHERE user_id = (SELECT id FROM users WHERE phone = $1)',
    [PHONE],
  );
  expect((rows.rows[0] as { n: number }).n).toBe(0);
});

dbIt('R21：PATCH 只改传入字段，其余保持原值', async () => {
  const token = await registerAndGetToken(PHONE);
  await resetSettings(PHONE);

  const first = await app.inject({
    method: 'PATCH',
    url: '/api/me/live-settings',
    headers: bearer(token),
    payload: { replyIntervalSeconds: 20, bannedWords: '最低价、绝对' },
  });
  expect(first.statusCode).toBe(200);
  expect(first.json()).toMatchObject({
    settings: { replyEnabled: true, replyIntervalSeconds: 20, bannedWords: '最低价、绝对' },
  });

  const second = await app.inject({
    method: 'PATCH',
    url: '/api/me/live-settings',
    headers: bearer(token),
    payload: { replyEnabled: false },
  });
  expect(second.json()).toMatchObject({
    settings: { replyEnabled: false, replyIntervalSeconds: 20, bannedWords: '最低价、绝对' },
  });
});

dbIt('R21：越界值一律 400，且带字段名', async () => {
  const token = await registerAndGetToken(PHONE);
  await resetSettings(PHONE);
  const headers = bearer(token);

  const tooSmall = await app.inject({
    method: 'PATCH',
    url: '/api/me/live-settings',
    headers,
    payload: { replyIntervalSeconds: 0 },
  });
  expect(tooSmall.statusCode).toBe(400);
  expect(tooSmall.json()).toMatchObject({ error: 'SETTING_INVALID' });
  expect(String((tooSmall.json() as { message: string }).message)).toContain('replyIntervalSeconds');

  const tooBig = await app.inject({
    method: 'PATCH',
    url: '/api/me/live-settings',
    headers,
    payload: { replyIntervalSeconds: 61 },
  });
  expect(tooBig.statusCode).toBe(400);

  const badRate = await app.inject({
    method: 'PATCH',
    url: '/api/me/live-settings',
    headers,
    payload: { defaultSpeechRate: 999 },
  });
  expect(badRate.statusCode).toBe(400);

  const notBool = await app.inject({
    method: 'PATCH',
    url: '/api/me/live-settings',
    headers,
    payload: { replyEnabled: 'yes' },
  });
  expect(notBool.statusCode).toBe(400);
});

dbIt('R21：上下限接口对外暴露（避免前端硬编码）；未登录 401', async () => {
  const limits = await app.inject({ method: 'GET', url: '/api/me/live-settings/limits' });
  expect(limits.statusCode).toBe(200);
  expect(limits.json()).toMatchObject({
    replyIntervalSeconds: { min: 1, max: 60 },
    autoEndMinutes: { min: 10, max: 1440 },
    defaultSpeechRate: { min: -20, max: 60 },
  });

  const anon = await app.inject({ method: 'GET', url: '/api/me/live-settings' });
  expect(anon.statusCode).toBe(401);
});
