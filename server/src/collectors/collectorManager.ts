// 采集管理器（D2.2）：注册/注销、每房一 worker、心跳判活 + 断线重连（有界次数）、并发上限、优雅退出。
// 适配器只负责 open 会话与发归一化事件；本模块做守卫兜底与生命周期，业务侧不感知单房断线细节。
// 真实平台协议适配器（D2.3/D2.4）受 D2.5 合规门约束本期不实现；本模块可接任意满足 CollectorAdapter 契约的源。
import {
  guardEvent,
} from './events';
import type { AdapterHooks, AdapterSession, CollectorAdapter, UnifiedDanmakuEvent, WatchTarget } from './types';

/** 单个监听会话的运行状态（manager 视角） */
export type CollectorWatchStatus = 'starting' | 'connected' | 'reconnecting' | 'stopped' | 'ended' | 'error';

/** 单房监听的可查询快照（status() 返回副本，不暴露内部可变引用） */
export interface CollectorWatchSummary {
  key: string;
  target: WatchTarget;
  status: CollectorWatchStatus;
  /** 累计 open 尝试次数（含断线重连）；超过上限即终止 */
  openAttempts: number;
  /** 通过守卫并转发的有效事件数 */
  eventCount: number;
  /** 被守卫丢弃的事件数（脏报文不影响会话存活） */
  invalidEvents: number;
  startedAt: string;
  connectedAt: string | null;
  lastError: string | null;
}

/** 管理器整体状态：活动监听 + 最近终止记录（有界，便于排障） */
export interface CollectorManagerStatus {
  activeWatches: number;
  maxConcurrentWatches: number;
  active: CollectorWatchSummary[];
  history: CollectorWatchSummary[];
}

/** 启动监听的结果：已存在同目标会话 → created=false（幂等，不重复起 worker） */
export type StartWatchResult =
  | { ok: true; summary: CollectorWatchSummary; created: boolean }
  | { ok: false; code: 'LIMIT_REACHED' | 'NO_ADAPTER'; reason: string };

/** 依赖全部可注入：生产用真实计时器与事件回调；测试注入替身适配器 / 假 sleep */
export interface CollectorManagerDeps {
  /** 已注册适配器注册表（含内置模拟源；未来真实平台适配器解锁后注册于此） */
  adapters: readonly CollectorAdapter[];
  /** 有效事件转发（D5.1 接线：接到既有弹幕网关 / 实时广播） */
  onEvent?(event: UnifiedDanmakuEvent): void;
  /** 并发监听上限（同时占位的会话数） */
  maxConcurrentWatches?: number;
  /** 心跳间隔（ms） */
  heartbeatIntervalMs?: number;
  /** 断线后的重连等待（ms） */
  reconnectDelayMs?: number;
  /** 单会话累计 open 上限（含首次与重连，超出判定 error 终止并释放占位） */
  maxOpenAttempts?: number;
  sleep?(ms: number): Promise<void>;
  now?(): Date;
}

export interface CollectorManager {
  startWatching(target: WatchTarget): Promise<StartWatchResult>;
  /** 主动停止：幂等；返回是否存在该会话 */
  stopWatching(key: string): Promise<boolean>;
  status(): CollectorManagerStatus;
  /** 停止全部并清理（服务关停 / 测试收尾） */
  dispose(): Promise<void>;
}

const DEFAULT_MAX_CONCURRENT = 4;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 5000;
const DEFAULT_RECONNECT_DELAY_MS = 2000;
const DEFAULT_MAX_OPEN_ATTEMPTS = 3;
const HISTORY_LIMIT = 20;

function sleepReal(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 会话幂等键：同一 source+platform+roomRef 只允许一条活动会话 */
export function watchKeyOf(target: WatchTarget): string {
  return `${target.source}:${target.platform}:${target.roomRef}`;
}

interface WatchWorker {
  key: string;
  target: WatchTarget;
  adapter: CollectorAdapter;
  summary: CollectorWatchSummary;
  session: AdapterSession | null;
  closed: boolean;
  finalized: boolean;
}

export function createCollectorManager(deps: CollectorManagerDeps): CollectorManager {
  const adapters = deps.adapters;
  const maxConcurrentWatches = deps.maxConcurrentWatches ?? DEFAULT_MAX_CONCURRENT;
  const heartbeatIntervalMs = deps.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  const reconnectDelayMs = deps.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS;
  const maxOpenAttempts = deps.maxOpenAttempts ?? DEFAULT_MAX_OPEN_ATTEMPTS;
  const sleep = deps.sleep ?? sleepReal;
  const now = deps.now ?? (() => new Date());
  const onEvent = deps.onEvent;

  /** 活动 worker：starting/connected/reconnecting 各占一个并发名额 */
  const active = new Map<string, WatchWorker>();
  const history: CollectorWatchSummary[] = [];
  let disposed = false;

  function snapshotOf(worker: WatchWorker): CollectorWatchSummary {
    const summary = worker.summary;
    return { ...summary, target: { ...summary.target } };
  }

  function finalize(worker: WatchWorker, finalStatus: CollectorWatchStatus): void {
    if (worker.finalized) {
      return;
    }
    worker.finalized = true;
    worker.closed = true;
    worker.summary.status = finalStatus;
    active.delete(worker.key);
    history.push(snapshotOf(worker));
    if (history.length > HISTORY_LIMIT) {
      history.shift();
    }
  }

  function makeHooks(worker: WatchWorker): AdapterHooks {
    return {
      onEvent(raw: UnifiedDanmakuEvent): void {
        if (worker.closed) {
          return;
        }
        const guarded = guardEvent(raw);
        if (!guarded.ok) {
          worker.summary.invalidEvents += 1;
          console.warn(`[collectorManager] 丢弃异常采集事件（${worker.key}）：${guarded.reason}`);
          return;
        }
        const event = guarded.event;
        worker.summary.eventCount += 1;
        if (event.msgType === 'end') {
          // 直播结束：优雅收尾（与业务主动 stop 区分，便于落库层联动场次状态）
          finalize(worker, 'ended');
          onEvent?.(event);
          void worker.session?.close().catch(() => undefined);
          return;
        }
        onEvent?.(event);
      },
      onStateChange(state): void {
        if (worker.closed) {
          return;
        }
        if (state === 'ended') {
          // 直播已结束（适配器主动上报）：与 end 事件同语义，优雅收尾不等心跳
          finalize(worker, 'ended');
          void worker.session?.close().catch(() => undefined);
        }
        // disconnected/error 状态由心跳探活兜底收敛（≤ 一个心跳周期），不在此处额外驱动
      },
    };
  }

  /** 心跳驱动：会话存活期间按固定间隔探活；返回 dead=会话判死需重连，closed=被外部停止 */
  async function driveHeartbeat(worker: WatchWorker, session: AdapterSession): Promise<'dead' | 'closed'> {
    while (!worker.closed) {
      await sleep(heartbeatIntervalMs);
      if (worker.closed) {
        return 'closed';
      }
      let alive = false;
      try {
        alive = await session.heartbeat();
      } catch (error) {
        worker.summary.lastError = error instanceof Error ? error.message : String(error);
      }
      if (!alive) {
        worker.summary.lastError = worker.summary.lastError ?? '心跳判死：连接已断开';
        worker.summary.status = 'reconnecting';
        await session.close().catch(() => undefined);
        return 'dead';
      }
    }
    return 'closed';
  }

  async function runWatch(worker: WatchWorker): Promise<void> {
    try {
      let openAttempts = 0;
      while (!worker.closed) {
        openAttempts += 1;
        worker.summary.openAttempts = openAttempts;
        if (openAttempts > maxOpenAttempts) {
          worker.summary.lastError = `重连 ${maxOpenAttempts} 次均失败，终止监听`;
          finalize(worker, 'error');
          return;
        }
        worker.summary.status = openAttempts === 1 ? 'starting' : 'reconnecting';
        try {
          const session = await worker.adapter.open(worker.target, makeHooks(worker));
          if (worker.closed) {
            await session.close().catch(() => undefined);
            return;
          }
          worker.session = session;
          worker.summary.connectedAt = now().toISOString();
          worker.summary.status = 'connected';
          worker.summary.lastError = null;
          const result = await driveHeartbeat(worker, session);
          worker.session = null;
          if (result === 'closed') {
            return;
          }
          // dead：回到循环头重连（attempt 已在循环头累计）
        } catch (error) {
          worker.summary.lastError = error instanceof Error ? error.message : String(error);
          console.warn(`[collectorManager] 会话打开失败（${worker.key}）：${worker.summary.lastError}`);
          if (worker.closed) {
            return;
          }
          if (openAttempts >= maxOpenAttempts) {
            finalize(worker, 'error');
            return;
          }
          worker.summary.status = 'reconnecting';
          await sleep(reconnectDelayMs);
        }
      }
    } finally {
      // run 因 stop/end 提前退出且未被业务侧 finalize 时兜底清理
      finalize(worker, worker.closed ? 'stopped' : worker.summary.status);
    }
  }

  async function startWatching(target: WatchTarget): Promise<StartWatchResult> {
    const key = watchKeyOf(target);
    if (disposed) {
      return { ok: false, code: 'LIMIT_REACHED', reason: '管理器已关闭' };
    }
    const existing = active.get(key);
    if (existing) {
      return { ok: true, summary: snapshotOf(existing), created: false };
    }
    if (active.size >= maxConcurrentWatches) {
      return { ok: false, code: 'LIMIT_REACHED', reason: `并发监听已达上限（${maxConcurrentWatches}）` };
    }
    const adapter = adapters.find((candidate) => candidate.source === target.source);
    if (!adapter) {
      return { ok: false, code: 'NO_ADAPTER', reason: `未注册适配器：${target.source}` };
    }
    const worker: WatchWorker = {
      key,
      target,
      adapter,
      summary: {
        key,
        target,
        status: 'starting',
        openAttempts: 0,
        eventCount: 0,
        invalidEvents: 0,
        startedAt: now().toISOString(),
        connectedAt: null,
        lastError: null,
      },
      session: null,
      closed: false,
      finalized: false,
    };
    active.set(key, worker);
    void runWatch(worker);
    return { ok: true, summary: snapshotOf(worker), created: true };
  }

  async function stopWatching(key: string): Promise<boolean> {
    const worker = active.get(key);
    if (!worker) {
      return false;
    }
    worker.closed = true;
    const session = worker.session;
    worker.session = null;
    finalize(worker, 'stopped');
    await session?.close().catch(() => undefined);
    return true;
  }

  function status(): CollectorManagerStatus {
    return {
      activeWatches: active.size,
      maxConcurrentWatches,
      active: [...active.values()].map(snapshotOf),
      history: history.map((summary) => ({ ...summary, target: { ...summary.target } })),
    };
  }

  async function dispose(): Promise<void> {
    disposed = true;
    const workers = [...active.values()];
    await Promise.all(
      workers.map(async (worker) => {
        worker.closed = true;
        const session = worker.session;
        worker.session = null;
        await session?.close().catch(() => undefined);
        finalize(worker, 'stopped');
      }),
    );
  }

  return { startWatching, stopWatching, status, dispose };
}

