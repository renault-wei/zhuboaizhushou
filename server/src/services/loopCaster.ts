import { eq } from 'drizzle-orm';
import { db } from '../db/client';
import { lives as livesTable, loopScriptItems as loopScriptItemsTable } from '../db/schema';
import {
  liveSpeaker,
  speechLinePendingCount,
  type SpeechOverrides,
  type TtsCacheContext,
} from './liveSpeaker';
import { getLiveSpeech, loadLiveTtsCacheContext } from './liveVoice';
import type { AtmosphereCategory, AtmosphereInsertion } from './atmosphere';
import { atmosphereScheduler } from './atmosphereScheduler';
import { takePendingReply } from './pendingReplies';
// R70：判「链路忙」要用**队列上界**（不是「非空」）—— 见 defaultIsBusy 的注释
import {
  MAX_REMOTE_SPEECH_JOBS_PER_LIVE,
  MAX_REMOTE_SPEECH_LOOKAHEAD_PER_LIVE,
} from './remoteSpeechQueue';

// 循环台本播出引擎（M4，P-循环台本 & P-播出里程碑 §8）：
// 开播（ready→live）后按台本顺序循环口播产品/团购券；与弹幕回复共用 liveSpeaker 全局出声链路，
// 只靠「出声链路空闲才推下一句」天然串行、不重叠；结束直播（唯一停止入口）即停。
// 合规：引擎只读库里已过敏感词扫描的台本条目，不做任何文本写入或旁路。

// ---------- 常量（口径 docs/LOOP-BROADCAST-PLAN.md §8）----------

/** 条间默认间隔（秒）：条目未配置 gapAfterSeconds 时使用。
 *  2026-09-11 由 6s 收紧到 2s：6s 停顿静默占比近 60%，听感像念稿、且长时间静默有平台判定风险。
 *  2026-09-17 用户拍板「循环话本播放期间间隔默认 0s」→ 再压到 0：连读更顺、静默几乎归零；
 *  单条时长与停顿由台本自身的标点与语速承担（长文本的句中不停顿由 volcTTS 分段合成保证）。
 *  2026-09-21 用户改口径：**默认 0s → 1s** —— 0s 连读太急、句子之间没有呼吸感，
 *  1s 停顿听感更像真人在直播间一句一句说。条目仍可各自覆盖，也可以在编辑器里「统一设置」。*/
export const DEFAULT_ITEM_GAP_SECONDS = 1;
/** 每轮播完后的轮间休息（秒）：2026-09-11 由 20s 收紧到 6s（一轮结束不长时间留白） */
export const DEFAULT_LOOP_REST_SECONDS = 6;
/** 单次空档避让的最长等待（ms）：超过就放弃让位继续播报（防助播机不轮询时台本卡死） */
export const DEFAULT_MAX_YIELD_MS = 30_000;

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
    gapAfterSeconds?: number,
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
  /**
   * R42：空档取一条**待播弹幕回复**的文案，无则 null。
   * 优先级高于氛围语 —— 观众的真问题比暖场词重要。
   */
  pickPendingReply?(liveId: string): Promise<string | null>;
  /** 空档插播取词（M10-A3）：返回一条到期的氛围台词，无则 null；生产接 atmosphereScheduler */
  pickAtmosphere?(liveId: string, nowMs: number): Promise<AtmosphereInsertion | null>;
  /** 插播实际出声后的记账（按类别刷新频控计时） */
  markAtmosphereSpoken?(liveId: string, category: AtmosphereCategory, atMs: number): void;
  /** 时钟注入（测试用假时钟）；生产默认 Date.now */
  now?(): number;
  itemGapSeconds?: number;
  loopRestSeconds?: number;
  idlePollMs?: number;
  /**
   * 单次空档避让的最长等待（ms）：超过就放弃让位继续播报。
   * 防的是「助播机不轮询 → 远程队列排不空 → 台本卡死」。默认 30s。
   */
  maxYieldMs?: number;
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
    | 'pickPendingReply'
    | 'pickAtmosphere'
    | 'markAtmosphereSpoken'
    | 'maxYieldMs'
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

/** 默认出声：全局 liveSpeaker（本地播完 resolve / 远程入队即返回），带本场音色覆盖与场次归属。
 *
 * ⚠️ 形参顺序与 [LoopCasterOptions.speak] 的**前缀约定**（R77）：
 *   注入接口只有 (text, overrides, liveId, gapAfterSeconds) 四个 ✓ ——
 *   隐藏的 `cache` 排在**最后**，于是「少参数的替身」自动可赋给它 ✓
 *   （若把 cache 放第 4 位，注入的 4 参函数就会与 gap 撞位 ✗）
 *   而 liveSpeaker.speak 的公开顺序是 (text, overrides, liveId, cache, gapAfterSeconds)，
 *   所以这里要**换位**再传 ✓ */
function defaultSpeak(
  text: string,
  overrides?: SpeechOverrides,
  liveId?: string,
  gapAfterSeconds?: number,
  cache?: TtsCacheContext,
): Promise<{ spoken: boolean; reason?: string }> {
  return liveSpeaker.speak(text, overrides, liveId, cache, gapAfterSeconds);
}

/** 默认睡眠：真实 setTimeout */
function defaultSleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** 默认忙闲：读当前出声链路未播出排队条数（按场次过滤，避免被别场次积压拖着走） */
function defaultIsBusy(liveId: string): boolean {
  // ★★R70 彻底修复（2026-09-22）：
  //
  // 原先这里是 `speechLinePendingCount(liveId) > 0` ——
  // 「队列里有【任何一条】」就算链路忙 ✗。
  //
  // 这个判据在 **20 秒存活期**时代是对的 ✓：那时队列只在该句「刚说完还没被取走」的
  // 几秒内有货，有货即异常 ✓
  //
  // 但 R69 把存活期放宽到 **10 分钟**、并引入「App 本地囤货」之后，语义**反了** ✗：
  //   队列有货 = **设计本来就该如此**（货正等着被囤走）✓
  //   于是 isBusy 恒真 → 台本每句白等 30 秒 ✗
  //   → 一轮 20 句拖成 10 分钟 ✗ → **队列只攒到 5 条就再也进不了新货** ✗
  //   → **本地囤货永远囤不满**（R69 的设计意图被这一行废掉）✓
  //
  // 正确的判据是「**队列满**」而不是「队列非空」——
  // 这是**背压**（back-pressure），不是故障 ✓：
  //   没满 → 照常入队，让 App 尽快把货囤到本地 ✓
  //   满了 → 等一下（此时台本会跳过等待、照播，多余条目由队列上界淘汰最旧的 ✓）
  //
  // ★★R77 修正水位（2026-09-22 真机实测「循环过快、似乎没有等待」）：
  //   R70 的「满 = 60」是在「间隔只在生产端」的前提下定的 ✗。
  //   间隔下放到播放端之后，生产端 ~1 秒/条、播放端 ~7.8 秒/条 ——
  //   若仍以 60 为水位，队列会一直钉在硬上界：台本永远在灌 7 分钟后的台词，
  //   队列持续淘汰最旧的条目，而助播机永远在念很久以前的话 ✗。
  //   改成「前瞻」水位（3 条）后，生产端由**消费速度**自然反压 ✓ ——
  //   这也正是我们想要的节奏：台本跟着助播机的嘴走，而不是跟着自己的 sleep 走 ✓
  return speechLinePendingCount(liveId) >= MAX_REMOTE_SPEECH_LOOKAHEAD_PER_LIVE;
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
/**
 * R69：本场次的合成缓存上下文，按 liveId 记忆化。
 *
 * 为什么记忆化：循环台本一场要念几十句，每句都回库查「商家 + 音色 + 语速」是浪费 ✗；
 * 而这三样在一场之内由开播快照决定，不会变 ✓。
 * 进程重启即清空（与场次音色快照同口径，不跨场次串读数）。
 */
const liveCacheContexts = new Map<string, TtsCacheContext | null>();

async function resolveCacheContext(
  liveId: string,
): Promise<TtsCacheContext | undefined> {
  const cached = liveCacheContexts.get(liveId);
  if (cached !== undefined) {
    return cached ?? undefined;
  }
  const resolved = await loadLiveTtsCacheContext(liveId).catch(() => null);
  liveCacheContexts.set(liveId, resolved);
  return resolved ?? undefined;
}

/** 逐句出声的容错包装：合成/播放失败只记日志，节奏照走，不让循环卡死（§8.3） */
async function speakSafely(
  speak: (
    text: string,
    overrides?: SpeechOverrides,
    liveId?: string,
    gapAfterSeconds?: number,
    cache?: TtsCacheContext,
  ) => Promise<{ spoken: boolean; reason?: string }>,
  liveId: string,
  text: string,
  overrides: SpeechOverrides | null,
  gapAfterSeconds: number,
): Promise<boolean> {
  try {
    // ★R69：把缓存上下文交给合成层 —— 命中缓存时【完全不碰火山】✓
    const cache = await resolveCacheContext(liveId);
    // ★R77：间隔随条目下发到播放端（详见 remoteSpeechQueue 的 gapAfterSeconds 注释）
    const result = await speak(text, overrides ?? undefined, liveId, gapAfterSeconds, cache);
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
/**
 * R42：空档插播**弹幕回复**。
 *
 * 优先级最高（回复 > 氛围语 > 台本句 —— 见 tryInsertAtmosphere 的注释），
 * 但**一个空档只放一条**：这就是「节奏」的硬保障 ——
 * 无论弹幕多少，台本都能按轮推进，不会被无限让位挤停。
 */
async function tryInsertReply(
  liveId: string,
  options: ResolvedLoopDeps,
  overrides: SpeechOverrides | null,
  gapAfterSeconds: number,
): Promise<boolean> {
  // ⚠️ 这里**不能**用 isBusy 当门槛（2026-09-17 修）：
  // 手机线用的是 remoteSpeechSink，它的 play 是「**入队即返回**」（不等播放）——
  // 于是 speak 返回后链路里必然还有刚说的那句台本，isBusy 恒为真，
  // 回复就**永远不会被放出去**（真机上表现为「AI 不回话」）。
  //
  // 语义上也不需要它：本函数就是要在**当前台本句之后**放一条回复，
  // 而出声链路是 FIFO —— 直接 push 进去，播出来正好夹在两句台本之间。
  // 节奏由「一个空档只调用一次本函数」保证，不靠 isBusy。
  let text: string | null;
  try {
    text = await options.pickPendingReply(liveId);
  } catch (err) {
    console.warn(
      `[loopCaster] 场次 ${liveId} 取待播回复失败，跳过本次插播：${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return false;
  }
  if (!text) {
    return false;
  }
  // 取出来就播；出声失败即丢弃（队列有上界，不会因此堆积）
  return await speakSafely(options.speak, liveId, text, overrides, gapAfterSeconds);
}

async function tryInsertAtmosphere(
  liveId: string,
  options: ResolvedLoopDeps,
  overrides: SpeechOverrides | null,
  gapAfterSeconds: number,
): Promise<void> {
  // 同样的坑（2026-09-17 一并修）：远程 sink「入队即返回」→ isBusy 恒为真 →
  // 氛围语在手机线上**从来没被插播过**。频次由 atmosphereScheduler.pickDue 自己控，
  // 不靠 isBusy —— 该到期就到期，没到期 pickDue 返回 null，不会插多。
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
  const spoken = await speakSafely(
    options.speak,
    liveId,
    insertion.text,
    overrides,
    gapAfterSeconds,
  );
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
  // 空档避让的上限（见下方让位循环的注释：防助播机不轮询时台本卡死）
  const maxYieldMs = options.maxYieldMs ?? DEFAULT_MAX_YIELD_MS;
  // 换算成轮询次数：sleep 步长固定，与墙钟等价但可测（假时钟下也能确定性复现）
  const maxYieldPolls = Math.max(1, Math.ceil(maxYieldMs / idlePollMs));
  let polls = 0;

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
        // 空档避让：队列里的**前瞻已满**（已经有几条排在前面等着播）→ 小步轮询，不在播放间隙插队。
        //
        // ⚠️ 判据是「前瞻满」而不是「非空」，也不是「撞硬上界」（R70 定方向，R77 定水位）——
        // R69 之后「队列里有货」是**正常状态**（等 App 囤走）✓；
        // R77 之后消费端按「音频时长 + 条间间隔」慢慢取 ✓，
        // 所以「已有 3 条等着播」就是该停下来的信号（详见 defaultIsBusy 的注释）。
        //
        // ⚠️ 并且**不能无限等**（2026-09-17 修）：助播机一旦停止轮询
        // （App 被杀 / 断网），队列排不空 → 台本会卡在这里。
        // 超过 maxYieldMs 就放弃等待继续推进，并告警留痕（此时照播，不跳过该句 ✓）。
        // 用「轮询次数」而不是墙钟：sleep 步长固定，两者等价，且测试可用假时钟确定性复现。
        polls = 0;
        while (!state.cancelled && options.isBusy(liveId)) {
          polls += 1;
          if (polls > maxYieldPolls) {
            // R70：文案改成中性 —— 旧文案写「疑似助播机未轮询」，但实测 App 一直在拉，
            // 那是**假警报** ✗。正常情况下前瞻水位会自然回落，走到这里只可能是助播机没在取货。
            // R77：带上三个数字（当前积压 / 前瞻水位 / 硬上界），便于区分「助播机慢」与「水位太小」✓
            console.warn(
              `[loopCaster] 场次 ${liveId} 出声队列积压（${speechLinePendingCount(liveId)} 条 / 前瞻 ${MAX_REMOTE_SPEECH_LOOKAHEAD_PER_LIVE}，硬上界 ${MAX_REMOTE_SPEECH_JOBS_PER_LIVE}），` +
                `等待 ${maxYieldMs}ms 仍未回落，本次照播（疑似助播机未取货）`,
            );
            break;
          }
          await options.sleep(idlePollMs);
        }
        if (state.cancelled) {
          break;
        }
        const item = roundItems[index];
        if (!item) {
          break;
        }
        // ★R77：间隔（本条播完后）随这句一起交给出声链路 —— 远程链路会把它下发到播放端 ✓
        await speakSafely(
          options.speak,
          liveId,
          item.text,
          voice,
          item.gapAfterSeconds ?? itemGapSeconds,
        );
        if (state.cancelled) {
          break;
        }
        // 空档插播（R42）：**回复优先**，一个空档只放一条。
        // 回复放出去了就不再插氛围语 —— 一个空档只给一次插播机会，节奏才稳。
        const insertedReply = await tryInsertReply(liveId, options, voice, itemGapSeconds);
        if (!insertedReply) {
          // 本句播完的间隔也是氛围语的机会窗口（忙/未到期 → 本次不插，等下一个空档）
          await tryInsertAtmosphere(liveId, options, voice, itemGapSeconds);
        }
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
  // 空档插播默认关闭（引擎核心不依赖回复队列）；生产由全局单例注入
  const pickPendingReply = options.pickPendingReply ?? (async () => null);
  const pickAtmosphere = options.pickAtmosphere ?? (async () => null);
  const markAtmosphereSpoken = options.markAtmosphereSpoken ?? (() => undefined);
  const now = options.now ?? (() => Date.now());
  const itemGapSeconds = options.itemGapSeconds ?? DEFAULT_ITEM_GAP_SECONDS;
  const loopRestSeconds = options.loopRestSeconds ?? DEFAULT_LOOP_REST_SECONDS;
  const idlePollMs = options.idlePollMs ?? DEFAULT_IDLE_POLL_MS;
  const maxYieldMs = options.maxYieldMs ?? DEFAULT_MAX_YIELD_MS;

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
      {
        speak,
        loadItems,
        loadVoice,
        sleep,
        isBusy,
        pickPendingReply,
        pickAtmosphere,
        markAtmosphereSpoken,
        maxYieldMs,
        now,
      },
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
  // R42：空档先取待播弹幕回复（回复 > 氛围语 > 台本句）
  pickPendingReply: async (liveId) => takePendingReply(liveId)?.text ?? null,
  pickAtmosphere: async (liveId, nowMs) => atmosphereScheduler.pickDue(liveId, nowMs),
  markAtmosphereSpoken: (liveId, category, atMs) =>
    atmosphereScheduler.markSpoken(liveId, category, atMs),
});
