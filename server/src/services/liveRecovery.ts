// 服务重启后的直播恢复（R59）。
//
// 要解决的问题（2026-09-21 我部署 R57 时亲眼看到）：直播运行时全在内存里 ——
// 音色快照 / 循环台本 / 氛围语 / 弹幕采集 / 定时关播，而它们原先**只在 /start 被拉起**。
// 进程一重启，DB 里 status 还是 live，可**采集断了、台本哑了、氛围语没了**，
// 更糟的是**定时关播也不会再响** —— 那场直播会一直播下去。
// 商家看到的是「一场安静的、永不结束的直播」。
//
// 做法：启动时扫一遍 status='live' 的场次，按**与开播完全相同**的路径拉起来
// （共用 services/liveRuntime.bringUpLiveSession）。
// 原则：**失败只告警，绝不影响服务启动** —— 恢复是尽力而为，不是启动前置条件。

import { eq } from 'drizzle-orm';
import { db } from '../db/client';
import { lives } from '../db/schema';
import { toLive } from './live';
import { bringUpLiveSession, type RuntimeWarn } from './liveRuntime';

/**
 * 把库里所有「正在直播中」的场次重新拉起来。
 *
 * @returns 实际尝试恢复的场次数（供启动日志与排障）
 */
export async function restoreLiveSessions(warn: RuntimeWarn): Promise<number> {
  let rows;
  try {
    rows = await db.select().from(lives).where(eq(lives.status, 'live'));
  } catch (err) {
    warn('重启恢复：查询进行中的场次失败（服务继续启动）', err);
    return 0;
  }
  if (rows.length === 0) {
    console.info('[liveRecovery] 没有进行中的场次需要恢复');
    return 0;
  }
  console.info(`[liveRecovery] 发现 ${rows.length} 场进行中的直播，开始恢复运行时`);
  let restored = 0;
  for (const row of rows) {
    const live = toLive(row);
    try {
      // userId 走 drizzle 行（Live 对外形状不含它 —— 场次永远属于当前登录用户）
      await bringUpLiveSession(row.userId, live, warn);
      restored += 1;
      console.info(`[liveRecovery] 场次 ${live.id}「${live.title}」运行时已恢复`);
    } catch (err) {
      // 单场失败不影响其它场次，更不影响服务启动
      warn(`重启恢复：场次 ${live.id} 拉起失败（继续下一场）`, err);
    }
  }
  return restored;
}
