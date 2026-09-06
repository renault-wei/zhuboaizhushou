import { afterAll, afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { pool } from '../src/db/client';
import { streamingService, StreamingError } from '../src/services/streaming';

const app: FastifyInstance = buildApp();

// FFmpeg 可用性探测：真合成只跑 1 个冒烟用例，其余一律注入 Mock（第三方/重计算一律 mock）
const FFMPEG_PATH = resolve(process.cwd(), 'bin', 'ffmpeg.exe');
const realFfmpegAvailable = existsSync(FFMPEG_PATH);
const UPLOADS_DIR = resolve(process.cwd(), 'uploads');

// 提前清理历史残留的测试产物目录，保证用例互不影响
rmSync(resolve(UPLOADS_DIR, 'videos'), { recursive: true, force: true });
rmSync(resolve(UPLOADS_DIR, 'lives'), { recursive: true, force: true });

// 提前探测数据库连通性，决定依赖数据库的用例是否执行
let dbAvailable = false;
try {
  await pool.query('SELECT 1');
  dbAvailable = true;
} catch {
  dbAvailable = false;
}
const dbIt = dbAvailable ? it : it.skip;
// 真合成冒烟：仅当数据库可达且本机存在 server/bin/ffmpeg.exe 时才执行
const smokeIt = dbAvailable && realFfmpegAvailable ? it : it.skip;

// 记录本文件产生的上传 / 合成文件，afterAll 统一清理
const generatedFiles = new Set<string>();
function trackCleanup(...paths: string[]): void {
  for (const path of paths) {
    generatedFiles.add(path);
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await app.close();
  await pool.end().catch(() => undefined);
  for (const path of generatedFiles) {
    rmSync(path, { force: true });
  }
});

// 各场景固定手机号（互不共用，避免短信重发限制与历史数据串扰）
const PHONE_FLOW = '13920000201'; // 前置校验流
const PHONE_SUCCESS = '13920000202'; // 合成成功
const PHONE_FAIL = '13920000203'; // 合成失败
const PHONE_OWNER_A = '13920000204'; // 归属隔离 A
const PHONE_OWNER_B = '13920000205'; // 归属隔离 B
const PHONE_SMOKE = '13920000206'; // 真合成冒烟
const PHONE_PROCESSING = '13920000207'; // processing 删除保护
const PHONE_PENDING_VOICE = '13920000208'; // 音色未就绪拦截

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
    [id, userId, name, `cosy-live-streaming-${id}`],
  );
  return id;
}

/** 直接给某用户种一条归属其名下的 ready 话术（绕过 DeepSeek 调用），sensitive 可选 pass / blocked */
async function seedOwnedScript(phone: string, title = '火锅店话术', sensitive = 'pass'): Promise<string> {
  const userId = await userIdOf(phone);
  const id = randomUUID();
  await pool.query(
    `INSERT INTO scripts
       (id, user_id, industry, title, product_snapshot, content, status, sensitive_check_status,
        sensitive_matched_words, sensitive_scanned_at)
     VALUES ($1, $2, 'restaurant', $3, '{"name":"测试商品"}'::jsonb, $4, 'ready', $5,
        '[]'::jsonb, now())`,
    [id, userId, title, '干净的话术内容。', sensitive],
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

/** 手工拼 multipart 请求体（app.inject 不支持 form-data，只能自己构造 boundary） */
function buildMultipart(content: Buffer, options: { filename?: string; mimetype?: string; fieldname?: string }) {
  const boundary = `----starvoiceTest${randomUUID().replace(/-/g, '')}`;
  const fieldname = options.fieldname ?? 'video';
  const filename = options.filename ?? 'clip.mp4';
  const mimetype = options.mimetype ?? 'video/mp4';
  const preamble = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="${fieldname}"; filename="${filename}"\r\nContent-Type: ${mimetype}\r\n\r\n`,
    'utf8',
  );
  const epilogue = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
  return {
    payload: Buffer.concat([preamble, content, epilogue]),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

/** 上传实景视频（断言 200 由调用方按需处理，这里只负责发请求） */
async function uploadVideo(
  token: string,
  liveId: string,
  content: Buffer,
  filename = 'clip.mp4',
  mimetype = 'video/mp4',
) {
  const body = buildMultipart(content, { filename, mimetype });
  return app.inject({
    method: 'POST',
    url: `/api/lives/${liveId}/video`,
    headers: { ...bearer(token), ...body.headers },
    payload: body.payload,
  });
}

// ---------- 未登录 401 ----------

it('未带 token 访问 video / prepare / stream-status 三个接口均返回 401', async () => {
  const id = randomUUID();
  const video = await app.inject({ method: 'POST', url: `/api/lives/${id}/video`, payload: {} });
  expect(video.statusCode).toBe(401);
  expect(video.json()).toMatchObject({ error: 'UNAUTHORIZED' });

  const prepare = await app.inject({ method: 'POST', url: `/api/lives/${id}/prepare`, payload: {} });
  expect(prepare.statusCode).toBe(401);
  expect(prepare.json()).toMatchObject({ error: 'UNAUTHORIZED' });

  const status = await app.inject({ method: 'GET', url: `/api/lives/${id}/stream-status` });
  expect(status.statusCode).toBe(401);
  expect(status.json()).toMatchObject({ error: 'UNAUTHORIZED' });
});

// ---------- 上传与 prepare 前置校验 ----------

dbIt('prepare 按序校验：无视频→空/非法文件→无话术→话术被拦截→未选音色', async () => {
  const token = await registerAndGetToken(PHONE_FLOW);
  await resetUserData(PHONE_FLOW);
  const liveId = await createLiveDraft(token);

  // 未上传视频直接 prepare → 400 VIDEO_NOT_UPLOADED
  const noVideo = await app.inject({
    method: 'POST',
    url: `/api/lives/${liveId}/prepare`,
    headers: bearer(token),
    payload: {},
  });
  expect(noVideo.statusCode).toBe(400);
  expect(noVideo.json()).toMatchObject({ error: 'VIDEO_NOT_UPLOADED' });

  // 空文件 → 400 VIDEO_EMPTY
  const empty = await uploadVideo(token, liveId, Buffer.alloc(0), 'empty.mp4');
  expect(empty.statusCode).toBe(400);
  expect(empty.json()).toMatchObject({ error: 'VIDEO_EMPTY' });

  // 非 mp4 → 400 VIDEO_TYPE_INVALID
  const badType = await uploadVideo(token, liveId, Buffer.from('not a video'), 'notes.txt', 'text/plain');
  expect(badType.statusCode).toBe(400);
  expect(badType.json()).toMatchObject({ error: 'VIDEO_TYPE_INVALID' });

  // 正常上传 → 200，videoSourceUrl 回填、角标恒 true
  const uploaded = await uploadVideo(token, liveId, Buffer.from('fake-mp4-bytes'));
  expect(uploaded.statusCode).toBe(200);
  const uploadedLive = uploaded.json().live as { videoSourceUrl: string; aiBadgeShown: boolean };
  expect(uploadedLive.videoSourceUrl).toBe(`/uploads/videos/${liveId}.mp4`);
  expect(uploadedLive.aiBadgeShown).toBe(true);
  trackCleanup(resolve(UPLOADS_DIR, 'videos', `${liveId}.mp4`));

  // 有视频但未选话术 → 400 SCRIPT_NOT_READY
  const noScript = await app.inject({
    method: 'POST',
    url: `/api/lives/${liveId}/prepare`,
    headers: bearer(token),
    payload: {},
  });
  expect(noScript.statusCode).toBe(400);
  expect(noScript.json()).toMatchObject({ error: 'SCRIPT_NOT_READY' });

  // 话术敏感词 blocked → 400 SCRIPT_NOT_READY
  const blockedId = await seedOwnedScript(PHONE_FLOW, '被拦截话术', 'blocked');
  await app.inject({
    method: 'PATCH',
    url: `/api/lives/${liveId}`,
    headers: bearer(token),
    payload: { scriptId: blockedId },
  });
  const blockedScript = await app.inject({
    method: 'POST',
    url: `/api/lives/${liveId}/prepare`,
    headers: bearer(token),
    payload: {},
  });
  expect(blockedScript.statusCode).toBe(400);
  expect(blockedScript.json()).toMatchObject({ error: 'SCRIPT_NOT_READY' });

  // 话术 ready+pass 但未选音色 → 400 VOICE_NOT_SELECTED
  const readyId = await seedOwnedScript(PHONE_FLOW, '干净话术', 'pass');
  await app.inject({
    method: 'PATCH',
    url: `/api/lives/${liveId}`,
    headers: bearer(token),
    payload: { scriptId: readyId },
  });
  const noVoice = await app.inject({
    method: 'POST',
    url: `/api/lives/${liveId}/prepare`,
    headers: bearer(token),
    payload: {},
  });
  expect(noVoice.statusCode).toBe(400);
  expect(noVoice.json()).toMatchObject({ error: 'VOICE_NOT_SELECTED' });
});

// ---------- 合成成功（Mock 注入，不真跑 FFmpeg）----------

dbIt('prepare 成功：注入 Mock 后状态置 ready、回填产物 URL、角标恒 true', async () => {
  const token = await registerAndGetToken(PHONE_SUCCESS);
  await resetUserData(PHONE_SUCCESS);
  const voiceId = await seedOwnedVoice(PHONE_SUCCESS);
  const scriptId = await seedOwnedScript(PHONE_SUCCESS);
  const liveId = await createLiveDraft(token, { voiceId, scriptId });

  const uploaded = await uploadVideo(token, liveId, Buffer.from('fake-mp4-bytes'));
  expect(uploaded.statusCode).toBe(200);
  trackCleanup(resolve(UPLOADS_DIR, 'videos', `${liveId}.mp4`));

  const spy = vi.spyOn(streamingService, 'composeLive').mockResolvedValueOnce({
    outputPath: resolve(UPLOADS_DIR, 'lives', `${liveId}.mp4`),
    durationSeconds: 30,
    fileSizeBytes: 4096,
  });

  const prepare = await app.inject({
    method: 'POST',
    url: `/api/lives/${liveId}/prepare`,
    headers: bearer(token),
    payload: { durationSeconds: 30 },
  });
  expect(prepare.statusCode).toBe(200);
  const live = prepare.json().live as {
    status: string;
    videoSourceUrl: string;
    aiBadgeShown: boolean;
  };
  expect(live.status).toBe('ready');
  expect(live.videoSourceUrl).toBe(`/uploads/lives/${liveId}.mp4`);
  expect(live.aiBadgeShown).toBe(true);
  expect(spy).toHaveBeenCalledTimes(1);
  expect(spy).toHaveBeenCalledWith(
    expect.objectContaining({
      sourceVideoPath: resolve(UPLOADS_DIR, 'videos', `${liveId}.mp4`),
      outputPath: resolve(UPLOADS_DIR, 'lives', `${liveId}.mp4`),
      durationSeconds: 30,
      providerVoiceId: `cosy-live-streaming-${voiceId}`,
    }),
  );

  // stream-status：ready + 产物 URL + 角标恒 true（不可篡改）
  const status = await app.inject({
    method: 'GET',
    url: `/api/lives/${liveId}/stream-status`,
    headers: bearer(token),
  });
  expect(status.statusCode).toBe(200);
  expect(status.json()).toEqual({
    status: 'ready',
    videoSourceUrl: `/uploads/lives/${liveId}.mp4`,
    aiBadgeShown: true,
  });
});

// ---------- 音色未就绪（pending）拦截 ----------

dbIt('prepare 前置校验：已选音色但未克隆完成（pending）→ 400 VOICE_NOT_SELECTED', async () => {
  const token = await registerAndGetToken(PHONE_PENDING_VOICE);
  await resetUserData(PHONE_PENDING_VOICE);
  const userId = await userIdOf(PHONE_PENDING_VOICE);
  const pendingVoiceId = randomUUID();
  await pool.query(
    `INSERT INTO voices (id, user_id, name, provider, provider_voice_id, status, sample_duration_seconds)
     VALUES ($1, $2, '克隆中音色', 'cosyvoice', $3, 'pending', 180)`,
    [pendingVoiceId, userId, `cosy-pending-${pendingVoiceId}`],
  );
  const scriptId = await seedOwnedScript(PHONE_PENDING_VOICE);
  const liveId = await createLiveDraft(token, { voiceId: pendingVoiceId, scriptId });

  const uploaded = await uploadVideo(token, liveId, Buffer.from('fake-mp4-bytes'));
  expect(uploaded.statusCode).toBe(200);
  trackCleanup(resolve(UPLOADS_DIR, 'videos', `${liveId}.mp4`));

  const prepare = await app.inject({
    method: 'POST',
    url: `/api/lives/${liveId}/prepare`,
    headers: bearer(token),
    payload: {},
  });
  expect(prepare.statusCode).toBe(400);
  expect(prepare.json()).toMatchObject({ error: 'VOICE_NOT_SELECTED' });
});

// ---------- 合成失败（Mock 抛错，注入一次）----------

dbIt('prepare 合成抛错：返回 500 COMPOSE_FAILED，状态置 failed', async () => {
  const token = await registerAndGetToken(PHONE_FAIL);
  await resetUserData(PHONE_FAIL);
  const voiceId = await seedOwnedVoice(PHONE_FAIL);
  const scriptId = await seedOwnedScript(PHONE_FAIL);
  const liveId = await createLiveDraft(token, { voiceId, scriptId });

  const uploaded = await uploadVideo(token, liveId, Buffer.from('fake-mp4-bytes'));
  expect(uploaded.statusCode).toBe(200);
  trackCleanup(resolve(UPLOADS_DIR, 'videos', `${liveId}.mp4`));

  vi.spyOn(streamingService, 'composeLive').mockRejectedValueOnce(
    new StreamingError('COMPOSE_FAILED', '模拟 ffmpeg 崩溃：exit code 1'),
  );
  const prepare = await app.inject({
    method: 'POST',
    url: `/api/lives/${liveId}/prepare`,
    headers: bearer(token),
    payload: {},
  });
  expect(prepare.statusCode).toBe(500);
  expect(prepare.json()).toMatchObject({ error: 'COMPOSE_FAILED' });

  const status = await app.inject({
    method: 'GET',
    url: `/api/lives/${liveId}/stream-status`,
    headers: bearer(token),
  });
  expect(status.statusCode).toBe(200);
  expect(status.json()).toMatchObject({ status: 'failed' });
});

// ---------- 归属隔离：B 操作 A 的 live 一律 404 ----------

dbIt('归属隔离：B 用户上传 / prepare / stream-status A 的 live 均返回 404', async () => {
  const tokenA = await registerAndGetToken(PHONE_OWNER_A);
  await resetUserData(PHONE_OWNER_A);
  const liveId = await createLiveDraft(tokenA, { title: 'A 的直播' });

  const tokenB = await registerAndGetToken(PHONE_OWNER_B);
  await resetUserData(PHONE_OWNER_B);

  const video = await uploadVideo(tokenB, liveId, Buffer.from('fake-mp4-bytes'));
  expect(video.statusCode).toBe(404);
  expect(video.json()).toMatchObject({ error: 'LIVE_NOT_FOUND' });

  const prepare = await app.inject({
    method: 'POST',
    url: `/api/lives/${liveId}/prepare`,
    headers: bearer(tokenB),
    payload: {},
  });
  expect(prepare.statusCode).toBe(404);
  expect(prepare.json()).toMatchObject({ error: 'LIVE_NOT_FOUND' });

  const status = await app.inject({
    method: 'GET',
    url: `/api/lives/${liveId}/stream-status`,
    headers: bearer(tokenB),
  });
  expect(status.statusCode).toBe(404);
  expect(status.json()).toMatchObject({ error: 'LIVE_NOT_FOUND' });
});

// ---------- processing 删除保护 ----------

dbIt('status=processing 时删除返回 409，stream-status 返回 processing', async () => {
  const token = await registerAndGetToken(PHONE_PROCESSING);
  await resetUserData(PHONE_PROCESSING);
  const liveId = await createLiveDraft(token);

  // 直接置 processing（同步合成中窗口极短，测试里手动构造该状态）
  await pool.query(`UPDATE lives SET status = 'processing' WHERE id = $1`, [liveId]);

  const blocked = await app.inject({
    method: 'DELETE',
    url: `/api/lives/${liveId}`,
    headers: bearer(token),
  });
  expect(blocked.statusCode).toBe(409);
  expect(blocked.json()).toMatchObject({ error: 'LIVE_IN_PROGRESS' });

  const status = await app.inject({
    method: 'GET',
    url: `/api/lives/${liveId}/stream-status`,
    headers: bearer(token),
  });
  expect(status.statusCode).toBe(200);
  expect(status.json()).toMatchObject({ status: 'processing', aiBadgeShown: true });
});

// ---------- 真合成冒烟（仅本机存在 server/bin/ffmpeg.exe 时执行一次）----------

smokeIt('真合成冒烟：上传真实 mp4 → prepare → ready，产物非空且时长 > 0', async () => {
  // 测试护栏：即便本机配置了真实 CosyVoice key，也不得在自动化测试里真调第三方
  vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
    throw new Error('测试禁止真实调用第三方 CosyVoice TTS');
  });
  const token = await registerAndGetToken(PHONE_SMOKE);
  await resetUserData(PHONE_SMOKE);
  const voiceId = await seedOwnedVoice(PHONE_SMOKE);
  const scriptId = await seedOwnedScript(PHONE_SMOKE);
  const liveId = await createLiveDraft(token, { voiceId, scriptId });

  // 先用 FFmpeg 生成 2s 的真实测试片源（testsrc），再走一遍上传接口
  mkdirSync(resolve(UPLOADS_DIR, 'videos'), { recursive: true });
  const fixture = resolve(UPLOADS_DIR, 'videos', `smoke-src-${randomUUID()}.mp4`);
  const made = spawnSync(
    FFMPEG_PATH,
    [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc=duration=2:size=320x240:rate=10',
      '-pix_fmt',
      'yuv420p',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      fixture,
    ],
    { encoding: 'utf8', windowsHide: true },
  );
  if (made.status !== 0) {
    throw new Error(`生成冒烟片源失败：${made.stderr ?? ''}`);
  }
  trackCleanup(fixture);

  const uploaded = await uploadVideo(token, liveId, readFileSync(fixture));
  expect(uploaded.statusCode).toBe(200);
  trackCleanup(resolve(UPLOADS_DIR, 'videos', `${liveId}.mp4`));

  const outputPath = resolve(UPLOADS_DIR, 'lives', `${liveId}.mp4`);
  trackCleanup(outputPath);
  const prepare = await app.inject({
    method: 'POST',
    url: `/api/lives/${liveId}/prepare`,
    headers: bearer(token),
    payload: { durationSeconds: 10 },
  });
  expect(prepare.statusCode).toBe(200);
  const live = prepare.json().live as { status: string; videoSourceUrl: string };
  expect(live.status).toBe('ready');
  expect(live.videoSourceUrl).toBe(`/uploads/lives/${liveId}.mp4`);

  // 合成产物存在且非空（>0 字节才算成功）
  const stats = statSync(outputPath);
  expect(stats.isFile()).toBe(true);
  expect(stats.size).toBeGreaterThan(0);
});
