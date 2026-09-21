package cn.starvoice.starvoice_app

import android.app.Activity
import android.os.Bundle
import android.view.WindowManager

/**
 * 1 像素透明 Activity（R62，对照竞品 xcai1618 的 `com.gyf.cactus.pix.OnePixActivity`）。
 *
 * 作用：Android 会把「有可见 Activity 的进程」放在更高的优先级桶里，
 * 从而**更不容易被系统冻结**。做成 1 像素 + 全透明，是为了**用户完全看不见** ✓
 * （不是藏起来骗人 —— 前台服务的常驻通知照常显示，用户始终知道 AI 在替他播）。
 *
 * 边界：Android 对后台启动 Activity 有严格限制，所以这个 Activity **只在
 * 保活服务运行期间由服务自己拉起**（属于前台服务可见的场景），不做静默自启 ✗。
 */
class OnePixelActivity : Activity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // 1×1 大小移到屏幕外角落、全透明、不吃焦点
        window.setLayout(1, 1)
        window.setGravity(android.view.Gravity.TOP or android.view.Gravity.START)
        window.addFlags(WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE)
        window.addFlags(WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE)
        // 不显示在最近任务里
    }

    override fun onResume() {
        super.onResume()
        // 不驻留：完成「让进程进可见桶」的使命后立刻退出，避免占资源
        finish()
    }
}
