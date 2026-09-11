import { remoteSpeechQueue, type RemoteSpeechQueue } from './remoteSpeechQueue';
import type { SpeechSink } from './liveSpeaker';
import type { PlayOutcome } from './voicePlayer';

// 远程出声端（P1 手机线）：把合成好的 wav 交到「远程出声队列」，由助播机（二期客户端）轮询拉取播放。
// 一期语义：入队成功即视为交付（played）；不删除 wav —— 文件生命周期移交给轮询接口（拉取流式返回后清理）。
// 静音 / 打断：远程链路由助播端（二期）负责，本 sink 的 stop 只清空未拉取队列作为兜底。
export function createRemoteSpeechSink(queue: RemoteSpeechQueue = remoteSpeechQueue): SpeechSink {
  return {
    isMuted: () => false,
    setMuted: () => undefined,
    async play(wavPath: string, liveId?: string): Promise<PlayOutcome> {
      queue.push(wavPath, liveId);
      return 'played';
    },
    stop: () => queue.clear(),
    pendingCount: (liveId?: string) => queue.size(liveId),
  };
}
