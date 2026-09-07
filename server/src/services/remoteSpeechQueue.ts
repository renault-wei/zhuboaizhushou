import { randomUUID } from 'node:crypto';

// P1 手机线：远程出声队列（出声端下沉到助播机）。
// AI 大脑（本服务）合成好 wav 后不再本地播放，而是交给「远程出声队列」；
// 助播机（手机 App，二期客户端）用轮询接口逐条拉取并在本地出声。
// 一期语义：拉取成功 = 交付完成（等效「已出声」）；播放回执 / 重试等留二期客户端联调。

export interface RemoteSpeechJob {
  /** 每条播报唯一 id（回执 / 日志定位用） */
  id: string;
  wavPath: string;
}

export interface RemoteSpeechQueue {
  /** 追加一条待播报 wav，返回 jobId */
  push(wavPath: string): string;
  /** 尚未被拉取的条数 */
  size(): number;
  /** 取走队首（一次交付）；队列为空返回 undefined */
  take(): RemoteSpeechJob | undefined;
  /** 清空未拉取队列（真人接管 / 一键静音扩展点） */
  clear(): void;
}

/** 内存 FIFO 实现：服务重启即清空（一期自用可接受；云 / 多商家化时再落库持久化） */
class MemoryRemoteSpeechQueue implements RemoteSpeechQueue {
  private readonly jobs: RemoteSpeechJob[] = [];

  push(wavPath: string): string {
    const id = randomUUID();
    this.jobs.push({ id, wavPath });
    return id;
  }

  size(): number {
    return this.jobs.length;
  }

  take(): RemoteSpeechJob | undefined {
    return this.jobs.shift();
  }

  clear(): void {
    this.jobs.length = 0;
  }
}

/** 全局单例：全服务共用一条远程出声队列（当前单商家自用口径；多门店隔离后置） */
export const remoteSpeechQueue: RemoteSpeechQueue = new MemoryRemoteSpeechQueue();
