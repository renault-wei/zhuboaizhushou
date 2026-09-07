import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLoopCaster, DEFAULT_IDLE_POLL_MS } from '../src/services/loopCaster';
import type { LoopCastItem, LoopCaster } from '../src/services/loopCaster';

// M4 loopCaster 单元测试：speak / loadItems / sleep / isBusy 全注入替身，
// 测试全程不出真实声音、不碰 DB、不碰真实时钟（sleep 用假时钟只记账）。

const LIVE_ID = 'live-loop-test';

/** 等待 Runner 完全退出（Map 清理、status 回 null）；超时抛错防挂死 */
async function waitRunnerGone(caster: LoopCaster, liveId: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (caster.status(liveId) !== null) {
    if (Date.now() > deadline) {
      throw new Error('loopCaster Runner 未在超时内退出');
    }
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

/** 让出几个宏任务，等微任务链推进（空台本 / 立即停等场景用） */
async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 5));
}

describe('M4 loopCaster 循环台本播出引擎（§8.2/§8.3）', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('按台本顺序逐句口播：条间用条目/全局间隔、轮末休息，跨轮循环', async () => {
    const items: LoopCastItem[] = [
      { text: '欢迎来到直播间，今天介绍招牌毛肚套餐。', gapAfterSeconds: null },
      { text: '套餐分量足，适合朋友聚餐，欢迎到店品尝。', gapAfterSeconds: null },
      { text: '点开左下角团购，还有限时优惠券可以领。', gapAfterSeconds: 10 },
    ];
    const spoken: string[] = [];
    const sleeps: number[] = [];
    let simulatedMilliseconds = 0;
    let stopRequested = false;
    const caster = createLoopCaster({
      itemGapSeconds: 2,
      loopRestSeconds: 5,
      idlePollMs: DEFAULT_IDLE_POLL_MS,
      loadItems: async () => items,
      isBusy: () => false,
      speak: async (text) => {
        spoken.push(text);
        return { spoken: true, reason: 'spoken' };
      },
      sleep: async (ms) => {
        sleeps.push(ms);
        simulatedMilliseconds += ms;
        if (!stopRequested && simulatedMilliseconds >= 25000) {
          stopRequested = true;
          caster.stop(LIVE_ID);
        }
      },
    });

    caster.start(LIVE_ID);
    await waitRunnerGone(caster, LIVE_ID);

    // 跨两轮严格按台本顺序循环
    expect(spoken).toEqual([
      '欢迎来到直播间，今天介绍招牌毛肚套餐。',
      '套餐分量足，适合朋友聚餐，欢迎到店品尝。',
      '点开左下角团购，还有限时优惠券可以领。',
      '欢迎来到直播间，今天介绍招牌毛肚套餐。',
      '套餐分量足，适合朋友聚餐，欢迎到店品尝。',
      '点开左下角团购，还有限时优惠券可以领。',
    ]);
    // 第 1 轮：前两句走全局 2s、第 3 句走条目 10s、轮末休息 5s
    expect(sleeps.slice(0, 4)).toEqual([2000, 2000, 10000, 5000]);
    // 第 2 轮节奏一致，停在第 3 句间隔内
    expect(sleeps.slice(4)).toEqual([2000, 2000, 10000]);
    expect(stopRequested).toBe(true);
    expect(caster.status(LIVE_ID)).toBeNull();
  });

  it.each([null, [] as LoopCastItem[]])('空台本（%p）不启动 Runner：不出声、状态即回 null', async (loaded) => {
    const spoken: string[] = [];
    const caster = createLoopCaster({
      loadItems: async () => loaded,
      isBusy: () => false,
      speak: async (text) => {
        spoken.push(text);
        return { spoken: true, reason: 'spoken' };
      },
      sleep: async () => undefined,
    });

    caster.start(LIVE_ID);
    await waitRunnerGone(caster, LIVE_ID);
    expect(caster.isRunning(LIVE_ID)).toBe(false);
    expect(spoken).toEqual([]);
    // 从未启动成功也可安全 stop（幂等）
    caster.stop(LIVE_ID);
    caster.stop(LIVE_ID);
  });

  it('台本加载失败：记日志不抛错、本场只回弹幕', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const spoken: string[] = [];
    const caster = createLoopCaster({
      loadItems: async () => {
        throw new Error('数据库不可用');
      },
      isBusy: () => false,
      speak: async (text) => {
        spoken.push(text);
        return { spoken: true, reason: 'spoken' };
      },
      sleep: async () => undefined,
    });

    caster.start(LIVE_ID);
    await waitRunnerGone(caster, LIVE_ID);
    expect(spoken).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(caster.status(LIVE_ID)).toBeNull();
  });

  it('start 幂等：运行中重复 start 不起第二条 Runner；stop 后重新 start 会再读一次台本快照（Q6）', async () => {
    const items: LoopCastItem[] = [{ text: '本店午市招牌套餐，欢迎到店品尝。', gapAfterSeconds: 1 }];
    const spoken: string[] = [];
    let loadCalls = 0;
    const caster = createLoopCaster({
      itemGapSeconds: 1,
      loopRestSeconds: 3,
      loadItems: async () => {
        loadCalls += 1;
        return items;
      },
      isBusy: () => false,
      speak: async (text) => {
        spoken.push(text);
        return { spoken: true, reason: 'spoken' };
      },
      sleep: async () => {
        // 每段 Runner 都要有确定停点：第 1 次（loadCalls=1）第 2 句后停；
        // stop 后重 start（loadCalls=2）第 3 句后再停，避免第二次运行无限循环
        if (spoken.length >= loadCalls + 1) {
          caster.stop(LIVE_ID);
        }
      },
    });

    caster.start(LIVE_ID);
    caster.start(LIVE_ID); // 幂等：同场次已挂 Runner 时忽略
    await tick();
    expect(loadCalls).toBe(1);

    await waitRunnerGone(caster, LIVE_ID);
    expect(loadCalls).toBe(1);
    expect(spoken.length).toBeGreaterThanOrEqual(2);

    // stop 后再 start：新 Runner 重新读一次台本快照
    caster.start(LIVE_ID);
    await waitRunnerGone(caster, LIVE_ID);
    expect(loadCalls).toBe(2);
  });

  it('stop 置位即停：正在播的当前句播完即止、不再推下一句；连续 stop 幂等', async () => {
    const items: LoopCastItem[] = [
      { text: '第一句：招牌套餐介绍。', gapAfterSeconds: 1 },
      { text: '第二句：不应该出现。', gapAfterSeconds: 1 },
    ];
    const spoken: string[] = [];
    const caster = createLoopCaster({
      itemGapSeconds: 1,
      loopRestSeconds: 2,
      loadItems: async () => items,
      isBusy: () => false,
      speak: async (text) => {
        spoken.push(text);
        return { spoken: true, reason: 'spoken' };
      },
      // 第一句播完后的间隔里 stop → 第二句不再推
      sleep: async () => {
        caster.stop(LIVE_ID);
      },
    });

    caster.start(LIVE_ID);
    await waitRunnerGone(caster, LIVE_ID);
    expect(spoken).toEqual(['第一句：招牌套餐介绍。']);
    expect(caster.isRunning(LIVE_ID)).toBe(false);
    expect(caster.status(LIVE_ID)).toBeNull();
    caster.stop(LIVE_ID);
    caster.stop(LIVE_ID);
  });

  it('start 后立即 stop：加载完成后不再出声（加载中已取消）', async () => {
    const spoken: string[] = [];
    const caster = createLoopCaster({
      loadItems: async () => [{ text: '不该播出的句子。', gapAfterSeconds: null }],
      isBusy: () => false,
      speak: async (text) => {
        spoken.push(text);
        return { spoken: true, reason: 'spoken' };
      },
      sleep: async () => undefined,
    });

    caster.start(LIVE_ID);
    caster.stop(LIVE_ID); // 台本快照可能仍在加载：Runner 在检查点退出
    await waitRunnerGone(caster, LIVE_ID);
    expect(spoken).toEqual([]);
  });

  it('空档避让：出声链路忙时按 idlePollMs 小步轮询，空闲才推下一句（§8.3）', async () => {
    const items: LoopCastItem[] = [{ text: '忙完空档再播这句。', gapAfterSeconds: 2 }];
    const spoken: string[] = [];
    const sleeps: number[] = [];
    let busyLeft = 3; // 开头 3 次 busy 判定为真（模拟弹幕回复/远程积压）
    const caster = createLoopCaster({
      itemGapSeconds: 2,
      loopRestSeconds: 3,
      idlePollMs: DEFAULT_IDLE_POLL_MS,
      loadItems: async () => items,
      isBusy: () => busyLeft > 0,
      speak: async (text) => {
        spoken.push(text);
        return { spoken: true, reason: 'spoken' };
      },
      sleep: async (ms) => {
        sleeps.push(ms);
        if (busyLeft > 0) {
          busyLeft -= 1; // 消耗一次“忙”信号（等出声链路清空）
        } else {
          caster.stop(LIVE_ID); // 空闲后推完第一句，在条间间隔停
        }
      },
    });

    caster.start(LIVE_ID);
    await waitRunnerGone(caster, LIVE_ID);
    expect(spoken).toEqual(['忙完空档再播这句。']);
    expect(sleeps).toEqual([500, 500, 500, 2000]);
  });

  it('单句未出声（disabled/skipped）只记日志，节奏照走继续下一句', async () => {
    const items: LoopCastItem[] = [
      { text: '第一句正常口播。', gapAfterSeconds: 1 },
      { text: '第二句照样轮播。', gapAfterSeconds: 1 },
    ];
    const attempts: string[] = [];
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    let stopRequested = false;
    const caster = createLoopCaster({
      itemGapSeconds: 1,
      loopRestSeconds: 2,
      loadItems: async () => items,
      isBusy: () => false,
      speak: async (text) => {
        attempts.push(text);
        return { spoken: false, reason: 'disabled' };
      },
      sleep: async () => {
        if (!stopRequested && attempts.length >= 2) {
          stopRequested = true;
          caster.stop(LIVE_ID);
        }
      },
    });

    caster.start(LIVE_ID);
    await waitRunnerGone(caster, LIVE_ID);
    expect(attempts).toEqual(['第一句正常口播。', '第二句照样轮播。']);
    expect(info).toHaveBeenCalled();
  });

  it('运行中 status 可见（running/round/currentSeq）；未启动场次为 null；stop 不打断正在播的句子', async () => {
    const items: LoopCastItem[] = [{ text: '卡住等待放行的句子。', gapAfterSeconds: 1 }];
    const spoken: string[] = [];
    let releaseSpeak: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      releaseSpeak = resolve;
    });
    const caster = createLoopCaster({
      loadItems: async () => items,
      isBusy: () => false,
      speak: async (text) => {
        spoken.push(text);
        await gate;
        return { spoken: true, reason: 'spoken' };
      },
      sleep: async () => undefined,
    });

    expect(caster.status(LIVE_ID)).toBeNull();
    caster.start(LIVE_ID);
    await tick();
    expect(spoken).toEqual(['卡住等待放行的句子。']);
    expect(caster.isRunning(LIVE_ID)).toBe(true);
    expect(caster.status(LIVE_ID)).toEqual({ running: true, round: 1, currentSeq: 1 });

    // stop 只置位：当前句还在“播”，不打断、让自然播完
    caster.stop(LIVE_ID);
    expect(caster.status(LIVE_ID)).toEqual({ running: false, round: 1, currentSeq: 0 });

    releaseSpeak();
    await waitRunnerGone(caster, LIVE_ID);
    expect(spoken).toEqual(['卡住等待放行的句子。']);
    expect(caster.status(LIVE_ID)).toBeNull();
  });
});