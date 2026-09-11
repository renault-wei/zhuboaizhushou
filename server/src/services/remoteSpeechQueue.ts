import { randomUUID } from 'node:crypto';

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
   * 取走一条交付：不带 liveId = 全局队首（旧单商家口径）；
   * 带 liveId = 该场次最先入队的一条（保持场次内 FIFO，且不动其它场次积压）。
   */
  take(liveId?: string): RemoteSpeechJob | undefined;
  /** 清空未拉取队列；带 liveId 时只清该场次（真人接管 / 一键静音扩展点） */
  clear(liveId?: string): void;
}

/** 内存 FIFO 实现：服务重启即清空（一期自用可接受；云 / 多商家化时再落库持久化） */
class MemoryRemoteSpeechQueue implements RemoteSpeechQueue {
  private readonly jobs: RemoteSpeechJob[] = [];

  push(wavPath: string, liveId?: string): string {
    const id = randomUUID();
    this.jobs.push({ id, wavPath, liveId });
    return id;
  }

  size(liveId?: string): number {
    if (liveId === undefined) {
      return this.jobs.length;
    }
    return this.jobs.reduce((total, job) => (job.liveId === liveId ? total + 1 : total), 0);
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

/** 全局单例：全服务共用一条远程出声队列（当前单商家自用口径；多门店隔离后置） */
export const remoteSpeechQueue: RemoteSpeechQueue = new MemoryRemoteSpeechQueue();
