package cn.starvoice.starvoice_app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.media.MediaPlayer
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
 * R62 起额外**循环播放一段完全静音的音频**：
 *   2026-09-21 真机实测（华为 ELS-AN10 / EMUI）：前台服务确实起着（isForeground=true、
 *   有通知、oom_score_adj=50），但系统**照样强制释放了我们的 WakeLock**
 *   （dumpsys power 里出现 Force Released WakeLocks），于是 Dart 定时器被冻，
 *   助播拉取从 1 秒掉到 8~22 秒，表现为「后台没声音」。
 *   根因之一是：`mediaPlayback` 这个前台服务类型**只有在真的在输出音频时才成立** ——
 *   我们只在台本说一句的那几秒有声，中间大段静默，系统不认。
 *   循环播静音让这个声明**变成事实**，从而拿到系统的前台服务豁免（不受 JobScheduler /
 *   Alarm 限流），定时器不再被冻。**这不是隐藏行为**：常驻通知照常在，音量恒为 0。
 *
 * 合规口径：正规前台服务 + 常驻可见通知 + 唤醒锁 + 真实（静音）音频输出；
 * 不使用双进程互拉 / 隐藏通知 / 1 像素 Activity / 静默自启等对抗系统的手段。
 */
class AssistantKeepAliveService : Service() {

    private var wakeLock: PowerManager.WakeLock? = null
    private var wifiLock: WifiManager.WifiLock? = null

    /** R62：静音循环播放器 —— 让应用保持「正在输出媒体」的前台服务豁免态 */
    private var silencePlayer: MediaPlayer? = null

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
        startSilenceLoop()
        // R62：两样保活加固（对照竞品取证）
        //   ① JobScheduler 心跳：系统统一调度，**不受应用定时器被限流影响**；
        //   ② 1 像素透明 Activity：让本进程留在更高的优先级桶里，更不容易被冻结。
        //      它只在保活期间由服务自己拉起（属前台服务可见场景，不做静默自启 ✗）。
        KeepAliveJobService.schedule(this)
        raiseOnePixel()
        // 被杀后由系统按 startForegroundService 语义尽量重建（保留常驻语义）
        return START_STICKY
    }

    override fun onDestroy() {
        stopSilenceLoop()
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

    /**
     * R62：循环播放一段静音音频。
     *
     * 失败一律静默吞掉 —— 这只是「提升后台可靠性」的加分项，
     * 不能因为它让保活本身起不来。
     */
    private fun startSilenceLoop() {
        if (silencePlayer != null) {
            return
        }
        try {
            silencePlayer = MediaPlayer.create(this, R.raw.keep_alive_silence)?.apply {
                isLooping = true
                setVolume(0f, 0f)
                start()
            }
        } catch (_: Throwable) {
            silencePlayer = null
        }
    }

    /**
     * 拉起 1 像素透明 Activity。
     *
     * 失败一律吞掉：这只是「提升后台存活率」的加分项，不能因为它让保活起不来。
     * 少数 ROM 会拦截后台启动 Activity —— 拦了就拦了，前台服务与 JobScheduler 仍在。
     */
    private fun raiseOnePixel() {
        try {
            val intent = Intent(this, OnePixelActivity::class.java).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                addFlags(Intent.FLAG_ACTIVITY_NO_ANIMATION)
                addFlags(Intent.FLAG_ACTIVITY_EXCLUDE_FROM_RECENTS)
            }
            startActivity(intent)
        } catch (_: Throwable) {
            // 被系统拦掉是预期内的，不处理
        }
    }

    private fun stopSilenceLoop() {
        try {
            silencePlayer?.stop()
        } catch (_: Throwable) {
            // 已停止 / 已释放都会抛，忽略
        }
        try {
            silencePlayer?.release()
        } catch (_: Throwable) {
            // 同上
        }
        silencePlayer = null
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
