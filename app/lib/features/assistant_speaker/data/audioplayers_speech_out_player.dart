import 'dart:async';
import 'dart:typed_data';

import 'package:audioplayers/audioplayers.dart';

import 'package:starvoice_app/features/assistant_speaker/application/speech_out_player.dart';

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
  Future<void> play(Uint8List wavBytes) async {
    if (_disposed) {
      return;
    }
    final player = await _ensurePlayer();
    await player.stop();
    final completer = Completer<void>();
    _finished = completer;
    try {
      await player.play(BytesSource(wavBytes));
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
