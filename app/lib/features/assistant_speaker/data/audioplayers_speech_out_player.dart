import 'dart:async';
import 'dart:typed_data';

import 'package:audioplayers/audioplayers.dart';

import 'package:starvoice_app/features/assistant_speaker/application/speech_out_player.dart';

/// R58：**并行出声**的音频上下文 —— 与手机上其它音频共存，而不是把别人顶掉。
///
/// 为什么必须显式设置：`audioplayers` 的默认值是 `AndroidAudioFocus.gain`，
/// 而包里对它的定义写得很清楚 ——
///   「AUDIOFOCUS_GAIN expresses the fact that your application is now
///     **the sole source of audio** that the user is listening to.」
/// 也就是**独占**。后果：助播机一开口，手机 / 车机上正在放的音乐、导航、
/// 短视频**全被暂停**（2026-09-21 用户提出「声音应该可以并行」）。
///
/// 这里改成 [`AndroidAudioFocus.none`]（**不申请焦点**）→ 各放各的。
/// 同时把 usage / content 改成 assistant / speech：系统会把 AI 语音按
/// 「助手在说话」而不是「在放音乐」来路由与处理。
///
/// 注意：iOS 侧沿用包默认值（本项目实际只发安卓），未做听感验证前不动它。
AudioContext buildParallelAudioContext() {
  return AudioContext(
    android: const AudioContextAndroid(
      // 不接管扬声器开关，交给系统按当前路由决定
      isSpeakerphoneOn: false,
      audioMode: AndroidAudioMode.normal,
      // 播放期间自己拿一把 WakeLock（需 WAKE_LOCK 权限，清单里已有）。
      // 保活服务另有一把，这里只是不让「保活被关掉」时声音断续。
      stayAwake: true,
      contentType: AndroidContentType.speech,
      usageType: AndroidUsageType.assistant,
      // ★ 关键：不申请音频焦点 —— 这就是「并行」
      audioFocus: AndroidAudioFocus.none,
    ),
  );
}

/// audioplayers 实现：把远程队列交付的 wav 字节播到本机音频输出。
/// 播放器懒创建（首次 play 才碰平台通道），便于单元 / Widget 测试注入假实现；
/// 用「完成事件一次订阅 + 每次 play 一个 Completer」实现整段播完才返回。
class AudioplayersSpeechOutPlayer implements SpeechOutPlayer {
  AudioPlayer? _player;
  StreamSubscription<PlayerState>? _stateSub;
  Completer<void>? _finished;
  bool _disposed = false;

  Future<AudioPlayer> _ensurePlayer() async {
    final existing = _player;
    if (existing != null) {
      return existing;
    }
    final player = AudioPlayer();
    // R58：**并行出声** —— 两个播放器（助播 + 试听）都走这里，一处设置全覆盖。
    // 不设的话就是 audioplayers 默认的「独占焦点」，会把手机上的音乐/导航顶停。
    await player.setAudioContext(buildParallelAudioContext());
    _player = player;
    // 播完 / 被打断均回到 stopped 态：任何一次状态到非播放中即放行 await。
    _stateSub = player.onPlayerStateChanged.listen((state) {
      if (state != PlayerState.playing) {
        _completeFinished();
      }
    });
    return player;
  }

  void _completeFinished() {
    final completer = _finished;
    if (completer != null && !completer.isCompleted) {
      completer.complete();
    }
  }

  @override
  Future<void> play(Uint8List wavBytes) => _playSource(BytesSource(wavBytes));

  @override
  Future<void> playUrl(String url) => _playSource(UrlSource(url));

  /// 播一段音频（字节 / URL 共用同一条等待语义）：整段播完或被 stop 打断后才返回。
  Future<void> _playSource(Source source) async {
    if (_disposed) {
      return;
    }
    final player = await _ensurePlayer();
    await player.stop();
    final completer = Completer<void>();
    _finished = completer;
    try {
      await player.play(source);
      // 等整段播完（或 stop 打断触发状态回调）再返回
      await completer.future;
    } finally {
      if (identical(_finished, completer)) {
        _finished = null;
      }
    }
  }

  @override
  Future<void> stop() async {
    _completeFinished();
    final player = _player;
    if (player != null) {
      await player.stop();
    }
  }

  @override
  Future<void> dispose() async {
    _disposed = true;
    _completeFinished();
    await _stateSub?.cancel();
    _stateSub = null;
    final player = _player;
    _player = null;
    if (player != null) {
      await player.dispose();
    }
  }
}
