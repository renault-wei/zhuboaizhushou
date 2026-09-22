import { afterAll, beforeEach, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { access, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../src/app';
import {
  MAX_REMOTE_SPEECH_JOBS_PER_LIVE,
  MAX_REMOTE_SPEECH_LOOKAHEAD_PER_LIVE,
  remoteSpeechQueue,
} from '../src/services/remoteSpeechQueue';
import { MAX_PENDING_BATCH } from '../src/routes/speechOut';
import {
  forgetSpeakerHeartbeat,
  secondsSinceSpeakerPull,
} from '../src/services/speakerHeartbeat';
import { createRemoteSpeechSink } from '../src/services/remoteSpeechSink';
import { createRemoteSpeechQueue } from '../src/services/remoteSpeechQueue';
import { readFile } from 'node:fs/promises';

// P1 手机线：远程出声端轮询拉取接口集成测试。
// 用假 wav 文件 + 直接向远程队列塞数据，验证「入队 → 拉取 → 流式返回 → 交付后删除」，
// 不依赖真实 TTS / 声卡 / 助播机客户端。

const app: FastifyInstance = buildApp();

afterAll(async () => {
  await app.close();
});

// 队列是模块级单例：每个用例前清空，避免相互污染
beforeEach(() => {
  remoteSpeechQueue.clear();
});

function makeToken(userId = 'speech-poller-1'): string {
  return app.jwt.sign({ userId });
}

async function makeWavFile(): Promise<string> {
  const wavPath = join(tmpdir(), `speech-out-test-${randomUUID()}.wav`);
  await writeFile(wavPath, 'RIFF-fake-wav-bytes');
  return wavPath;
}

function pullSpeech(token: string) {
  return app.inject({
    method: 'GET',
    url: '/api/out/speech/next',
    headers: { authorization: `Bearer ${token}` },
  });
}

function pullSpeechForLive(token: string, liveId: string) {
  return app.inject({
    method: 'GET',
    url: `/api/out/speech/next?liveId=${encodeURIComponent(liveId)}`,
    headers: { authorization: `Bearer ${token}` },
  });
}

it('未带登录态访问轮询接口返回 401', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/out/speech/next' });
  expect(res.statusCode).toBe(401);
});

it('空队列返回 204 无内容', async () => {
  const res = await pullSpeech(makeToken());
  expect(res.statusCode).toBe(204);
});

it('远程出声端 sink：入队成功视为交付（played），不删除 wav（生命周期归轮询接口）', async () => {
  const wavPath = await makeWavFile();
  const sink = createRemoteSpeechSink(remoteSpeechQueue);
  const outcome = await sink.play(wavPath);
  expect(outcome).toBe('played');
  expect(remoteSpeechQueue.size()).toBe(1);
  await expect(access(wavPath)).resolves.toBeUndefined();
});

it('R72：按队首取号 —— 返回 jobId 与 audioUrl（不再回字节），且文件不删', async () => {
  const firstWav = await makeWavFile();
  const secondWav = await makeWavFile();
  const firstId = remoteSpeechQueue.push(firstWav);
  remoteSpeechQueue.push(secondWav);
  expect(remoteSpeechQueue.size()).toBe(2);

  const res = await pullSpeech(makeToken());
  expect(res.statusCode).toBe(200);
  const body = res.json() as { jobId: string; audioUrl: string };
  expect(body.jobId).toBe(firstId);
  expect(body.audioUrl).toBe(`/api/out/speech/audio/${firstId}`);
  // 取号即出队 ✓
  expect(remoteSpeechQueue.size()).toBe(1);
  // ★ 关键：**文件必须还在** ✗ —— App 是稍后才拿这个 URL 来取的，
  //   删早了就是死链（这正是 R72 改掉的旧行为）
  await expect(access(firstWav)).resolves.toBeUndefined();
  await expect(access(secondWav)).resolves.toBeUndefined();
});

it('R72：按 audioUrl 能真正取到字节（受鉴权）', async () => {
  const wavPath = await makeWavFile();
  await writeFile(wavPath, 'RIFF-fake-wav-bytes');
  const jobId = remoteSpeechQueue.push(wavPath);

  const taken = await pullSpeech(makeToken());
  const { audioUrl } = taken.json() as { audioUrl: string };

  const audio = await app.inject({
    method: 'GET',
    url: audioUrl,
    headers: { authorization: `Bearer ${makeToken()}` },
  });
  expect(audio.statusCode).toBe(200);
  expect(audio.headers['content-type']).toContain('audio/wav');
  expect(audio.rawPayload.toString('utf8')).toBe('RIFF-fake-wav-bytes');
  expect(remoteSpeechQueue.findPath(jobId)).toBe(wavPath);
});

it('R72：未知 / 已回收的 jobId 取音频返回 404（客户端按「这条没了」跳过）', async () => {
  const audio = await app.inject({
    method: 'GET',
    url: '/api/out/speech/audio/does-not-exist',
    headers: { authorization: `Bearer ${makeToken()}` },
  });
  expect(audio.statusCode).toBe(404);
});

it('队列 FIFO：多次拉取按入队顺序返回', async () => {
  const firstWav = await makeWavFile();
  const secondWav = await makeWavFile();
  await writeFile(firstWav, 'first-wav');
  await writeFile(secondWav, 'second-wav');
  const firstId = remoteSpeechQueue.push(firstWav);
  const secondId = remoteSpeechQueue.push(secondWav);

  const first = await pullSpeech(makeToken());
  expect((first.json() as { jobId: string }).jobId).toBe(firstId);

  const second = await pullSpeech(makeToken());
  expect((second.json() as { jobId: string }).jobId).toBe(secondId);
});

// ---------- 按场次隔离（单台本多音色修复：多场并发时不互相插队） ----------

it('按 liveId 取件：只交付该场次最早一条，他场次积压不受影响', async () => {
  const wavA1 = await makeWavFile();
  const wavA2 = await makeWavFile();
  const wavB1 = await makeWavFile();
  await writeFile(wavA1, 'a-first');
  await writeFile(wavA2, 'a-second');
  await writeFile(wavB1, 'b-first');

  const idA1 = remoteSpeechQueue.push(wavA1, 'live-a');
  const idB1 = remoteSpeechQueue.push(wavB1, 'live-b');
  const idA2 = remoteSpeechQueue.push(wavA2, 'live-a');

  expect(remoteSpeechQueue.size()).toBe(3);
  expect(remoteSpeechQueue.size('live-a')).toBe(2);
  expect(remoteSpeechQueue.size('live-b')).toBe(1);

  // 取 live-a：拿到本场最早一条，且不动 live-b 的积压
  const first = await pullSpeechForLive(makeToken(), 'live-a');
  expect(first.statusCode).toBe(200);
  expect((first.json() as { jobId: string }).jobId).toBe(idA1);
  expect(remoteSpeechQueue.size('live-a')).toBe(1);
  expect(remoteSpeechQueue.size('live-b')).toBe(1);
  // ★R72：取号不删文件（App 稍后拿 audioUrl 来取）
  await expect(access(wavA1)).resolves.toBeUndefined();
  await expect(access(wavA2)).resolves.toBeUndefined();
  await expect(access(wavB1)).resolves.toBeUndefined();

  // 取 live-b：交付本场那条
  const second = await pullSpeechForLive(makeToken(), 'live-b');
  expect((second.json() as { jobId: string }).jobId).toBe(idB1);

  // 不带 liveId = 全局队首（旧口径兼容）：此时只剩 A2
  const rest = await pullSpeech(makeToken());
  expect((rest.json() as { jobId: string }).jobId).toBe(idA2);
  expect(remoteSpeechQueue.size()).toBe(0);
  // R72：取号不删文件 ✓
  await expect(access(wavA2)).resolves.toBeUndefined();
});

it('按 liveId 取件：该场次空队返回 204，不误取他场次', async () => {
  const wavB1 = await makeWavFile();
  await writeFile(wavB1, 'b-only');
  remoteSpeechQueue.push(wavB1, 'live-b');

  const empty = await pullSpeechForLive(makeToken(), 'live-a');
  expect(empty.statusCode).toBe(204);
  // 他场次积压原样保留
  expect(remoteSpeechQueue.size('live-b')).toBe(1);
});

// ---------- R53：助播机心跳 ----------
it('带 liveId 拉取会记一次心跳（供工作台显示「助播机掉线」）', async () => {
  const liveId = `hb-${randomUUID()}`;
  // 没拉过之前是 null —— 与「拉过但停了很久」必须区分开：
  // 前者是「助播机没开」（商家的选择），后者才是故障。
  expect(secondsSinceSpeakerPull(liveId)).toBeNull();

  const res = await pullSpeechForLive(makeToken(), liveId);
  expect(res.statusCode).toBe(204); // 空队列

  const elapsed = secondsSinceSpeakerPull(liveId);
  expect(elapsed).not.toBeNull();
  expect(elapsed).toBeLessThan(5);

  forgetSpeakerHeartbeat(liveId);
  expect(secondsSinceSpeakerPull(liveId)).toBeNull();
});

// ---------- R61：待播清单（本地缓冲用） ----------
// 设计规格 docs/superpowers/specs/2026-09-21-speaker-local-buffer-design.md
function pullPending(token: string, liveId?: string) {
  const suffix = liveId === undefined ? '' : `?liveId=${encodeURIComponent(liveId)}`;
  return app.inject({
    method: 'GET',
    url: `/api/out/speech/pending${suffix}`,
    headers: { authorization: `Bearer ${token}` },
  });
}

it('R61：未带登录态问清单返回 401', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/out/speech/pending' });
  expect(res.statusCode).toBe(401);
});

it('R61：空队列返回空清单与 maxBatch', async () => {
  const res = await pullPending(makeToken());
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ items: [], maxBatch: MAX_PENDING_BATCH });
});

it('R61：清单按场次过滤，且单次不超过 maxBatch（只读，不取走）', async () => {
  const liveA = `pend-a-${randomUUID()}`;
  const liveB = `pend-b-${randomUUID()}`;
  // A 场 12 条（超过 maxBatch），B 场 1 条
  for (let index = 0; index < 12; index += 1) {
    remoteSpeechQueue.push(await makeWavFile(), liveA);
  }
  remoteSpeechQueue.push(await makeWavFile(), liveB);

  const resA = await pullPending(makeToken(), liveA);
  const bodyA = resA.json() as { items: unknown[]; maxBatch: number };
  expect(bodyA.items).toHaveLength(MAX_PENDING_BATCH);
  expect(bodyA.maxBatch).toBe(MAX_PENDING_BATCH);

  const resB = await pullPending(makeToken(), liveB);
  expect((resB.json() as { items: unknown[] }).items).toHaveLength(1);

  // ★ 关键：问清单【不取走】—— 队列条数一点没少
  expect(remoteSpeechQueue.size(liveA)).toBe(12);
  expect(remoteSpeechQueue.size(liveB)).toBe(1);
});

// ---------- R77：条间间隔（gapAfterSeconds）随条目下发到播放端 ----------
// 2026-09-22 真机实测「语音队列循环过快、似乎没有等待」：
//   间隔原先只在生产端（loopCaster 里 await sleep(gap)），而远程 speak 是入队即返回 ——
//   台本 ~1 秒/条 灌进队列、播放端 6.8 秒才念完一条 → 队列被灌满、播放端背靠背念，
//   台本里那点间隔被队列吸收干净。修法：间隔跟着条目走到播放端（竞品 bgAudio.onEnded 同款）。

it('R77：入队时的间隔随取号一起下发（播放端据此在两条之间等待）', async () => {
  const wavPath = await makeWavFile();
  remoteSpeechQueue.push(wavPath, 'live-gap', 1.5);

  const res = await pullSpeechForLive(makeToken(), 'live-gap');
  expect(res.statusCode).toBe(200);
  const body = res.json() as { jobId: string; gapAfterSeconds: number };
  expect(body.gapAfterSeconds).toBe(1.5);
});

it('R77：未指定间隔时默认 0（插播的回复 / 氛围语不该被拖住）', async () => {
  const wavPath = await makeWavFile();
  remoteSpeechQueue.push(wavPath, 'live-gap0');

  const res = await pullSpeechForLive(makeToken(), 'live-gap0');
  const body = res.json() as { gapAfterSeconds: number };
  expect(body.gapAfterSeconds).toBe(0);
});

it('R77：远程 sink 把间隔一并入队（speak → sink.play(wav, liveId, gap) 一路透传）', async () => {
  const wavPath = await makeWavFile();
  const sink = createRemoteSpeechSink(remoteSpeechQueue);
  await sink.play(wavPath, 'live-sink', 2);

  const res = await pullSpeechForLive(makeToken(), 'live-sink');
  const body = res.json() as { gapAfterSeconds: number };
  expect(body.gapAfterSeconds).toBe(2);
});

// 水位：前瞻（节奏）与硬上界（防线）必须分开，否则队列会一直钉在硬上界 ——
// 台本永远在灌几分钟后的台词、队列持续淘汰最旧的条目，而助播机永远在念很久以前的话 ✗
it('R77：播放前瞻远小于硬上界（生产端由消费速度反压，不是灌满才停）', () => {
  expect(MAX_REMOTE_SPEECH_LOOKAHEAD_PER_LIVE).toBe(2);
  expect(MAX_REMOTE_SPEECH_LOOKAHEAD_PER_LIVE).toBeLessThan(
    MAX_REMOTE_SPEECH_JOBS_PER_LIVE,
  );
});

// ---------- R-C2：**服务重启不再把在途 URL 打成死链** ----------
// 2026-09-22 真机「突然没声音」：files 表是内存态，重启即清空 →
// 之前发出去的 URL 全 404，而播放器对着 404 死重试（同一 URL 连取 13 次）✗
it('R-C2：registerFile 登记过的 URL 在**服务重启后**依然可取（不依赖内存表）', async () => {
  const wavPath = await makeWavFile();
  await writeFile(wavPath, 'R-C2-survives-restart');
  const before = createRemoteSpeechQueue();
  const jobId = before.registerFile(wavPath);

  // 新的队列实例 = 重启后那份「空的内存表」✓
  const after = createRemoteSpeechQueue();
  const resolved = after.findPath(jobId);
  expect(resolved).toBeTruthy();
  expect(await readFile(resolved as string, 'utf8')).toBe('R-C2-survives-restart');
});

it('R-C2：jobId 形状不合法（路径穿越）直接 404，不去碰文件系统', async () => {
  for (const bad of ['..%2F..%2Fetc%2Fpasswd', 'not-a-uuid', '../../etc/passwd']) {
    const res = await app.inject({
      method: 'GET',
      url: `/api/out/speech/audio/${bad}`,
      headers: { authorization: `Bearer ${makeToken()}` },
    });
    expect(res.statusCode).toBe(404);
  }
});

// ---------- R-C：C 的两条新通道（客户端持游标：按序号取货 + 空档取插播） ----------
// 对照竞品：它的 makeAudio 请求体带 xuhao（要第几条），序号由**客户端**点名 ✓
// 我们此前是生产端灌队列、客户端取队首 —— 位置归生产端，于是显示的位置 ≠ 听众的位置 ✗

it('R-C：registerFile 登记的文件可通过 /audio/:jobId 取到（与 push 共用同一套回收）', async () => {
  const wavPath = await makeWavFile();
  await writeFile(wavPath, 'R-C-on-demand-bytes');
  const jobId = remoteSpeechQueue.registerFile(wavPath);
  // 不进交付队列 —— C 之后客户端是「点名要货」，不再从队列里取走 ✓
  expect(remoteSpeechQueue.size()).toBe(0);
  expect(remoteSpeechQueue.findPath(jobId)).toBe(wavPath);

  const audio = await app.inject({
    method: 'GET',
    url: `/api/out/speech/audio/${jobId}`,
    headers: { authorization: `Bearer ${makeToken()}` },
  });
  expect(audio.statusCode).toBe(200);
  expect(audio.rawPayload.toString('utf8')).toBe('R-C-on-demand-bytes');
});

it('R-C：/item 未带登录态 401；缺 liveId / seq 或 seq 非正整数一律 400', async () => {
  const anonymous = await app.inject({
    method: 'GET',
    url: '/api/out/speech/item?liveId=x&seq=1',
  });
  expect(anonymous.statusCode).toBe(401);

  const token = makeToken();
  const headers = { authorization: `Bearer ${token}` };
  const noLive = await app.inject({ method: 'GET', url: '/api/out/speech/item?seq=1', headers });
  expect(noLive.statusCode).toBe(400);
  const noSeq = await app.inject({ method: 'GET', url: '/api/out/speech/item?liveId=x', headers });
  expect(noSeq.statusCode).toBe(400);
  const zeroSeq = await app.inject({
    method: 'GET',
    url: '/api/out/speech/item?liveId=x&seq=0',
    headers,
  });
  expect(zeroSeq.statusCode).toBe(400);
});

it('R-C：/insertion 未带登录态 401；缺 liveId 400', async () => {
  const anonymous = await app.inject({
    method: 'GET',
    url: '/api/out/speech/insertion?liveId=x',
  });
  expect(anonymous.statusCode).toBe(401);

  const missing = await app.inject({
    method: 'GET',
    url: '/api/out/speech/insertion',
    headers: { authorization: `Bearer ${makeToken()}` },
  });
  expect(missing.statusCode).toBe(400);
});

