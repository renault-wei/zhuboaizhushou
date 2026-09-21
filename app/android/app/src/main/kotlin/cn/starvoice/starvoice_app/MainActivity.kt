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
        val granted = checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) ==
            PackageManager.PERMISSION_GRANTED
        if (!granted) {
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), NOTIFICATION_REQUEST)
        }
    }

    companion object {
        private const val KEEP_ALIVE_CHANNEL = "starvoice/keep_alive"
        private const val NOTIFICATION_REQUEST = 202609
    }
}
