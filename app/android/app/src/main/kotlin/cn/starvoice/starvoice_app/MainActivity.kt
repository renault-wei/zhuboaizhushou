package cn.starvoice.starvoice_app

import android.Manifest
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
