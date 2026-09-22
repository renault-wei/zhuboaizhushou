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
    // ★R72：条数上限淘汰**只出队、不删文件** ✗
    //   URL 模式下「App 拿到 URL」与「App 真正去 GET」是两个时刻，
    //   在这里删会把刚发出去的 URL 变成死链 ✓ —— 删除权统一归 TTL
    expect(evicted).toEqual([]);
    // 队首应该已经是第 4 条（1~3 被挤出队列），且**文件仍在**
    expect(queue.take('live-a')?.wavPath).toBe('/tmp/a-4.wav');
    expect(queue.findPath('a-1')).toBeUndefined(); // 登记表按 id 索引，不是文件名
    expect(queue.findPath('')).toBeUndefined();
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
