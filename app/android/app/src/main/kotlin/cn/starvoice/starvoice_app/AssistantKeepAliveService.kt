package cn.starvoice.starvoice_app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.wifi.WifiManager
import android.os.Build
import android.os.IBinder
import android.os.PowerManager

/**
 * 助播保活前台服务（M9 手机线）。
 *
 * 用途：AI 语音助播出声期间，把 App 进程固定在「前台服务」优先级上，
 * 避免切到别的 App 或锁屏后被系统冻结，导致助播轮询队列与出声中断
 * （对照竞品取证结论：后台能出声的本质 = 进程不被冻结，而非特殊播放 API）。
 *
 * 同时持有 PARTIAL_WAKE_LOCK（息屏时 CPU 不停）与 WifiLock（息屏时网络不断）。
 *
 * 合规口径：只用正规前台服务 + 常驻可见通知 + 唤醒锁，
 * 不使用双进程互拉 / 隐藏通知 / 1 像素 Activity / 静默自启等对抗系统的手段。
 */
class AssistantKeepAliveService : Service() {

    private var wakeLock: PowerManager.WakeLock? = null
    private var wifiLock: WifiManager.WifiLock? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            stopSelf()
            return START_NOT_STICKY
        }
        val title = intent?.getStringExtra(EXTRA_TITLE).orEmpty().ifBlank { DEFAULT_TITLE }
        val content = intent?.getStringExtra(EXTRA_CONTENT).orEmpty().ifBlank { DEFAULT_CONTENT }
        startForegroundCompat(title, content)
        acquireLocks()
        // 被杀后由系统按 startForegroundService 语义尽量重建（保留常驻语义）
        return START_STICKY
    }

    override fun onDestroy() {
        releaseLocks()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            stopForeground(STOP_FOREGROUND_REMOVE)
        } else {
            @Suppress("DEPRECATION")
            stopForeground(true)
        }
        super.onDestroy()
    }

    private fun startForegroundCompat(title: String, content: String) {
        createChannel()
        val notification = buildNotification(title, content)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(
                NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK,
            )
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }

    private fun buildNotification(title: String, content: String): Notification {
        val launchIntent = packageManager.getLaunchIntentForPackage(packageName)
        val flags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        } else {
            PendingIntent.FLAG_UPDATE_CURRENT
        }
        val pendingIntent = launchIntent?.let {
            PendingIntent.getActivity(this, 0, it, flags)
        }
        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(this, CHANNEL_ID)
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(this)
        }
        builder
            .setContentTitle(title)
            .setContentText(content)
            .setSmallIcon(applicationInfo.icon)
            .setOngoing(true)
            .setShowWhen(false)
        pendingIntent?.let { builder.setContentIntent(it) }
        return builder.build()
    }

    private fun createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            return
        }
        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (manager.getNotificationChannel(CHANNEL_ID) != null) {
            return
        }
        val channel = NotificationChannel(
            CHANNEL_ID,
            CHANNEL_NAME,
            NotificationManager.IMPORTANCE_LOW,
        ).apply {
            description = CHANNEL_DESCRIPTION
            setShowBadge(false)
            enableVibration(false)
            setSound(null, null)
        }
        manager.createNotificationChannel(channel)
    }

    private fun acquireLocks() {
        if (wakeLock == null) {
            val power = getSystemService(Context.POWER_SERVICE) as PowerManager
            wakeLock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, WAKE_LOCK_TAG).apply {
                setReferenceCounted(false)
            }
        }
        wakeLock?.takeIf { !it.isHeld }?.acquire()

        if (wifiLock == null) {
            val wifi = applicationContext.getSystemService(Context.WIFI_SERVICE) as? WifiManager
            wifiLock = wifi?.createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, WAKE_LOCK_TAG)
        }
        wifiLock?.takeIf { !it.isHeld }?.acquire()
    }

    private fun releaseLocks() {
        wakeLock?.takeIf { it.isHeld }?.release()
        wakeLock = null
        wifiLock?.takeIf { it.isHeld }?.release()
        wifiLock = null
    }

    companion object {
        const val ACTION_START = "cn.starvoice.starvoice_app.action.KEEP_ALIVE_START"
        const val ACTION_STOP = "cn.starvoice.starvoice_app.action.KEEP_ALIVE_STOP"
        const val EXTRA_TITLE = "extra_title"
        const val EXTRA_CONTENT = "extra_content"

        private const val CHANNEL_ID = "starvoice_assistant_keep_alive"
        private const val CHANNEL_NAME = "AI 语音助播"
        private const val CHANNEL_DESCRIPTION = "助播出声期间的常驻提示"
        private const val NOTIFICATION_ID = 20260910
        private const val WAKE_LOCK_TAG = "starvoice:assistant_keep_alive"
        private const val DEFAULT_TITLE = "AI 语音助播运行中"
        private const val DEFAULT_CONTENT = "正在轮询播报队列并出声，请勿清理后台"

        /** 拉起保活（前台服务 + 唤醒锁）；重复调用只刷新通知文案。 */
        fun start(context: Context, title: String?, content: String?) {
            val intent = Intent(context, AssistantKeepAliveService::class.java).apply {
                action = ACTION_START
                putExtra(EXTRA_TITLE, title)
                putExtra(EXTRA_CONTENT, content)
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }

        /** 停止保活：停服并释放唤醒锁（幂等，未启动时调用无副作用）。 */
        fun stop(context: Context) {
            context.stopService(Intent(context, AssistantKeepAliveService::class.java))
        }
    }
}
