import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

/// 助播保活桥（M9 手机线）：把「AI 语音助播出声期间 App 不能被系统冻结」
/// 的诉求交给 Android 前台服务承接（原生侧 `AssistantKeepAliveService`）。
///
/// 口径：保活只解决「切后台 / 锁屏后出声是否中断」的稳定性问题，
/// 不是开播前置条件 —— 桥接失败时一律静默降级，绝不阻断出声链路。
abstract interface class KeepAliveBridge {
  /// 启用助播出声时调用：拉起前台服务并持有唤醒锁（幂等）。
  Future<void> start({String? title, String? content});

  /// 停用助播出声 / 直播结束时调用：停服并释放唤醒锁（幂等）。
  Future<void> stop();

  /// 是否已豁免电池优化：未豁免时息屏可能被冻结，用于引导弹窗判断。
  Future<bool> isIgnoringBatteryOptimizations();

  /// 拉起系统电池优化设置页，由用户自行放行（不强制、不代改系统设置）。
  Future<void> openBatteryOptimizationSettings();

  /// R62：**主动申请**电池优化豁免 —— 弹系统对话框让用户点「允许」。
  ///
  /// 与 [openBatteryOptimizationSettings] 的区别很关键：
  ///   那个是「把用户丢到设置页、让他自己找」✗；
  ///   这个是系统提供的**正规 API**，会弹明确的授权框 ✓。
  /// 竞品 xcai1618 的清单里就有 `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` ——
  /// 我们此前只做了前者，等于**连正规手段都没用满**。
  /// 返回是否已豁免（含「本来就已经豁免」）。
  Future<bool> requestIgnoreBatteryOptimizations();

  // ---------- R65：权限**查询**（对照竞品 xcai1618 的 `checkAppNotification()` 等） ----------
  // 没有这些方法，权限向导的按钮就无法在「下一步 / 马上设置」之间切换
  //（竞品的 `checkquan()` 正是靠它们决定 `quanbutton` 文案）。

  /// 通知权限是否已授予（Android 13+ 才需要；低版本恒 true）。
  Future<bool> checkNotificationPermission();

  /// 悬浮窗（显示在其他应用上层）权限是否已授予。
  Future<bool> checkOverlayPermission();

  /// 拉起悬浮窗权限设置页。
  Future<void> openOverlaySettings();

  /// 拉起本应用的通知设置页。
  Future<void> openNotificationSettings();

  /// R62：拉起**厂商的「自启动 / 受保护应用」设置页**。
  ///
  /// 为什么必须有：华为 / 小米 / OPPO / vivo 各有自己一套后台管制，
  /// **代码无法申请**，只能引导用户手动开。2026-09-21 真机实测（华为 ELS-AN10）：
  /// 前台服务照起（isForeground=true、有通知），但系统照样**强制释放 WakeLock**、
  /// 冻掉 Dart 定时器 —— 助播拉取从 1 秒掉到 8~22 秒，表现为「后台没声音」。
  ///
  /// 返回是否成功拉起（拉不起时调用方应引导用户手动去找）。
  Future<bool> openAutoStartSettings();
}

/// Android 实现：转发到原生方法通道 `starvoice/keep_alive`。
class MethodChannelKeepAliveBridge implements KeepAliveBridge {
  MethodChannelKeepAliveBridge([
    this._channel = const MethodChannel('starvoice/keep_alive'),
  ]);

  final MethodChannel _channel;

  @override
  Future<void> start({String? title, String? content}) {
    return _channel.invokeMethod<void>('start', <String, String?>{
      'title': title,
      'content': content,
    });
  }

  @override
  Future<void> stop() {
    return _channel.invokeMethod<void>('stop');
  }

  @override
  Future<bool> isIgnoringBatteryOptimizations() async {
    final granted = await _channel.invokeMethod<bool>(
      'isIgnoringBatteryOptimizations',
    );
    // 原生返回 null（能力缺失）时按「已放行」处理，避免无谓打扰用户
    return granted ?? true;
  }

  @override
  Future<void> openBatteryOptimizationSettings() async {
    await _channel.invokeMethod<bool>('openBatteryOptimizationSettings');
  }

  @override
  Future<bool> openAutoStartSettings() async {
    final opened = await _channel.invokeMethod<bool>('openAutoStartSettings');
    return opened ?? false;
  }

  @override
  Future<bool> requestIgnoreBatteryOptimizations() async {
    final granted = await _channel.invokeMethod<bool>(
      'requestIgnoreBatteryOptimizations',
    );
    return granted ?? false;
  }

  @override
  Future<bool> checkNotificationPermission() async {
    // 查询类接口：原生缺失时按「已授权」处理，避免无谓打扰用户
    final granted = await _channel.invokeMethod<bool>(
      'checkNotificationPermission',
    );
    return granted ?? true;
  }

  @override
  Future<bool> checkOverlayPermission() async {
    final granted = await _channel.invokeMethod<bool>('checkOverlayPermission');
    return granted ?? true;
  }

  @override
  Future<void> openOverlaySettings() async {
    await _channel.invokeMethod<bool>('openOverlaySettings');
  }

  @override
  Future<void> openNotificationSettings() async {
    await _channel.invokeMethod<bool>('openNotificationSettings');
  }
}

/// 空实现：非 Android 平台（桌面 / 测试）与原生通道不可用时使用。
/// 「已豁免」恒为真 —— 桌面端没有 Android 那套后台冻结，无需引导。
class NoopKeepAliveBridge implements KeepAliveBridge {
  const NoopKeepAliveBridge();

  @override
  Future<void> start({String? title, String? content}) async {}

  @override
  Future<void> stop() async {}

  @override
  Future<bool> isIgnoringBatteryOptimizations() async => true;

  @override
  Future<void> openBatteryOptimizationSettings() async {}

  @override
  Future<bool> openAutoStartSettings() async => false;

  @override
  Future<bool> requestIgnoreBatteryOptimizations() async => true;

  @override
  Future<bool> checkNotificationPermission() async => true;

  @override
  Future<bool> checkOverlayPermission() async => true;

  @override
  Future<void> openOverlaySettings() async {}

  @override
  Future<void> openNotificationSettings() async {}
}

/// 按运行平台挑选默认实现：仅 Android 走原生前台服务，其余走空实现。
KeepAliveBridge createDefaultKeepAliveBridge() {
  if (kIsWeb || defaultTargetPlatform != TargetPlatform.android) {
    return const NoopKeepAliveBridge();
  }
  return MethodChannelKeepAliveBridge();
}
