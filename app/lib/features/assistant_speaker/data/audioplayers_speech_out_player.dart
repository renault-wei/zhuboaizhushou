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
/// 这里改成 `AndroidAudioFocus.none`（**不申请焦点**）→ 各放各的。
///
/// ⚠️ 2026-09-22 真机实测的教训：**不要再改 usage / contentType** ✗
///   我曾把 contentType 改成 `speech`、usageType 改成 `assistant`（理由是「系统会按
///   助手说话来路由」）—— 结果真机上 `dumpsys media.audio_flinger` 显示我们的音轨是
///     `G db = -inf`（**增益为零，完全静音**），用户听到的就是「声音阻塞」✗。
///   症状极具迷惑性：播放**没有报错**、队列也在正常进出，只是**没有声音** ✗。
///   已改回系统默认（music / media）。要动这两个字段，必须先在真机上
///   核对 `G db` 不是 `-inf` 再合入。
AudioContext buildParallelAudioContext() {
  return AudioContext(
    android: const AudioContextAndroid(
      isSpeakerphoneOn: false,
      audioMode: AndroidAudioMode.normal,
      stayAwake: true,
      // 保持内容/用途为系统默认（music / media）—— 见上方 2026-09-22 的实测教训：
      // 改成 speech / assistant 会让音轨增益变成 -inf（静音），用户只听到「没声音」✗
      audioFocus: AndroidAudioFocus.none,
    ),
  );
}

/// 从 WAV 头算真实时长（R62）。
///
/// 为什么要算：看门狗的超时如果拍脑袋定，就会**切掉真的还在播的音频**。
/// WAV 头里有 byteRate，直接除一下就是准确时长，零成本。
/// 头不规范 → 返回 null，调用方回落到默认上限。
Duration? _wavDuration(Uint8List bytes) {
  if (bytes.length < 44) {
    return null;
  }
  final data = ByteData.sublistView(bytes);
  // 'RIFF' .... 'WAVE'
  if (bytes[0] != 0x52 || bytes[1] != 0x49 || bytes[8] != 0x57) {
    return null;
  }
  final byteRate = data.getUint32(28, Endian.little);
  if (byteRate <= 0) {
    return null;
  }
  // 已经是整段 wav（服务端产物），data 块长度 = 总长 - 44
  final dataSize = bytes.length - 44;
  final seconds = dataSize / byteRate;
  if (seconds <= 0 || seconds > 600) {
    return null;
  }
  return Duration(milliseconds: (seconds * 1000).round());
}

/// audioplayers 实现：把远程队列交付的 wav 字节播到本机音频输出。
///
/// R62 起带**播放看门狗**（对照竞品 xcai1618 的 `resetBgAudioAndPlayNext` +
/// `bgAudioGeneration` + `bgAudioPlayRetryTimer`）：
///
///   为什么必须有：后台音频被系统重置时，`player.play()` 可能**永远不返回** ✗。
///   我们的播放循环是 `await` 它的 —— 一旦卡住，后面拉进来的音频全堆在缓冲里，
///   就是用户实测到的「**首次播放队列挤压**」✗。
///
///   三段式（与竞品一一对应）：
///     ① **超时**：按 WAV 头算出真实时长，再加余量；到点就当这条结束了；
///     ② **代际计数**：每次播放自增，旧的在途回调一看代际不对就闭嘴，
///        不会污染新播放器；
///     ③ **连续失败重建**：连着失败 N 次就把播放器销毁重建。
class AudioplayersSpeechOutPlayer implements SpeechOutPlayer {
  /// [playTimeoutMargin] 可注入：生产用默认余量，测试注入极短值以便快速验证看门狗。
  // 用**位置可选**参数而非具名：Dart 不允许私有具名参数，
  // 而位置形参可以直接用初始化形参 `this._x`（也就没有 prefer_initializing_formals 提示）。
  AudioplayersSpeechOutPlayer([this._playTimeoutMargin = _playTimeoutMarginDefault]);

  AudioPlayer? _player;
  StreamSubscription<PlayerState>? _stateSub;
  Completer<void>? _finished;
  bool _disposed = false;

  /// ★R73：播放结束事件流 —— 每次播放**恰好发一次**
  /// （正常播完 / 看门狗超时 / 播放失败 / 被打断 都发 ✓）。
  /// 这是「推」的那一半：上层据此推进下一条，**不再 await 一个 future** ✓
  final StreamController<void> _completeController =
      StreamController<void>.broadcast();

  /// 已发过事件的代际（防同一次播放重发）
  int _emittedGeneration = -1;

  @override
  Stream<void> get onComplete => _completeController.stream;

  /// 代际计数：串行化「播放 / 停止 / 重建」，让在途回调失效（对照竞品 `bgAudioGeneration`）。
  int _generation = 0;

  /// 连续失败次数：达到阈值就重建播放器（对照竞品 `resetBgAudio`）。
  int _consecutiveFailures = 0;

  /// 音频头不规范时的兜底上限。
  static const Duration _fallbackPlayTimeout = Duration(seconds: 60);

  /// 超时余量：给平台通道与解码留点时间，别把正常播放判成卡死。
  static const Duration _playTimeoutMarginDefault = Duration(seconds: 8);

  final Duration _playTimeoutMargin;

  static const int _recreateAfterFailures = 3;

  Future<AudioPlayer> _ensurePlayer() async {
    final existing = _player;
    if (existing != null) {
      return existing;
    }
    final player = AudioPlayer();
    // R58：**并行出声** —— 两个播放器（助播 + 试听）都走这里，一处设置全覆盖。
    await player.setAudioContext(buildParallelAudioContext());
    _player = player;
    // ★★R75 修复（2026-09-22 真机实测「音频被截断、没读完就播下一条」）：
    //
    // 这里原先写的是 `if (state != PlayerState.playing)` ✗ ——
    // 「任何非 playing」都被当成「本条播完了」✓。
    //
    // 而 `_playSource` 的第一件事是 `await player.stop()`（换源前先停旧的 ✓），
    // 于是每次播放的真实时序是：
    //     stop()   → 状态变 stopped → 【立刻发一次 onComplete】✗（这时还没开始播）
    //                             → 同时把代际占掉 ✗
     //     play()   → playing …… completed → 真正的完成事件被代际守卫吞掉 ✗
    // 净效果：上层在音频**刚开始播**的瞬间就被告知「播完了」✗ → 立刻切下一条 ✓
    //
    // 这也解释了更早之前用户报的「几句语音一起播」——
    // await 版的播放同样会因为这个假完成而提前返回，而去播下一条 ✗
    //
    // 正确做法：**只认 completed** ✓
    //   其余情况（解码失败 / 播放器被重置 / 平台不回调）交给下面两个兜底：
    //     · 看门狗超时（本文件末尾的 Timer）✓
    //     · 显式 stop()（_completeFinished 由 stop 路径调用）✓
    _stateSub = player.onPlayerStateChanged.listen((state) {
      if (state == PlayerState.completed) {
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
    // ★R73：同时把「本条结束」推给上层 ✓
    // 不重不漏：同一次播放代际只发一次（否则上层会重复推进 ✗）
    if (_emittedGeneration != _generation) {
      _emittedGeneration = _generation;
      if (!_completeController.isClosed) {
        _completeController.add(null);
      }
    }
  }

  /// 丢弃当前播放器并重建（竞品 `resetBgAudio` 的对应物）。
  Future<void> _recyclePlayer() async {
    _generation += 1;
    _completeFinished();
    await _stateSub?.cancel();
    _stateSub = null;
    final player = _player;
    _player = null;
    if (player != null) {
      try {
        await player.dispose();
      } catch (_) {
        // 播放器已经坏了才会走到这里，dispose 抛错无需处理
      }
    }
  }

  @override
  Future<void> play(Uint8List wavBytes) => _playSource(BytesSource(wavBytes), wavBytes);

  @override
  Future<void> playUrl(String url) => _playSource(UrlSource(url), null);

  Future<void> _playSource(Source source, Uint8List? wavBytes) async {
    if (_disposed) {
      return;
    }
    _generation += 1;
    final generation = _generation;
    final player = await _ensurePlayer();
    if (_disposed || generation != _generation) {
      return;
    }
    await player.stop();
    final completer = Completer<void>();
    _finished = completer;
    // ① 超时：按 WAV 头算真实时长 + 余量。到点强制放行 ——
    //    宁可当这条播完了，也不能让整条链路卡死在它身上。
    final limit =
        (wavBytes == null ? null : _wavDuration(wavBytes)) ?? _fallbackPlayTimeout;
    final timeout = Timer(limit + _playTimeoutMargin, () {
      if (generation == _generation) {
        _consecutiveFailures += 1;
      }
      _completeFinished();
    });
    try {
      await player.play(source);
      await completer.future;
    } catch (_) {
      // 播放失败：当作这条结束，交给调用方继续下一条（不整体停）
      if (generation == _generation) {
        _consecutiveFailures += 1;
      }
      _completeFinished();
    } finally {
      timeout.cancel();
      if (identical(_finished, completer)) {
        _finished = null;
      }
    }
    // ② 代际：只有仍然是最新一代才有资格做善后
    if (_disposed || generation != _generation) {
      return;
    }
    // ③ 连续失败重建：播放器八成已经坏了，扔掉重来
    if (_consecutiveFailures >= _recreateAfterFailures) {
      _consecutiveFailures = 0;
      await _recyclePlayer();
      return;
    }
    _consecutiveFailures = 0;
  }

  @override
  Future<void> stop() async {
    _generation += 1;
    _completeFinished();
    final player = _player;
    if (player != null) {
      try {
        await player.stop();
      } catch (_) {
        // 已释放等情况忽略
      }
    }
  }

  @override
  Future<void> dispose() async {
    _disposed = true;
    _generation += 1;
    _completeFinished();
    await _stateSub?.cancel();
    _stateSub = null;
    final player = _player;
    _player = null;
    if (player != null) {
      try {
        await player.dispose();
      } catch (_) {
        // 同上
      }
    }
  }
}
