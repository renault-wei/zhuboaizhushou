import { afterAll, beforeEach, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { access, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../src/app';
import { remoteSpeechQueue } from '../src/services/remoteSpeechQueue';
import { createRemoteSpeechSink } from '../src/services/remoteSpeechSink';

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

async function waitForDeleted(wavPath: string): Promise<void> {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    try {
      await access(wavPath);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('交付后文件未被删除（等待超时）');
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

it('按队首逐条交付：返回 wav 字节与 jobId，交付后删除对应文件', async () => {
  const firstWav = await makeWavFile();
  const secondWav = await makeWavFile();
  const firstId = remoteSpeechQueue.push(firstWav);
  remoteSpeechQueue.push(secondWav);
  expect(remoteSpeechQueue.size()).toBe(2);

  const res = await pullSpeech(makeToken());
  expect(res.statusCode).toBe(200);
  expect(res.headers['content-type']).toContain('audio/wav');
  expect(res.headers['x-speech-job-id']).toBe(firstId);
  expect(res.headers['cache-control']).toBe('no-store');
  expect(res.rawPayload.toString('utf8')).toBe('RIFF-fake-wav-bytes');
  expect(remoteSpeechQueue.size()).toBe(1);
  await waitForDeleted(firstWav);
  // 第二条仍在队内且文件未被误删
  await expect(access(secondWav)).resolves.toBeUndefined();
  expect(remoteSpeechQueue.size()).toBe(1);
});

it('队列 FIFO：多次拉取按入队顺序返回', async () => {
  const firstWav = await makeWavFile();
  const secondWav = await makeWavFile();
  await writeFile(firstWav, 'first-wav');
  await writeFile(secondWav, 'second-wav');
  const firstId = remoteSpeechQueue.push(firstWav);
  const secondId = remoteSpeechQueue.push(secondWav);

  const first = await pullSpeech(makeToken());
  expect(first.headers['x-speech-job-id']).toBe(firstId);
  expect(first.rawPayload.toString('utf8')).toBe('first-wav');
  await waitForDeleted(firstWav);

  const second = await pullSpeech(makeToken());
  expect(second.headers['x-speech-job-id']).toBe(secondId);
  expect(second.rawPayload.toString('utf8')).toBe('second-wav');
  await waitForDeleted(secondWav);
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
  expect(first.headers['x-speech-job-id']).toBe(idA1);
  expect(first.rawPayload.toString('utf8')).toBe('a-first');
  expect(remoteSpeechQueue.size('live-a')).toBe(1);
  expect(remoteSpeechQueue.size('live-b')).toBe(1);
  await waitForDeleted(wavA1);
  await expect(access(wavA2)).resolves.toBeUndefined();
  await expect(access(wavB1)).resolves.toBeUndefined();

  // 取 live-b：交付本场那条
  const second = await pullSpeechForLive(makeToken(), 'live-b');
  expect(second.headers['x-speech-job-id']).toBe(idB1);
  expect(second.rawPayload.toString('utf8')).toBe('b-first');
  await waitForDeleted(wavB1);

  // 不带 liveId = 全局队首（旧口径兼容）：此时只剩 A2
  const rest = await pullSpeech(makeToken());
  expect(rest.headers['x-speech-job-id']).toBe(idA2);
  expect(remoteSpeechQueue.size()).toBe(0);
  await waitForDeleted(wavA2);
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
