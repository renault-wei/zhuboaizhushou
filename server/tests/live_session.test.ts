import { afterAll, afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { pool } from '../src/db/client';
import { loopCaster } from '../src/services/loopCaster';
import { liveSpeaker } from '../src/services/liveSpeaker';

const app: FastifyInstance = buildApp();

// 探测数据库连通性，决定依赖数据库的用例是否执行
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

// 各场景固定手机号（互不共用，避免短信重发限制与历史数据串扰）
const PHONE_START = '13920000302'; // 开播流程
const PHONE_END = '13920000303'; // 结束流程
const PHONE_MONITOR = '13920000304'; // 监控 + 弹幕
const PHONE_OWNER_A = '13920000305'; // 归属隔离 A
const PHONE_OWNER_B = '13920000306'; // 归属隔离 B
const PHONE_LOOP = '13920000307'; // M5 循环播报接线

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

/** 复位：清空该用户的 lives（级联清 live_danmaku）/ scripts / voices */
async function resetUserData(phone: string): Promise<void> {
  const userId = await userIdOf(phone);
  await pool.query('DELETE FROM loop_scripts WHERE user_id = $1', [userId]);
  await pool.query('DELETE FROM lives WHERE user_id = $1', [userId]);
  await pool.query('DELETE FROM scripts WHERE user_id = $1', [userId]);
  await pool.query('DELETE FROM voices WHERE user_id = $1', [userId]);
}

function bearer(token: string): { authorization: string } {
  return { authorization: `Bearer ${token}` };
}

/** 用一个已登录 token 创建一条开播配置草稿（断言 201），返回 live.id */
async function createLiveDraft(token: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/lives',
    headers: bearer(token),
    payload: { title: '火锅店午市循环直播' },
  });
  expect(res.statusCode).toBe(201);
  const body = res.json() as { live: { id: string } };
  return body.live.id;
}

/** 直接把草稿置为指定状态（绕过 prepare/FFmpeg），可带 startedAt/endedAt 偏移 */
async function setLiveStatus(
  liveId: string,
  status: string,
  opts: { startedSecondsAgo?: number; endedSecondsAgo?: number; videoSourceUrl?: string } = {},
): Promise<void> {
  const startedAt =
    opts.startedSecondsAgo !== undefined
      ? new Date(Date.now() - opts.startedSecondsAgo * 1000)
      : null;
  const endedAt =
    opts.endedSecondsAgo !== undefined ? new Date(Date.now() - opts.endedSecondsAgo * 1000) : null;
  await pool.query(
    `UPDATE lives
        SET status = $1,
            started_at = COALESCE($2, started_at),
            ended_at = COALESCE($3, ended_at),
            video_source_url = COALESCE($4, video_source_url)
      WHERE id = $5`,
    [status, startedAt, endedAt, opts.videoSourceUrl ?? null, liveId],
  );
}

/** 直接往 live_danmaku 表 seed 弹幕（T13 只读，真实来源待抖音接入） */
async function seedDanmaku(
  liveId: string,
  entries: Array<{ content: string; nickname?: string; sentSecondsAgo?: number }>,
): Promise<void> {
  for (const entry of entries) {
    const sentAt = new Date(Date.now() - (entry.sentSecondsAgo ?? 0) * 1000);
    await pool.query(
      `INSERT INTO live_danmaku (id, live_id, content, sender_nickname, sent_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [randomUUID(), liveId, entry.content, entry.nickname ?? null, sentAt],
    );
  }
}

// ---------- 未登录 401 ----------

it('未带 token 访问 start / end / monitor / danmaku 均返回 401', async () => {
  const id = randomUUID();
  for (const [method, url] of [
    ['POST', `/api/lives/${id}/start`],
    ['POST', `/api/lives/${id}/end`],
    ['GET', `/api/lives/${id}/monitor`],
    ['GET', `/api/lives/${id}/danmaku`],
  ] as const) {
    const res = await app.inject({ method, url, payload: method === 'POST' ? {} : undefined });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: 'UNAUTHORIZED' });
  }
});

// ---------- 开播 / 结束状态机 ----------

dbIt('start：idle 草稿不可开播（400 LIVE_NOT_READY），ready 可开播（200 → live + startedAt）', async () => {
  const token = await registerAndGetToken(PHONE_START);
  await resetUserData(PHONE_START);
  const liveId = await createLiveDraft(token);

  // idle 直接开播 → 400 LIVE_NOT_READY
  const notReady = await app.inject({
    method: 'POST',
    url: `/api/lives/${liveId}/start`,
    headers: bearer(token),
    payload: {},
  });
  expect(notReady.statusCode).toBe(400);
  expect(notReady.json()).toMatchObject({ error: 'LIVE_NOT_READY' });

  // 置 ready 后开播 → 200 + status=live + startedAt 非空 + 角标恒 true
  await setLiveStatus(liveId, 'ready', { videoSourceUrl: `/uploads/lives/${liveId}.mp4` });
  const started = await app.inject({
    method: 'POST',
    url: `/api/lives/${liveId}/start`,
    headers: bearer(token),
    payload: {},
  });
  expect(started.statusCode).toBe(200);
  const live = started.json().live as { status: string; startedAt: string | null; aiBadgeShown: boolean };
  expect(live.status).toBe('live');
  expect(live.startedAt).toBeTruthy();
  expect(live.aiBadgeShown).toBe(true);
});

dbIt('end：ready 不可结束（400 LIVE_NOT_LIVE），live 可结束（200 → ended + endedAt）', async () => {
  const token = await registerAndGetToken(PHONE_END);
  await resetUserData(PHONE_END);
  const liveId = await createLiveDraft(token);

  // ready 直接结束 → 400 LIVE_NOT_LIVE
  await setLiveStatus(liveId, 'ready');
  const notLive = await app.inject({
    method: 'POST',
    url: `/api/lives/${liveId}/end`,
    headers: bearer(token),
    payload: {},
  });
  expect(notLive.statusCode).toBe(400);
  expect(notLive.json()).toMatchObject({ error: 'LIVE_NOT_LIVE' });

  // 置 live 后结束 → 200 + status=ended + endedAt 非空
  await setLiveStatus(liveId, 'live', { startedSecondsAgo: 30 });
  const ended = await app.inject({
    method: 'POST',
    url: `/api/lives/${liveId}/end`,
    headers: bearer(token),
    payload: {},
  });
  expect(ended.statusCode).toBe(200);
  const live = ended.json().live as { status: string; endedAt: string | null; startedAt: string | null };
  expect(live.status).toBe('ended');
  expect(live.endedAt).toBeTruthy();
  expect(live.startedAt).toBeTruthy();
});

// ---------- 监控快照 + 弹幕 ----------

dbIt('monitor：ready 时长 0；live 时长按 startedAt 累计；弹幕计数正确', async () => {
  const token = await registerAndGetToken(PHONE_MONITOR);
  await resetUserData(PHONE_MONITOR);
  const liveId = await createLiveDraft(token);

  // ready 状态：durationSeconds = 0
  await setLiveStatus(liveId, 'ready', { videoSourceUrl: `/uploads/lives/${liveId}.mp4` });
  const readyMonitor = await app.inject({
    method: 'GET',
    url: `/api/lives/${liveId}/monitor`,
    headers: bearer(token),
  });
  expect(readyMonitor.statusCode).toBe(200);
  expect(readyMonitor.json()).toMatchObject({ status: 'ready', durationSeconds: 0, aiBadgeShown: true });

  // 置 live（5 秒前开播）+ seed 2 条弹幕
  await setLiveStatus(liveId, 'live', { startedSecondsAgo: 5 });
  await seedDanmaku(liveId, [
    { content: '这个套餐划算吗', nickname: '路人甲', sentSecondsAgo: 2 },
    { content: '主播在吗', nickname: '路人乙', sentSecondsAgo: 1 },
  ]);
  const liveMonitor = await app.inject({
    method: 'GET',
    url: `/api/lives/${liveId}/monitor`,
    headers: bearer(token),
  });
  expect(liveMonitor.statusCode).toBe(200);
  const monitor = liveMonitor.json() as {
    status: string;
    durationSeconds: number;
    danmakuCount: number;
    aiBadgeShown: boolean;
  };
  expect(monitor.status).toBe('live');
  expect(monitor.durationSeconds).toBeGreaterThanOrEqual(5);
  expect(monitor.danmakuCount).toBe(2);
  expect(monitor.aiBadgeShown).toBe(true);
});

dbIt('danmaku：按 sentAt 倒序返回，limit 生效', async () => {
  const token = await registerAndGetToken(PHONE_MONITOR);
  await resetUserData(PHONE_MONITOR);
  const liveId = await createLiveDraft(token);

  // 空列表
  const empty = await app.inject({
    method: 'GET',
    url: `/api/lives/${liveId}/danmaku`,
    headers: bearer(token),
  });
  expect(empty.statusCode).toBe(200);
  expect(empty.json()).toEqual([]);

  // seed 3 条，sentSecondsAgo 越大越早（sentAt 越旧）
  await seedDanmaku(liveId, [
    { content: '最早', sentSecondsAgo: 30 },
    { content: '居中', sentSecondsAgo: 20 },
    { content: '最新', sentSecondsAgo: 10 },
  ]);

  const all = await app.inject({
    method: 'GET',
    url: `/api/lives/${liveId}/danmaku`,
    headers: bearer(token),
  });
  expect(all.statusCode).toBe(200);
  const list = all.json() as Array<{ content: string; senderNickname: string | null; sentAt: string }>;
  expect(list).toHaveLength(3);
  // 最新（sentSecondsAgo=10）应排最前
  expect(list[0].content).toBe('最新');
  expect(list[2].content).toBe('最早');

  // limit=2
  const limited = await app.inject({
    method: 'GET',
    url: `/api/lives/${liveId}/danmaku?limit=2`,
    headers: bearer(token),
  });
  expect(limited.json()).toHaveLength(2);
});

// ---------- 归属隔离 ----------

dbIt('归属隔离：B 用户 start / end / monitor / danmaku A 的 live 均 404', async () => {
  const tokenA = await registerAndGetToken(PHONE_OWNER_A);
  await resetUserData(PHONE_OWNER_A);
  const liveId = await createLiveDraft(tokenA);
  await setLiveStatus(liveId, 'ready');

  const tokenB = await registerAndGetToken(PHONE_OWNER_B);
  await resetUserData(PHONE_OWNER_B);

  for (const [method, url] of [
    ['POST', `/api/lives/${liveId}/start`],
    ['POST', `/api/lives/${liveId}/end`],
    ['GET', `/api/lives/${liveId}/monitor`],
    ['GET', `/api/lives/${liveId}/danmaku`],
  ] as const) {
    const res = await app.inject({
      method,
      url,
      headers: bearer(tokenB),
      payload: method === 'POST' ? {} : undefined,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: 'LIVE_NOT_FOUND' });
  }
});

// ---------- 删除保护回归 ----------

dbIt('status=live 时删除返回 409（删除保护沿用）', async () => {
  const token = await registerAndGetToken(PHONE_START);
  await resetUserData(PHONE_START);
  const liveId = await createLiveDraft(token);
  await setLiveStatus(liveId, 'live', { startedSecondsAgo: 10 });

  const blocked = await app.inject({
    method: 'DELETE',
    url: `/api/lives/${liveId}`,
    headers: bearer(token),
  });
  expect(blocked.statusCode).toBe(409);
  expect(blocked.json()).toMatchObject({ error: 'LIVE_IN_PROGRESS' });
});
// ---------- M5 循环播报接线（loopCaster 生命周期随 start/end 驱动） ----------

/** 直接 seed 一条归属该用户的循环台本（1 条安全文案）并绑定到 live，绕过 DeepSeek / 敏感扫描 */
async function seedBoundLoopScript(phone: string, liveId: string): Promise<void> {
  const userId = await userIdOf(phone);
  const scriptId = randomUUID();
  const itemId = randomUUID();
  await pool.query(`INSERT INTO loop_scripts (id, user_id, title) VALUES ($1, $2, $3)`, [
    scriptId,
    userId,
    '火锅循环台本（测试）',
  ]);
  await pool.query(
    `INSERT INTO loop_script_items (id, loop_script_id, seq, kind, text, gap_after_seconds)
     VALUES ($1, $2, 1, 'product', $3, 1)`,
    [itemId, scriptId, '本店招牌毛肚套餐，欢迎到店品尝。'],
  );
  await pool.query(`UPDATE lives SET loop_script_id = $1 WHERE id = $2`, [scriptId, liveId]);
}

/** 轮询 monitor 直到谓词满足；Runner 异步启动，/start 返回时可能尚未 running（超时抛错防挂死） */
async function waitMonitorUntil(
  token: string,
  liveId: string,
  predicate: (monitor: Record<string, unknown>) => boolean,
  timeoutMs = 4000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await app.inject({
      method: 'GET',
      url: `/api/lives/${liveId}/monitor`,
      headers: bearer(token),
    });
    expect(res.statusCode).toBe(200);
    const monitor = res.json() as Record<string, unknown>;
    if (predicate(monitor)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`monitor 条件未在 ${timeoutMs}ms 内满足`);
}

dbIt('M5 接线：未绑台本 start 后 loopMissing=true；绑定台本 start 启 Runner（替身拦截出声）、end 停', async () => {
  const token = await registerAndGetToken(PHONE_LOOP);
  await resetUserData(PHONE_LOOP);
  // 出声链路替身：绝不在测试里真发声（引擎会把台本句推到 liveSpeaker，但被吞掉）
  const speakSpy = vi.spyOn(liveSpeaker, 'speak').mockResolvedValue({
    spoken: false,
    reason: 'disabled',
  });

  // 场景 1：未绑定循环台本 → 开播只回弹幕（Runner 空快照自动退出）
  const unboundId = await createLiveDraft(token);
  await setLiveStatus(unboundId, 'ready', { videoSourceUrl: `/uploads/lives/${unboundId}.mp4` });
  const startUnbound = await app.inject({
    method: 'POST',
    url: `/api/lives/${unboundId}/start`,
    headers: bearer(token),
    payload: {},
  });
  expect(startUnbound.statusCode).toBe(200);
  const unboundMonitor = await app.inject({
    method: 'GET',
    url: `/api/lives/${unboundId}/monitor`,
    headers: bearer(token),
  });
  expect(unboundMonitor.statusCode).toBe(200);
  expect(unboundMonitor.json()).toMatchObject({
    status: 'live',
    loopRunning: false,
    loopRound: 0,
    loopCurrentSeq: 0,
    loopMissing: true,
  });
  await app.inject({
    method: 'POST',
    url: `/api/lives/${unboundId}/end`,
    headers: bearer(token),
    payload: {},
  });

  // 场景 2：绑定台本开播 → 引擎真实启动（循环口播被 speakSpy 拦截）；end → Runner 停
  const boundId = await createLiveDraft(token);
  await setLiveStatus(boundId, 'ready', { videoSourceUrl: `/uploads/lives/${boundId}.mp4` });
  await seedBoundLoopScript(PHONE_LOOP, boundId);
  try {
    const startBound = await app.inject({
      method: 'POST',
      url: `/api/lives/${boundId}/start`,
      headers: bearer(token),
      payload: {},
    });
    expect(startBound.statusCode).toBe(200);

    await waitMonitorUntil(token, boundId, (monitor) => monitor.loopRunning === true);
    const runningMonitor = await app.inject({
      method: 'GET',
      url: `/api/lives/${boundId}/monitor`,
      headers: bearer(token),
    });
    const running = runningMonitor.json() as {
      status: string;
      loopRunning: boolean;
      loopMissing: boolean;
      loopRound: number;
    };
    expect(running.status).toBe('live');
    expect(running.loopRunning).toBe(true);
    expect(running.loopMissing).toBe(false);
    expect(running.loopRound).toBeGreaterThanOrEqual(1);
    // 引擎确实把台本句交到出声链路（替身吞掉，未真发声）
    expect(speakSpy).toHaveBeenCalled();

    const endBound = await app.inject({
      method: 'POST',
      url: `/api/lives/${boundId}/end`,
      headers: bearer(token),
      payload: {},
    });
    expect(endBound.statusCode).toBe(200);
    const endedMonitor = await app.inject({
      method: 'GET',
      url: `/api/lives/${boundId}/monitor`,
      headers: bearer(token),
    });
    expect(endedMonitor.json()).toMatchObject({
      status: 'ended',
      loopRunning: false,
      loopCurrentSeq: 0,
    });
  } finally {
    // 兜底：无论断言走到哪一步都确保停掉 Runner，避免污染同文件后续用例
    loopCaster.stop(boundId);
  }
});