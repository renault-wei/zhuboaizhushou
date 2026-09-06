import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';

// G5 音频出口（Windows 后台出声）：
// 把一段已合成的 wav 播到系统「默认播放设备」。现场直播（模式 B）时，只要把虚拟声卡
// （如 VB-Cable）设为系统默认播放设备，这段声音就会像麦克风一样进入抖音直播伴侣。
// 本模块只负责出声通道（排队 / 静音 / 打断），TTS 合成在 voice.ts、回复决策在 interactionEngine。
// 实现口径：System.Media.SoundPlayer 只支持经典 PCM wav，CosyVoice 非流式输出正是 wav，可直接播放。

// ---------- 错误类型 ----------

export type AudioOutErrorCode =
  | 'UNSUPPORTED_PLATFORM'
  | 'POWERSHELL_NOT_FOUND'
  | 'PLAY_FAILED';

/** 音频出口业务错误：携带机器可读错误码，由调用方决定吞掉或上报 */
export class AudioOutError extends Error {
  readonly code: AudioOutErrorCode;

  constructor(code: AudioOutErrorCode, message: string) {
    super(message);
    this.name = 'AudioOutError';
    this.code = code;
  }
}

// ---------- 底层播放执行器 ----------

/** 一次播放的句柄：done 完成即播完；cancel 用于打断（Windows 下直接结束播放子进程） */
export interface PlayHandle {
  done: Promise<void>;
  cancel(): void;
}

/** 播放执行器：测试可注入假实现，生产用 PowerShell + SoundPlayer 播到默认设备 */
export type PlayExecutor = (wavPath: string) => PlayHandle;

function createPowerShellCommand(wavPath: string): string {
  // 路径用 PowerShell 单引号包裹；路径内含单引号时翻倍转义，避免命令注入
  const safePath = wavPath.replace(/'/g, "''");
  return (
    "$ErrorActionPreference = 'Stop';" +
    `$player = New-Object System.Media.SoundPlayer -ArgumentList '${safePath}';` +
    '$player.PlaySync();' +
    '$player.Dispose();'
  );
}

/**
 * Windows 真实播放执行器：起一个隐藏的 powershell 进程同步播放 wav，
 * 播完退出码 0 即成功；进程被杀（stop）会以非 0 关闭，由队列层翻译成「被打断」。
 */
export function createWindowsDefaultDeviceExecutor(): PlayExecutor {
  return (wavPath: string): PlayHandle => {
    const child: ChildProcessWithoutNullStreams = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-STA', '-Command', createPowerShellCommand(wavPath)],
      { windowsHide: true },
    );
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    const done = new Promise<void>((resolve, reject) => {
      child.on('error', (err) => {
        const detail = (err as NodeJS.ErrnoException).message;
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          reject(new AudioOutError('POWERSHELL_NOT_FOUND', `未找到 powershell.exe：${detail}`));
        } else {
          reject(new AudioOutError('PLAY_FAILED', `启动系统播放器失败：${detail}`));
        }
      });
      child.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          const detail = (stderr.trim() || '未知原因').slice(0, 300);
          reject(new AudioOutError('PLAY_FAILED', `播放失败（退出码 ${code}）：${detail}`));
        }
      });
    });

    return {
      done,
      cancel: () => {
        child.kill();
      },
    };
  };
}

// ---------- 播放队列 ----------

/** 一条排队请求的实际结果 */
export type PlayOutcome = 'played' | 'skipped' | 'failed';

export interface VoicePlayer {
  /** 当前是否静音（静音只拦新播放，播到一半的让其自然播完） */
  isMuted(): boolean;
  setMuted(muted: boolean): void;
  /** 把一段 wav 加入播放队列；返回实际结果：played=播完 / skipped=被静音或打断 / failed=出错 */
  enqueue(wavPath: string): Promise<PlayOutcome>;
  /** 清空未播队列并打断当前播放（真人接管 / 一键静音用） */
  stop(): void;
  /** 尚未播出的排队条数 */
  pendingCount(): number;
}

interface QueueJob {
  wavPath: string;
  resolve: (outcome: PlayOutcome) => void;
}

export interface VoicePlayerOptions {
  platform?: NodeJS.Platform;
  executor?: PlayExecutor;
}

class DefaultVoicePlayer implements VoicePlayer {
  private readonly executor: PlayExecutor;
  private readonly queue: QueueJob[] = [];
  private muted = false;
  private pumping = false;
  /** 每次 stop 自增：让正在 pump 的循环感知「被打断」，避免继续取新任务 */
  private generation = 0;
  private activeHandle: PlayHandle | null = null;

  constructor(executor: PlayExecutor) {
    this.executor = executor;
  }

  isMuted(): boolean {
    return this.muted;
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
  }

  enqueue(wavPath: string): Promise<PlayOutcome> {
    return new Promise<PlayOutcome>((resolve) => {
      this.queue.push({ wavPath, resolve });
      void this.pump();
    });
  }

  pendingCount(): number {
    return this.queue.length;
  }

  stop(): void {
    this.generation += 1;
    // 未播出的全部记为 skipped，避免 Promise 悬挂
    for (const job of this.queue.splice(0)) {
      job.resolve('skipped');
    }
    this.activeHandle?.cancel();
    this.activeHandle = null;
  }

  private async pump(): Promise<void> {
    if (this.pumping) {
      return;
    }
    this.pumping = true;
    const gen = this.generation;
    try {
      while (this.queue.length > 0 && this.generation === gen) {
        const job = this.queue[0];
        if (!job) {
          break;
        }
        // 静音期间：新任务一律跳过，但保留已排队的顺序被消费（不堆积）
        if (this.muted) {
          this.queue.shift();
          job.resolve('skipped');
          continue;
        }
        let handle: PlayHandle;
        try {
          handle = this.executor(job.wavPath);
        } catch {
          this.queue.shift();
          job.resolve('failed');
          continue;
        }
        this.activeHandle = handle;
        let outcome: PlayOutcome = 'played';
        try {
          await handle.done;
        } catch {
          // stop 打断时 done 会以非 0 关闭：只可能是本段被中断或播放失败
          outcome = this.generation === gen ? 'failed' : 'skipped';
        } finally {
          if (this.activeHandle === handle) {
            this.activeHandle = null;
          }
        }
        // stop 已把本任务从队列清掉时不再重复 resolve
        if (this.queue[0] === job) {
          this.queue.shift();
          job.resolve(outcome);
        }
      }
    } finally {
      this.pumping = false;
    }
    // 打断瞬间可能已有新任务入队但被本轮的 pumping 挡下：补跑一轮，避免丢唤醒
    if (this.queue.length > 0) {
      void this.pump();
    }
  }
}

/**
 * 播放器工厂：
 * - 显式注入 executor / platform（测试用）；
 * - 生产默认：Windows 用真实系统播放器；非 Windows 抛 UNSUPPORTED_PLATFORM（真实出声只在本机 PC 验收）。
 */
export function createVoicePlayer(options: VoicePlayerOptions = {}): VoicePlayer {
  const platform = options.platform ?? process.platform;
  const executor =
    options.executor ??
    (platform === 'win32'
      ? createWindowsDefaultDeviceExecutor()
      : (_wavPath: string): PlayHandle => {
          throw new AudioOutError(
            'UNSUPPORTED_PLATFORM',
            `Windows 后台出声只支持本机验收，当前平台：${platform}`,
          );
        });
  return new DefaultVoicePlayer(executor);
}
