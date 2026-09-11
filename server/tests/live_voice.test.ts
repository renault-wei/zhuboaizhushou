import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync as writeWav } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { pool } from '../src/db/client';
import { env } from '../src/config/env';
import {
  clampLiveSpeechRate,
  DEFAULT_LIVE_SPEECH_RATE,
  MAX_LIVE_SPEECH_RATE,
  MIN_LIVE_SPEECH_RATE,
  presetSpeechOverrides,
} from '../src/services/liveVoice';
import { DEFAULT_VOLC_PRESET_ID } from '../src/services/volcPresets';
import { VOICE_PREVIEW_TEXT } from '../src/routes/voices';
import { volcTtsSynth } from '../src/services/volcTTS';

// 档 A「音色接线」测试：
// - liveVoice.presetSpeechOverrides：预设音色白名单 → 合成覆盖项（纯函数，不碰 DB）
// - POST /api/voices/preview：鉴权 / 非法音色 / 未配 Key / 预设试听 / 克隆音色回落 / 缓存命中
// - 商家默认音色：GET /api/voices/presets 生效值语义 + PUT /api/voices/default 设置与清空
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

// 每个用例前复位试听缓存与默认音色，保证「首次合成 / 未设置默认」的初态可复现
beforeEach(async () => {
  if (!dbAvailable) {
    return;
  }
  await pool.query(
    `DELETE FROM tts_audio_cache
      WHERE user_id IN (SELECT id FROM users WHERE phone = $1)`,
    [PHONE],
  );
  await pool.query('UPDATE users SET default_volc_preset_id = NULL WHERE phone = $1', [PHONE]);
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
  it('命中内置预设音色：返回该预设 id 作为 speaker，并带上默认语速档', () => {
    expect(presetSpeechOverrides(DEFAULT_VOLC_PRESET_ID)).toEqual({
      speechRate: DEFAULT_LIVE_SPEECH_RATE,
      speaker: DEFAULT_VOLC_PRESET_ID,
    });
  });

  it('空音色：只下发默认语速档、不带 speaker（不告警）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(presetSpeechOverrides(null)).toEqual({ speechRate: DEFAULT_LIVE_SPEECH_RATE });
    expect(presetSpeechOverrides(undefined)).toEqual({ speechRate: DEFAULT_LIVE_SPEECH_RATE });
    expect(presetSpeechOverrides('')).toEqual({ speechRate: DEFAULT_LIVE_SPEECH_RATE });
    expect(warn).not.toHaveBeenCalled();
  });

  it('未知音色回落默认音色并告警一次（避免脏 id 静默出声），语速档仍下发', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(presetSpeechOverrides('zh_female_not_exist_uranus_bigtts')).toEqual({
      speechRate: DEFAULT_LIVE_SPEECH_RATE,
    });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('显式语速档：原样下发（已归一）', () => {
    expect(presetSpeechOverrides(DEFAULT_VOLC_PRESET_ID, 45)).toEqual({
      speechRate: 45,
      speaker: DEFAULT_VOLC_PRESET_ID,
    });
  });
});

describe('clampLiveSpeechRate（语速归一：滑块区间 -20~60）', () => {
  it('缺省 / 非有限数：回落默认档（-10）', () => {
    expect(clampLiveSpeechRate(null)).toBe(DEFAULT_LIVE_SPEECH_RATE);
    expect(clampLiveSpeechRate(undefined)).toBe(DEFAULT_LIVE_SPEECH_RATE);
    expect(clampLiveSpeechRate(Number.NaN)).toBe(DEFAULT_LIVE_SPEECH_RATE);
    expect(clampLiveSpeechRate(Number.POSITIVE_INFINITY)).toBe(DEFAULT_LIVE_SPEECH_RATE);
  });

  it('越界钳到区间边界', () => {
    expect(clampLiveSpeechRate(-20)).toBe(MIN_LIVE_SPEECH_RATE);
    expect(clampLiveSpeechRate(-50)).toBe(MIN_LIVE_SPEECH_RATE);
    expect(clampLiveSpeechRate(999)).toBe(MAX_LIVE_SPEECH_RATE);
    expect(clampLiveSpeechRate(100)).toBe(MAX_LIVE_SPEECH_RATE);
  });

  it('区间内就近取整原样保留', () => {
    expect(clampLiveSpeechRate(15)).toBe(15);
    expect(clampLiveSpeechRate(-12.7)).toBe(-13);
    expect(clampLiveSpeechRate(42.4)).toBe(42);
    expect(clampLiveSpeechRate(DEFAULT_LIVE_SPEECH_RATE)).toBe(DEFAULT_LIVE_SPEECH_RATE);
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

  dbIt('音色缺失 / 非内置预设：400 VOICE_INVALID，不发合成请求', async () => {
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

  dbIt('服务端未配置火山 Key：503 TTS_NOT_CONFIGURED，不发合成请求', async () => {
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

  dbIt('voiceId 形态非法（非 uuid）：404 VOICE_NOT_FOUND，不发合成请求', async () => {
    const token = await tokenFor(PHONE);
    const synth = vi.spyOn(volcTtsSynth, 'synthesize');
    const res = await app.inject({
      method: 'POST',
      url: '/api/voices/preview',
      headers: bearer(token),
      payload: { voiceId: 'not-a-uuid' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('VOICE_NOT_FOUND');
    expect(synth).not.toHaveBeenCalled();
  });
});

describe('商家默认音色（GET /api/voices/presets · PUT /api/voices/default）', () => {
  it('未登录：401', async () => {
    const read = await app.inject({ method: 'GET', url: '/api/voices/presets' });
    expect(read.statusCode).toBe(401);
    const write = await app.inject({
      method: 'PUT',
      url: '/api/voices/default',
      payload: { presetId: DEFAULT_VOLC_PRESET_ID },
    });
    expect(write.statusCode).toBe(401);
  });

  dbIt('未设置默认音色：defaultPresetId = 全局默认，userDefaultPresetId = null', async () => {
    const token = await tokenFor(PHONE);
    const res = await app.inject({
      method: 'GET',
      url: '/api/voices/presets',
      headers: bearer(token),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().defaultPresetId).toBe(DEFAULT_VOLC_PRESET_ID);
    expect(res.json().userDefaultPresetId).toBeNull();
  });

  dbIt('设为默认：目录接口的 defaultPresetId 变为该音色（新建开播配置据此预填）', async () => {
    const token = await tokenFor(PHONE);
    const presetId = 'zh_male_m191_uranus_bigtts';
    const put = await app.inject({
      method: 'PUT',
      url: '/api/voices/default',
      headers: bearer(token),
      payload: { presetId },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toEqual({ defaultPresetId: presetId, userDefaultPresetId: presetId });

    const res = await app.inject({
      method: 'GET',
      url: '/api/voices/presets',
      headers: bearer(token),
    });
    expect(res.json().defaultPresetId).toBe(presetId);
    expect(res.json().userDefaultPresetId).toBe(presetId);

    // 服务端为准：确实落了库
    const row = await pool.query('SELECT default_volc_preset_id FROM users WHERE phone = $1', [
      PHONE,
    ]);
    expect(row.rows[0].default_volc_preset_id).toBe(presetId);
  });

  dbIt('清空默认（presetId: null）：回落全局默认，userDefaultPresetId 归 null', async () => {
    const token = await tokenFor(PHONE);
    await app.inject({
      method: 'PUT',
      url: '/api/voices/default',
      headers: bearer(token),
      payload: { presetId: 'zh_male_m191_uranus_bigtts' },
    });
    const clear = await app.inject({
      method: 'PUT',
      url: '/api/voices/default',
      headers: bearer(token),
      payload: { presetId: null },
    });
    expect(clear.statusCode).toBe(200);
    expect(clear.json()).toEqual({
      defaultPresetId: DEFAULT_VOLC_PRESET_ID,
      userDefaultPresetId: null,
    });
  });

  dbIt('音色不在白名单 / 请求体结构不合法：400 VOICE_INVALID，不落库', async () => {
    const token = await tokenFor(PHONE);
    for (const payload of [{ presetId: 'not-a-preset' }, {}, { presetId: 123 }, { presetId: '' }]) {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/voices/default',
        headers: bearer(token),
        payload,
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('VOICE_INVALID');
    }
    const row = await pool.query('SELECT default_volc_preset_id FROM users WHERE phone = $1', [
      PHONE,
    ]);
    expect(row.rows[0].default_volc_preset_id).toBeNull();
  });
});

describe('试听命中 T3 缓存（同一音色同一演示句只真合成一次）', () => {
  dbIt('首次合成落缓存、二次直接命中：不再调供应商且回命中头', async () => {
    const token = await tokenFor(PHONE);
    const synth = mockSynthOnce();
    const payload = { presetId: 'zh_female_vv_uranus_bigtts' };

    const first = await app.inject({
      method: 'POST',
      url: '/api/voices/preview',
      headers: bearer(token),
      payload,
    });
    expect(first.statusCode).toBe(200);
    expect(first.headers['x-voice-preview-cache']).toBeUndefined();
    expect(synth).toHaveBeenCalledTimes(1);

    const second = await app.inject({
      method: 'POST',
      url: '/api/voices/preview',
      headers: bearer(token),
      payload,
    });
    expect(second.statusCode).toBe(200);
    expect(second.headers['x-voice-preview-cache']).toBe('hit');
    expect(synth).toHaveBeenCalledTimes(1);
    expect(second.rawPayload.length).toBe(first.rawPayload.length);
  });
});

describe('预设试听静态产物（方案 A：预生成 wav 直连播放）', () => {
  // 预生成目录改指临时目录：校验「有文件才下发 previewUrl」，不污染真实 uploads
  const staticDir = mkdtempSync(join(tmpdir(), 'starvoice-preview-static-'));
  const presetId = 'zh_female_vv_uranus_bigtts';
  const fileName = `${presetId}.wav`;

  beforeEach(() => {
    (env.voicePreview as { dir: string }).dir = staticDir;
  });

  afterEach(() => {
    (env.voicePreview as { dir: string }).dir = 'uploads/voice-previews';
  });

  afterAll(() => {
    rmSync(staticDir, { recursive: true, force: true });
  });

  dbIt('未预生成：presets 不下发 previewUrl，静态路由 404', async () => {
    const token = await tokenFor(PHONE);
    const res = await app.inject({
      method: 'GET',
      url: '/api/voices/presets',
      headers: bearer(token),
    });
    expect(res.statusCode).toBe(200);
    const presets = res.json().presets as { id: string; previewUrl?: string }[];
    expect(presets.find((preset) => preset.id === presetId)?.previewUrl).toBeUndefined();

    const missing = await app.inject({
      method: 'GET',
      url: `/uploads/voice-previews/${fileName}`,
    });
    expect(missing.statusCode).toBe(404);
  });

  dbIt('已预生成：presets 带 previewUrl，静态路由 200 audio/wav 且字节一致', async () => {
    const bytes = Buffer.from('RIFF\u0000\u0000\u0000\u0000WAVEfmt ');
    writeWav(join(staticDir, fileName), bytes);
    try {
      const token = await tokenFor(PHONE);
      const res = await app.inject({
        method: 'GET',
        url: '/api/voices/presets',
        headers: bearer(token),
      });
      const presets = res.json().presets as { id: string; previewUrl?: string }[];
      expect(presets.find((preset) => preset.id === presetId)?.previewUrl).toBe(
        `/uploads/voice-previews/${fileName}`,
      );

      const audio = await app.inject({
        method: 'GET',
        url: `/uploads/voice-previews/${fileName}`,
      });
      expect(audio.statusCode).toBe(200);
      expect(audio.headers['content-type']).toContain('audio/wav');
      expect(audio.rawPayload.equals(bytes)).toBe(true);
    } finally {
      rmSync(join(staticDir, fileName), { force: true });
    }
  });

  it('文件名不合白名单 / 目录穿越：一律拒掉，不触盘', async () => {
    for (const bad of ['..%2F..%2Fpackage.json', 'zh_female_vv_uranus_bigtts.mp3', 'a b.wav']) {
      const res = await app.inject({
        method: 'GET',
        url: `/uploads/voice-previews/${bad}`,
      });
      expect([400, 404]).toContain(res.statusCode);
    }
  });
});
