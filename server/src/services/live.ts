import { and, desc, eq } from 'drizzle-orm';
import { db } from '../db/client';
import {
  lives as livesTable,
  loopScripts as loopScriptsTable,
  scripts as scriptsTable,
  voices as voicesTable,
} from '../db/schema';
import { isVolcPresetId } from './volcPresets';

// ---------- 常量 ----------

// 标题长度上限：与 lives.title 的 varchar(100) 对齐
export const MAX_LIVE_TITLE_LENGTH = 100;

// 列表单次返回上限：默认按 updatedAt desc 取最近 50 条
export const DEFAULT_LIST_LIMIT = 50;

// ---------- 类型定义 ----------

/** 直播状态：idle = 草稿 / processing = 合成中 / ready = 配置完成 / live = 直播中 / ended / failed */
export type LiveStatus = 'idle' | 'processing' | 'ready' | 'live' | 'ended' | 'failed';

/** 开播配置（Live）对外结构：时间字段统一为 ISO8601 字符串 */
export interface Live {
  id: string;
  title: string;
  videoSourceUrl: string;
  couponId: string | null;
  rtmpUrl: string | null;
  /** 火山预设音色 id：与 voiceId 互斥，二选一 */
  volcPresetId: string | null;
  /** 口播语速：商家滑块档 -20~60（火山 speech_rate 口径）；null = 未设过，合成时回落默认档（-10） */
  speechRate: number | null;
  voiceId: string | null;
  scriptId: string | null;
  loopScriptId: string | null;
  status: LiveStatus;
  /** 合规角标：一律 true，禁止篡改（AI 智能直播角标强制叠加，不提供关闭入口） */
  aiBadgeShown: boolean;
  startedAt: string | null;
  endedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** 创建开播配置入参：T10 仅配置草稿，不含推流逻辑 */
export interface CreateLiveInput {
  /** 直播标题：trim 后 1-100 字 */
  title: string;
  /** 火山预设音色 id：可空（暂未选）；与 voiceId 互斥 */
  volcPresetId: string | null;
  /** 口播语速：可空（暂未设）；服务端按滑块区间 -20~60 钳制 */
  speechRate: number | null;
  /** 音色 id：可空（暂未选） */
  voiceId: string | null;
  /** 话术 id：可空（暂未选） */
  scriptId: string | null;
  /** 循环台本 id：可空（暂未绑定）。开播时读取快照，中途改台本不影响进行中场次 */
  loopScriptId: string | null;
  /** 团购券 id：T10 直接存档，不校验 openId 持有关系 */
  couponId: string | null;
  /** 实景视频源：T10 默认 ''，T11 上传视频后回填 */
  videoSourceUrl?: string;
}

/** 更新入参：字段缺省表示保留原值 */
export type UpdateLiveInput = Partial<
  Pick<
    CreateLiveInput,
    | 'title'
    | 'volcPresetId'
    | 'speechRate'
    | 'voiceId'
    | 'scriptId'
    | 'loopScriptId'
    | 'couponId'
    | 'videoSourceUrl'
  >
>;

// ---------- 错误类型 ----------

export type LiveErrorCode =
  | 'LIVE_TITLE_INVALID'
  | 'VOICE_NOT_OWNED'
  | 'VOLC_PRESET_INVALID'
  | 'SCRIPT_NOT_OWNED'
  | 'LOOP_SCRIPT_NOT_OWNED'
  | 'LIVE_NOT_FOUND'
  | 'LIVE_IN_PROGRESS'
  | 'LIVE_NO_FIELDS_TO_UPDATE'
  | 'LIVE_NOT_READY'
  | 'LIVE_NOT_LIVE';

/** 直播配置业务错误：携带机器可读错误码，由路由层翻译成 HTTP 状态 */
export class LiveError extends Error {
  readonly code: LiveErrorCode;

  constructor(code: LiveErrorCode, message: string) {
    super(message);
    this.name = 'LiveError';
    this.code = code;
  }
}

// ---------- 行转换 ----------

/** drizzle 查询返回的行类型（时间字段为 Date） */
export type LiveRow = typeof livesTable.$inferSelect;

/** 数据库行 → 对外 Live：时间统一转 ISO8601 字符串 */
export function toLive(row: LiveRow): Live {
  return {
    id: row.id,
    title: row.title ?? '',
    videoSourceUrl: row.videoSourceUrl,
    couponId: row.couponId,
    rtmpUrl: row.rtmpUrl,
    volcPresetId: row.volcPresetId,
    speechRate: row.speechRate,
    voiceId: row.voiceId,
    scriptId: row.scriptId,
    loopScriptId: row.loopScriptId,
    status: row.status,
    aiBadgeShown: row.aiBadgeShown,
    startedAt: row.startedAt ? row.startedAt.toISOString() : null,
    endedAt: row.endedAt ? row.endedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** 按「归属 + 存在性」查当前用户的一条开播配置 */
async function findOwnedLive(userId: string, id: string): Promise<LiveRow | null> {
  const rows = await db
    .select()
    .from(livesTable)
    .where(and(eq(livesTable.id, id), eq(livesTable.userId, userId)))
    .limit(1);
  return rows[0] ?? null;
}

/** 校验音色存在且归属当前用户 */
async function isOwnedVoice(voiceId: string, userId: string): Promise<boolean> {
  const rows = await db
    .select({ id: voicesTable.id })
    .from(voicesTable)
    .where(and(eq(voicesTable.id, voiceId), eq(voicesTable.userId, userId)))
    .limit(1);
  return rows.length > 0;
}

/** 校验话术存在且归属当前用户 */
async function isOwnedScript(scriptId: string, userId: string): Promise<boolean> {
  const rows = await db
    .select({ id: scriptsTable.id })
    .from(scriptsTable)
    .where(and(eq(scriptsTable.id, scriptId), eq(scriptsTable.userId, userId)))
    .limit(1);
  return rows.length > 0;
}

/** 校验循环台本存在且归属当前用户 */
async function isOwnedLoopScript(loopScriptId: string, userId: string): Promise<boolean> {
  const rows = await db
    .select({ id: loopScriptsTable.id })
    .from(loopScriptsTable)
    .where(and(eq(loopScriptsTable.id, loopScriptId), eq(loopScriptsTable.userId, userId)))
    .limit(1);
  return rows.length > 0;
}

/** 标题校验：trim 后 1-100 字，失败抛 LIVE_TITLE_INVALID */
function assertValidTitle(title: string): string {
  const trimmed = title.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_LIVE_TITLE_LENGTH) {
    throw new LiveError('LIVE_TITLE_INVALID', `直播标题不能为空且不超过 ${MAX_LIVE_TITLE_LENGTH} 字`);
  }
  return trimmed;
}

/** 校验可空的音色/话术归属（提供时非空才校验） */
async function assertOwnedReferences(
  userId: string,
  input: { voiceId: string | null; scriptId: string | null; loopScriptId: string | null },
): Promise<void> {
  if (input.voiceId && !(await isOwnedVoice(input.voiceId, userId))) {
    throw new LiveError('VOICE_NOT_OWNED', '音色不存在或不属于当前用户');
  }
  if (input.scriptId && !(await isOwnedScript(input.scriptId, userId))) {
    throw new LiveError('SCRIPT_NOT_OWNED', '话术不存在或不属于当前用户');
  }
  if (input.loopScriptId && !(await isOwnedLoopScript(input.loopScriptId, userId))) {
    throw new LiveError('LOOP_SCRIPT_NOT_OWNED', '循环台本不存在或不属于当前用户');
  }
}

// ---------- 服务函数（仅 CRUD，不含推流逻辑）----------

/** 我的开播配置列表：默认按 updatedAt desc，最多 50 条，支持按状态过滤 */
export async function listLives(
  userId: string,
  options: { limit?: number; status?: LiveStatus } = {},
): Promise<Live[]> {
  const limit = Math.min(options.limit ?? DEFAULT_LIST_LIMIT, DEFAULT_LIST_LIMIT);
  const conditions = [eq(livesTable.userId, userId)];
  if (options.status) {
    conditions.push(eq(livesTable.status, options.status));
  }
  const rows = await db
    .select()
    .from(livesTable)
    .where(and(...conditions))
    .orderBy(desc(livesTable.updatedAt))
    .limit(limit);
  return rows.map(toLive);
}

/** 单查：归属隔离，不是我的返回 null（路由层转 404） */
export async function getLiveById(userId: string, id: string): Promise<Live | null> {
  const row = await findOwnedLive(userId, id);
  return row ? toLive(row) : null;
}

/** 创建开播配置草稿：默认 status=idle、aiBadgeShown=true（合规写死，body 传参一律忽略） */
export async function createLive(userId: string, input: CreateLiveInput): Promise<Live> {
  const title = assertValidTitle(input.title);
  // 互斥归一化：预设音色与克隆音色同时出现时以预设为准，避免库里两字段同时非空
  const presetId = input.volcPresetId?.trim() ?? null;
  const voiceId = presetId ? null : input.voiceId;
  if (presetId && !isVolcPresetId(presetId)) {
    throw new LiveError('VOLC_PRESET_INVALID', '不支持的火山预设音色');
  }
  await assertOwnedReferences(userId, { ...input, voiceId });

  const inserted = await db
    .insert(livesTable)
    .values({
      userId,
      title,
      // T10 实景视频源默认空串，T11 上传视频后再 PATCH 回填
      videoSourceUrl: input.videoSourceUrl?.trim() ?? '',
      couponId: input.couponId,
      volcPresetId: presetId,
      speechRate: input.speechRate,
      voiceId,
      scriptId: input.scriptId,
      loopScriptId: input.loopScriptId,
      status: 'idle',
      // 合规红线：'AI 智能直播'角标强制叠加、不可关闭；即使请求传 false 也被忽略
      aiBadgeShown: true,
    })
    .returning();
  const row = inserted[0];
  if (!row) {
    // 理论上插入成功必有返回，此处兜底避免静默失败
    throw new Error('创建开播配置失败');
  }
  return toLive(row);
}

/** 更新开播配置：归属隔离 + 标题/引用校验；非本人或不存在返回 null（路由层转 404） */
export async function updateLive(
  userId: string,
  id: string,
  patch: UpdateLiveInput,
): Promise<Live | null> {
  const existing = await findOwnedLive(userId, id);
  if (!existing) {
    return null;
  }

  const changes: {
    title?: string;
    videoSourceUrl?: string;
    couponId?: string | null;
    volcPresetId?: string | null;
    speechRate?: number | null;
    voiceId?: string | null;
    scriptId?: string | null;
    loopScriptId?: string | null;
  } = {};
  if (patch.title !== undefined) {
    changes.title = assertValidTitle(patch.title);
  }
  if (patch.videoSourceUrl !== undefined) {
    changes.videoSourceUrl = patch.videoSourceUrl.trim();
  }
  if (patch.couponId !== undefined) {
    changes.couponId = patch.couponId;
  }
  if (patch.speechRate !== undefined) {
    changes.speechRate = patch.speechRate;
  }

  // 音色选择：基于现值叠加本次 patch，再做互斥归一化，保证 voiceId 与 volcPresetId 不同时非空
  const voiceTouched = patch.voiceId !== undefined;
  const presetTouched = patch.volcPresetId !== undefined;
  let nextVoiceId: string | null = existing.voiceId;
  let nextPresetId: string | null = existing.volcPresetId;
  if (voiceTouched) {
    const nextVoice = patch.voiceId;
    if (nextVoice && !(await isOwnedVoice(nextVoice, userId))) {
      throw new LiveError('VOICE_NOT_OWNED', '音色不存在或不属于当前用户');
    }
    nextVoiceId = nextVoice ?? null;
  }
  if (presetTouched) {
    const preset = patch.volcPresetId?.trim() ?? '';
    if (preset && !isVolcPresetId(preset)) {
      throw new LiveError('VOLC_PRESET_INVALID', '不支持的火山预设音色');
    }
    nextPresetId = preset || null;
  }
  // 明确选了一侧就清空另一侧；两侧同时给且都非空时以预设为准
  if (presetTouched && nextPresetId) {
    nextVoiceId = null;
  }
  if (voiceTouched && nextVoiceId) {
    nextPresetId = null;
  }
  if (voiceTouched || presetTouched) {
    changes.voiceId = nextVoiceId;
    changes.volcPresetId = nextPresetId;
  }
  if (patch.scriptId !== undefined) {
    if (patch.scriptId && !(await isOwnedScript(patch.scriptId, userId))) {
      throw new LiveError('SCRIPT_NOT_OWNED', '话术不存在或不属于当前用户');
    }
    changes.scriptId = patch.scriptId;
  }
  if (patch.loopScriptId !== undefined) {
    if (patch.loopScriptId && !(await isOwnedLoopScript(patch.loopScriptId, userId))) {
      throw new LiveError('LOOP_SCRIPT_NOT_OWNED', '循环台本不存在或不属于当前用户');
    }
    changes.loopScriptId = patch.loopScriptId;
  }

  // 边界保护：body 只含非法字段（如仅 aiBadgeShown / status）时，changes 为空，
  // 直接 set({}) 会让 drizzle 抛「No values to set」500，这里显式转 400。
  if (Object.keys(changes).length === 0) {
    throw new LiveError('LIVE_NO_FIELDS_TO_UPDATE', '没有可更新的字段');
  }

  // 合规红线：不提供 status / aiBadgeShown 等字段的更新入口，角标恒为 true
  const updated = await db
    .update(livesTable)
    .set(changes)
    .where(and(eq(livesTable.id, id), eq(livesTable.userId, userId)))
    .returning();
  const row = updated[0];
  if (!row) {
    return null;
  }
  return toLive(row);
}

/**
 * 直播中更换循环台本（M4 热更）：只允许 status === 'live' 的场次调用。
 * - 非本人或不存在 → 返回 null（路由层转 404）；
 * - 非直播中 → 抛 LIVE_NOT_LIVE（路由层转 409）；
 * - 台本不存在或不归属当前用户 → 抛 LOOP_SCRIPT_NOT_OWNED（路由层转 400）。
 * 生效时机：loopCaster 每轮开头重读台本，改绑于「下一轮」生效，不打断当前句。
 */
export async function bindLiveLoopScript(
  userId: string,
  id: string,
  loopScriptId: string,
): Promise<Live | null> {
  const existing = await findOwnedLive(userId, id);
  if (!existing) {
    return null;
  }
  if (existing.status !== 'live') {
    throw new LiveError('LIVE_NOT_LIVE', '只有直播中的场次才能更换循环台本');
  }
  if (!(await isOwnedLoopScript(loopScriptId, userId))) {
    throw new LiveError('LOOP_SCRIPT_NOT_OWNED', '循环台本不存在或不属于当前用户');
  }
  const updated = await db
    .update(livesTable)
    .set({ loopScriptId })
    .where(and(eq(livesTable.id, id), eq(livesTable.userId, userId)))
    .returning();
  const row = updated[0];
  return row ? toLive(row) : null;
}

/**
 * 删除开播配置：归属隔离 + 状态保护。
 * - 非本人或不存在 → 返回 false（路由层转 404）；
 * - status = live / ready / processing（直播进行中、已就绪或合成中）→ 抛 LIVE_IN_PROGRESS（路由层转 409）；
 * - 仅 idle / ended / failed 允许删除。
 */
export async function deleteLive(userId: string, id: string): Promise<boolean> {
  const existing = await findOwnedLive(userId, id);
  if (!existing) {
    return false;
  }
  if (existing.status === 'live' || existing.status === 'ready' || existing.status === 'processing') {
    throw new LiveError('LIVE_IN_PROGRESS', '直播进行中、已就绪或合成中，不可删除');
  }
  const deleted = await db
    .delete(livesTable)
    .where(and(eq(livesTable.id, id), eq(livesTable.userId, userId)))
    .returning({ id: livesTable.id });
  return deleted.length > 0;
}

// ---------- T11 合成流程辅助（prepare 路由专用，禁止外部直接改状态）----------

/** 合成上下文：开播配置 + 绑定话术 + 绑定音色（用于敏感词 pass 校验与取话术全文 / 音色合成） */
export interface LiveComposeContext {
  live: Live;
  /** 绑定的 ready 话术；未绑定或引用已被删除时为 null */
  script: {
    content: string;
    status: string;
    sensitiveCheckStatus: string | null;
  } | null;
  /** 绑定的 ready 音色；未绑定、未就绪或引用已被删除时为 null */
  voice: { providerVoiceId: string } | null;
}

/** 取开播配置与其绑定话术 / 音色：归属隔离，非本人或不存在返回 null（路由层转 404） */
export async function getLiveComposeContext(
  userId: string,
  id: string,
): Promise<LiveComposeContext | null> {
  const row = await findOwnedLive(userId, id);
  if (!row) {
    return null;
  }
  let script: LiveComposeContext['script'] = null;
  if (row.scriptId) {
    const rows = await db
      .select({
        content: scriptsTable.content,
        status: scriptsTable.status,
        sensitiveCheckStatus: scriptsTable.sensitiveCheckStatus,
      })
      .from(scriptsTable)
      .where(eq(scriptsTable.id, row.scriptId))
      .limit(1);
    script = rows[0] ?? null;
  }
  let voice: LiveComposeContext['voice'] = null;
  if (row.voiceId) {
    const rows = await db
      .select({ providerVoiceId: voicesTable.providerVoiceId })
      .from(voicesTable)
      .where(and(eq(voicesTable.id, row.voiceId), eq(voicesTable.status, 'ready')))
      .limit(1);
    voice = rows[0] ?? null;
  }
  return { live: toLive(row), script, voice };
}

/**
 * 内部状态流转：仅供 T11 合成流程置 processing / ready / failed，并回填合成产物 URL。
 * 归属隔离校验同其它更新；非本人或不存在返回 null。
 */
export async function updateLiveInternal(
  userId: string,
  id: string,
  patch: { status: LiveStatus; videoSourceUrl?: string },
): Promise<Live | null> {
  const changes: { status: LiveStatus; videoSourceUrl?: string } = { status: patch.status };
  if (patch.videoSourceUrl !== undefined) {
    changes.videoSourceUrl = patch.videoSourceUrl;
  }
  const updated = await db
    .update(livesTable)
    .set(changes)
    .where(and(eq(livesTable.id, id), eq(livesTable.userId, userId)))
    .returning();
  const row = updated[0];
  return row ? toLive(row) : null;
}
