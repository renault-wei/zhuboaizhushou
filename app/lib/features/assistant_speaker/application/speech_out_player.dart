import 'dart:typed_data';

/// 出声播放抽象（P1 手机线·助播机出声端）：把一段 wav 播到本机音频输出。
/// 实现约定：play 在整段播完（或被 stop 打断）后才返回，供上层串行播报；
/// 手机线场景下本机出声经音频转接线进入开播手机。
abstract interface class SpeechOutPlayer {
  /// 播放一段 wav 字节，正常播完或被 [stop] 打断后返回。
  Future<void> play(Uint8List wavBytes);

  /// 打断当前播放（幂等）：播报切走 / 停用时兜底调用。
  Future<void> stop();

  /// 释放底层播放资源（App 生命周期收尾用）。
  Future<void> dispose();
}
