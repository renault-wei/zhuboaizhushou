import { describe, expect, it } from 'vitest';
import { createCollectorManager, watchKeyOf } from '../src/collectors/collectorManager';
import type { AdapterHooks, CollectorAdapter, CollectorSourceKey, WatchTarget } from '../src/collectors/types';

// D2.2 CollectorManager 单测：注册/注销、每房一 worker、心跳判死重连、并发上限、优雅退出、事件守卫兜底。
// 全部用替身适配器 + 封顶真实计时器（离线，不触网不碰 DB）。

const TARGET: WatchTarget = { source: 'simulator', platform: 'douyin', roomRef: '7312834574980', liveId: 'live-0001' };
const OTHER_TARGET: WatchTarget = { source: 'simulator', platform: 'douyin', roomRef: '8888', liveId: null };

function cappedSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.min(ms, 8)));
}

interface FakeAdapterBehavior {
  heartbeatFor?(sessionSeq: number): boolean;
  /** 返回 false → 本次 open 抛错（模拟连接失败） */
  openFor?(sessionSeq: number): boolean;
  /** open 成功瞬间同步触发（发事件 / 上报连接态） */
  emitOnOpen?(hooks: AdapterHooks, sessionSeq: number): void;
}

function fakeAdapter(source: CollectorSourceKey, behavior: FakeAdapterBehavior = {}) {
  let seq = 0;
  const closedSessions: number[] = [];
  const adapter: CollectorAdapter & { openCalls: number; closedSessions: number[] } = {
    source,
    openCalls: 0,
    closedSessions,
    async open(target: WatchTarget, hooks: AdapterHooks) {
      seq += 1;
      adapter.openCalls += 1;
      if (behavior.openFor && !behavior.openFor(seq)) {
        throw new Error(`模拟打开失败（第 ${seq} 次）`);
      }
      behavior.emitOnOpen?.(hooks, seq);
      return {
        async heartbeat() {
          return behavior.heartbeatFor ? behavior.heartbeatFor(seq) : true;
        },
        async close() {
          closedSessions.push(seq);
        },
      };
    },
  };
  return adapter;
}

function managerWith(adapter: CollectorAdapter, extra: Record<string, unknown> = {}) {
  const forwarded: Array<Record<string, unknown>> = [];
  const manager = createCollectorManager({
    adapters: [adapter],
    onEvent: (event) => forwarded.push({ ...event }),
    sleep: cappedSleep,
    ...extra,
  });
  return { manager, forwarded };
}

function waitUntil(cond: () => boolean, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const poll = (): void => {
      if (cond()) {
        resolve();
        return;
      }
      if (Date.now() - started > timeoutMs) {
        reject(new Error('waitUntil 超时'));
        return;
      }
      setTimeout(poll, 5);
    };
    poll();
  });
}

describe('D2.2 CollectorManager 生命周期与事件守卫', () => {
  it('注册监听：有效事件经守卫转发并计数，会话进入 connected', async () => {
    const adapter = fakeAdapter('simulator', {
      emitOnOpen: (hooks) => {
        hooks.onEvent({
          platform: 'douyin',
          roomRef: TARGET.roomRef,
          liveId: TARGET.liveId,
          msgKey: 'douyin:1',
          msgType: 'chat',
          content: '  老板，毛肚套餐多少钱？  ',
          senderNickname: '干饭的猫',
          happenedAt: new Date().toISOString(),
        });
        hooks.onEvent({
          platform: 'douyin',
          roomRef: TARGET.roomRef,
          liveId: TARGET.liveId,
          msgKey: 'douyin:2',
          msgType: 'gift',
          senderNickname: '老板大气',
          happenedAt: new Date().toISOString(),
        });
      },
    });
    const { manager, forwarded } = managerWith(adapter);
    const result = await manager.startWatching(TARGET);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.created).toBe(true);
    await waitUntil(() => forwarded.length >= 2, 500);
    expect(forwarded[0]).toMatchObject({ content: '老板，毛肚套餐多少钱？', senderNickname: '干饭的猫' });
    expect(forwarded[1]).toMatchObject({ msgType: 'gift' });
    await waitUntil(() => manager.status().active[0]?.status === 'connected', 500);
    expect(manager.status().active).toHaveLength(1);
    expect(manager.status().active[0]?.eventCount).toBe(2);
    await manager.stopWatching(watchKeyOf(TARGET));
  });

  it('脏事件（chat 无文本）被守卫丢弃：只计 invalidEvents，不转发、会话不死', async () => {
    const adapter = fakeAdapter('simulator', {
      emitOnOpen: (hooks) => {
        hooks.onEvent({
          platform: 'douyin',
          roomRef: TARGET.roomRef,
          liveId: TARGET.liveId,
          msgKey: 'douyin:bad',
          msgType: 'chat',
          happenedAt: new Date().toISOString(),
        });
      },
    });
    const { manager, forwarded } = managerWith(adapter);
    await manager.startWatching(TARGET);
    await waitUntil(() => manager.status().active[0]?.invalidEvents === 1, 500);
    expect(forwarded).toHaveLength(0);
    expect(manager.status().active[0]?.eventCount).toBe(0);
    await manager.stopWatching(watchKeyOf(TARGET));
  });

  it('end 事件 → 优雅收尾：状态 ended、释放占位并进历史', async () => {
    const adapter = fakeAdapter('simulator', {
      emitOnOpen: (hooks) => {
        hooks.onEvent({
          platform: 'douyin',
          roomRef: TARGET.roomRef,
          liveId: TARGET.liveId,
          msgKey: 'douyin:end',
          msgType: 'end',
          happenedAt: new Date().toISOString(),
        });
      },
    });
    const { manager } = managerWith(adapter);
    const result = await manager.startWatching(TARGET);
    expect(result.ok).toBe(true);
    await waitUntil(() => manager.status().active.length === 0, 500);
    const ended = manager.status().history.find((item) => item.key === watchKeyOf(TARGET));
    expect(ended?.status).toBe('ended');
  });

  it('startWatching 同目标幂等：created=false 且不重复起 worker', async () => {
    const adapter = fakeAdapter('simulator');
    const { manager } = managerWith(adapter);
    const first = await manager.startWatching(TARGET);
    const second = await manager.startWatching(TARGET);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.created).toBe(false);
    expect(adapter.openCalls).toBe(1);
    await manager.stopWatching(watchKeyOf(TARGET));
  });

  it('并发上限：占满名额后新目标返回 LIMIT_REACHED', async () => {
    const adapter = fakeAdapter('simulator');
    const { manager } = managerWith(adapter, { maxConcurrentWatches: 2 });
    const a = await manager.startWatching(TARGET);
    const b = await manager.startWatching(OTHER_TARGET);
    const c = await manager.startWatching({ ...OTHER_TARGET, roomRef: '9999' });
    expect(a.ok && b.ok).toBe(true);
    if (!c.ok) {
      expect(c.code).toBe('LIMIT_REACHED');
    }
    expect(manager.status().active).toHaveLength(2);
    await manager.dispose();
  });

  it('未知适配器 → NO_ADAPTER', async () => {
    const { manager } = managerWith(fakeAdapter('simulator'));
    const result = await manager.startWatching({ ...TARGET, source: 'bilibili' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('NO_ADAPTER');
    }
  });
});

describe('D2.2 CollectorManager 心跳与重连', () => {
  it('心跳判死 → 自动重连新会话（openAttempts=2 后恢复 connected）', async () => {
    const adapter = fakeAdapter('simulator', { heartbeatFor: (sessionSeq) => sessionSeq !== 1 });
    const { manager } = managerWith(adapter, { heartbeatIntervalMs: 20, reconnectDelayMs: 10 });
    await manager.startWatching(TARGET);
    await waitUntil(() => adapter.openCalls >= 2, 1000);
    await waitUntil(() => manager.status().active[0]?.status === 'connected' && (manager.status().active[0]?.openAttempts ?? 0) >= 2, 1000);
    expect(adapter.closedSessions).toContain(1);
    await manager.stopWatching(watchKeyOf(TARGET));
  });

  it('open 连续失败超过上限 → error 终止并释放占位（最多尝试 maxOpenAttempts 次）', async () => {
    const adapter = fakeAdapter('simulator', { openFor: () => false });
    const { manager } = managerWith(adapter, { reconnectDelayMs: 5, maxOpenAttempts: 3 });
    await manager.startWatching(TARGET);
    await waitUntil(() => manager.status().active.length === 0, 1000);
    const failed = manager.status().history.find((item) => item.key === watchKeyOf(TARGET));
    expect(failed?.status).toBe('error');
    expect(adapter.openCalls).toBe(3);
    expect(failed?.lastError).toContain('打开失败');
    expect(manager.status().activeWatches).toBe(0);
  });

  it('stopWatching 幂等：首次 true、再次 false，占位释放后可重新监听', async () => {
    const adapter = fakeAdapter('simulator');
    const { manager } = managerWith(adapter);
    await manager.startWatching(TARGET);
    expect(await manager.stopWatching(watchKeyOf(TARGET))).toBe(true);
    expect(await manager.stopWatching(watchKeyOf(TARGET))).toBe(false);
    expect(manager.status().active).toHaveLength(0);
    expect(manager.status().history[0]?.status).toBe('stopped');
    const restart = await manager.startWatching(TARGET);
    expect(restart.ok).toBe(true);
    if (restart.ok) {
      expect(restart.created).toBe(true);
      expect(adapter.openCalls).toBe(2);
    }
    await manager.dispose();
  });

  it('适配器上报 ended 连接态 → 优雅收尾（无需心跳判死）', async () => {
    const adapter = fakeAdapter('simulator', {
      emitOnOpen: (hooks) => hooks.onStateChange('ended'),
    });
    const { manager } = managerWith(adapter);
    await manager.startWatching(TARGET);
    await waitUntil(() => manager.status().active.length === 0, 500);
    expect(manager.status().history[0]?.status).toBe('ended');
  });

  it('dispose 清空活动会话，之后 startWatching 被拒', async () => {
    const adapter = fakeAdapter('simulator');
    const { manager } = managerWith(adapter);
    await manager.startWatching(TARGET);
    await manager.startWatching(OTHER_TARGET);
    expect(manager.status().active).toHaveLength(2);
    await manager.dispose();
    expect(manager.status().active).toHaveLength(0);
    expect(manager.status().history).toHaveLength(2);
    const after = await manager.startWatching(TARGET);
    expect(after.ok).toBe(false);
  });
});
