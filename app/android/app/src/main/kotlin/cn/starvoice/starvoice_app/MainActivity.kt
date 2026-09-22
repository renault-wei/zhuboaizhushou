package cn.starvoice.starvoice_app

import android.Manifest
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel

/**
 * 主 Activity：除承载 Flutter 引擎外，注册「助播保活」方法通道
 * （M9 手机线）。桥接能力刻意保持最小：启停前台服务 + 查询 / 引导
 * 电池优化豁免，不引入任何对抗系统的保活手段。
 */
class MainActivity : FlutterActivity() {

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        MethodChannel(
            flutterEngine.dartExecutor.binaryMessenger,
            KEEP_ALIVE_CHANNEL,
        ).setMethodCallHandler { call, result ->
            when (call.method) {
                "start" -> {
                    ensureNotificationPermission()
                    AssistantKeepAliveService.start(
                        applicationContext,
                        call.argument<String>("title"),
                        call.argument<String>("content"),
                    )
                    result.success(null)
                }
                "stop" -> {
                    AssistantKeepAliveService.stop(applicationContext)
                    result.success(null)
                }
                "isIgnoringBatteryOptimizations" -> {
                    result.success(isIgnoringBatteryOptimizations())
                }
                "openBatteryOptimizationSettings" -> {
                    result.success(openBatteryOptimizationSettings())
                }
                "openAutoStartSettings" -> {
                    result.success(openAutoStartSettings())
                }
                "requestIgnoreBatteryOptimizations" -> {
                    result.success(requestIgnoreBatteryOptimizations())
                }
                // R65：权限**查询**（对照竞品 xcai1618 的 `checkAppNotification()` 等）——
                // 没有这些方法，向导的按钮就无法在「下一步 / 马上设置」之间切换。
                "checkNotificationPermission" -> {
                    result.success(checkNotificationPermission())
                }
                "checkOverlayPermission" -> {
                    result.success(checkOverlayPermission())
                }
                "openOverlaySettings" -> {
                    result.success(openOverlaySettings())
                }
                "openNotificationSettings" -> {
                    result.success(openNotificationSettings())
                }
                else -> result.notImplemented()
            }
        }
    }

    /** 是否已豁免电池优化（未豁免时息屏可能被冻结导致出声中断）。 */
    private fun isIgnoringBatteryOptimizations(): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) {
            return true
        }
        val power = getSystemService(Context.POWER_SERVICE) as PowerManager
        return power.isIgnoringBatteryOptimizations(packageName)
    }

    /**
     * 拉起系统电池优化设置页，由用户手动放行（不强制、不引导关闭系统能力）。
     * 优先定位到本应用的电池优化详情页，失败则退到应用详情页。
     */
    private fun openBatteryOptimizationSettings(): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) {
            return false
        }
        val candidates = listOf(
            Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS),
            Intent(
                Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                Uri.fromParts("package", packageName, null),
            ),
        )
        for (intent in candidates) {
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            if (intent.resolveActivity(packageManager) != null) {
                startActivity(intent)
                return true
            }
        }
        return false
    }

    /** 通知权限是否已授予（Android 13+ 才需要；低版本恒 true）。 */
    private fun checkNotificationPermission(): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            return true
        }
        return checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) ==
            PackageManager.PERMISSION_GRANTED
    }

    /**
     * 悬浮窗权限是否已授予（R65）。
     *
     * 竞品为什么查这项：它是「保活 + 悬浮展示」的前提，
     * 系统提供了可查询判定 `Settings.canDrawOverlays` ✓ 且能直接跳设置页。
     * 我们的助播机不画悬浮窗，但**持有该权限的进程在多数 ROM 上更不容易被冻结**，
     * 因此按竞品口径纳入向导。
     */
    private fun checkOverlayPermission(): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) {
            return true
        }
        return Settings.canDrawOverlays(this)
    }

    /** 拉起「显示在其他应用上层」设置页（失败返回 false，由调用方引导手找）。 */
    private fun openOverlaySettings(): Boolean {
        return try {
            val intent = Intent(
                Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                Uri.fromParts("package", packageName, null),
            ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            startActivity(intent)
            true
        } catch (_: Throwable) {
            false
        }
    }

    /** 拉起本应用的通知设置页（用户可在这里打开通知开关）。 */
    private fun openNotificationSettings(): Boolean {
        return try {
            val intent = Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).apply {
                putExtra(Settings.EXTRA_APP_PACKAGE, packageName)
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            startActivity(intent)
            true
        } catch (_: Throwable) {
            false
        }
    }
    /**
     * **主动申请**电池优化豁免（R62）。
     *
     * 与 [openBatteryOptimizationSettings] 的区别很关键：
     *   那个是「把用户丢到设置页，让他自己找」✗；
     *   这个是系统提供的**正规 API**，会弹一个明确的系统对话框让用户点「允许」✓。
     *
     * 竞品 xcai1618 的清单里就有 `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` ——
     * 我们此前只做了前者，等于**连正规手段都没用满**。
     *
     * 已有豁免时直接返回 true，不重复打扰。
     */
    @Suppress("BatteryLife")
    private fun requestIgnoreBatteryOptimizations(): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) {
            return true
        }
        if (isIgnoringBatteryOptimizations()) {
            return true
        }
        val intent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
            data = Uri.fromParts("package", packageName, null)
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        return try {
            startActivity(intent)
            true
        } catch (_: Throwable) {
            // 个别 ROM 不支持这个 action：回落到「打开设置页让用户自己找」
            openBatteryOptimizationSettings()
        }
    }

    /**
     * 拉起厂商的「自启动 / 受保护应用」设置页（R62）。
     *
     * 为什么必须有：华为 / 小米 / OPPO / vivo 各有自己一套后台管制，
     * **代码无法申请**，只能引导用户手动开。2026-09-21 真机实测（华为 ELS-AN10）：
     * 我们既不在自启动白名单、也不在电池优化白名单 —— 前台服务照起，
     * 但系统照样强制释放 WakeLock、冻掉定时器，表现为「后台没声音」。
     *
     * 逐个尝试各厂商的设置页组件，命中不了的自动跳过；全都不行则退到应用详情页。
     */
    private fun openAutoStartSettings(): Boolean {
        val candidates = listOf(
            // 华为 / 荣耀
            ComponentName(
                "com.huawei.systemmanager",
                "com.huawei.systemmanager.startupmgr.ui.StartupNormalAppListActivity",
            ),
            ComponentName(
                "com.huawei.systemmanager",
                "com.huawei.systemmanager.optimize.process.ProtectActivity",
            ),
            // 小米 / 红米
            ComponentName(
                "com.miui.securitycenter",
                "com.miui.permcenter.autostart.AutoStartManagementActivity",
            ),
            // OPPO / 一加 / realme
            ComponentName(
                "com.coloros.safecenter",
                "com.coloros.safecenter.permission.startup.StartupAppListActivity",
            ),
            ComponentName(
                "com.oneplus.security",
                "com.oneplus.security.chainlaunch.view.ChainLaunchAppListActivity",
            ),
            // vivo / iQOO
            ComponentName(
                "com.vivo.permissionmanager",
                "com.vivo.permissionmanager.activity.BgStartUpManagerActivity",
            ),
            // 三星
            ComponentName(
                "com.samsung.android.lool",
                "com.samsung.android.sm.ui.battery.BatteryActivity",
            ),
        )
        for (target in candidates) {
            val intent = Intent().apply {
                component = target
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            if (intent.resolveActivity(packageManager) == null) {
                continue
            }
            try {
                startActivity(intent)
                return true
            } catch (_: Throwable) {
                // 该厂商页存在但拒绝外部拉起：继续试下一个
            }
        }
        // 兜底：应用详情页（用户仍可从这里进后台管理）
        val details = Intent(
            Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
            Uri.fromParts("package", packageName, null),
        ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        return try {
            startActivity(details)
            true
        } catch (_: Throwable) {
            false
        }
    }

    /**
     * Android 13+ 请求通知权限：前台服务仍会运行，但没有该权限时常驻通知
     * 不会展示。保活口径要求通知可见（合规），故启用出声时一并申请。
     */
    private fun ensureNotificationPermission() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            return
        }
        // ★★R76 修复（2026-09-22 用户实测「一直提示权限问题」）：
        //   本方法挂在方法通道的 start 上 ✗，而保活服务会因为 App 重启、
        //   被系统回收后重建等原因**被反复拉起** ✓ ——
        //   于是每拉一次就申请一次权限，用户看到的就是**反复弹权限框** ✓。
        //
        //   正确行为：**只问一次** ✓。被拒了也**不要反复骚扰** ✗ ——
        //   系统本身在拒绝两次之后就当作「不再询问」✓，我们不该抢在它前面反复弹。
        //   真被拒了也不影响出声：前台服务照常运行，只是通知不可见 ✓。
        //
        // ★★R77 再修（2026-09-22 用户复测「还是有不断弹出权限配置提示」）：
        //   R76 的标记是个**实例字段** ✗ —— Activity 重建（旋转 / 被系统回收后恢复）
        //   与**进程重启**都会把它清零 ✓，于是用户每次重新打开 App 又被问一次 ✓。
        //   改成**落盘**：问过就永远不再问（用户要改可以自己去系统设置里开）✓
        if (notificationPermissionAskedEver()) {
            return
        }
        val granted = checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) ==
            PackageManager.PERMISSION_GRANTED
        if (granted) {
            return
        }
        markNotificationPermissionAsked()
        requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), NOTIFICATION_REQUEST)
    }

    /** ★R77：通知权限是否**已经问过**（跨 Activity 重建 / 进程重启都算数）✓ */
    private fun notificationPermissionAskedEver(): Boolean =
        keepAlivePrefs().getBoolean(KEY_NOTIFICATION_ASKED, false)

    private fun markNotificationPermissionAsked() {
        keepAlivePrefs().edit().putBoolean(KEY_NOTIFICATION_ASKED, true).apply()
    }

    private fun keepAlivePrefs() = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    companion object {
        private const val KEEP_ALIVE_CHANNEL = "starvoice/keep_alive"
        private const val NOTIFICATION_REQUEST = 202609
        /** ★R77：保活相关的一次性标记（目前只有「通知权限问过没有」）✓ */
        private const val PREFS_NAME = "starvoice_keep_alive_prefs"
        private const val KEY_NOTIFICATION_ASKED = "notification_permission_asked"
    }
}
