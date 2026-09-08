// 多平台弹幕采集模块（D 系列）：公共类型与常量
// 只定义类型 / 常量，不含 IO；真实平台协议适配器（D2.3/D2.4）受 D2.5 合规门约束，本期不实现。

/** 已规划接入的直播平台（kuaishou 一期仅 spike，见 docs/DANMAKU-COLLECTOR-PLAN.md §4） */
export type DanmakuPlatform = 'douyin' | 'bilibili' | 'kuaishou';

/** 已知平台列表（守卫 / 路由共用，避免魔法字符串散落） */
export const KNOWN_PLATFORMS: readonly DanmakuPlatform[] = ['douyin', 'bilibili', 'kuaishou'];

/** 采集器源标识：simulator = 内置离线模拟弹幕源（演示 / 测试用，不连真实平台） */
export type CollectorSourceKey = 'simulator' | DanmakuPlatform;

/** 归一化事件类型：采集输出只保留这五类，其余平台事件（关注 / 分享等）暂不建模 */
export type DanmakuMessageType = 'chat' | 'gift' | 'like' | 'enter' | 'end';

/** 已知事件类型列表（守卫校验用） */
export const KNOWN_MESSAGE_TYPES: readonly DanmakuMessageType[] = ['chat', 'gift', 'like', 'enter', 'end'];

/** 单条弹幕内容上限：与 services/danmaku MAX_DANMAKU_CONTENT_LENGTH 对齐 */
export const MAX_DANMAKU_CONTENT_LENGTH = 200;

/** 发送者昵称上限：与 live_danmaku.sender_nickname varchar(50) 对齐 */
export const MAX_DANMAKU_NICKNAME_LENGTH = 50;

/** 采集器归一化事件（对齐 DANMAKU-COLLECTOR-PLAN §6）：先归一化再去重落库，业务侧不感知平台差异 */
export interface UnifiedDanmakuEvent {
  platform: DanmakuPlatform;
  /** 直播间稳定身份：bilibili = room_id 数字串；douyin = live 页 webRid；simulator 演示按目标透传 */
  roomRef: string;
  /** 归属场次：接线层把 watch 绑到 lives 后回填，采集核心不感知业务归属 */
  liveId: string | null;
  /** 幂等键 = platform + 平台侧消息 id（buildMsgKey 生成），供 (platform,msg_key) 唯一索引去重 */
  msgKey: string;
  msgType: DanmakuMessageType;
  /** chat 必填；gift / like / enter 可空 */
  content?: string;
  senderNickname?: string;
  /** 平台事件时间（ISO8601）；缺失时守卫层以本地时间兜底 */
  happenedAt: string;
  /** 原报文（调错 / 审计用，不入索引） */
  raw?: unknown;
}

/** 一次监听的目标：同一目标（source + platform + roomRef）只允许一条会话 */
export interface WatchTarget {
  source: CollectorSourceKey;
  platform: DanmakuPlatform;
  roomRef: string;
  /** 归属场次（可空：落库接线层回填前允许先监听） */
  liveId: string | null;
}

/** 会话连接状态：manager 据此驱动心跳与断线重连 */
export type ConnectionState = 'connected' | 'disconnected' | 'ended' | 'error';

/** 适配器会话：open() 的返回值，manager 持有后驱动 heartbeat / close */
export interface AdapterSession {
  /** 探活：返回 false 或抛错 → manager 判定断线并进入重连 */
  heartbeat(): Promise<boolean>;
  /** 关闭会话（幂等；应清理内部定时器并停止发事件） */
  close(): Promise<void>;
}

/** 适配器回调钩子：manager 注入，适配器只负责发事件与上报连接状态 */
export interface AdapterHooks {
  onEvent(event: UnifiedDanmakuEvent): void;
  onStateChange(state: ConnectionState): void;
}

/** 采集器适配器契约：内置模拟源与未来真实平台适配器（D2.5 后）共用 */
export interface CollectorAdapter {
  readonly source: CollectorSourceKey;
  open(target: WatchTarget, hooks: AdapterHooks): Promise<AdapterSession>;
}
