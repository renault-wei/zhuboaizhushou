// 直播运行时（R59）：把「一场直播跑起来需要哪些东西」集中到一处。
//
// 为什么抽出来（2026-09-21 发现）：这些运行时**全在内存里** ——
//   音色快照 / 循环台本 Runner / 氛围语 / 弹幕采集 / 定时关播，
// 而它们原先**只在 `/start` 这一个入口被拉起**。于是服务一重启：
//   DB 里 status 还是 live，可**采集断了、台本哑了、氛围语没了、定时关播也不会再响** ——
//   商家看到的是一场「安静的直播」，而且**永远不会自己结束**。
// 我是在部署 R57 时亲眼看到采集卡变回「开始采集」才发现的。
//
// 所以开播与「重启恢复」必须走**同一条**拉起路径，否则两边迟早漂移
// —— R47 那次「`/start` 不落库」的缺口就是这么来的。

import { atmosphereScheduler } from './atmosphereScheduler';
import { autoEndScheduler } from './autoEnd';
import { interactionEngine } from './interactionEngine';
import { type Live, saveLiveDanmakuSource } from './live';
import { liveCollector } from './liveCollector';
import { settleLiveSession } from './liveBilling';
import { endLive } from './liveSession';
import { captureLiveSpeech, forgetLiveSpeech } from './liveVoice';
import { loopCaster } from './loopCaster';
import { clearPendingReplies } from './pendingReplies';
import { forgetSpeakerHeartbeat } from './speakerHeartbeat';

/** 只告警不抛出 —— 拉起失败绝不能阻断开播，也绝不能阻断服务启动 */
export type RuntimeWarn = (message: string, err?: unknown) => void;

/**
 * 把一场「已经在直播中」的场次所需的运行时全部拉起来。
 *
 * **开播（/start）与服务重启恢复共用这一份** —— 两处行为必须一致。
 * 调用方负责：场次已置为 live、以及开播才需要的「清空上一场痕迹」。
 */
export async function bringUpLiveSession(
  userId: string,
  live: Live,
  warn: RuntimeWarn,
): Promise<void> {
  // 音色口径统一：冻结本场音色 / 语速快照（循环台本句与弹幕回复共用同一份）
  await captureLiveSpeech(live.id);
  // 循环台本 Runner（未绑定台本 → 快照为空自动退出，只回弹幕）
  loopCaster.start(live.id);
  // 氛围语快照（空档插播取词用；无氛围语 → 空快照，不影响循环）
  atmosphereScheduler.start(live.id);
  // 弹幕采集：以**库里存的源**为准（用户拍板 D4：原始链接优先，房间号兜底）
  try {
    const sourceUrl = live.danmakuCollectEnabled ? live.danmakuSourceUrl : null;
    const roomRef = live.danmakuCollectEnabled ? live.danmakuRoomRef : null;
    if (sourceUrl || roomRef) {
      const binding = await liveCollector.start({
        userId,
        liveId: live.id,
        ...(sourceUrl ? { shareText: sourceUrl } : { roomRef: roomRef as string }),
      });
      // R51：把这次真实解析出来的结果写回场次（roomRef + 主播稳定身份）
      try {
        await saveLiveDanmakuSource(userId, live.id, {
          roomRef: binding.roomRef,
          anchorId: binding.anchorId ?? null,
        });
      } catch (err) {
        warn('回写采集解析结果失败（采集已启动，不影响出声与入库）', err);
      }
    } else {
      // 库里没存源 → 回落到内存绑定（兼容更早登记的场次）
      await liveCollector.resume(live.id);
    }
  } catch (err) {
    warn('启动弹幕采集失败（不阻断直播）', err);
  }
  scheduleAutoEndIfNeeded(userId, live, warn);
}

/**
 * 登记定时关播。
 *
 * ★重启恢复的关键差别：`autoEndScheduler.schedule` 收的是**相对分钟数**，
 * 而重启时该场已经播了一会儿 —— 直接拿 `autoEndMinutes` 重登记会**白送它 N 分钟**。
 * 所以这里按「开播时刻 + 设定时长」算**剩余**时间；已经过点的**立即收尾**
 * （进程挂掉期间该结束的直播，恢复时就该结束，不能让它继续播下去）。
 */
function scheduleAutoEndIfNeeded(userId: string, live: Live, warn: RuntimeWarn): void {
  const minutes = live.autoEndMinutes;
  if (minutes === null) {
    return;
  }
  const startedAtMs = live.startedAt ? Date.parse(live.startedAt) : Number.NaN;
  if (Number.isNaN(startedAtMs)) {
    // 没有开播时刻就无法算剩余 —— 退回按原时长登记（至少不会永久不停）
    registerAutoEnd(userId, live.id, minutes, warn);
    return;
  }
  const remainingMs = startedAtMs + minutes * 60_000 - Date.now();
  if (remainingMs <= 0) {
    console.info(`[liveRuntime] 场次 ${live.id} 的定时关播在重启期间已过期，立即收尾`);
    void finishLiveSession(userId, live.id, warn).catch((err) => {
      warn('过期定时关播收尾失败', err);
    });
    return;
  }
  registerAutoEnd(userId, live.id, Math.ceil(remainingMs / 60_000), warn);
}

function registerAutoEnd(userId: string, liveId: string, minutes: number, warn: RuntimeWarn): void {
  const registration = autoEndScheduler.schedule({
    liveId,
    minutes,
    onFire: async (id) => {
      await finishLiveSession(userId, id, warn);
    },
  });
  console.info(`[liveRuntime] 场次 ${liveId} 已登记定时关播：${minutes} 分钟后（${registration.endsAt}）`);
}

/**
 * 优雅收尾（用户拍板 D2）：循环台本「当前句播完即止」、出声队列**不清空**、
 * 停采集不再产生新回复、取消定时器。代价：实际静默比设定晚十几秒（用户已知并接受）。
 *
 * 从 `routes/lives.ts` 挪到这里（R59）—— 重启恢复也要能调它，路由局部函数做不到。
 */
export async function finishLiveSession(
  userId: string,
  liveId: string,
  warn: RuntimeWarn,
): Promise<{ live: Live | null; billing: Awaited<ReturnType<typeof settleLiveSession>> | null }> {
  const live = await endLive(userId, liveId);
  if (!live) {
    return { live: null, billing: null };
  }
  loopCaster.stop(live.id);
  try {
    await liveCollector.suspend(live.id);
  } catch (err) {
    warn('结束直播停止弹幕采集失败（不阻断结束）', err);
  }
  forgetLiveSpeech(live.id);
  atmosphereScheduler.stop(live.id);
  autoEndScheduler.cancel(live.id);
  // R29：清掉本场的频控记账 —— 否则进程内 Map 会随场次数无界增长
  interactionEngine.forgetLive(live.id);
  // R42：台本已停，队列里没放出去的回复不会再有机会播 —— 清掉，避免内存滞留
  clearPendingReplies(live.id);
  // R53：助播机心跳记录也回收
  forgetSpeakerHeartbeat(live.id);
  let billing: Awaited<ReturnType<typeof settleLiveSession>> | null = null;
  try {
    billing = await settleLiveSession({
      userId,
      liveId: live.id,
      startedAt: live.startedAt,
      endedAt: live.endedAt,
    });
    if (billing.settledMinutes > 0) {
      console.info(
        `[liveBilling] 场次 ${live.id} 结算 ${billing.settledMinutes} 分钟（余额 ${billing.drawnFromBalance}）`,
      );
    }
  } catch (err) {
    warn('结算失败', err);
  }
  return { live, billing };
}
