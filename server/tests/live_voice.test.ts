import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync as writeWav } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { pool } from '../src/db/client';
import { env } from '../src/config/env';
import { presetSpeechOverrides } from '../src/services/liveVoice';
import { DEFAULT_VOLC_PRESET_ID } from '../src/services/volcPresets';
import { VOICE_PREVIEW_TEXT } from '../src/routes/voices';
import { volcTtsSynth } from '../src/services/volcTTS';

// 档 A「音色接线」测试：
// - liveVoice.presetSpeechOverrides：预设音色白名单 → 合成覆盖项（纯函数，不碰 DB）
// - POST /api/voices/preview：鉴权 / 非法音色 / 未配 Key / 预设试听 / 克隆音色回落
// 第三方合成全部 mock（写临时 wav），测试不真调火山，不花钱。

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

// 试听产物临时目录（被路由 finally 删除，这里兜底清理整个目录）
const previewDir = mkdtempSync(join(tmpdir(), 'starvoice-preview-'));
let previewSeq = 0;

afterAll(async () => {
  await app.close();
  await pool.end().catch(() => undefined);
  rmSync(previewDir, { recursive: true, force: true });
});

afterEach(() => {
  vi.restoreAllMocks();
});

const PHONE = '13900000021';

/** 同手机号只发一次验证码：内存 mock 有 60 秒重发限制，重复调用会被 429 */
const tokenCache = new Map<string, Promise<string>>();

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

function tokenFor(phone: string): Promise<string> {
  let pending = tokenCache.get(phone);
  if (!pending) {
    pending = registerAndGetToken(phone);
    tokenCache.set(phone, pending);
  }
  return pending;
}

function bearer(token: string): { authorization: string } {
  return { authorization: `Bearer ${token}` };
}

/** mock 一次合成：写一个占位 wav 并返回其路径（不调火山） */
function mockSynthOnce(): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(volcTtsSynth, 'synthesize').mockImplementation(async () => {
    previewSeq += 1;
    const wavPath = join(previewDir, `preview-${previewSeq}.wav`);
    writeWav(wavPath, Buffer.from('RIFF\u0000\u0000\u0000\u0000WAVEfmt '));
    return { wavPath };
  });
}

describe('presetSpeechOverrides（预设音色 → 合成覆盖项）', () => {
  it('命中内置预设音色：返回该预设 id 作为 speaker 覆盖项', () => {
    expect(presetSpeechOverrides(DEFAULT_VOLC_PRESET_ID)).toEqual({
      speaker: DEFAULT_VOLC_PRESET_ID,
    });
  });

  it('空音色直接回落：null（不告警）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(presetSpeechOverrides(null)).toBeNull();
    expect(presetSpeechOverrides(undefined)).toBeNull();
    expect(presetSpeechOverrides('')).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  it('未知音色回落默认音色并告警一次（避免脏 id 静默出声）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(presetSpeechOverrides('zh_female_not_exist_uranus_bigtts')).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('POST /api/voices/preview（音色试听）', () => {
  it('未登录：401，不发合成请求', async () => {
    const synth = vi.spyOn(volcTtsSynth, 'synthesize');
    const res = await app.inject({
      method: 'POST',
      url: '/api/voices/preview',
      payload: { presetId: DEFAULT_VOLC_PRESET_ID },
    });
    expect(res.statusCode).toBe(401);
    expect(synth).not.toHaveBeenCalled();
  });

  it('音色缺失 / 非内置预设：400 VOICE_INVALID，不发合成请求', async () => {
    const token = await tokenFor(PHONE);
    const synth = vi.spyOn(volcTtsSynth, 'synthesize');
    for (const payload of [{}, { presetId: 'not-a-preset' }]) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/voices/preview',
        headers: bearer(token),
        payload,
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('VOICE_INVALID');
    }
    expect(synth).not.toHaveBeenCalled();
  });

  it('服务端未配置火山 Key：503 TTS_NOT_CONFIGURED，不发合成请求', async () => {
    const token = await tokenFor(PHONE);
    const mutableEnv = env.volcTTS as { apiKey?: string };
    const original = mutableEnv.apiKey;
    mutableEnv.apiKey = undefined;
    const synth = vi.spyOn(volcTtsSynth, 'synthesize');
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/voices/preview',
        headers: bearer(token),
        payload: { presetId: DEFAULT_VOLC_PRESET_ID },
      });
      expect(res.statusCode).toBe(503);
      expect(res.json().error).toBe('TTS_NOT_CONFIGURED');
      expect(synth).not.toHaveBeenCalled();
    } finally {
      mutableEnv.apiKey = original;
    }
  });

  dbIt('预设音色试听：200 + audio/wav，试听用所选预设作为发音人、无回落头', async () => {
    const token = await tokenFor(PHONE);
    const synth = mockSynthOnce();
    const res = await app.inject({
      method: 'POST',
      url: '/api/voices/preview',
      headers: bearer(token),
      payload: { presetId: 'zh_male_m191_uranus_bigtts' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('audio/wav');
    expect(res.headers['x-voice-preview-fallback']).toBeUndefined();
    expect(synth).toHaveBeenCalledWith(VOICE_PREVIEW_TEXT, {
      speaker: 'zh_male_m191_uranus_bigtts',
    });
  });

  dbIt('克隆音色试听：真复刻未接入，回落演示预设并回回落头', async () => {
    const token = await tokenFor(PHONE);
    const userId = (
      (await pool.query('SELECT id FROM users WHERE phone = $1 LIMIT 1', [PHONE])).rows[0] as {
        id: string;
      }
    ).id;
    const voiceId = randomUUID();
    await pool.query(
      `INSERT INTO voices (id, user_id, name, provider, provider_voice_id, status)
       VALUES ($1, $2, '试听测试音色', 'cosyvoice', 'mock-preview-voice', 'ready')`,
      [voiceId, userId],
    );
    const synth = mockSynthOnce();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/voices/preview',
        headers: bearer(token),
        payload: { voiceId },
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['x-voice-preview-fallback']).toBe('demo-preset');
      expect(synth).toHaveBeenCalledWith(VOICE_PREVIEW_TEXT, {
        speaker: DEFAULT_VOLC_PRESET_ID,
      });
    } finally {
      await pool.query('DELETE FROM voices WHERE id = $1', [voiceId]);
    }
  });

  dbIt('音色不属于当前用户：404 VOICE_NOT_FOUND，不发合成请求', async () => {
    const token = await tokenFor(PHONE);
    const synth = vi.spyOn(volcTtsSynth, 'synthesize');
    const res = await app.inject({
      method: 'POST',
      url: '/api/voices/preview',
      headers: bearer(token),
      payload: { voiceId: randomUUID() },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('VOICE_NOT_FOUND');
    expect(synth).not.toHaveBeenCalled();
  });
});
