import { readdir, stat, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// R68：未交付音频的**孤儿回收**（2026-09-22）。
//
// 病灶：远程出声队列是**内存态**（见 remoteSpeechQueue.ts 的注释）。
//   正常路径下文件都会被删 ——
//     · 被助播机取走 → routes/speechOut.ts 交付即删 ✓
//     · 入队超限 / R63 过期淘汰 → onEvict 删 ✓
//   但**服务重启或崩溃时，内存里排队的 job 连同它们的删除义务一起消失** ✗，
//   文件却留在磁盘上 —— 实测累积到 62 个（约 30MB）✓
//
// 本模块做一件很窄的事：定期扫掉**明显过了寿命**的孤儿音频。
//   判定用「文件年龄」而不是「是否在队列里」——
//   因为队列本身就是不可靠的一方，拿它当参照会漏掉正是它弄丢的那些 ✓

/** 与 TTS 产物一致的命名前缀（volcTTS / liveSpeaker 落盘时用 starvoice- 前缀）。 */
const ORPHAN_PREFIX = 'starvoice-';
const ORPHAN_SUFFIX = '.wav';

/**
 * 孤儿寿命上限：30 分钟。
 *
 * 为什么是 30 分钟而不是更短：队列里合法等待的条目最长也就几十秒
 * （R63 的 MAX_REMOTE_SPEECH_AGE_MS = 20 秒就会把它们剔掉）✓，
 * 留 30 分钟纯属给「服务端卡顿 / 时钟抖动」留余量，宁可漏杀不可误杀 ✓。
 */
const ORPHAN_MAX_AGE_MS = 30 * 60 * 1000;

/** 回收间隔：10 分钟。清扫是廉价操作（一次 readdir + 若干 stat），无需更密。 */
const SWEEP_INTERVAL_MS = 10 * 60 * 1000;

/** 扫描并删除过期的孤儿音频，返回删除条数（便于日志与测试断言）。 */
export async function sweepOrphanSpeechWavs(
  options: { dir?: string; maxAgeMs?: number; now?: number } = {},
): Promise<number> {
  const dir = options.dir ?? tmpdir();
  const maxAgeMs = options.maxAgeMs ?? ORPHAN_MAX_AGE_MS;
  const now = options.now ?? Date.now();
  let removed = 0;
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    // 临时目录读不到（权限 / 不存在）不该影响服务
    return 0;
  }
  for (const name of names) {
    if (!name.startsWith(ORPHAN_PREFIX) || !name.endsWith(ORPHAN_SUFFIX)) {
      continue;
    }
    const full = join(dir, name);
    try {
      const info = await stat(full);
      if (now - info.mtimeMs < maxAgeMs) {
        continue;
      }
      await unlink(full);
      removed += 1;
    } catch {
      // 文件刚好被别人删了 / 权限问题：跳过即可
    }
  }
  return removed;
}

/** 启动时扫一遍，并按周期继续扫；返回停止函数（测试 / 优雅关闭用）。 */
export function startSpeechWavSweeper(
  warn: (message: string) => void,
): () => void {
  const run = async (): Promise<void> => {
    try {
      const removed = await sweepOrphanSpeechWavs();
      if (removed > 0) {
        warn(`[speechWavSweeper] 回收了 ${removed} 个未交付的孤儿音频`);
      }
    } catch {
      // 回收失败不影响服务
    }
  };
  void run();
  const timer = setInterval(() => void run(), SWEEP_INTERVAL_MS);
  // 不因这个定时器而阻止进程退出
  timer.unref?.();
  return () => clearInterval(timer);
}
