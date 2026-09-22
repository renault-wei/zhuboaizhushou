import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createLoopCaster,
  DEFAULT_IDLE_POLL_MS,
  DEFAULT_ITEM_GAP_SECONDS,
} from '../src/services/loopCaster';
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

  // R22 / D1（2026-09-17）：弹幕回复与循环台本**共用同一条 FIFO 出声链路** + 台本每句前做空档避让，
  // 因此回复必然排在「当前正在播的那句之后、下一句之前」，不会打断半句。
  // 把这个顺序**钉成断言**：否则哪天有人把 FIFO 改成抢占式，线上极难复现。
  it('R22：出声链路忙时台本不插队 —— 回复严格排在两句台本之间', async () => {
    const order: string[] = [];
    let pending = 0;
    let spokeCount = 0;
    const caster = createLoopCaster({
      itemGapSeconds: 0,
      loopRestSeconds: 1,
      idlePollMs: 1,
      loadItems: async () => [{ text: '台本句A。', gapAfterSeconds: null }],
      // 忙闲 = 出声链路里还有没播完的东西（弹幕回复入队后就是 true）
      isBusy: () => pending > 0,
      speak: async (text) => {
        order.push(text);
        spokeCount += 1;
        if (spokeCount === 1) {
          // 第一句刚播完的瞬间，观众的弹幕回复入队
          pending = 1;
        }
        if (spokeCount >= 2) {
          caster.stop(LIVE_ID);
        }
        return { spoken: true, reason: 'spoken' };
      },
      sleep: async () => {
        // 台本在等的这个空档里，排在队列前面的回复被播掉
        if (pending > 0) {
          order.push('【弹幕回复】');
          pending = 0;
        }
      },
    });

    caster.start(LIVE_ID);
    await waitRunnerGone(caster, LIVE_ID);

    // 关键：回复**严格夹在两句台本之间**，而不是插进某句中间或跑到队尾
    expect(order).toEqual(['台本句A。', '【弹幕回复】', '台本句A。']);
  });

  // R42（2026-09-17 · 用户定调「节奏一定要好」）：回复走**空档插播**，一个空档最多一条。
  it('R42：一个空档最多放一条回复 —— 积压再多也挤不停台本', async () => {
    const order: string[] = [];
    const backlog = ['回复1', '回复2', '回复3', '回复4'];
    const caster = createLoopCaster({
      itemGapSeconds: 0,
      loopRestSeconds: 1,
      idlePollMs: 1,
      loadItems: async () => [{ text: '台本句A。', gapAfterSeconds: null }],
      isBusy: () => false,
      pickPendingReply: async () => backlog.shift() ?? null,
      speak: async (text) => {
        order.push(text);
        if (order.filter((entry) => entry === '台本句A。').length >= 3) {
          caster.stop(LIVE_ID);
        }
        return { spoken: true, reason: 'spoken' };
      },
      sleep: async () => undefined,
    });

    caster.start(LIVE_ID);
    await waitRunnerGone(caster, LIVE_ID);

    // 关键：每两句台本之间**只有一条**回复 —— 有 4 条积压也一样
    expect(order).toEqual(['台本句A。', '回复1', '台本句A。', '回复2', '台本句A。']);
  });

  it('R42：回复优先于氛围语 —— 一个空档只给一次插播机会', async () => {
    const order: string[] = [];
    let replies = 1;
    const caster = createLoopCaster({
      itemGapSeconds: 0,
      loopRestSeconds: 1,
      idlePollMs: 1,
      loadItems: async () => [{ text: '台本句A。', gapAfterSeconds: null }],
      isBusy: () => false,
      pickPendingReply: async () => (replies > 0 ? `回复${replies--}` : null),
      pickAtmosphere: async () => ({ category: 'welcome', text: '欢迎语' }),
      speak: async (text) => {
        order.push(text);
        // 收工条件要等**第 4 次出声**（台本→回复→台本→氛围语）之后，
        // 否则 stop 会发生在氛围语插播之前，测不到「氛围语让位」这件事
        if (order.length >= 4) {
          caster.stop(LIVE_ID);
        }
        return { spoken: true, reason: 'spoken' };
      },
      sleep: async () => undefined,
    });

    caster.start(LIVE_ID);
    await waitRunnerGone(caster, LIVE_ID);

    // 第 1 个空档放了回复 → **氛围语让位**；第 2 个空档没回复了 → 氛围语才上
    expect(order).toEqual(['台本句A。', '回复1', '台本句A。', '欢迎语']);
  });

  // R36（2026-09-17）：手机线上助播机若不轮询（App 被杀 / 断网），远程队列排不空 →
  // isBusy 恒真 → 台本会**卡死在空档避让里**（连同待播回复一起永远播不出去）。
  // 所以让位必须有上限：超时就放弃等待继续推进，并告警留痕。
  // R36（2026-09-17）：手机线上助播机若不轮询（App 被杀 / 断网），远程队列排不空 →
  // isBusy 恒真 → 台本会**卡死在空档避让里**（连同待播回复一起永远播不出去）。
  // 所以让位必须有上限：超时就放弃等待继续推进，并告警留痕。
  it('R36：助播机不轮询时台本不卡死 —— 让位超时后继续播报并告警', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const order: string[] = [];
    const caster = createLoopCaster({
      itemGapSeconds: 0,
      loopRestSeconds: 1,
      idlePollMs: 1,
      // 5ms / 1ms = 5 次轮询就放弃让位
      maxYieldMs: 5,
      loadItems: async () => [{ text: '台本句A。', gapAfterSeconds: null }],
      // 永远忙：模拟「助播机停止轮询、远程队列排不空」
      isBusy: () => true,
      speak: async (text) => {
        order.push(text);
        if (order.filter((entry) => entry === '台本句A。').length >= 2) {
          caster.stop(LIVE_ID);
        }
        return { spoken: true, reason: 'spoken' };
      },
      sleep: async () => undefined,
    });

    caster.start(LIVE_ID);
    await waitRunnerGone(caster, LIVE_ID);

    // 修复前：永远卡在 while(isBusy) 里，一条都播不出去（测试会挂死超时）
    expect(order.filter((entry) => entry === '台本句A。').length).toBeGreaterThanOrEqual(2);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  // 🔴 R42 回归复现（2026-09-17 用户提问「AI 回复会进入语音队列吗」时查出来的）：
  // 手机线用的是 remoteSpeechSink —— 它的 play 是「**入队即返回**」（不等播放）。
  // 于是 speak 返回后链路里必然还有那条台本句 → isBusy 恒为真 →
  // 若 tryInsertReply 以 isBusy 为门槛，回复就**永远不会被放出去**。
  it('R42 回归：出声链路是「入队即返回」时（手机线），回复也必须被放出去', async () => {
    const order: string[] = [];
    let pending = 0; // 模拟远程队列积压
    let replies = 2;
    const caster = createLoopCaster({
      itemGapSeconds: 0,
      loopRestSeconds: 1,
      idlePollMs: 1,
      loadItems: async () => [{ text: '台本句A。', gapAfterSeconds: null }],
      // 远程 sink 语义：入队即返回 → 刚说完就「忙」
      isBusy: () => pending > 0,
      pickPendingReply: async () => (replies > 0 ? `回复${replies--}` : null),
      speak: async (text) => {
        order.push(text);
        pending += 1;
        if (order.length >= 5) {
          caster.stop(LIVE_ID);
        }
        return { spoken: true, reason: 'spoken' };
      },
      // 模拟助播机在台本等待期间把队列里的音频播掉
      sleep: async () => {
        pending = 0;
      },
    });

    caster.start(LIVE_ID);
    await waitRunnerGone(caster, LIVE_ID);

    // 修复前：order 里只有台本句，一条回复都没有（回复全卡在队列里）
    expect(order.filter((entry) => entry.startsWith('回复'))).toHaveLength(2);
  });

  // R60（2026-09-21）：用户把口径从「默认 0s」改成「默认 1s」——
  // 0s 连读太急、句子之间没有呼吸感；1s 更像真人在直播间一句一句说。
  // 这个数字被改过两次（6→2→0），所以在这里**钉住**，避免以后再被顺手改掉。
  it('R60：条间默认间隔为 1s', () => {
    expect(DEFAULT_ITEM_GAP_SECONDS).toBe(1);
  });

  it('R60：条目未配置间隔时按默认 1s 停顿，然后进入轮间休息', async () => {
    const items: LoopCastItem[] = [
      { text: '第一句。', gapAfterSeconds: null },
      { text: '第二句。', gapAfterSeconds: null },
    ];
    const spoken: string[] = [];
    const sleeps: number[] = [];
    const caster = createLoopCaster({
      // 不传 itemGapSeconds → 走默认 1s；轮间给 2s，两者可区分
      loopRestSeconds: 2,
      idlePollMs: DEFAULT_IDLE_POLL_MS,
      loadItems: async () => items,
      isBusy: () => false,
      speak: async (text) => {
        spoken.push(text);
        return { spoken: true, reason: 'spoken' };
      },
      sleep: async (ms) => {
        sleeps.push(ms);
        // 收满三次就收工：句1后 1s、句2后 1s、轮末 2s
        if (sleeps.length >= 3) {
          caster.stop(LIVE_ID);
        }
      },
    });

    caster.start(LIVE_ID);
    await waitRunnerGone(caster, LIVE_ID);

    expect(spoken).toEqual(['第一句。', '第二句。']);
    // 条间两次各 1s（默认间隔），轮末一次 2s（轮间休息）
    expect(sleeps).toEqual([1000, 1000, 2000]);
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

  it('start 幂等；台本每轮开头重读（直播中改绑台本，下一轮生效）', async () => {
    let items: LoopCastItem[] = [{ text: '第一轮台本句。', gapAfterSeconds: 1 }];
    const spoken: string[] = [];
    let loadCalls = 0;
    // 手动闸门：让 Runner 停在第 1 轮首句的条间间隔里，先断言幂等再放行
    let releaseGate: (() => void) | null = null;
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
      sleep: async (ms) => {
        // 第 1 轮首句播完后改绑台本（第 2 轮开头重读才生效）并停住等测试放行
        if (spoken.length === 1 && ms === 1000) {
          items = [{ text: '第二轮新台本句。', gapAfterSeconds: 1 }];
          await new Promise<void>((resolve) => {
            releaseGate = resolve;
          });
          return;
        }
        if (spoken.length >= 3) {
          caster.stop(LIVE_ID);
        }
      },
    });

    caster.start(LIVE_ID);
    caster.start(LIVE_ID); // 幂等：同场次已挂 Runner 时忽略
    await tick();
    expect(loadCalls).toBe(1); // 幂等：第二次 start 未新起 Runner
    expect(spoken).toEqual(['第一轮台本句。']);

    releaseGate?.();
    await waitRunnerGone(caster, LIVE_ID);
    // 第 1 轮用开播时读到的旧台本；第 2 轮开头重读 → 新台本生效
    expect(spoken).toEqual(['第一轮台本句。', '第二轮新台本句。', '第二轮新台本句。']);
    expect(loadCalls).toBeGreaterThanOrEqual(2);
  });

  it('运行中解绑 / 清空台本：下一轮停止循环、只回弹幕（已播句子不受影响）', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    let items: LoopCastItem[] | null = [{ text: '清空前最后一句。', gapAfterSeconds: 1 }];
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
      sleep: async (ms) => {
        // 首句的条间间隔里清空台本（rest 2s 的睡眠不改动快照）
        if (ms === 1000) {
          items = null;
        }
      },
    });

    caster.start(LIVE_ID);
    await waitRunnerGone(caster, LIVE_ID);
    expect(spoken).toEqual(['清空前最后一句。']);
    expect(info).toHaveBeenCalled();
    expect(caster.status(LIVE_ID)).toBeNull();
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

describe('M10-A3 loopCaster 空档插播氛围语', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('命中氛围语：本句播完先插一条再走间隔，实际出声后按类别记账', async () => {
    const events: string[] = [];
    const marks: string[] = [];
    let stopRequested = false;
    const caster = createLoopCaster({
      itemGapSeconds: 1,
      loopRestSeconds: 2,
      loadItems: async () => [
        { text: '台本句一', gapAfterSeconds: 1 },
        { text: '台本句二', gapAfterSeconds: 1 },
      ],
      isBusy: () => false,
      speak: async (text) => {
        events.push(text);
        return { spoken: true, reason: 'spoken' };
      },
      pickAtmosphere: async () => ({ category: 'welcome' as const, text: '欢迎语一句' }),
      markAtmosphereSpoken: (_liveId, category) => {
        marks.push(category);
      },
      sleep: async () => {
        if (!stopRequested && events.includes('台本句二')) {
          stopRequested = true;
          caster.stop(LIVE_ID);
        }
      },
    });

    caster.start(LIVE_ID);
    await waitRunnerGone(caster, LIVE_ID);
    // 每句台本播完后的空档各插一条：台本句 → 氛围语 → 台本句 → 氛围语
    expect(events).toEqual(['台本句一', '欢迎语一句', '台本句二', '欢迎语一句']);
    expect(marks).toEqual(['welcome', 'welcome']);
  });

  // 意图不变（**有回复要插时，氛围语让位**），但**机制换了** ——
  // 原来用 isBusy 假装「有回复」，而手机线的 remoteSpeechSink 是「入队即返回」，
  // isBusy 恒为真 → 氛围语在真机上**从来没插播过**。R42 起改成直接看
  // 「这个空档有没有插进一条回复」—— 表达更直接，也不再依赖 sink 的实现细节。
  it('出声链路忙时让位：有回复要插时氛围语让位，没有回复才插播', async () => {
    const events: string[] = [];
    let pending = 0;
    let replies = 1;
    let stopRequested = false;
    const caster = createLoopCaster({
      itemGapSeconds: 1,
      loopRestSeconds: 2,
      loadItems: async () => [
        { text: '台本句一', gapAfterSeconds: 1 },
        { text: '台本句二', gapAfterSeconds: 1 },
      ],
      // 手机线语义：speak 是「入队即返回」→ 刚说完 isBusy 就为真；
      // 由 sleep 模拟助播机把队列播掉（注意：若助播机**不轮询**，isBusy 恒真，
      // 台本会卡在空档避让里 —— 这是手机线一个已知风险，另记）。
      isBusy: () => pending > 0,
      // 第 1 个空档有一条待播回复 → 回复占用这次机会，氛围语让位
      pickPendingReply: async () => (replies > 0 ? `回复${replies--}` : null),
      speak: async (text) => {
        events.push(text);
        pending += 1;
        return { spoken: true, reason: 'spoken' };
      },
      pickAtmosphere: async () => ({ category: 'welcome' as const, text: '欢迎语一句' }),
      markAtmosphereSpoken: () => undefined,
      sleep: async () => {
        pending = 0;
        if (!stopRequested && events.includes('台本句二')) {
          stopRequested = true;
          caster.stop(LIVE_ID);
        }
      },
    });

    caster.start(LIVE_ID);
    await waitRunnerGone(caster, LIVE_ID);
    // 第 1 个空档放了回复（氛围语让位）；第 2 个空档没回复了 → 氛围语上
    expect(events).toEqual(['台本句一', '回复1', '台本句二', '欢迎语一句']);
  });

  it('插播出声失败（disabled/skipped）不记账，节奏照走', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const marks: string[] = [];
    let stopRequested = false;
    const caster = createLoopCaster({
      itemGapSeconds: 1,
      loopRestSeconds: 2,
      loadItems: async () => [{ text: '台本句一', gapAfterSeconds: 1 }],
      isBusy: () => false,
      speak: async (text) =>
        text === '暖场一句'
          ? { spoken: false, reason: 'disabled' }
          : { spoken: true, reason: 'spoken' },
      pickAtmosphere: async () => ({ category: 'custom' as const, text: '暖场一句' }),
      markAtmosphereSpoken: (_liveId, category) => {
        marks.push(category);
      },
      sleep: async () => {
        if (!stopRequested) {
          stopRequested = true;
          caster.stop(LIVE_ID);
        }
      },
    });

    caster.start(LIVE_ID);
    await waitRunnerGone(caster, LIVE_ID);
    expect(marks).toEqual([]);
    expect(info).toHaveBeenCalled();
  });

  it('未接氛围语调度（默认返回 null）时不影响既有循环节奏', async () => {
    const items: LoopCastItem[] = [{ text: '只有循环句。', gapAfterSeconds: 1 }];
    const spoken: string[] = [];
    let stopRequested = false;
    const caster = createLoopCaster({
      itemGapSeconds: 1,
      loopRestSeconds: 2,
      loadItems: async () => items,
      isBusy: () => false,
      speak: async (text) => {
        spoken.push(text);
        return { spoken: true, reason: 'spoken' };
      },
      sleep: async () => {
        if (!stopRequested) {
          stopRequested = true;
          caster.stop(LIVE_ID);
        }
      },
    });

    caster.start(LIVE_ID);
    await waitRunnerGone(caster, LIVE_ID);
    expect(spoken).toEqual(['只有循环句。']);
  });

  // ---------- R77：间隔随条目走到【播放端】 ----------
  // 2026-09-22 真机实测「语音队列循环过快、似乎没有等待」：
  //   间隔原先**只在生产端**（本文件里那句 await sleep(gap)）✗，
  //   而远程 speak 是**入队即返回** —— 台本 ~1 秒/条 灌进队列，
  //   播放端却要 6.8 秒才念完一条 → 队列灌满、播放端背靠背念，
  //   台本里那点间隔被队列吸收干净 ✓
  // 修法：间隔跟着**这句**一起交给出声链路（远程链路由它下发到播放端）✓
  it('R77：每句的间隔（条目值 ?? 全局默认）随 speak 一起交给出声链路', async () => {
    const items: LoopCastItem[] = [
      { text: '第一句。', gapAfterSeconds: null },
      { text: '第二句。', gapAfterSeconds: 3.5 },
    ];
    const gaps: Array<number | undefined> = [];
    const caster = createLoopCaster({
      itemGapSeconds: 1,
      loopRestSeconds: 5,
      loadItems: async () => items,
      isBusy: () => false,
      speak: async (_text, _overrides, _liveId, gapAfterSeconds) => {
        gaps.push(gapAfterSeconds);
        return { spoken: true, reason: 'spoken' };
      },
      sleep: async () => {
        // 两句都说过就收工，不必等整轮跑完
        if (gaps.length >= 2) {
          caster.stop(LIVE_ID);
        }
      },
    });

    caster.start(LIVE_ID);
    await waitRunnerGone(caster, LIVE_ID);

    // 第一条没配 → 回落全局默认 1；第二条自带 3.5 → 原样透传
    expect(gaps.slice(0, 2)).toEqual([1, 3.5]);
  });
});
