// 采集接线层（R2/R3）：把 collectors/* 这个库接到既有弹幕网关与场次生命周期上。
// 这是 collectors/* 的**第一个生产调用点**——库本身一行不改，只在这里做「装配 + 归属映射 + 事件转发」。
//
// 为什么必须单独有这一层：
//   1. UnifiedDanmakuEvent 只带 liveId，不带 userId；而 danmakuGateway.ingest(userId, liveId, …) 两者都要。
//      → 本层在 start 时记下 liveId → userId，stop 时清除。
//   2. collectors 库只认「适配器 + 管理器」，不认业务归属；绑定 / 解绑属业务侧职责。
//
// 合规边界（见 docs/DANMAKU-COLLECTOR-PLAN.md §7）：
//   只以观众身份连平台公开网页端，仅监听自己直播间，低流量、自用自测；
//   未配置签名 Key 时整层降级为「仅测试弹幕注入」，不影响任何既有功能。

import { randomUUID } from 'node:crypto';
import {
  createCollectorManager,
  watchKeyOf,
  type CollectorManager,
  type CollectorManagerDeps,
  type CollectorWatchSummary,
} from '../collectors/collectorManager';
import { createDouyinHttpSigner, createDouyinLiveAdapter } from '../collectors/douyinLiveAdapter';
import { eventToIngestInput } from '../collectors/events';
import { createLinkResolver, type ResolveShareResult } from '../collectors/linkResolver';
import {
  createDouyinTtwidFetcher,
  createHttpShortLinkExpander,
} from '../collectors/shortLinkExpander';
import type { CollectorAdapter, DanmakuPlatform, UnifiedDanmakuEvent } from '../collectors/types';
import { env } from '../config/env';
import { danmakuGateway, type DanmakuIngestInput } from './danmaku';

// ---------- 错误类型 ----------

export type CollectorSourceErrorCode = 'SOURCE_DISABLED' | 'RESOLVE_FAILED' | 'START_FAILED';

/** 采集源业务错误：携带机器可读错误码，由路由层翻译成 HTTP 状态 */
export class CollectorSourceError extends Error {
  readonly code: CollectorSourceErrorCode;

  constructor(code: CollectorSourceErrorCode, message: string) {
    super(message);
    this.name = 'CollectorSourceError';
    this.code = code;
  }
}

// ---------- 类型定义 ----------

/**
 * 一场直播的采集绑定（内存态）。
 * 自用自测口径下**不落库**：collectorManager.status() 已提供内存态，
 * 按「能砍就砍」不建 collector_watches 表（见 PLAN §11.3）。
 */
export interface LiveCollectorBinding {
  liveId: string;
  userId: string;
  platform: DanmakuPlatform;
  roomRef: string;
  /** manager 的会话幂等键（= source:platform:roomRef） */
  watchKey: string;
  startedAt: string;
  /**
   * 该场连接 wss 时必需的头（目前是抖音的 `Cookie: ttwid=…`）。
   * 来自短链解析那一次请求的 Set-Cookie —— 每个直播间一份，所以必须随绑定存下来。
   */
  connectHeaders?: Record<string, string>;
}

/**
 * 独立监控绑定（R16 · 监听源与场次解耦）：
 * **不绑场次、不落库**，只把事件放进有界环形缓冲供接口读取。
 * 用途 = 用户要的「贴个链接就能单独看弹幕流水」，无需先开一场直播。
 */
export interface MonitorBinding {
  /** 服务端生成的监听源 id */
  watchId: string;
  userId: string;
  platform: DanmakuPlatform;
  roomRef: string;
  watchKey: string;
  startedAt: string;
  connectHeaders?: Record<string, string>;
}

/** 缓冲里的一条事件（只保留读流水需要的字段，不暴露原始报文） */
export interface MonitorEvent {
  /** 单调递增序号，供 since 增量拉取 */
  seq: number;
  msgType: string;
  content: string | null;
  senderNickname: string | null;
  happenedAt: string;
}

export interface StartMonitorInput {
  userId: string;
  roomRef?: string;
  shareText?: string;
}

export interface LiveCollectorStatus {
  /** 采集通道是否可用（= 已配签名 Key 且注册了适配器） */
  enabled: boolean;
  binding: LiveCollectorBinding | null;
  /** 运行态快照（来自 collectorManager，只含本场那一条） */
  watch: CollectorWatchSummary | null;
}

export interface StartCollectorInput {
  userId: string;
  liveId: string;
  /** 抖音 web 房间号（数字串）——与 shareText 二选一 */
  roomRef?: string;
  /** 直播间分享文本 / 链接——与 roomRef 二选一 */
  shareText?: string;
}

export interface LiveCollector {
  /** 采集通道是否已启用（未配 Key → false，路由层据此给出明确提示而不是报错） */
  enabled(): boolean;
  /**
   * 只登记采集源（解析 + 记绑定），**不起会话**。
   * 用途 = 「开播前先把直播间配好」：场次还没直播时无法起会话（入库会被 LIVE_NOT_LIVE 拒），
   * 但可以先把房间号记下来，等 /start 时由 resume 拉起。
   */
  bind(input: StartCollectorInput): Promise<LiveCollectorBinding>;
  /** 绑定并起会话（= bind + resume；幂等） */
  start(input: StartCollectorInput): Promise<LiveCollectorBinding>;
  /** 为已有绑定起会话（幂等）；无绑定返回 null，供 /start 开播联动 */
  resume(liveId: string): Promise<LiveCollectorBinding | null>;
  /** 只停会话、**保留绑定**（供 /end；下次开播 resume 即可复用同一房间号） */
  suspend(liveId: string): Promise<boolean>;
  /** 停会话并清绑定（幂等），供 DELETE */
  stop(liveId: string): Promise<boolean>;
  statusOf(liveId: string): LiveCollectorStatus;
  /** R16：起一个**独立监控**（不绑场次、不落库，只进内存环形缓冲） */
  startMonitor(input: StartMonitorInput): Promise<MonitorBinding>;
  /** R16：停并移除独立监控（幂等；返回是否确实存在） */
  stopMonitor(watchId: string, userId: string): Promise<boolean>;
  /** R16：读某监控的最近事件（按 seq 升序）；`sinceSeq` 用于增量；非本人 / 不存在返回 null */
  monitorEvents(watchId: string, userId: string, sinceSeq?: number): MonitorEvent[] | null;
  /** R16：列出某用户当前的独立监控 */
  listMonitors(userId: string): MonitorBinding[];
  /** 停止全部会话并清理（服务关停 / 测试收尾） */
  dispose(): Promise<void>;
}

/** 依赖全部可注入：生产用真实适配器与网关；测试注入替身，做到全离线 */
export interface LiveCollectorDeps {
  /** 适配器注册表；缺省按环境构造（未配签名 Key 时为空 → 整层降级） */
  adapters?: readonly CollectorAdapter[];
  /** 事件落库出口；缺省走既有弹幕网关 */
  ingest?: (userId: string, liveId: string, input: DanmakuIngestInput) => Promise<unknown>;
  /** 链接解析；缺省用带短链展开器的解析器 */
  resolveShareText?: (text: string) => Promise<ResolveShareResult>;
  /** 按房间号现取 ttwid（完整链接 / 纯房间号场景）；缺省真网络，测试可注入 */
  fetchTtwid?: (roomRef: string) => Promise<string | null>;
  /** 透传给 collectorManager 的参数（重连策略 / 心跳间隔等）；测试可调，生产按部署调 */
  managerOptions?: Partial<Omit<CollectorManagerDeps, 'adapters' | 'onEvent'>>;
  /**
   * 保活看门狗间隔（ms）：定期检查「武装中」的绑定，会话掉出 connected/starting/reconnecting 就自动拉起。
   * 对齐竞品 startCSystemTimer(30, …)。**0 = 关闭**（测试用）。默认 30s。
   */
  watchdogIntervalMs?: number;
  now?: () => Date;
  warn?: (message: string) => void;
}

/**
 * 默认解析器**带短链展开器**：抖音 App 分享出来的就是 `v.douyin.com` 短链，
 * 而直播间身份只在跳转后的 `live.douyin.com/<房间号>` 里 —— 不带展开器时「只给链接」走不通
 * （linkResolver 会返回 SHORT_LINK_ONLY）。
 */
const defaultLinkResolver = createLinkResolver({
  expandShortLink: createHttpShortLinkExpander(),
});

/** 按环境构造适配器：没有签名 Key 就一个都不注册 → 采集通道优雅降级 */
function defaultAdapters(): CollectorAdapter[] {
  const { apiKey, endpointUrl, userUniqueId } = env.douyinSign;
  if (!apiKey) {
    return [];
  }
  const signer = createDouyinHttpSigner({
    endpointUrl,
    apiKey,
    ...(userUniqueId ? { userUniqueId } : {}),
  });
  return [createDouyinLiveAdapter({ signer })];
}

// ---------- 工厂 + 单例 ----------

export function createLiveCollector(deps: LiveCollectorDeps = {}): LiveCollector {
  const adapters = deps.adapters ?? defaultAdapters();
  const ingest =
    deps.ingest ?? ((userId: string, liveId: string, input: DanmakuIngestInput) => danmakuGateway.ingest(userId, liveId, input));
  const resolveShareText =
    deps.resolveShareText ?? ((text: string) => defaultLinkResolver.resolveShareText(text));
  const fetchTtwid = deps.fetchTtwid ?? createDouyinTtwidFetcher();
  const warn = deps.warn ?? ((message: string) => console.warn(`[liveCollector] ${message}`));
  const now = deps.now ?? (() => new Date());
  const watchdogIntervalMs = deps.watchdogIntervalMs ?? 30_000;

  /** liveId → 绑定：采集事件只带 liveId，靠它反查 userId */
  const bindings = new Map<string, LiveCollectorBinding>();
  /**
   * 「武装中」的场次：这些绑定的会话**应当**在跑，看门狗负责拉起。
   * suspend（直播结束）会把它移出 —— 否则看门狗会把已结束的场次又拉起来，白烧连接。
   */
  const armed = new Set<string>();

  // ---------- R16：独立监控（不绑场次、不落库） ----------
  /** watchId → 监控绑定 */
  const monitors = new Map<string, MonitorBinding>();
  /** manager 会话键 → watchId（事件只带平台/房间，靠它反查监控） */
  const monitorIdByWatchKey = new Map<string, string>();
  /** watchId → 最近事件（有界环形，新的在后） */
  const monitorBuffers = new Map<string, MonitorEvent[]>();
  /** 全局单调序号：供 since 增量拉取，跨监控共享即可 */
  let monitorSeq = 0;

  /** 独立监控的事件缓冲上限（防长直播把内存吃满） */
  const MAX_MONITOR_EVENTS = 200;

  /**
   * 采集事件 → 既有弹幕网关。
   * 任何失败只告警、绝不向上抛：单条弹幕入库失败不能拖垮整场采集会话。
   */
  /** 独立监控：按「平台+房间」反查监控并把事件压入环形缓冲（不落库、不进 AI 链路） */
  function bufferMonitorEvent(event: UnifiedDanmakuEvent): void {
    const key = watchKeyOf({
      source: event.platform,
      platform: event.platform,
      roomRef: event.roomRef,
      liveId: null,
    });
    const watchId = monitorIdByWatchKey.get(key);
    if (!watchId) {
      return;
    }
    monitorSeq += 1;
    const buffer = monitorBuffers.get(watchId) ?? [];
    buffer.push({
      seq: monitorSeq,
      msgType: event.msgType,
      content: event.content ?? null,
      senderNickname: event.senderNickname ?? null,
      happenedAt: event.happenedAt,
    });
    if (buffer.length > MAX_MONITOR_EVENTS) {
      buffer.splice(0, buffer.length - MAX_MONITOR_EVENTS);
    }
    monitorBuffers.set(watchId, buffer);
  }

  function handleEvent(event: UnifiedDanmakuEvent): void {
    const liveId = event.liveId;
    if (!liveId) {
      // R16：独立监控（不绑场次）—— 只进环形缓冲，不落库、不触发 AI 回复
      bufferMonitorEvent(event);
      return;
    }
    const binding = bindings.get(liveId);
    if (!binding) {
      // 场次已解绑（直播结束）后仍有在途事件：属正常收尾，忽略
      return;
    }
    const input = eventToIngestInput(event);
    if (!input) {
      // 非 chat（gift / like / enter / end）本期不入库：G4 引擎只回应弹幕文本
      return;
    }
    void ingest(binding.userId, liveId, input).catch((err: unknown) => {
      warn(`弹幕入库失败（live=${liveId}）：${err instanceof Error ? err.message : String(err)}`);
    });
  }

  const manager: CollectorManager = createCollectorManager({
    ...deps.managerOptions,
    adapters,
    onEvent: handleEvent,
  });

  function enabled(): boolean {
    return adapters.length > 0;
  }

  /** 起会话所需的最小目标描述：场次绑定与独立监控绑定都满足（liveId 为 null = 独立监控） */
  interface WatchTargetLike {
    platform: DanmakuPlatform;
    roomRef: string;
    /** 有值 = 场次采集；缺省 / null = 独立监控（R16），事件不落库 */
    liveId?: string | null;
    connectHeaders?: Record<string, string>;
  }

  /** 为一个绑定起（或复用）采集会话：manager 自带幂等，同 watchKey 不会重复起 worker */
  async function startWatch(binding: WatchTargetLike): Promise<void> {
    const target = {
      source: binding.platform,
      platform: binding.platform,
      roomRef: binding.roomRef,
      liveId: binding.liveId ?? null,
      ...(binding.connectHeaders ? { headers: binding.connectHeaders } : {}),
    };
    const result = await manager.startWatching(target);
    if (!result.ok) {
      throw new CollectorSourceError('START_FAILED', `启动采集失败（${result.code}）：${result.reason}`);
    }
  }

  async function resolveRoom(
    input: { roomRef?: string; shareText?: string },
  ): Promise<{ platform: DanmakuPlatform; roomRef: string; connectHeaders?: Record<string, string> }> {
    const directRoomRef = input.roomRef?.trim();
    if (directRoomRef) {
      // 直接给房间号：没有跳转链，ttwid 得按房间号现取（见下）
      return withTtwid('douyin', directRoomRef, undefined);
    }
    const shareText = input.shareText?.trim();
    if (!shareText) {
      throw new CollectorSourceError('RESOLVE_FAILED', '必须提供直播间分享链接或房间号');
    }
    const resolved = await resolveShareText(shareText);
    if (!resolved.ok) {
      throw new CollectorSourceError('RESOLVE_FAILED', `直播间解析失败（${resolved.code}）：${resolved.reason}`);
    }
    return withTtwid(resolved.room.platform, resolved.room.roomRef, resolved.room.connectHints?.cookie);
  }

  /**
   * 保证抖音场景一定拿到 ttwid。
   * - 短链路径：展开时已顺带取到，直接用；
   * - 完整链接 / 纯房间号路径：解析是静态的、没发过请求，**必须现取一次** ——
   *   否则 wss 握手会被回 HTTP 200（2026-09-16 对照实验实测）。
   */
  async function withTtwid(
    platform: DanmakuPlatform,
    roomRef: string,
    existingCookie: string | undefined,
  ): Promise<{ platform: DanmakuPlatform; roomRef: string; connectHeaders?: Record<string, string> }> {
    if (existingCookie) {
      return { platform, roomRef, connectHeaders: { Cookie: existingCookie } };
    }
    if (platform !== 'douyin') {
      return { platform, roomRef };
    }
    const fetched = await fetchTtwid(roomRef);
    return fetched ? { platform, roomRef, connectHeaders: { Cookie: fetched } } : { platform, roomRef };
  }

  /**
   * 保活看门狗（R13）：对齐竞品 startCSystemTimer(30, …)。
   * 只扫「武装中」的绑定：会话若已掉出 connected/starting/reconnecting（例如重连耗尽判 error），
   * 就自动重新拉起，避免「一场直播跑几小时、中途断几次就永久停摆」。
   */
  async function runWatchdog(): Promise<void> {
    for (const liveId of [...armed]) {
      // armed 里两种 id 混放：场次模式是 liveId，独立监控是 watchId
      const binding = bindings.get(liveId) ?? monitors.get(liveId);
      if (!binding) {
        armed.delete(liveId);
        continue;
      }
      const watch = manager.status().active.find((item) => item.key === binding.watchKey);
      const healthy =
        watch !== undefined &&
        (watch.status === 'connected' || watch.status === 'starting' || watch.status === 'reconnecting');
      if (healthy) {
        continue;
      }
      warn(`看门狗：会话未在监听（live=${liveId}，当前 ${watch?.status ?? '已终止'}），自动拉起`);
      try {
        await startWatch(binding);
      } catch (err) {
        warn(`看门狗拉起失败（live=${liveId}）：${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // unref：看门狗常驻不应阻止进程退出
  const watchdog =
    watchdogIntervalMs > 0
      ? setInterval(() => {
          void runWatchdog();
        }, watchdogIntervalMs)
      : null;
  watchdog?.unref?.();

  return {
    enabled,

    async bind(input: StartCollectorInput): Promise<LiveCollectorBinding> {
      if (!enabled()) {
        throw new CollectorSourceError(
          'SOURCE_DISABLED',
          '未配置 DOUYIN_SIGN_API_KEY，采集通道未启用（仍可用测试弹幕注入）',
        );
      }
      const room = await resolveRoom(input);
      const watchKey = watchKeyOf({
        source: room.platform,
        platform: room.platform,
        roomRef: room.roomRef,
        liveId: input.liveId,
      });
      const binding: LiveCollectorBinding = {
        liveId: input.liveId,
        userId: input.userId,
        platform: room.platform,
        roomRef: room.roomRef,
        watchKey,
        startedAt: now().toISOString(),
        ...(room.connectHeaders ? { connectHeaders: room.connectHeaders } : {}),
      };
      // ★换直播间时必须**先停掉旧会话**（2026-09-17）。
      // 原先只是 bindings.set 覆盖内存绑定，旧会话仍然连着**上一个直播间** ——
      // 结果是两个会话并行，把别的直播间的弹幕灌进本场（重复 + 串台）。
      // 这正是「改链接自动重连」要成立的前提：不先断旧，重连就是加倍泄漏。
      const previous = bindings.get(input.liveId);
      if (previous && previous.watchKey !== watchKey) {
        // 先解除武装，避免看门狗把旧会话又拉起来
        armed.delete(input.liveId);
        await manager.stopWatching(previous.watchKey);
      }
      bindings.set(input.liveId, binding);
      return binding;
    },

    async start(input: StartCollectorInput): Promise<LiveCollectorBinding> {
      const binding = await this.bind(input);
      armed.add(binding.liveId);
      await startWatch(binding);
      return binding;
    },

    async resume(liveId: string): Promise<LiveCollectorBinding | null> {
      const binding = bindings.get(liveId);
      if (!binding) {
        return null;
      }
      armed.add(liveId);
      await startWatch(binding);
      return binding;
    },

    async suspend(liveId: string): Promise<boolean> {
      const binding = bindings.get(liveId);
      if (!binding) {
        return false;
      }
      // 先解除武装，看门狗才动不到它：直播已结束，不该被保活逻辑拉起来
      armed.delete(liveId);
      await manager.stopWatching(binding.watchKey);
      return true;
    },

    async stop(liveId: string): Promise<boolean> {
      const binding = bindings.get(liveId);
      if (!binding) {
        return false;
      }
      armed.delete(liveId);
      bindings.delete(liveId);
      await manager.stopWatching(binding.watchKey);
      return true;
    },

    statusOf(liveId: string): LiveCollectorStatus {
      const binding = bindings.get(liveId) ?? null;
      const watch = binding
        ? (manager.status().active.find((item) => item.key === binding.watchKey) ?? null)
        : null;
      return { enabled: enabled(), binding, watch };
    },

    // ---------- R16：独立监控（不绑场次、不落库） ----------

    async startMonitor(input: StartMonitorInput): Promise<MonitorBinding> {
      if (!enabled()) {
        throw new CollectorSourceError(
          'SOURCE_DISABLED',
          '未配置 DOUYIN_SIGN_API_KEY，采集通道未启用（仍可用测试弹幕注入）',
        );
      }
      const room = await resolveRoom(input);
      const watchId = `mon-${randomUUID()}`;
      const watchKey = watchKeyOf({
        source: room.platform,
        platform: room.platform,
        roomRef: room.roomRef,
        liveId: null,
      });
      const binding: MonitorBinding = {
        watchId,
        userId: input.userId,
        platform: room.platform,
        roomRef: room.roomRef,
        watchKey,
        startedAt: now().toISOString(),
        ...(room.connectHeaders ? { connectHeaders: room.connectHeaders } : {}),
      };
      // 先登记再起会话：open 之后事件可能立刻到达，登记晚了会丢首批弹幕
      monitors.set(watchId, binding);
      monitorIdByWatchKey.set(watchKey, watchId);
      monitorBuffers.set(watchId, []);
      armed.add(watchId);
      try {
        await startWatch(binding);
      } catch (err) {
        // 起不来就回滚登记：不留「永远不会被拉起」的幽灵监控
        monitors.delete(watchId);
        monitorIdByWatchKey.delete(watchKey);
        monitorBuffers.delete(watchId);
        armed.delete(watchId);
        throw err;
      }
      return binding;
    },

    async stopMonitor(watchId: string, userId: string): Promise<boolean> {
      const binding = monitors.get(watchId);
      if (!binding || binding.userId !== userId) {
        return false;
      }
      armed.delete(watchId);
      monitors.delete(watchId);
      monitorIdByWatchKey.delete(binding.watchKey);
      monitorBuffers.delete(watchId);
      await manager.stopWatching(binding.watchKey);
      return true;
    },

    monitorEvents(watchId: string, userId: string, sinceSeq?: number): MonitorEvent[] | null {
      const binding = monitors.get(watchId);
      if (!binding || binding.userId !== userId) {
        return null;
      }
      const buffer = monitorBuffers.get(watchId) ?? [];
      if (sinceSeq === undefined || !Number.isFinite(sinceSeq)) {
        return [...buffer];
      }
      return buffer.filter((item) => item.seq > sinceSeq);
    },

    listMonitors(userId: string): MonitorBinding[] {
      return [...monitors.values()].filter((item) => item.userId === userId);
    },

    async dispose(): Promise<void> {
      if (watchdog !== null) {
        clearInterval(watchdog);
      }
      armed.clear();
      monitors.clear();
      monitorIdByWatchKey.clear();
      monitorBuffers.clear();
      bindings.clear();
      await manager.dispose();
    },
  };
}

/** 全局单例：路由 / 场次生命周期共用同一份采集绑定表 */
export const liveCollector = createLiveCollector();
