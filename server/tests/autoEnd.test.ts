// R26 定时关播调度器单测：全程注入假计时器，不碰真实时钟、不碰 DB。
// 重点验证「优雅收尾路径与手动 /end 同源」之外的调度语义：登记 / 覆盖 / 取消 / 触发。

import { describe, expect, it, vi } from 'vitest';
import { createAutoEndScheduler } from '../src/services/autoEnd';

/** 假计时器：只记账，不真的等 */
function fakeTimer() {
  const tasks: Array<{ id: number; fn: () => void; ms: number; cancelled: boolean }> = [];
  let seq = 0;
  return {
    tasks,
    setTimer(fn: () => void, ms: number): { cancel: () => void } {
      seq += 1;
      const id = seq;
      const task = { id, fn, ms, cancelled: false };
      tasks.push(task);
      return {
        cancel: () => {
          task.cancelled = true;
        },
      };
    },
    /** 触发第 index 个未取消的任务 */
    fire(index = 0): void {
      const alive = tasks.filter((task) => !task.cancelled);
      const task = alive[index];
      if (!task) {
        throw new Error('没有可触发的定时器');
      }
      task.cancelled = true;
      task.fn();
    },
  };
}

describe('R26 createAutoEndScheduler 定时关播', () => {
  it('登记后可按场次查到，endsAt 由分钟数算出', () => {
    const timer = fakeTimer();
    const scheduler = createAutoEndScheduler({
      now: () => Date.parse('2026-09-17T10:00:00.000Z'),
      setTimer: timer.setTimer,
    });
    const reg = scheduler.schedule({ liveId: 'live-1', minutes: 30, onFire: async () => undefined });
    expect(reg.endsAt).toBe('2026-09-17T10:30:00.000Z');
    expect(timer.tasks[0]?.ms).toBe(30 * 60_000);
    expect(scheduler.pending('live-1')).toEqual(reg);
    expect(scheduler.pending('live-2')).toBeNull();
    expect(scheduler.list()).toHaveLength(1);
  });

  it('到点触发 onFire，并把回调参数传成该场次 id；触发后登记自动出表', async () => {
    const timer = fakeTimer();
    const scheduler = createAutoEndScheduler({ setTimer: timer.setTimer });
    const onFire = vi.fn(async () => undefined);
    scheduler.schedule({ liveId: 'live-9', minutes: 10, onFire });

    timer.fire();
    // onFire 是 async：等一轮微任务
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(onFire).toHaveBeenCalledWith('live-9');
    expect(scheduler.pending('live-9')).toBeNull();
    expect(scheduler.list()).toHaveLength(0);
  });

  it('取消后不再触发（手动 /end 的路径）', async () => {
    const timer = fakeTimer();
    const scheduler = createAutoEndScheduler({ setTimer: timer.setTimer });
    const onFire = vi.fn(async () => undefined);
    scheduler.schedule({ liveId: 'live-3', minutes: 10, onFire });

    expect(scheduler.cancel('live-3')).toBe(true);
    expect(scheduler.cancel('live-3')).toBe(false); // 幂等
    expect(timer.tasks.filter((task) => !task.cancelled)).toHaveLength(0);
    expect(onFire).not.toHaveBeenCalled();
  });

  it('同场次重复登记会覆盖旧定时器（改配置后重开播）', () => {
    const timer = fakeTimer();
    const scheduler = createAutoEndScheduler({ setTimer: timer.setTimer });
    scheduler.schedule({ liveId: 'live-4', minutes: 10, onFire: async () => undefined });
    scheduler.schedule({ liveId: 'live-4', minutes: 60, onFire: async () => undefined });

    expect(scheduler.list()).toHaveLength(1);
    expect(scheduler.pending('live-4')?.minutes).toBe(60);
    // 旧的那个必须被取消，否则同一场次会被关两次
    expect(timer.tasks.filter((task) => !task.cancelled)).toHaveLength(1);
  });

  it('onFire 抛错只告警，不产生未处理拒绝', async () => {
    const timer = fakeTimer();
    const warn = vi.fn();
    const scheduler = createAutoEndScheduler({ setTimer: timer.setTimer, warn });
    scheduler.schedule({
      liveId: 'live-5',
      minutes: 10,
      onFire: async () => {
        throw new Error('结算炸了');
      },
    });

    timer.fire();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('结算炸了');
  });

  it('dispose 取消全部（服务关停）', () => {
    const timer = fakeTimer();
    const scheduler = createAutoEndScheduler({ setTimer: timer.setTimer });
    scheduler.schedule({ liveId: 'a', minutes: 10, onFire: async () => undefined });
    scheduler.schedule({ liveId: 'b', minutes: 20, onFire: async () => undefined });

    scheduler.dispose();
    expect(scheduler.list()).toHaveLength(0);
    expect(timer.tasks.filter((task) => !task.cancelled)).toHaveLength(0);
  });
});
