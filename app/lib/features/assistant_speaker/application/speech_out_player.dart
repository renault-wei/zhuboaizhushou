import 'dart:async';
import 'dart:typed_data';

/// 出声播放抽象（P1 手机线·助播机出声端）：把一段 wav 播到本机音频输出。
/// 实现约定：play 在整段播完（或被 stop 打断）后才返回，供上层串行播报；
/// 手机线场景下本机出声经音频转接线进入开播手机。
abstract interface class SpeechOutPlayer {
  /// 播放一段 wav 字节，正常播完或被 [stop] 打断后返回。
  Future<void> play(Uint8List wavBytes);

  /// 播放一个音频 URL（试听方案 A：服务端预生成的静态 wav 直连播放）。
  /// 语义同 [play]：整段播完（或被 [stop] 打断）后才返回。
  Future<void> playUrl(String url);

  /// ★★R73：**播放结束事件流**（推 ✓，而非 await 拉 ✗）。
  ///
  /// 为什么加它（2026-09-22 架构定案，对照竞品反编译包）：
  ///   竞品驱动「播下一条」靠的是 `bgAudio.onEnded(...)` —— **原生主动通知** ✓；
  ///   而我们一直是 `await play()`，即 **Dart 侧必须等一个 future resolve** ✗。
  ///   今晚连续 5 个 bug（双驱动 / 空转 / 互斥漏放闸 / 磁盘挂起 / …）
  ///   形状完全一样：**那个 future 因为任何原因不 resolve，整条链路就停摆** ✓
  ///
  ///   改成事件驱动后，Dart 侧不再有「必须 resolve 的 future」✓ ——
  ///   这一类问题**从结构上消失**，而不是再打一个补丁 ✓
  ///
  /// 约定：
  ///   · **正常播完** → 发一次 ✓
  ///   · **被 [stop] 打断 / 播放失败 / 看门狗超时** → 也要发一次 ✓
  ///     （否则链条会停在「永远等不到事件」上 ✗ —— 那正是要消灭的形状）
  ///   · 每次播放**恰好发一次**，不重不漏 ✓
  Stream<void> get onComplete;

  /// 打断当前播放（幂等）：播报切走 / 停用时兜底调用。
  Future<void> stop();

  /// 释放底层播放资源（App 生命周期收尾用）。
  Future<void> dispose();
}
