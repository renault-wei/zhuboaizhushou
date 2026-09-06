import { and, eq } from 'drizzle-orm';
import { db } from '../db/client';
import { liveDanmaku as liveDanmakuTable, lives as livesTable } from '../db/schema';

// ---------- 常量 ----------

// 单条弹幕内容长度上限（业务口径；防止超长粘贴刷屏）
export const MAX_DANMAKU_CONTENT_LENGTH = 200;
// 发送者昵称长度上限：与 live_danmaku.sender_nickname varchar(50) 对齐
export const MAX_DANMAKU_NICKNAME_LENGTH = 50;

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

/** 网关入参：统一弹幕事件（content 必填，昵称可选） */
export interface DanmakuIngestInput {
  content: string;
  senderNickname?: string | null;
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

    const inserted = await db
      .insert(liveDanmakuTable)
      .values({
        liveId,
        content,
        senderNickname: senderNickname.length > 0 ? senderNickname : null,
      })
      .returning();
    const row = inserted[0];
    if (!row) {
      // 理论上插入成功必有返回，兜底避免静默失败
      throw new Error('弹幕写入失败');
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
