import { randomUUID } from 'node:crypto';
import { unlink } from 'node:fs/promises';

// P1 手机线：远程出声队列（出声端下沉到助播机）。
// AI 大脑（本服务）合成好 wav 后不再本地播放，而是交给「远程出声队列」；
// 助播机（手机 App，二期客户端）用轮询接口逐条拉取并在本地出声。
// 一期语义：拉取成功 = 交付完成（等效「已出声」）；播放回执 / 重试等留二期客户端联调。

export interface RemoteSpeechJob {
  /** 每条播报唯一 id（回执 / 日志定位用） */
  id: string;
  wavPath: string;
  /** 归属场次：助播机按场拉取，避免多场并发时音频互相插队（旧数据 / 未标记为空） */
  liveId?: string;
}

export interface RemoteSpeechQueue {
  /** 追加一条待播报 wav（可标记归属场次），返回 jobId */
  push(wavPath: string, liveId?: string): string;
  /** 尚未被拉取的条数；带 liveId 时只数该场次 */
  size(liveId?: string): number;
  /**
   * **只读**清单（R61 本地缓冲用）：按入队顺序返回待播条目的浅拷贝，最多 limit 条。
   *
   * 为什么只要清单、不要字节：手机据此「先知道有几条、再去逐条下载」。
   * 下载仍走 `/next`（原子取出）—— 于是**清单被看到 ≠ 已被取走**，
   * 两条 App 同时拉也不会重复播（`take` 从数组里 splice，天然去重）。
   */
  list(liveId?: string, limit?: number): RemoteSpeechJob[];
  /**
   * 取走一条交付：不带 liveId = 全局队首（旧单商家口径）；
   * 带 liveId = 该场次最先入队的一条（保持场次内 FIFO，且不动其它场次积压）。
   */
  take(liveId?: string): RemoteSpeechJob | undefined;
  /** 清空未拉取队列；带 liveId 时只清该场次（真人接管 / 一键静音扩展点） */
  clear(liveId?: string): void;
}

/**
 * 单场次队列上界。
 *
 * 为什么必须有（2026-09-17）：帮助机（手机）若停止轮询（App 被杀 / 断网），
 * 远程队列排不空 → 台本的空档避让会一直等到超时 → 之后仍持续推新条目。
 * 没有上界的话，助播机回来时会被灌一长串**过时**的语音（十几分钟前的台词）。
 * 上限之内正常；超了就**丢最旧的**——过时的语音播出来反而奇怪。
 */
export const MAX_REMOTE_SPEECH_JOBS_PER_LIVE = 20;

/** 内存 FIFO 实现：服务重启即清空（一期自用可接受；云 / 多商家化时再落库持久化） */
class MemoryRemoteSpeechQueue implements RemoteSpeechQueue {
  private readonly jobs: RemoteSpeechJob[] = [];

  /** 淘汰回调：让调用方有机会清理被丢掉那条的 wav 文件（否则临时目录会堆垃圾） */
  constructor(private readonly onEvict?: (job: RemoteSpeechJob) => void) {}

  push(wavPath: string, liveId?: string): string {
    const id = randomUUID();
    this.jobs.push({ id, wavPath, liveId });
    if (liveId !== undefined) {
      while (this.size(liveId) > MAX_REMOTE_SPEECH_JOBS_PER_LIVE) {
        const index = this.jobs.findIndex((job) => job.liveId === liveId);
        if (index < 0) {
          break;
        }
        const [evicted] = this.jobs.splice(index, 1);
        if (evicted) {
          // 淘汰是尽力而为：清理回调（删 wav）失败**不该把入队搞挂** ——
          // 队列的职责是保管任务，文件清理是附带收益。
          try {
            this.onEvict?.(evicted);
          } catch (err) {
            console.warn(
              `[remoteSpeechQueue] 淘汰任务时清理失败（忽略）：${
                err instanceof Error ? err.message : String(err)
              }`,
            );
          }
        }
      }
    }
    return id;
  }

  size(liveId?: string): number {
    if (liveId === undefined) {
      return this.jobs.length;
    }
    return this.jobs.reduce((total, job) => (job.liveId === liveId ? total + 1 : total), 0);
  }

  list(liveId?: string, limit = 10): RemoteSpeechJob[] {
    const matched =
      liveId === undefined ? this.jobs : this.jobs.filter((job) => job.liveId === liveId);
    // 浅拷贝：调用方拿到的是快照，不能借它改动队列内部状态
    return matched.slice(0, Math.max(0, limit)).map((job) => ({ ...job }));
  }

  take(liveId?: string): RemoteSpeechJob | undefined {
    if (liveId === undefined) {
      return this.jobs.shift();
    }
    const index = this.jobs.findIndex((job) => job.liveId === liveId);
    if (index < 0) {
      return undefined;
    }
    const [job] = this.jobs.splice(index, 1);
    return job;
  }

  clear(liveId?: string): void {
    if (liveId === undefined) {
      this.jobs.length = 0;
      return;
    }
    for (let index = this.jobs.length - 1; index >= 0; index -= 1) {
      if (this.jobs[index]?.liveId === liveId) {
        this.jobs.splice(index, 1);
      }
    }
  }
}

/** 建一条独立的远程出声队列（测试用；生产走下面的全局单例） */
export function createRemoteSpeechQueue(
  onEvict?: (job: RemoteSpeechJob) => void,
): RemoteSpeechQueue {
  return new MemoryRemoteSpeechQueue(onEvict);
}

/**
 * 全局单例：全服务共用一条远程出声队列（当前单商家自用口径；多门店隔离后置）。
 * 淘汰任务时顺手删掉它的 wav —— 与轮询接口交付后的清理口径一致，避免临时目录堆垃圾。
 */
export const remoteSpeechQueue: RemoteSpeechQueue = createRemoteSpeechQueue((evicted) => {
  void unlink(evicted.wavPath).catch(() => undefined);
});
