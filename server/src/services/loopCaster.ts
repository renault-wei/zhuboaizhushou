import { eq } from 'drizzle-orm';
import { db } from '../db/client';
import { lives as livesTable, loopScriptItems as loopScriptItemsTable } from '../db/schema';
import {
  liveSpeaker,
  speechLinePendingCount,
  type SpeechOverrides,
} from './liveSpeaker';
import { getLiveSpeech } from './liveVoice';
import type { AtmosphereCategory, AtmosphereInsertion } from './atmosphere';
import { atmosphereScheduler } from './atmosphereScheduler';

// 循环台本播出引擎（M4，P-循环台本 & P-播出里程碑 §8）：
// 开播（ready→live）后按台本顺序循环口播产品/团购券；与弹幕回复共用 liveSpeaker 全局出声链路，
// 只靠「出声链路空闲才推下一句」天然串行、不重叠；结束直播（唯一停止入口）即停。
// 合规：引擎只读库里已过敏感词扫描的台本条目，不做任何文本写入或旁路。

// ---------- 常量（口径 docs/LOOP-BROADCAST-PLAN.md §8）----------

/** 条间默认间隔（秒）：条目未配置 gapAfterSeconds 时使用
 *  2026-09-11 由 6s 收紧到 2s：6s 停顿静默占比近 60%，听感像念稿、且长时间静默有平台判定风险 */
export const DEFAULT_ITEM_GAP_SECONDS = 2;
/** 每轮播完后的轮间休息（秒）：2026-09-11 由 20s 收紧到 6s（一轮结束不长时间留白） */
export const DEFAULT_LOOP_REST_SECONDS = 6;
/** 出声链路忙时的空档避让轮询步长（ms） */
export const DEFAULT_IDLE_POLL_MS = 500;

// ---------- 类型定义 ----------

/** 一条可循环播报的台本短句（运行期每轮开头重读：直播中改绑台本下一轮生效） */
export interface LoopCastItem {
  text: string;
  /** 本条播完后的间隔秒数：null = 用全局默认 */
  gapAfterSeconds: number | null;
}

/** 某个场次当前循环播报状态（供工作台监控轮询） */
export interface LoopCasterStatus {
  running: boolean;
  round: number;
  currentSeq: number;
}

/** 引擎依赖：全部可注入（生产用默认实现，测试全替身，不出真实声音） */
export interface LoopCasterOptions {
  /** 把一句口播交给出声链路（可带本场音色覆盖 + 场次归属）；本地端播完才 resolve，远程端入队即 resolve */
  speak?(
    text: string,
    overrides?: SpeechOverrides,
    liveId?: string,
  ): Promise<{ spoken: boolean; reason?: string }>;
  /**
   * 读当前场次绑定的循环台本：开播时读一次，运行中每轮开头重读（改绑下一轮生效）；
   * null / 空数组 = 未绑定台本（首轮不启动循环；运行中清空则停止循环，只回弹幕）。
   */
  loadItems?(liveId: string): Promise<LoopCastItem[] | null>;
  /** 开播时读一次本场音色：null = 未绑定音色（回落默认音色） */
  loadVoice?(liveId: string): Promise<SpeechOverrides | null>;
  /** 睡眠（条间间隔 / 轮间休息 / 避让轮询共用）；测试注入假时钟 */
  sleep?(ms: number): Promise<void>;
  /** 出声链路忙闲判定：忙 = 本场有排队未播的音频（只看自己场次，避免多场互相拖节奏） */
  isBusy?(liveId: string): boolean;
  /** 空档插播取词（M10-A3）：返回一条到期的氛围台词，无则 null；生产接 atmosphereScheduler */
  pickAtmosphere?(liveId: string, nowMs: number): Promise<AtmosphereInsertion | null>;
  /** 插播实际出声后的记账（按类别刷新频控计时） */
  markAtmosphereSpoken?(liveId: string, category: AtmosphereCategory, atMs: number): void;
  /** 时钟注入（测试用假时钟）；生产默认 Date.now */
  now?(): number;
  itemGapSeconds?: number;
  loopRestSeconds?: number;
  idlePollMs?: number;
}

/** 运行期已解析依赖：默认实现在工厂里兜底，runLoop 内部不再判空 */
type ResolvedLoopDeps = Required<
  Pick<
    LoopCasterOptions,
    | 'speak'
    | 'loadItems'
    | 'loadVoice'
    | 'sleep'
    | 'isBusy'
    | 'pickAtmosphere'
    | 'markAtmosphereSpoken'
    | 'now'
  >
>;

/** 引擎公开接口：start 幂等、stop 幂等；每场次一条 Runner（内存态，进程重启不恢复） */
export interface LoopCaster {
  start(liveId: string): void;
  stop(liveId: string): void;
  isRunning(liveId: string): boolean;
  status(liveId: string): LoopCasterStatus | null;
}

/** 单个场次的 Runner 状态（挂在全局 Map，stop 置位后由循环体在下一个检查点退出） */
interface RunnerState {
  cancelled: boolean;
  running: boolean;
  round: number;
  currentSeq: number;
}

// ---------- 默认实现 ----------

/** 默认出声：全局 liveSpeaker（本地播完 resolve / 远程入队即返回），带本场音色覆盖与场次归属 */
function defaultSpeak(
  text: string,
  overrides?: SpeechOverrides,
  liveId?: string,
): Promise<{ spoken: boolean; reason?: string }> {
  return liveSpeaker.speak(text, overrides, liveId);
}

/** 默认睡眠：真实 setTimeout */
function defaultSleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** 默认忙闲：读当前出声链路未播出排队条数（按场次过滤，避免被别场次积压拖着走） */
function defaultIsBusy(liveId: string): boolean {
  return speechLinePendingCount(liveId) > 0;
}

/**
 * 默认台本加载：读场次绑定的 loopScriptId → 按 seq 取全部条目。
 * 场次不存在或未绑定台本 → null（路由开播时才调用，场次必然存在，主要覆盖「未绑定」）。
 */
export async function loadBoundLoopItems(liveId: string): Promise<LoopCastItem[] | null> {
  const liveRows = await db
    .select({ loopScriptId: livesTable.loopScriptId })
    .from(livesTable)
    .where(eq(livesTable.id, liveId))
    .limit(1);
  const loopScriptId = liveRows[0]?.loopScriptId ?? null;
  if (!loopScriptId) {
    return null;
  }
  const itemRows = await db
    .select({
      text: loopScriptItemsTable.text,
      gapAfterSeconds: loopScriptItemsTable.gapAfterSeconds,
    })
    .from(loopScriptItemsTable)
    .where(eq(loopScriptItemsTable.loopScriptId, loopScriptId))
    .orderBy(loopScriptItemsTable.seq);
  return itemRows.map((row) => ({ text: row.text, gapAfterSeconds: row.gapAfterSeconds }));
}

/** 逐句出声的容错包装：合成/播放失败只记日志，节奏照走，不让循环卡死（§8.3） */
async function speakSafely(
  speak: (
    text: string,
    overrides?: SpeechOverrides,
    liveId?: string,
  ) => Promise<{ spoken: boolean; reason?: string }>,
  liveId: string,
  text: string,
  overrides: SpeechOverrides | null,
): Promise<boolean> {
  try {
    const result = await speak(text, overrides ?? undefined, liveId);
    if (!result.spoken) {
      console.info(
        `[loopCaster] 场次 ${liveId} 循环句未出声（${result.reason ?? 'unknown'}），继续下一句`,
      );
    }
    return result.spoken;
  } catch (err) {
    console.warn(
      `[loopCaster] 场次 ${liveId} 循环句播报异常：${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return false;
  }
}

/**
 * 空档插播（M10-A3）：出声链路空闲且存在到期氛围语时插一条，绝不打断循环句。
 * 完整优先级 = 弹幕回复 > 欢迎/关注/点赞 > 报时 > 自定义暖场 > 循环台本句：
 * 回复由 liveSpeaker 队列天然优先 —— 链路忙（回复排队/远程积压）时本轮机会直接让位，不排队抢播。
 * 只有真正出声成功才记账（该类别间隔从实际插入时点重新起算，与弹幕回复口径一致）。
 */
async function tryInsertAtmosphere(
  liveId: string,
  options: ResolvedLoopDeps,
  overrides: SpeechOverrides | null,
): Promise<void> {
  if (options.isBusy(liveId)) {
    return;
  }
  let insertion: AtmosphereInsertion | null;
  try {
    insertion = await options.pickAtmosphere(liveId, options.now());
  } catch (err) {
    console.warn(
      `[loopCaster] 场次 ${liveId} 氛围语取词失败，跳过本次插播：${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return;
  }
  if (!insertion) {
    return;
  }
  const spoken = await speakSafely(options.speak, liveId, insertion.text, overrides);
  if (spoken) {
    options.markAtmosphereSpoken(liveId, insertion.category, options.now());
  }
}

/**
 * Runner 主体（§8.2 算法）：
 * 每轮 round+=1；逐条在出声链路空闲时 speak；条间用条目的 gapAfterSeconds ?? itemGapSeconds；
 * 轮末休息 loopRestSeconds。stop 置位后，正在播的句子播完即止、不再推新句。
 * 台本每轮开头重读：直播中改绑台本下一轮生效（不打断当前句）；清空则停止循环只回弹幕。
 */
async function runLoop(
  liveId: string,
  state: RunnerState,
  options: ResolvedLoopDeps,
  itemGapSeconds: number,
  loopRestSeconds: number,
  idlePollMs: number,
): Promise<void> {
  let loaded: LoopCastItem[] | null;
  try {
    loaded = await options.loadItems(liveId);
  } catch (err) {
    console.warn(
      `[loopCaster] 场次 ${liveId} 循环台本加载失败，本场只回弹幕：${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return;
  }
  if (state.cancelled) {
    return;
  }
  if (!loaded || loaded.length === 0) {
    // 未绑定台本 / 空台本：不启动循环，只回弹幕（Q2 正常流程不出现）
    console.info(`[loopCaster] 场次 ${liveId} 未绑定循环台本，本场只回弹幕`);
    return;
  }
  // 运行期可变：每轮开头重读替换（直播中改绑台本下一轮生效）
  let items: LoopCastItem[] = loaded;
  // 本场音色：只读一次（开播后改库不影响本场）；读失败回落默认音色，不打断循环
  let voice: SpeechOverrides | null = null;
  try {
    voice = await options.loadVoice(liveId);
  } catch (err) {
    console.warn(
      `[loopCaster] 场次 ${liveId} 音色解析失败，回落默认音色：${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  state.running = true;
  try {
    while (!state.cancelled) {
      // 轮间休息后再重读台本：直播中改绑台本于「下一轮」生效，不打断当前句
      if (state.round > 0) {
        await options.sleep(loopRestSeconds * 1000);
        if (state.cancelled) {
          break;
        }
        let reloaded: LoopCastItem[] | null;
        try {
          reloaded = await options.loadItems(liveId);
        } catch (err) {
          console.warn(
            `[loopCaster] 场次 ${liveId} 台本重读失败，沿用上一轮快照：${
              err instanceof Error ? err.message : String(err)
            }`,
          );
          reloaded = items;
        }
        if (state.cancelled) {
          break;
        }
        if (!reloaded || reloaded.length === 0) {
          // 直播中解绑 / 清空台本：停止循环只回弹幕（已播出的句子不受影响）
          console.info(`[loopCaster] 场次 ${liveId} 台本已解绑或清空，停止循环只回弹幕`);
          break;
        }
        items = reloaded;
      }
      state.round += 1;
      const roundItems = items;
      for (let index = 0; index < roundItems.length; index += 1) {
        if (state.cancelled) {
          break;
        }
        state.currentSeq = index + 1;
        // 空档避让：出声链路忙（回复排队 / 远程积压）→ 小步轮询，不在播放间隙插队
        while (!state.cancelled && options.isBusy(liveId)) {
          await options.sleep(idlePollMs);
        }
        if (state.cancelled) {
          break;
        }
        const item = roundItems[index];
        if (!item) {
          break;
        }
        await speakSafely(options.speak, liveId, item.text, voice);
        if (state.cancelled) {
          break;
        }
        // 空档插播：本句播完的间隔就是氛围语的机会窗口（忙/未到期 → 本次不插，等下一个空档）
        await tryInsertAtmosphere(liveId, options, voice);
        if (state.cancelled) {
          break;
        }
        const gapMilliseconds = (item.gapAfterSeconds ?? itemGapSeconds) * 1000;
        if (gapMilliseconds > 0) {
          await options.sleep(gapMilliseconds);
        }
      }
    }
  } finally {
    state.running = false;
    state.currentSeq = 0;
  }
}

// ---------- 工厂 + 全局单例 ----------

/** 引擎工厂：生产默认接真实 DB 快照 + 真实出声链路；测试全部注入替身 */
export function createLoopCaster(options: LoopCasterOptions = {}): LoopCaster {
  const speak = options.speak ?? defaultSpeak;
  const loadItems = options.loadItems ?? loadBoundLoopItems;
  // 音色解析默认不读库：引擎核心保持无 DB 依赖（单测全替身）；生产由全局单例注入真实实现
  const loadVoice = options.loadVoice ?? (async () => null);
  const sleep = options.sleep ?? defaultSleep;
  const isBusy = options.isBusy ?? defaultIsBusy;
  // 空档插播默认关闭（引擎核心不依赖氛围语模块）；生产由全局单例注入真实调度器
  const pickAtmosphere = options.pickAtmosphere ?? (async () => null);
  const markAtmosphereSpoken = options.markAtmosphereSpoken ?? (() => undefined);
  const now = options.now ?? (() => Date.now());
  const itemGapSeconds = options.itemGapSeconds ?? DEFAULT_ITEM_GAP_SECONDS;
  const loopRestSeconds = options.loopRestSeconds ?? DEFAULT_LOOP_REST_SECONDS;
  const idlePollMs = options.idlePollMs ?? DEFAULT_IDLE_POLL_MS;

  const runners = new Map<string, RunnerState>();

  function start(liveId: string): void {
    // 幂等：同场次已有 Runner（加载中 / 运行中 / 已停未清理）一律忽略
    if (runners.has(liveId)) {
      return;
    }
    const state: RunnerState = { cancelled: false, running: false, round: 0, currentSeq: 0 };
    runners.set(liveId, state);
    void runLoop(
      liveId,
      state,
      { speak, loadItems, loadVoice, sleep, isBusy, pickAtmosphere, markAtmosphereSpoken, now },
      itemGapSeconds,
      loopRestSeconds,
      idlePollMs,
    ).finally(() => {
      // 只清理自己：若期间被 stop 后再次 start，旧 Runner 醒来不得误删新 Runner
      if (runners.get(liveId) === state) {
        runners.delete(liveId);
      }
    });
  }

  function stop(liveId: string): void {
    const state = runners.get(liveId);
    if (!state) {
      return;
    }
    // 置位即「不再运行」：监控立刻可见；正在播的当前句让它自然播完，播完检查点退出
    state.cancelled = true;
    state.running = false;
    state.currentSeq = 0;
  }

  function isRunning(liveId: string): boolean {
    return runners.get(liveId)?.running === true;
  }

  function status(liveId: string): LoopCasterStatus | null {
    const state = runners.get(liveId);
    if (!state) {
      return null;
    }
    return { running: state.running, round: state.round, currentSeq: state.currentSeq };
  }

  return { start, stop, isRunning, status };
}

/**
 * 全局单例：routes/lives 的 start/end 接线 + liveSession 监控读取共用；
 * 显式注入本场音色解析与本场氛围语调度（空档插播）。
 */
export const loopCaster = createLoopCaster({
  loadVoice: getLiveSpeech,
  pickAtmosphere: async (liveId, nowMs) => atmosphereScheduler.pickDue(liveId, nowMs),
  markAtmosphereSpoken: (liveId, category, atMs) =>
    atmosphereScheduler.markSpoken(liveId, category, atMs),
});
