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
}

/// 按运行平台挑选默认实现：仅 Android 走原生前台服务，其余走空实现。
KeepAliveBridge createDefaultKeepAliveBridge() {
  if (kIsWeb || defaultTargetPlatform != TargetPlatform.android) {
    return const NoopKeepAliveBridge();
  }
  return MethodChannelKeepAliveBridge();
}
