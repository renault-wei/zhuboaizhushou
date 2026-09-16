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

import {
  createCollectorManager,
  watchKeyOf,
  type CollectorManager,
  type CollectorWatchSummary,
} from '../collectors/collectorManager';
import { createDouyinHttpSigner, createDouyinLiveAdapter } from '../collectors/douyinLiveAdapter';
import { eventToIngestInput } from '../collectors/events';
import { createLinkResolver, type ResolveShareResult } from '../collectors/linkResolver';
import { createHttpShortLinkExpander } from '../collectors/shortLinkExpander';
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
  /** 停止全部会话并清理（服务关停 / 测试收尾） */
  dispose(): Promise<void>;
}

/** 依赖全部可注入：生产用真实适配器与网关；测试注入替身，做到全离线 */
export interface LiveCollectorDeps {
  /** 适配器注册表；缺省按环境构造（未配签名 Key 时为空 → 整层降级） */
  adapters?: readonly CollectorAdapter[];
  /** 事件落库出口；缺省走既有弹幕网关 */
  ingest?: (userId: string, liveId: string, input: DanmakuIngestInput) => Promise<unknown>;
  /** 链接解析；缺省用 linkResolver 单例 */
  resolveShareText?: (text: string) => Promise<ResolveShareResult>;
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
  const warn = deps.warn ?? ((message: string) => console.warn(`[liveCollector] ${message}`));
  const now = deps.now ?? (() => new Date());

  /** liveId → 绑定：采集事件只带 liveId，靠它反查 userId */
  const bindings = new Map<string, LiveCollectorBinding>();

  /**
   * 采集事件 → 既有弹幕网关。
   * 任何失败只告警、绝不向上抛：单条弹幕入库失败不能拖垮整场采集会话。
   */
  function handleEvent(event: UnifiedDanmakuEvent): void {
    const liveId = event.liveId;
    if (!liveId) {
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
    adapters,
    onEvent: handleEvent,
  });

  function enabled(): boolean {
    return adapters.length > 0;
  }

  /** 为一个绑定起（或复用）采集会话：manager 自带幂等，同 watchKey 不会重复起 worker */
  async function startWatch(binding: LiveCollectorBinding): Promise<void> {
    const target = {
      source: binding.platform,
      platform: binding.platform,
      roomRef: binding.roomRef,
      liveId: binding.liveId,
    };
    const result = await manager.startWatching(target);
    if (!result.ok) {
      throw new CollectorSourceError('START_FAILED', `启动采集失败（${result.code}）：${result.reason}`);
    }
  }

  async function resolveRoom(input: StartCollectorInput): Promise<{ platform: DanmakuPlatform; roomRef: string }> {
    const directRoomRef = input.roomRef?.trim();
    if (directRoomRef) {
      return { platform: 'douyin', roomRef: directRoomRef };
    }
    const shareText = input.shareText?.trim();
    if (!shareText) {
      throw new CollectorSourceError('RESOLVE_FAILED', '必须提供直播间分享链接或房间号');
    }
    const resolved = await resolveShareText(shareText);
    if (!resolved.ok) {
      throw new CollectorSourceError('RESOLVE_FAILED', `直播间解析失败（${resolved.code}）：${resolved.reason}`);
    }
    return { platform: resolved.room.platform, roomRef: resolved.room.roomRef };
  }

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
      };
      bindings.set(input.liveId, binding);
      return binding;
    },

    async start(input: StartCollectorInput): Promise<LiveCollectorBinding> {
      const binding = await this.bind(input);
      await startWatch(binding);
      return binding;
    },

    async resume(liveId: string): Promise<LiveCollectorBinding | null> {
      const binding = bindings.get(liveId);
      if (!binding) {
        return null;
      }
      await startWatch(binding);
      return binding;
    },

    async suspend(liveId: string): Promise<boolean> {
      const binding = bindings.get(liveId);
      if (!binding) {
        return false;
      }
      await manager.stopWatching(binding.watchKey);
      return true;
    },

    async stop(liveId: string): Promise<boolean> {
      const binding = bindings.get(liveId);
      if (!binding) {
        return false;
      }
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

    async dispose(): Promise<void> {
      bindings.clear();
      await manager.dispose();
    },
  };
}

/** 全局单例：路由 / 场次生命周期共用同一份采集绑定表 */
export const liveCollector = createLiveCollector();
