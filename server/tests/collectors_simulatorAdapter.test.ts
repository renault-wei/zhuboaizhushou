import { describe, expect, it } from 'vitest';
import { createSimulatorAdapter, type SimulatedScript } from '../src/collectors/simulatorAdapter';
import type { WatchTarget } from '../src/collectors/types';

// D2.2 模拟弹幕源：内置 fixture 定时发归一化事件；假时钟驱动可离线测循环 / 断线 / 幂等键。

const TARGET: WatchTarget = { source: 'simulator', platform: 'douyin', roomRef: '7312834574980', liveId: 'live-0001' };

/** 真计时但每条封顶 8ms：避免长延时拖慢测试，也不会让循环饿死事件循环 */
function cappedSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.min(ms, 8)));
}

interface CollectResult {
  events: Array<Record<string, unknown>>;
  states: string[];
  stop(): Promise<void>;
}

async function collect(script: SimulatedScript | null, heartbeatOk?: (seq: number) => boolean): Promise<CollectResult> {
  const adapter = createSimulatorAdapter({
    scriptFor: () => script,
    sleep: cappedSleep,
    heartbeatOk,
  });
  const events: Array<Record<string, unknown>> = [];
  const states: string[] = [];
  const session = await adapter.open(TARGET, {
    onEvent: (event) => events.push({ ...event }),
    onStateChange: (state) => states.push(state),
  });
  return {
    events,
    states,
    stop: () => session.close(),
  };
}

describe('D2.2 simulatorAdapter 模拟弹幕源', () => {
  it('按 fixture 顺序发出 chat/enter/like/gift，字段透传且带幂等键', async () => {
    const script: SimulatedScript = {
      loop: false,
      steps: [
        { delayMs: 1, type: 'chat', nickname: '干饭的猫', content: ' 双人毛肚套餐多少钱？ ' },
        { delayMs: 1, type: 'gift', nickname: '老板大气', content: '送出小心心' },
        { delayMs: 1, type: 'enter', nickname: '路人甲' },
      ],
    };
    const handle = await collect(script);
    // 播完即 ended，不循环
    await waitUntil(() => handle.states.includes('ended'), 300);
    expect(handle.events).toHaveLength(3);
    expect(handle.events[0]).toMatchObject({
      platform: 'douyin',
      roomRef: '7312834574980',
      liveId: 'live-0001',
      msgType: 'chat',
      content: '双人毛肚套餐多少钱？',
      senderNickname: '干饭的猫',
    });
    expect(handle.events[0]?.msgKey).toMatch(/^7312834574980:sim-\d+-1$/);
    expect(handle.events[1]).toMatchObject({ msgType: 'gift' });
    expect(handle.events[2]).toMatchObject({ msgType: 'enter' });
    for (const event of handle.events) {
      expect(Number.isNaN(Date.parse(String(event.happenedAt)))).toBe(false);
    }
    await handle.stop();
  });

  it('loop=true 循环播放时 msgKey 始终唯一（幂等键可跨轮去重）', async () => {
    const script: SimulatedScript = {
      loop: true,
      steps: [
        { delayMs: 1, type: 'chat', nickname: '老王', content: '有券吗' },
        { delayMs: 1, type: 'like', nickname: '老王' },
      ],
    };
    const handle = await collect(script);
    await waitUntil(() => handle.events.length >= 6, 500);
    const keys = new Set(handle.events.map((event) => event.msgKey as string));
    expect(keys.size).toBe(handle.events.length);
    expect(handle.events.filter((event) => event.msgType === 'chat')).toHaveLength(3);
    await handle.stop();
  });

  it('heartbeatOk=false → heartbeat 判死（供断线重连用例）；close 幂等', async () => {
    const adapter = createSimulatorAdapter({ scriptFor: () => null, sleep: cappedSleep, heartbeatOk: () => false });
    const session = await adapter.open(TARGET, { onEvent: () => undefined, onStateChange: () => undefined });
    expect(await session.heartbeat()).toBe(false);
    await session.close();
    await session.close();
    expect(await session.heartbeat()).toBe(false);
  });

  it('heartbeatOk=true → 会话存活；close 后不再发新事件', async () => {
    const script: SimulatedScript = {
      loop: true,
      steps: [{ delayMs: 1, type: 'chat', nickname: 'A', content: '继续播' }],
    };
    const adapter = createSimulatorAdapter({ scriptFor: () => script, sleep: cappedSleep, heartbeatOk: () => true });
    const events: Array<Record<string, unknown>> = [];
    const session = await adapter.open(TARGET, {
      onEvent: (event) => events.push({ ...event }),
      onStateChange: () => undefined,
    });
    expect(await session.heartbeat()).toBe(true);
    await waitUntil(() => events.length >= 2, 300);
    const countAtClose = events.length;
    await session.close();
    // close 后已发出的不再补发：等一个真实 tick 后数量不变
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(events.length).toBe(countAtClose);
  });

  it('无脚本（scriptFor 返回空）→ 不发事件但会话存活，close 正常退出', async () => {
    const adapter = createSimulatorAdapter({ scriptFor: () => null, sleep: cappedSleep });
    const events: Array<Record<string, unknown>> = [];
    const session = await adapter.open(TARGET, {
      onEvent: (event) => events.push({ ...event }),
      onStateChange: () => undefined,
    });
    expect(await session.heartbeat()).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(events).toHaveLength(0);
    await session.close();
  });
});

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

