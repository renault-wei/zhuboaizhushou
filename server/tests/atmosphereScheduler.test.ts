import { describe, expect, it, vi } from 'vitest';
import {
  buildCategorySnapshots,
  createAtmosphereScheduler,
} from '../src/services/atmosphereScheduler';
import type {
  LiveSnapshotData,
  SnapshotCategoryInput,
} from '../src/services/atmosphereScheduler';

// M10-A2/A3 空档插播调度器测试：loadSnapshot / random / now 全注入替身，
// 不碰 DB、不出真实声音、不依赖真实时钟（口径 docs/ATMOSPHERE-INTERACTION-PLAN.md §5/§6）。

const LIVE_ID = 'live-atmo-test';

/** 固定随机源：始终取第一行候选 */
const pickFirst = () => 0;

/** 让出宏任务，等 start 的异步快照加载落地 */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function snapshotOf(...categories: SnapshotCategoryInput[]): LiveSnapshotData {
  return { categories };
}

describe('M10-A2 buildCategorySnapshots 快照收敛', () => {
  it('丢静音档/空文案/未知类别，重复类别后者覆盖前者', () => {
    const map = buildCategorySnapshots([
      { category: 'welcome', texts: ['A', 'B'], intervalSeconds: 60 },
      { category: 'follow', texts: ['F'], intervalSeconds: 0 },
      { category: 'thumb', texts: ['   ', ''], intervalSeconds: 60 },
      { category: 'bogus' as never, texts: ['X'], intervalSeconds: 60 },
      { category: 'custom', texts: ['C1'], intervalSeconds: 30 },
      { category: 'welcome', texts: ['A2'], intervalSeconds: 90 },
    ]);

    expect(map.has('follow')).toBe(false);
    expect(map.has('thumb')).toBe(false);
    expect(map.has('bogus' as never)).toBe(false);
    expect(map.get('welcome')).toMatchObject({
      texts: ['A2'],
      intervalSeconds: 90,
      lastSpokenAtMs: null,
    });
    expect(map.get('custom')?.intervalSeconds).toBe(30);
    expect(map.size).toBe(2);
  });

  it('非有限/负数间隔一律丢弃', () => {
    const map = buildCategorySnapshots([
      { category: 'welcome', texts: ['A'], intervalSeconds: Number.NaN },
      { category: 'follow', texts: ['F'], intervalSeconds: -5 },
    ]);
    expect(map.size).toBe(0);
  });
});

describe('M10-A2/A3 createAtmosphereScheduler 调度器', () => {
  it('start 幂等：加载中重复 start 只加载一次；stop 幂等', async () => {
    let loadCount = 0;
    const scheduler = createAtmosphereScheduler({
      loadSnapshot: async () => {
        loadCount += 1;
        return snapshotOf({ category: 'welcome', texts: ['欢迎光临'], intervalSeconds: 60 });
      },
      now: () => 0,
      random: pickFirst,
    });

    scheduler.start(LIVE_ID);
    scheduler.start(LIVE_ID);
    expect(loadCount).toBe(1);

    await settle();
    expect(scheduler.isReady(LIVE_ID)).toBe(true);

    scheduler.stop(LIVE_ID);
    scheduler.stop(LIVE_ID);
    expect(scheduler.isReady(LIVE_ID)).toBe(false);
  });

  it('未 start 或加载为空时 pickDue 一律 null', async () => {
    const scheduler = createAtmosphereScheduler({
      loadSnapshot: async () => null,
      now: () => 0,
    });

    expect(scheduler.pickDue(LIVE_ID, 0)).toBeNull();
    scheduler.start(LIVE_ID);
    await settle();
    expect(scheduler.isReady(LIVE_ID)).toBe(false);
    expect(scheduler.pickDue(LIVE_ID, 10_000_000)).toBeNull();
  });

  it('频控：首插需等满一个间隔；到期按优先级命中，记账后重新计时', async () => {
    const scheduler = createAtmosphereScheduler({
      loadSnapshot: async () =>
        snapshotOf(
          { category: 'welcome', texts: ['欢迎光临'], intervalSeconds: 60 },
          { category: 'follow', texts: ['谢谢关注'], intervalSeconds: 60 },
        ),
      now: () => 0,
      random: pickFirst,
    });

    scheduler.start(LIVE_ID);
    await settle();

    // 未满间隔：不插播
    expect(scheduler.pickDue(LIVE_ID, 59_000)).toBeNull();
    // 满间隔：按优先级先取 welcome
    expect(scheduler.pickDue(LIVE_ID, 60_000)).toEqual({
      category: 'welcome',
      text: '欢迎光临',
    });
    // welcome 记账后重新计时，本次让位给 follow
    scheduler.markSpoken(LIVE_ID, 'welcome', 60_000);
    expect(scheduler.pickDue(LIVE_ID, 60_000)).toEqual({ category: 'follow', text: '谢谢关注' });
    // follow 也记账：两类均未到期
    scheduler.markSpoken(LIVE_ID, 'follow', 60_000);
    expect(scheduler.pickDue(LIVE_ID, 100_000)).toBeNull();
    // 两类都到期时仍按优先级 welcome 先出
    expect(scheduler.pickDue(LIVE_ID, 120_000)).toEqual({
      category: 'welcome',
      text: '欢迎光临',
    });
  });

  it('占位符缺值跳过该行，回退到无占位候选（采集器到位前的可演示路径）', async () => {
    const scheduler = createAtmosphereScheduler({
      loadSnapshot: async () =>
        snapshotOf({
          category: 'welcome',
          texts: ['[昵称]来啦', '欢迎新朋友来到直播间'],
          intervalSeconds: 30,
        }),
      now: () => 0,
      random: pickFirst,
    });

    scheduler.start(LIVE_ID);
    await settle();
    // pickFirst 从第 0 行（含 [昵称]）起，取不到昵称 → 跳到第 1 行
    expect(scheduler.pickDue(LIVE_ID, 30_000)).toEqual({
      category: 'welcome',
      text: '欢迎新朋友来到直播间',
    });
  });

  it('start 后进行中 stop：异步加载结果被丢弃，停播后不再冒出', async () => {
    let releaseLoad: (value: LiveSnapshotData | null) => void = () => undefined;
    const scheduler = createAtmosphereScheduler({
      loadSnapshot: () =>
        new Promise<LiveSnapshotData | null>((resolve) => {
          releaseLoad = resolve;
        }),
      now: () => 0,
      random: pickFirst,
    });

    scheduler.start(LIVE_ID);
    scheduler.stop(LIVE_ID); // 快照仍在加载 → 停播
    releaseLoad(snapshotOf({ category: 'welcome', texts: ['不该出现'], intervalSeconds: 30 }));
    await settle();
    expect(scheduler.isReady(LIVE_ID)).toBe(false);
    expect(scheduler.pickDue(LIVE_ID, 10_000_000)).toBeNull();
  });

  it('加载抛异常：本场不插播、不冒泡，仅记一次告警', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const scheduler = createAtmosphereScheduler({
        loadSnapshot: async () => {
          throw new Error('DB 不可用');
        },
        now: () => 0,
      });
      scheduler.start(LIVE_ID);
      await settle();
      expect(scheduler.isReady(LIVE_ID)).toBe(false);
      expect(scheduler.pickDue(LIVE_ID, 10_000_000)).toBeNull();
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('markSpoken 对未就绪场次/未知类别安全无副作用', () => {
    const scheduler = createAtmosphereScheduler({
      loadSnapshot: async () => null,
      now: () => 0,
    });
    scheduler.markSpoken(LIVE_ID, 'welcome', 123);
    scheduler.markSpoken(LIVE_ID, 'bogus' as never, 123);
    scheduler.stop(LIVE_ID);
    expect(scheduler.pickDue(LIVE_ID, 1)).toBeNull();
  });
});
