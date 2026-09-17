// R36 远程出声队列上界单测：助播机不轮询时不至于堆积一长串过时语音。

import { describe, expect, it } from 'vitest';
import {
  createRemoteSpeechQueue,
  MAX_REMOTE_SPEECH_JOBS_PER_LIVE,
} from '../src/services/remoteSpeechQueue';

describe('R36 远程出声队列上界', () => {
  it('按场次计上限：超了**丢最旧**，且不动其它场次', () => {
    const evicted: string[] = [];
    const queue = createRemoteSpeechQueue((job) => evicted.push(job.wavPath));

    for (let index = 1; index <= MAX_REMOTE_SPEECH_JOBS_PER_LIVE + 3; index += 1) {
      queue.push(`/tmp/a-${index}.wav`, 'live-a');
    }
    queue.push('/tmp/b-1.wav', 'live-b');

    expect(queue.size('live-a')).toBe(MAX_REMOTE_SPEECH_JOBS_PER_LIVE);
    expect(queue.size('live-b')).toBe(1);
    // 被淘汰的是最旧的那 3 条，并且**回调通知了调用方**（用于删 wav 文件）
    expect(evicted).toEqual(['/tmp/a-1.wav', '/tmp/a-2.wav', '/tmp/a-3.wav']);
    // 队首应该已经是第 4 条（1~3 被挤掉）
    expect(queue.take('live-a')?.wavPath).toBe('/tmp/a-4.wav');
  });

  it('淘汰回调抛错不影响入队', () => {
    const queue = createRemoteSpeechQueue(() => {
      throw new Error('删文件失败');
    });
    expect(() => {
      for (let index = 0; index < MAX_REMOTE_SPEECH_JOBS_PER_LIVE + 1; index += 1) {
        queue.push(`/tmp/c-${index}.wav`, 'live-c');
      }
    }).not.toThrow();
    expect(queue.size('live-c')).toBe(MAX_REMOTE_SPEECH_JOBS_PER_LIVE);
  });

  it('不带 liveId 的入队不参与按场次淘汰（保持旧全局口径）', () => {
    const queue = createRemoteSpeechQueue();
    for (let index = 0; index < MAX_REMOTE_SPEECH_JOBS_PER_LIVE + 5; index += 1) {
      queue.push(`/tmp/d-${index}.wav`);
    }
    expect(queue.size()).toBe(MAX_REMOTE_SPEECH_JOBS_PER_LIVE + 5);
  });
});
