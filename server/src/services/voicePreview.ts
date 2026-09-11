import { readdir } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { env } from '../config/env';

// 预设音色试听「方案 A」静态产物（预生成 wav）：
// - 一次性预生成 uploads/voice-previews/{presetId}.wav，GET /api/voices/presets 逐条带 previewUrl；
// - App 试听直接播这个 URL，不再每次点试听都走一次真实合成（省钱 + 秒开）；
// - 产物不入库（.gitignore 已忽略 uploads/ 与 *.wav），部署机跑 `npm run preview:build -- --write` 生成；
// - 未预生成的音色不下发 previewUrl，App 自动回落 POST /api/voices/preview 真合成（兜底不破）。

/** 试听演示短句：固定 30 字左右的小额演示调用，与正式口播话术无关 */
export const VOICE_PREVIEW_TEXT =
  '大家好，欢迎来到直播间，今天给大家介绍咱们的团购套餐，喜欢的可以点个关注。';

/** 试听静态文件 URL 前缀（静态下发路由与本模块共用同一口径） */
export const VOICE_PREVIEW_URL_PREFIX = '/uploads/voice-previews/';

/** 试听静态文件名白名单：仅「音色 id + .wav」，杜绝目录穿越（静态下发前先过白名单） */
const VOICE_PREVIEW_FILE_PATTERN = /^[A-Za-z0-9_-]{1,64}\.wav$/;

/** 预生成目录绝对路径：相对路径按 server 运行目录解析（每次调用重读，测试可改 env 指向临时目录） */
export function resolveVoicePreviewDir(): string {
  const dir = env.voicePreview.dir;
  return isAbsolute(dir) ? dir : resolve(process.cwd(), dir);
}

/** 试听文件名：{presetId}.wav */
export function voicePreviewFileName(presetId: string): string {
  return `${presetId}.wav`;
}

/** 试听播放入口（相对路径，客户端拼服务端 baseUrl 使用） */
export function voicePreviewUrl(presetId: string): string {
  return `${VOICE_PREVIEW_URL_PREFIX}${voicePreviewFileName(presetId)}`;
}

/**
 * 已预生成试听的音色 id 集合：
 * 目录不存在 / 读取失败一律按「无预生成」处理，让接口退回「不下发 previewUrl」，不影响其它字段。
 */
export async function listAvailableVoicePreviewIds(): Promise<Set<string>> {
  try {
    const files = await readdir(resolveVoicePreviewDir());
    const ids = new Set<string>();
    for (const file of files) {
      if (!VOICE_PREVIEW_FILE_PATTERN.test(file)) {
        continue;
      }
      ids.add(file.slice(0, -'.wav'.length));
    }
    return ids;
  } catch {
    return new Set<string>();
  }
}

/** 解析静态下发请求的文件名：不在白名单直接返回 null（调用方按 404 处理，不触盘） */
export function resolveVoicePreviewFile(file: string): string | null {
  if (!VOICE_PREVIEW_FILE_PATTERN.test(file)) {
    return null;
  }
  return join(resolveVoicePreviewDir(), file);
}
