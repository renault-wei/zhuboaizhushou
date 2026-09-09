import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir, rename, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { sql } from 'drizzle-orm';
import { db } from '../db/client';
import { env } from '../config/env';

// T3 TTS 分句缓存服务（服务端基础设施，首批不接线 liveSpeaker，接线留给 T4 预热批次）：
// - 缓存键 = (userId, voiceKey, rate, textSha256)：voiceKey 归一取 lives 口径（火山预设 id 或克隆 voiceId）；
// - 命中直接返回产物绝对路径，不调供应商、不写 usage_logs、不扣 ttsCharsUsed（计量口径见 ttsUsage.ts）；
// - 产物按副本落入 env.ttsCache.dir，库里只存相对路径（跨机可整体搬迁缓存目录）；
// - TTS_CACHE_ENABLED=false 时 find 恒 miss、store 不落盘，用于灰度对比命中率与成本。

export interface TtsCacheLookup {
  userId: string;
  /** 音色键：火山预设 = volcPresetId；克隆 = voiceId（与 lives 归一取值一致） */
  voiceKey: string;
  /** 语速档：对齐火山 speech_rate [-50, 100]，0 为正常语速 */
  rate: number;
  /** 待合成文本（缓存键按 trim 后 sha256 计算） */
  text: string;
}

export interface TtsCacheEntry {
  /** 缓存产物绝对路径（可直接交给播放器） */
  audioPath: string;
  /** 真实合成字符数（trim 后按 Unicode 码点计数） */
  chars: number;
}

/** 文本指纹：trim 后 sha256（改一个字即 miss，天然处理改稿失效） */
export function computeTextSha256(text: string): string {
  return createHash('sha256').update(text.trim(), 'utf8').digest('hex');
}

/** 真实合成字符数：trim 后按 Unicode 码点计数（代理对算 1 个，中文按 1 个计） */
export function countTtsChars(text: string): number {
  return Array.from(text.trim()).length;
}

/** 缓存根目录：绝对路径直接使用；相对路径相对 server 运行目录解析 */
export function resolveTtsCacheRoot(): string {
  return isAbsolute(env.ttsCache.dir)
    ? env.ttsCache.dir
    : resolve(process.cwd(), env.ttsCache.dir);
}

/** 音色键目录段：sha256 前 16 位，避免非文件系统安全的键值进入路径 */
function voiceKeySegment(voiceKey: string): string {
  return createHash('sha256').update(voiceKey, 'utf8').digest('hex').slice(0, 16);
}

/** 组装缓存相对路径（统一正斜杠分隔，入库后整体可搬迁） */
export function buildTtsCacheRelativePath(
  userId: string,
  voiceKey: string,
  textSha256: string,
): string {
  return `users/${userId}/${voiceKeySegment(voiceKey)}/${textSha256}.wav`;
}

/** 把合成产物复制成缓存副本（先写临时文件再 rename，避免半成品被并发命中读到） */
async function copyIntoTtsCache(
  relativePath: string,
  sourceWavPath: string,
): Promise<string> {
  const root = resolveTtsCacheRoot();
  const dest = resolve(root, relativePath);
  await mkdir(join(dest, '..'), { recursive: true });
  const tmp = `${dest}.tmp-${randomUUID()}`;
  await copyFile(sourceWavPath, tmp);
  await rename(tmp, dest);
  return dest;
}

async function removeCacheFiles(relativePaths: string[]): Promise<void> {
  const root = resolveTtsCacheRoot();
  await Promise.all(
    relativePaths.map((rel) => unlink(resolve(root, rel)).catch(() => undefined)),
  );
}

/**
 * 缓存命中查询：返回缓存产物绝对路径；文件已丢/开关关闭均按 miss 处理。
 * 命中会顺带自增 hit_count 并刷新 last_hit_at（更新失败不影响本次命中，静默降级）。
 */
export async function findCachedTtsAudio(
  key: TtsCacheLookup,
): Promise<TtsCacheEntry | null> {
  if (!env.ttsCache.enabled) {
    return null;
  }
  const textSha256 = computeTextSha256(key.text);
  const rows = await db.execute(sql`
    SELECT id, audio_path, chars
    FROM tts_audio_cache
    WHERE user_id = ${key.userId}
      AND voice_key = ${key.voiceKey}
      AND rate = ${key.rate}
      AND text_sha256 = ${textSha256}
    LIMIT 1
  `);
  const row = rows.rows[0] as
    | { id: string; audio_path: string; chars: number }
    | undefined;
  if (!row) {
    return null;
  }
  const audioPath = resolve(resolveTtsCacheRoot(), row.audio_path);
  if (!existsSync(audioPath)) {
    // 产物文件缺失（被清理/搬迁）：删行按 miss 处理，下一轮重新合成
    await db
      .execute(sql`DELETE FROM tts_audio_cache WHERE id = ${row.id}`)
      .catch(() => undefined);
    return null;
  }
  db.execute(sql`
    UPDATE tts_audio_cache
    SET hit_count = hit_count + 1, last_hit_at = now()
    WHERE id = ${row.id}
  `).catch(() => undefined);
  return { audioPath, chars: row.chars };
}

/**
 * 缓存写入（miss 合成成功后调用）：复制副本 + 插行。
 * 并发同键已存在时保留先到者；写缓存任一步失败只告警不阻断既有出声链路。
 */
export async function storeCachedTtsAudio(
  key: TtsCacheLookup,
  sourceWavPath: string,
): Promise<TtsCacheEntry | null> {
  if (!env.ttsCache.enabled) {
    return null;
  }
  const textSha256 = computeTextSha256(key.text);
  const relativePath = buildTtsCacheRelativePath(key.userId, key.voiceKey, textSha256);
  const chars = countTtsChars(key.text);
  try {
    const dest = await copyIntoTtsCache(relativePath, sourceWavPath);
    const inserted = await db.execute(sql`
      INSERT INTO tts_audio_cache
        (user_id, voice_key, rate, text_sha256, text, audio_path, chars)
      VALUES
        (${key.userId}, ${key.voiceKey}, ${key.rate}, ${textSha256}, ${key.text}, ${relativePath}, ${chars})
      ON CONFLICT (user_id, voice_key, rate, text_sha256) DO NOTHING
    `);
    if ((inserted.rowCount ?? 0) === 0) {
      // 并发下先到者已落库：本副本内容同键同源，直接删除刚写入的临时副本避免重复
      await unlink(dest).catch(() => undefined);
    }
    return { audioPath: dest, chars };
  } catch (err) {
    console.warn('[ttsCache] 写缓存失败（不影响出声链路）：', (err as Error).message);
    return null;
  }
}

/**
 * 懒清理兜底：把某 user 的缓存条目裁剪到 keepMax（保最近命中/最近写入），
 * 顺带清理被删行对应的产物文件，防磁盘无限膨胀。v1 不做全局 LRU。
 */
export async function pruneCachedTtsAudio(
  userId: string,
  keepMax: number,
): Promise<number> {
  if (!env.ttsCache.enabled || keepMax <= 0) {
    return 0;
  }
  const removed = await db.execute(sql`
    DELETE FROM tts_audio_cache AS c
    USING (
      SELECT id, row_number() OVER (
        ORDER BY COALESCE(last_hit_at, created_at) DESC NULLS LAST, created_at DESC
      ) AS rn
      FROM tts_audio_cache
      WHERE user_id = ${userId}
    ) AS ranked
    WHERE c.id = ranked.id AND ranked.rn > ${keepMax}
    RETURNING c.audio_path
  `);
  const paths = (removed.rows ?? []) as Array<{ audio_path: string }>;
  await removeCacheFiles(paths.map((row) => row.audio_path)).catch(() => undefined);
  return removed.rowCount ?? 0;
}
