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
  /** 入队时刻（epoch ms）：用于**过期丢弃**（R63） */
  createdAt: number;
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
  /**
   * ★R72：按 jobId 找音频文件路径（供**受鉴权的下载端点**使用）。
   *
   * 为什么需要独立于队列：URL 模式下「App 拿到 URL」与「App 真正去 GET」
   * 是**两个时刻** ✗ —— 条目很可能已经 `take` 出队了 ✓，
   * 但文件还在磁盘上等着被取 ✓。
   * 所以路径登记不能跟着队列条目的生死走 ✗，要按**时间**（TTL）回收 ✓
   * —— 与 R63 的过期口径同源，由 [pruneStale] 一并清理 ✓。
   */
  findPath(jobId: string): string | undefined;
}

/**
 * 单场次队列上界。
 *
 * 为什么必须有（2026-09-17）：帮助机（手机）若停止轮询（App 被杀 / 断网），
 * 远程队列排不空 → 台本的空档避让会一直等到超时 → 之后仍持续推新条目。
 * 没有上界的话，助播机回来时会被灌一长串**过时**的语音（十几分钟前的台词）。
 * 上限之内正常；超了就**丢最旧的**——过时的语音播出来反而奇怪。
 *
 * R69：20 → 60。
 * 放宽存活期（见下方 10 分钟）后，队列本来就能存更久，条数上界也要跟着抬 ✗，
 * 否则「10 分钟存活」会先被 20 条卡死，App 依然囤不起来 ✓。
 * 60 条 ≈ 一轮完整台本，正好够 App 囤满一轮 ✓。
 */
export const MAX_REMOTE_SPEECH_JOBS_PER_LIVE = 60;

/**
 * 队列条目的**最大存活时长**（R63）。超过就直接丢掉，永远不交付。
 *
 * 为什么需要（2026-09-22 用户实测「直播间打开时部分语音一起播放」）：
 *   只有**条数**上界还不够 —— 手机切后台 / 被限流时，队列里会攒下十几条
 *   **十几秒甚至几分钟前**的台词；等它恢复，这些陈年旧话会**一起涌出来**，
 *   和台上的循环台本叠在一起，听上去就是「几句一起播」✗。
 *
 * 参照竞品 xcai1618 的 `appMaxAudio`（客户端队列上限，超了不入队）；
 * 我们在服务端用**时间**而不是**条数**来判断更对症：
 *   陈旧与否取决于「多久之前的台词」，而不是「排在第几位」。
 *
 * **2026-09-22（R69）从 20 秒放宽到 10 分钟**，理由：
 *
 *   20 秒是为**逐句实时合成**设的 —— 那时台本说一句产一句，
 *   一句台词晚 20 秒还没送出去，台上的循环早把同一件事又说了一遍 ✓
 *
 *   R69 引入**开播前预生成**后语义变了：音频是提前备好的，
 *   一条 1 分钟前合成的台本句与刚合成的**没有任何区别** ✓
 *   （它本来就是循环里的一句，本来就要反复念。）
 *
 *   而 App 侧要做「本地囤货」——存活期若还是 20 秒，
 *   App 稍一打盹（后台被降频 / 短暂断网）队列就被抹光 ✗，本地根本攒不起来 ✓
 *
 *   这个数字**绑在「实时」语义上，语义变了它就该变** ✓。
 *   防积压改由「条数上界 + App 本地双限」兜住，不做无限增长 ✓。
 */
export const MAX_REMOTE_SPEECH_AGE_MS = 10 * 60 * 1000;

/** 内存 FIFO 实现：服务重启即清空（一期自用可接受；云 / 多商家化时再落库持久化） */
class MemoryRemoteSpeechQueue implements RemoteSpeechQueue {
  private readonly jobs: RemoteSpeechJob[] = [];

  /** ★R72：jobId → { 文件路径, 入队时刻 }。独立于队列条目，只按 TTL 回收 ✓ */
  private readonly files = new Map<string, { wavPath: string; createdAt: number }>();

  /** 淘汰回调：让调用方有机会清理被丢掉那条的 wav 文件（否则临时目录会堆垃圾） */
  constructor(private readonly onEvict?: (job: RemoteSpeechJob) => void) {}

  push(wavPath: string, liveId?: string): string {
    const id = randomUUID();
    const createdAt = Date.now();
    this.jobs.push({ id, wavPath, liveId, createdAt });
    this.files.set(id, { wavPath, createdAt });
    if (liveId !== undefined) {
      while (this.size(liveId) > MAX_REMOTE_SPEECH_JOBS_PER_LIVE) {
        const index = this.jobs.findIndex((job) => job.liveId === liveId);
        if (index < 0) {
          break;
        }
        // ★R72：**这里只出队、不删文件** ✗
        //
        // URL 模式下「App 拿到 URL」与「App 真正去 GET」是两个时刻：
        // 条目被挤出队列 ≠ 文件没人要了 ✓。若在这里删，刚发出去的 URL 会变成死链 ✗。
        //
        // 文件删除权**统一归 TTL**（pruneStale 里的 files 回收 ✓）——
        // 那条路径与「App 有多久没来取」同口径，是唯一安全的判据 ✓
        this.jobs.splice(index, 1);
      }
    }
    return id;
  }

  size(liveId?: string): number {
    // R63：先剔陈旧 —— 只被「过期积压」占着的链路不该算忙，
    // 否则台本会一直判「出声链路繁忙」然后让位超时（就是那条卡死路径）。
    this.pruneStale();
    if (liveId === undefined) {
      return this.jobs.length;
    }
    return this.jobs.reduce((total, job) => (job.liveId === liveId ? total + 1 : total), 0);
  }

  list(liveId?: string, limit = 10): RemoteSpeechJob[] {
    this.pruneStale();
    const matched =
      liveId === undefined ? this.jobs : this.jobs.filter((job) => job.liveId === liveId);
    // 浅拷贝：调用方拿到的是快照，不能借它改动队列内部状态
    return matched.slice(0, Math.max(0, limit)).map((job) => ({ ...job }));
  }

  take(liveId?: string): RemoteSpeechJob | undefined {
    this.pruneStale();
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

  /**
   * 剔掉过期条目并清理其 wav（R63）。
   *
   * 每个对外方法入口都调一次 —— 队列是内存里的短数组，这个开销可以忽略，
   * 而「任何一次读写都看不到陈旧条目」这个性质很重要。
   */
  findPath(jobId: string): string | undefined {
    this.pruneStale();
    return this.files.get(jobId)?.wavPath;
  }

  private pruneStale(): void {
    const now = Date.now();
    // ★R72：路径登记按同一 TTL 回收 —— URL 模式下的文件删除权在这里（不在交付时）✓
    for (const [id, entry] of this.files) {
      if (now - entry.createdAt > MAX_REMOTE_SPEECH_AGE_MS) {
        this.files.delete(id);
        this.onEvict?.({ id, wavPath: entry.wavPath, createdAt: entry.createdAt });
      }
    }
    for (let index = this.jobs.length - 1; index >= 0; index -= 1) {
      const job = this.jobs[index];
      if (job && now - job.createdAt > MAX_REMOTE_SPEECH_AGE_MS) {
        this.jobs.splice(index, 1);
        this.onEvict?.(job);
      }
    }
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
