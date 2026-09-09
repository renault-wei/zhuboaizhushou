import { afterAll, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pool } from '../src/db/client';
import {
  buildTtsCacheRelativePath,
  computeTextSha256,
  countTtsChars,
  findCachedTtsAudio,
  pruneCachedTtsAudio,
  storeCachedTtsAudio,
} from '../src/services/ttsCache';

// T3 TTS 分句缓存服务测试：
// - 纯函数用例（指纹/计数/路径）不依赖数据库，任何环境都跑；
// - 落库 + 产物文件用例走 DB 探测（库不可用时静默 skip，避免 CI 误报）。

let dbAvailable = false;
try {
  await pool.query('SELECT 1');
  dbAvailable = true;
} catch {
  dbAvailable = false;
}
const dbIt = dbAvailable ? it : it.skip;

/** 测试期自建用户与临时源音频，afterAll 统一回收 */
const createdUsers: string[] = [];
const createdSrcDirs: string[] = [];
const cachedFiles: string[] = [];

async function createTestUser(): Promise<string> {
  const phone = `139${randomUUID().replace(/-/g, '').slice(0, 8)}`;
  const rows = await pool.query('INSERT INTO users (phone) VALUES ($1) RETURNING id', [phone]);
  const userId = rows.rows[0]?.id as string | undefined;
  if (!userId) {
    throw new Error('测试用户创建失败');
  }
  createdUsers.push(userId);
  return userId;
}

function makeSourceWav(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'starvoice-cache-src-'));
  createdSrcDirs.push(dir);
  const path = join(dir, 'src.wav');
  writeFileSync(path, Buffer.from(`RIFF-${content}`, 'utf8'));
  return path;
}

async function cacheRowCount(userId: string): Promise<number> {
  const rows = await pool.query(
    'SELECT count(*)::int AS n FROM tts_audio_cache WHERE user_id = $1',
    [userId],
  );
  return rows.rows[0]?.n as number;
}

afterAll(async () => {
  for (const userId of createdUsers) {
    await pool.query('DELETE FROM users WHERE id = $1', [userId]).catch(() => undefined);
  }
  for (const file of cachedFiles) {
    rmSync(file, { force: true });
  }
  for (const dir of createdSrcDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  await pool.end().catch(() => undefined);
});

// ---------- 纯函数：指纹 / 字符计数 / 相对路径 ----------

it('文本指纹：同文同指纹、trim 后稳定、改字即变', () => {
  expect(computeTextSha256('欢迎光临本店')).toBe(computeTextSha256('  欢迎光临本店  '));
  expect(computeTextSha256('欢迎光临本店')).not.toBe(computeTextSha256('欢迎光临本店啊'));
});

it('字符计数：trim 后按 Unicode 码点计数（中文/emoji 均算 1）', () => {
  expect(countTtsChars('  欢迎光临  ')).toBe(4);
  expect(countTtsChars('🍲火锅店')).toBe(4);
  expect(countTtsChars('')).toBe(0);
});

it('缓存相对路径：含用户目录 + 音色哈希段 + 文本指纹，音色不同路径不同', () => {
  const userId = 'u-12345678-1234-1234-1234-123456789abc';
  const shaA = computeTextSha256('欢迎光临');
  const p1 = buildTtsCacheRelativePath(userId, 'zh_female_vv_uranus_bigtts', shaA);
  const p2 = buildTtsCacheRelativePath(userId, 'voice-clone-abc', shaA);
  expect(p1).toContain(userId);
  expect(p1).toContain(`${shaA}.wav`);
  expect(p1).not.toBe(p2);
  expect(p1.split('/')).toHaveLength(4);
});

// ---------- 落库 + 产物：命中旁路 / 键互斥 / 懒清理（依赖数据库）----------

dbIt('store 后同键命中：返回同一产物文件且不重复插行', async () => {
  const userId = await createTestUser();
  const voiceKey = 'zh_female_vv_uranus_bigtts';
  const text = '欢迎光临本店，今天锅底五折';
  const src = makeSourceWav(text);
  const first = await storeCachedTtsAudio({ userId, voiceKey, rate: 0, text }, src);
  expect(first).not.toBeNull();
  expect(existsSync(first?.audioPath ?? '')).toBe(true);
  cachedFiles.push(first?.audioPath ?? '');

  const hit = await findCachedTtsAudio({ userId, voiceKey, rate: 0, text });
  expect(hit).not.toBeNull();
  expect(hit?.audioPath).toBe(first?.audioPath);
  expect(hit?.chars).toBe(countTtsChars(text));

  const again = await storeCachedTtsAudio({ userId, voiceKey, rate: 0, text }, src);
  expect(again?.audioPath).toBe(first?.audioPath);
  expect(await cacheRowCount(userId)).toBe(1);
});

dbIt('键互斥：改字 / 换音色 / 换语速都算 miss', async () => {
  const userId = await createTestUser();
  const base = { userId, voiceKey: 'zh_female_vv_uranus_bigtts', rate: 0, text: '锅底半价' };
  const src = makeSourceWav(base.text);
  const stored = await storeCachedTtsAudio(base, src);
  cachedFiles.push(stored?.audioPath ?? '');

  expect(await findCachedTtsAudio({ ...base, text: '锅底五折' })).toBeNull();
  expect(
    await findCachedTtsAudio({ ...base, voiceKey: 'zh_male_m191_uranus_bigtts' }),
  ).toBeNull();
  expect(await findCachedTtsAudio({ ...base, rate: 10 })).toBeNull();
  expect(await findCachedTtsAudio(base)).not.toBeNull();
  expect(await cacheRowCount(userId)).toBe(1);
});

dbIt('懒清理：裁剪到 keepMax 且顺带删除被裁产物文件', async () => {
  const userId = await createTestUser();
  const voiceKey = 'zh_female_vv_uranus_bigtts';
  const texts = ['第一条口播', '第二条口播', '第三条口播'];
  const paths: string[] = [];
  for (const text of texts) {
    const src = makeSourceWav(text);
    const entry = await storeCachedTtsAudio({ userId, voiceKey, rate: 0, text }, src);
    paths.push(entry?.audioPath ?? '');
    cachedFiles.push(entry?.audioPath ?? '');
  }
  expect(await cacheRowCount(userId)).toBe(3);

  const removed = await pruneCachedTtsAudio(userId, 1);
  expect(removed).toBe(2);
  expect(await cacheRowCount(userId)).toBe(1);

  const hits = await Promise.all(
    texts.map((text) => findCachedTtsAudio({ userId, voiceKey, rate: 0, text })),
  );
  const alive = hits.filter((hit) => hit !== null);
  expect(alive).toHaveLength(1);
  // 被裁的两份产物文件应已删除（最后一条保留）
  expect(paths.slice(0, 2).every((p) => !existsSync(p))).toBe(true);
});
