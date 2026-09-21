package cn.starvoice.starvoice_app

import android.app.job.JobParameters
import android.app.job.JobService
import android.app.job.JobInfo
import android.app.job.JobScheduler
import android.content.ComponentName
import android.content.Context

/**
 * 保活定时唤醒（R62，对照竞品 xcai1618 的 `com.gyf.cactus.service.CactusJobService`）。
 *
 * 为什么需要：前台服务保证的是「进程不容易被杀」，**不保证定时器不被限流** ✗。
 * 2026-09-21 真机实测（华为 ELS-AN10）：前台服务照起（isForeground=true、有通知），
 * 系统照样**强制释放 WakeLock**（dumpsys power 里出现 Force Released WakeLocks），
 * 于是 Dart 定时器被冻，助播拉取从 1 秒掉到 8~22 秒，表现为「后台没声音」。
 *
 * JobScheduler 是 Android 官方为「后台也要定期干活」提供的通道 ——
 * 它由系统统一调度，**不受应用自身定时器被限流的影响** ✓（Doze 期间由系统窗口唤醒）。
 * 这里不直接拉音频（音频仍由前端负责），只做一件事：
 * **定期确认保活服务还活着**，掉了就把它拉回来。
 */
class KeepAliveJobService : JobService() {

    override fun onStartJob(params: JobParameters?): Boolean {
        // 重新拉一次保活服务（幂等：已在前台就只刷新通知）
        AssistantKeepAliveService.start(applicationContext, null, null)
        // 立即收工 —— 我们不需要在这里做长任务，唤醒本身就是目的
        jobFinished(params, false)
        return false
    }

    override fun onStopJob(params: JobParameters?): Boolean {
        // 被系统打断：下次重新排（返回 true 表示希望系统重试）
        return true
    }

    companion object {
        private const val JOB_ID = 20260910

        /** 最小周期 15 分钟 —— 这是 JobScheduler 的硬下限，再短系统也会按 15 分钟给。 */
        private const val INTERVAL_MS = 15L * 60L * 1000L

        /** 排一次保活心跳任务；重复调用不会重复排（JobScheduler 按 jobId 去重）。 */
        fun schedule(context: Context) {
            val scheduler = context.getSystemService(Context.JOB_SCHEDULER_SERVICE) as? JobScheduler
                ?: return
            val component = ComponentName(context, KeepAliveJobService::class.java)
            val info = JobInfo.Builder(JOB_ID, component)
                .setPeriodic(INTERVAL_MS)
                .setPersisted(true) // 重启后仍然有效
                // 不需要网络/充电等前置条件：这条任务只是「叫醒自己」
                .build()
            try {
                scheduler.schedule(info)
            } catch (_: Throwable) {
                // 少数 ROM 会拒绝持久化任务：忽略，前台服务本身仍在
            }
        }
    }
}
