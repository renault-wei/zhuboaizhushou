import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

// ---------- FFmpeg 定位（streaming.ts 与火山 TTS 转码共用）----------

/**
 * FFmpeg 定位三级规则：
 * 1. process.env.FFMPEG_PATH（显式指定，最优先）；
 * 2. path.resolve(process.cwd(), 'bin', 'ffmpeg.exe')（项目自带）；
 * 3. 系统 PATH 中的 ffmpeg（生产 / CI 环境）。
 * 三级都探测不到时抛错，由调用方按自身错误语义包装。
 */
export function locateFfmpeg(): string {
  const candidates: string[] = [];
  if (process.env.FFMPEG_PATH) {
    candidates.push(process.env.FFMPEG_PATH);
  }
  candidates.push(resolve(process.cwd(), 'bin', 'ffmpeg.exe'));
  const pathDirs = (process.env.PATH ?? '').split(';').filter((dir) => dir.length > 0);
  for (const dir of pathDirs) {
    candidates.push(join(dir, 'ffmpeg.exe'));
    candidates.push(join(dir, 'ffmpeg'));
  }
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error('未找到 FFmpeg：请配置 FFMPEG_PATH，或确认 server/bin/ffmpeg.exe / 系统 PATH 可用');
}
