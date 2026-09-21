import { expect, it } from 'vitest';
import {
  createVoicePlayer,
  type PlayExecutor,
  type PlayHandle,
} from '../src/services/voicePlayer';

// G5 播放队列单元测试：用假执行器验证「顺序 / 静音 / 打断 / 出错不阻塞」，不依赖真实声卡。

interface FakeHandle {
  handle: PlayHandle;
  resolve: () => void;
  reject: (err: unknown) => void;
  cancelCount: number;
}

/** 造一个手动控制完成时机的假播放句柄，便于断言顺序与打断行为 */
function makeFakeHandle(): FakeHandle {
  let resolveDone = (): void => undefined;
  let rejectDone = (_err: unknown): void => undefined;
  const done = new Promise<void>((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });
  const state: FakeHandle = {
    handle: {
      done,
      cancel: () => {
        state.cancelCount += 1;
        rejectDone(new Error('被打断'));
      },
    },
    resolve: () => resolveDone(),
    reject: (err: unknown) => rejectDone(err),
    cancelCount: 0,
  };
  return state;
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('等待条件超时');
}

/** 造一个会记录调用顺序的假执行器，返回句柄便于手动放行 / 打断 */
function makeRecordingExecutor(): { calls: string[]; handles: FakeHandle[] } {
  const calls: string[] = [];
  const handles: FakeHandle[] = [];
  const executor: PlayExecutor = (wavPath) => {
    calls.push(wavPath);
    const fake = makeFakeHandle();
    handles.push(fake);
    return fake.handle;
  };
  return { calls, handles, executor };
}

it('静音时入队直接跳过，取消静音后正常播放', async () => {
  const calls: string[] = [];
  const player = createVoicePlayer({
    executor: (wavPath) => {
      calls.push(wavPath);
      return { done: Promise.resolve(), cancel: () => undefined };
    },
  });

  player.setMuted(true);
  await expect(player.enqueue('muted.wav')).resolves.toBe('skipped');
  expect(calls).toEqual([]);

  player.setMuted(false);
  await expect(player.enqueue('ok.wav')).resolves.toBe('played');
  expect(calls).toEqual(['ok.wav']);
  expect(player.isMuted()).toBe(false);
});

it('多条回复按入队顺序串行播放，不并行出声', async () => {
  const { calls, handles, executor } = makeRecordingExecutor();
  const player = createVoicePlayer({ executor });

  const first = player.enqueue('a.wav');
  const second = player.enqueue('b.wav');
  await waitFor(() => calls.length === 1);
  expect(calls).toEqual(['a.wav']);

  handles[0]?.resolve();
  await expect(first).resolves.toBe('played');
  await waitFor(() => calls.length === 2);
  expect(calls).toEqual(['a.wav', 'b.wav']);

  handles[1]?.resolve();
  await expect(second).resolves.toBe('played');
  expect(player.pendingCount()).toBe(0);
});

// ---------- R61：排队条数按场次过滤 ----------
// 2026-09-21 发现：liveSpeaker 的注释一直写着「带 liveId 时只算本场」，
// 但实现（本机出声端 → 播放器）**从来没做**，无脑返回全局长度。
// 后果：别场次的积压会把本场台本卡死 —— loopCaster 靠它判「出声链路是否空闲」，
// 判成「一直忙」就会反复让位 30 秒然后放弃，表现为【静音】。
it('R61：pendingCount 带 liveId 时只数该场次，不带才算全局', async () => {
  const { calls, handles, executor } = makeRecordingExecutor();
  const player = createVoicePlayer({ executor });

  // A 场一条、B 场两条。第一条（A）立刻进入播放，但**仍在队列里** ——
  // 这是对的：正在说话时这条链路本来就该被判为「忙」。
  void player.enqueue('a1.wav', 'live-A');
  void player.enqueue('b1.wav', 'live-B');
  void player.enqueue('b2.wav', 'live-B');
  await waitFor(() => calls.length === 1);
  expect(player.pendingCount('live-A')).toBe(1);
  expect(player.pendingCount('live-B')).toBe(2);
  expect(player.pendingCount()).toBe(3);

  // ★ 真正要验的那一刻：A 播完、B 开始播 —— A 场必须立刻变「空闲」，
  //   哪怕 B 场还有积压。修复前这里恒等于全局长度，台本会被别场拖死。
  handles[0]?.resolve();
  await waitFor(() => calls.length === 2);
  expect(player.pendingCount('live-A')).toBe(0);
  expect(player.pendingCount('live-B')).toBe(2);

  handles.forEach((handle) => handle.resolve());
});

it('stop 清空未播队列并打断当前播放，之后仍可继续入队', async () => {
  const { calls, handles, executor } = makeRecordingExecutor();
  const player = createVoicePlayer({ executor });

  const active = player.enqueue('a.wav');
  await waitFor(() => calls.length === 1);
  const queued1 = player.enqueue('b.wav');
  const queued2 = player.enqueue('c.wav');

  player.stop();
  await expect(active).resolves.toBe('skipped');
  await expect(queued1).resolves.toBe('skipped');
  await expect(queued2).resolves.toBe('skipped');
  expect(handles[0]?.cancelCount).toBe(1);
  expect(player.pendingCount()).toBe(0);

  const after = player.enqueue('d.wav');
  await waitFor(() => calls.length === 2);
  handles[1]?.resolve();
  await expect(after).resolves.toBe('played');
});

it('某段播放失败不阻塞后续排队任务', async () => {
  let shouldFail = true;
  const executor: PlayExecutor = (_wavPath) => {
    if (shouldFail) {
      return { done: Promise.reject(new Error('模拟播放失败')), cancel: () => undefined };
    }
    return { done: Promise.resolve(), cancel: () => undefined };
  };
  const player = createVoicePlayer({ executor });

  await expect(player.enqueue('bad.wav')).resolves.toBe('failed');
  shouldFail = false;
  await expect(player.enqueue('good.wav')).resolves.toBe('played');
});
