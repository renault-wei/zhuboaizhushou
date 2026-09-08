import { afterAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { pool } from '../src/db/client';
import {
  LOOP_ITEM_KINDS,
  MAX_LOOP_ITEM_TEXT_LENGTH,
  MAX_LOOP_ITEMS,
  MIN_LOOP_ITEMS,
} from '../src/services/loopScript';
import { scanSensitive } from '../src/services/sensitive';
import { findLoopScriptSample, loopScriptSamples } from '../src/services/loopScriptSamples';

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

const PHONE = '13900000199';

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

describe('示例循环台本（谈单演示，G7）', () => {
  it('内置示例 ≥2 套且 id 唯一', () => {
    expect(loopScriptSamples.length).toBeGreaterThanOrEqual(2);
    const ids = loopScriptSamples.map((sample) => sample.sampleId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('每条示例均满足台本结构约束（条数/字数/kind/间隔）', () => {
    for (const sample of loopScriptSamples) {
      expect(sample.title.length).toBeGreaterThan(0);
      expect(sample.title.length).toBeLessThanOrEqual(100);
      expect(sample.subtitle.length).toBeGreaterThan(0);
      expect(sample.items.length).toBeGreaterThanOrEqual(MIN_LOOP_ITEMS);
      expect(sample.items.length).toBeLessThanOrEqual(MAX_LOOP_ITEMS);
      for (const item of sample.items) {
        expect((LOOP_ITEM_KINDS as readonly string[])).toContain(item.kind);
        expect(item.text.length).toBeGreaterThanOrEqual(1);
        expect(item.text.length).toBeLessThanOrEqual(MAX_LOOP_ITEM_TEXT_LENGTH);
        expect(item.gapAfterSeconds).toBeGreaterThanOrEqual(0);
        expect(item.gapAfterSeconds).toBeLessThanOrEqual(60);
      }
    }
  });

  it('示例内容逐条通过敏感词扫描（L1 不命中、L2 无提示）', () => {
    for (const sample of loopScriptSamples) {
      for (const item of sample.items) {
        const scanned = scanSensitive(item.text);
        expect(scanned.status, `${sample.sampleId} 命中拦截词：${scanned.matchedWords.join('、')}`).toBe('pass');
        expect(scanned.warnWords, `${sample.sampleId} 出现疑似词：${scanned.warnWords.join('、')}`).toEqual([]);
      }
    }
  });

  it('findLoopScriptSample：命中返回整本、未知返回 undefined', () => {
    const hit = findLoopScriptSample('hotpot-set-a');
    expect(hit?.items.length).toBeGreaterThan(0);
    expect(findLoopScriptSample('unknown-sample')).toBeUndefined();
  });

  dbIt('GET /api/loop-script-samples：未登录 401、登录返回全部示例', async () => {
    const unauthorized = await app.inject({ method: 'GET', url: '/api/loop-script-samples' });
    expect(unauthorized.statusCode).toBe(401);

    const token = await registerAndGetToken(PHONE);
    const res = await app.inject({
      method: 'GET',
      url: '/api/loop-script-samples',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { samples: Array<{ sampleId: string; items: unknown[] }> };
    expect(body.samples.length).toBe(loopScriptSamples.length);
    expect(body.samples[0]?.sampleId).toBe(loopScriptSamples[0]?.sampleId);
    expect((body.samples[0]?.items.length ?? 0)).toBeGreaterThan(0);
  });
});