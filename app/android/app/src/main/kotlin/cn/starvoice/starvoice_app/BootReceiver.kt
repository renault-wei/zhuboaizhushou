package cn.starvoice.starvoice_app

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * 开机 / 应用被替换后重新排保活（R62，对照竞品的 `RECEIVE_BOOT_COMPLETED`）。
 *
 * 注意：**开机拉起前台服务**在 Android 12+ 需要用户先把应用加入自启动白名单，
 * 否则这里会被系统直接拦掉 —— 所以它只是「用户放行了就生效」的加分项，
 * 不是绕过白名单的手段 ✗。
 *
 * 这里**只排 JobScheduler**，不直接 startForegroundService：
 * 开机瞬间起前台服务在多数国产 ROM 上会被拒，而 JobScheduler 由系统调度，更稳。
 */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context?, intent: Intent?) {
        val action = intent?.action ?: return
        if (action != Intent.ACTION_BOOT_COMPLETED &&
            action != Intent.ACTION_MY_PACKAGE_REPLACED
        ) {
            return
        }
        val appContext = context?.applicationContext ?: return
        KeepAliveJobService.schedule(appContext)
    }
}
