import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../db/client';
import { liveDanmaku as liveDanmakuTable, lives as livesTable } from '../db/schema';

// ---------- 常量 ----------

// 单条弹幕内容长度上限（业务口径；防止超长粘贴刷屏）
export const MAX_DANMAKU_CONTENT_LENGTH = 200;
// 发送者昵称长度上限：与 live_danmaku.sender_nickname varchar(50) 对齐
export const MAX_DANMAKU_NICKNAME_LENGTH = 50;
// 采集通道字段长度上限：与 live_danmaku 对应列宽对齐（R1）
export const MAX_DANMAKU_PLATFORM_LENGTH = 16;
export const MAX_DANMAKU_ROOM_REF_LENGTH = 128;
export const MAX_DANMAKU_MSG_KEY_LENGTH = 128;
export const MAX_DANMAKU_MSG_TYPE_LENGTH = 16;

// ---------- 错误类型 ----------

export type DanmakuErrorCode = 'LIVE_NOT_FOUND' | 'LIVE_NOT_LIVE' | 'CONTENT_INVALID';

/** 弹幕网关业务错误：携带机器可读错误码，由路由层翻译成 HTTP 状态 */
export class DanmakuError extends Error {
  readonly code: DanmakuErrorCode;

  constructor(code: DanmakuErrorCode, message: string) {
    super(message);
    this.name = 'DanmakuError';
    this.code = code;
  }
}

// ---------- 类型定义 ----------

/**
 * 网关入参：统一弹幕事件（content 必填，昵称可选）。
 * 采集通道字段（platform / roomRef / msgKey / msgType）为 R1 新增，可空：
 * 既有「测试弹幕注入」路径不传，行为不变；自研采集通道传入后启用幂等去重。
 */
export interface DanmakuIngestInput {
  content: string;
  senderNickname?: string | null;
  /** 平台标识（如 douyin）；仅采集通道传 */
  platform?: string | null;
  /** 平台侧房间稳定身份；仅采集通道传 */
  roomRef?: string | null;
  /** 平台侧消息 id（幂等键）；仅采集通道传 */
  msgKey?: string | null;
  /** 事件类型（chat / gift / like / enter / end）；仅采集通道传 */
  msgType?: string | null;
}

/** 可选字符串归一：非字符串 / 空白一律视为「未提供」→ null，避免写出空串混进唯一索引 */
function normalizeOptional(value: unknown, maxLength: number): string | null {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text.length === 0) {
    return null;
  }
  return text.slice(0, maxLength);
}

/** 入库后的弹幕记录（对外结构：时间字段为 ISO8601 字符串） */
export interface LiveDanmakuRecord {
  id: string;
  liveId: string;
  content: string;
  senderNickname: string | null;
  /** 弹幕到达时间（ISO8601） */
  sentAt: string;
}

/**
 * 弹幕网关（G3，写入侧）：把统一弹幕事件写入 live_danmaku，并对订阅方广播。
 * - 归属隔离：ingest 入参带 userId，服务内校验 live 属于该用户且处于直播中；
 * - 采集实现与业务解耦：未来真实抖音采集通道（自用号登录态）解析出 userId/liveId
 *   后复用同一 ingest 入口即可，业务侧无需改动。
 */
export interface DanmakuGateway {
  ingest(userId: string, liveId: string, input: DanmakuIngestInput): Promise<LiveDanmakuRecord>;
}

// ---------- 事件订阅（G4 实时互动引擎接入点）----------

export type DanmakuListener = (message: LiveDanmakuRecord) => void;

/** 内存监听器集合：单进程内广播已入库弹幕；返回取消订阅函数 */
const listeners = new Set<DanmakuListener>();

export function onDanmaku(listener: DanmakuListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 广播入库弹幕：引擎句柄异常只吞掉并记入监听器自身，不阻塞写入主链路 */
function emit(message: LiveDanmakuRecord): void {
  for (const listener of [...listeners]) {
    try {
      listener(message);
    } catch {
      // 单个订阅方（如 G4 引擎）出错不应影响弹幕落库
    }
  }
}

// ---------- 实现（写库）----------

/** 数据库实现：校验归属 + 直播中状态 → 插入 live_danmaku → 广播事件 */
export class DbDanmakuGateway implements DanmakuGateway {
  async ingest(userId: string, liveId: string, input: DanmakuIngestInput): Promise<LiveDanmakuRecord> {
    // 运行期兜底：非法类型（数字/对象等）一律按空串处理，走 CONTENT_INVALID，避免 TypeError 冒成 500
    const content = typeof input.content === 'string' ? input.content.trim() : '';
    if (content.length === 0 || content.length > MAX_DANMAKU_CONTENT_LENGTH) {
      throw new DanmakuError(
        'CONTENT_INVALID',
        `弹幕内容不能为空且不超过 ${MAX_DANMAKU_CONTENT_LENGTH} 字`,
      );
    }
    const rawNickname = typeof input.senderNickname === 'string' ? input.senderNickname : '';
    const senderNickname = rawNickname.trim().slice(0, MAX_DANMAKU_NICKNAME_LENGTH);

    const owned = await db
      .select({ status: livesTable.status })
      .from(livesTable)
      .where(and(eq(livesTable.id, liveId), eq(livesTable.userId, userId)))
      .limit(1);
    if (owned.length === 0) {
      throw new DanmakuError('LIVE_NOT_FOUND', '开播配置不存在');
    }
    const live = owned[0];
    if (!live) {
      // 理论上命中 length 必有行，兜底避免静默通过
      throw new DanmakuError('LIVE_NOT_FOUND', '开播配置不存在');
    }
    if (live.status !== 'live') {
      throw new DanmakuError('LIVE_NOT_LIVE', `只有直播中的场次才能接收弹幕（当前：${live.status}）`);
    }

    // 采集通道字段（可空）：空白一律归一为 null，避免空串混进唯一索引
    const platform = normalizeOptional(input.platform, MAX_DANMAKU_PLATFORM_LENGTH);
    const roomRef = normalizeOptional(input.roomRef, MAX_DANMAKU_ROOM_REF_LENGTH);
    const msgKey = normalizeOptional(input.msgKey, MAX_DANMAKU_MSG_KEY_LENGTH);
    const msgType = normalizeOptional(input.msgType, MAX_DANMAKU_MSG_TYPE_LENGTH);

    const inserted = await db
      .insert(liveDanmakuTable)
      .values({
        liveId,
        content,
        senderNickname: senderNickname.length > 0 ? senderNickname : null,
        platform,
        roomRef,
        msgKey,
        msgType,
      })
      // 重连重放防护：同 (platform, msg_key) 已落库时静默跳过（NULL 不参与冲突）
      .onConflictDoNothing({
        target: [liveDanmakuTable.platform, liveDanmakuTable.msgKey],
      })
      .returning();
    const row = inserted[0];
    if (!row) {
      // 命中幂等：把已存在那条读回来，并【不重新广播】——
      // 重放若再广播，G4 互动引擎会对同一条弹幕再回复一次，观众听到重复口播。
      if (msgKey === null) {
        // 没有幂等键却插入失败：属异常，兜底避免静默失败
        throw new Error('弹幕写入失败');
      }
      const dupWhere =
        platform === null
          ? and(isNull(liveDanmakuTable.platform), eq(liveDanmakuTable.msgKey, msgKey))
          : and(eq(liveDanmakuTable.platform, platform), eq(liveDanmakuTable.msgKey, msgKey));
      const existing = await db.select().from(liveDanmakuTable).where(dupWhere).limit(1);
      const dup = existing[0];
      if (!dup) {
        throw new Error('弹幕幂等命中但读不回原记录');
      }
      return {
        id: dup.id,
        liveId: dup.liveId,
        content: dup.content,
        senderNickname: dup.senderNickname,
        sentAt: dup.sentAt.toISOString(),
      };
    }
    const message: LiveDanmakuRecord = {
      id: row.id,
      liveId: row.liveId,
      content: row.content,
      senderNickname: row.senderNickname,
      sentAt: row.sentAt.toISOString(),
    };
    emit(message);
    return message;
  }
}

// ---------- 工厂 + 单例 ----------

/** 弹幕网关工厂：G3 阶段仅写库实现（采集通道待真实抖音接入），保留工厂形态便于后续切换 */
export function createDanmakuGateway(): DanmakuGateway {
  return new DbDanmakuGateway();
}

// 全局单例：路由 / 未来采集通道共用同一入口
export const danmakuGateway = createDanmakuGateway();
