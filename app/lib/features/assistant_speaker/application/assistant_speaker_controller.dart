import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'package:starvoice_app/core/network/api_client.dart';
import 'package:starvoice_app/core/network/api_exception.dart';

import 'speech_out_player.dart';

/// 助播机出声端状态（P1 手机线）：
/// idle = 未启用；waiting = 监听中，等待下一条播报；
/// playing = 正在播报；error = 最近一次拉取 / 播放失败（自动重试中）。
enum AssistantSpeakerStatus { idle, waiting, playing, error }

/// 助播机出声端状态快照：开关 + 运行态 + 最近错误 + 累计播报条数。
@immutable
class AssistantSpeakerState {
  const AssistantSpeakerState({
    required this.enabled,
    required this.status,
    required this.playedCount,
    this.lastError,
  });

  /// 未启用：页面初始 / 停用后的兜底态。
  factory AssistantSpeakerState.idle() {
    return const AssistantSpeakerState(
      enabled: false,
      status: AssistantSpeakerStatus.idle,
      playedCount: 0,
    );
  }

  final bool enabled;
  final AssistantSpeakerStatus status;
  final int playedCount;

  /// 最近一次失败的中文提示（成功轮询后清空）。
  final String? lastError;

  /// 未提供时保持原值；显式传 null 可清空 [lastError]（成功轮询后复位）。
  AssistantSpeakerState copyWith({
    bool? enabled,
    AssistantSpeakerStatus? status,
    int? playedCount,
    Object? lastError = _unset,
  }) {
    return AssistantSpeakerState(
      enabled: enabled ?? this.enabled,
      status: status ?? this.status,
      playedCount: playedCount ?? this.playedCount,
      lastError: identical(lastError, _unset)
          ? this.lastError
          : lastError as String?,
    );
  }

  static const Object _unset = Object();
}

/// 助播机出声控制器：启用后周期轮询远程出声队列（GET /api/out/speech/next），
/// 取到 wav 就交给本机播放器出声（一条播完再取下一条，天然串行）。
/// 队列拉空（204）即回到「监听中」；失败不清除队列（交付即删、无重试），
/// 只记录错误并等下一个轮询周期自愈。停用 = 停表 + 打断播放 + 回到 idle。
class AssistantSpeakerController extends StateNotifier<AssistantSpeakerState> {
  AssistantSpeakerController(
    this._api,
    this._player, [
    this._pollInterval = const Duration(milliseconds: 1000),
  ]) : super(AssistantSpeakerState.idle());

  final ApiClient _api;
  final SpeechOutPlayer _player;
  final Duration _pollInterval;

  Timer? _timer;

  /// 防止上一轮 poll 未结束时下一轮重入（播放中不重复拉取）。
  bool _busy = false;

  /// dispose 后不再触碰 state：在途轮询回来时直接返回（stop/dispose 竞态兜底）。
  bool _disposed = false;

  /// 启用出声：置 listening 态并启动轮询；先立即拉一次，不必等首个周期。
  void start() {
    if (_disposed || state.enabled) {
      return;
    }
    state = AssistantSpeakerState(
      enabled: true,
      status: AssistantSpeakerStatus.waiting,
      playedCount: state.playedCount,
    );
    _timer = Timer.periodic(_pollInterval, (_) => unawaited(pollOnce()));
    unawaited(pollOnce());
  }

  /// 停用出声：停表、打断播放并回到 idle（幂等，页面收尾 / 直播结束时调用）。
  void stop() {
    if (!state.enabled && state.status == AssistantSpeakerStatus.idle) {
      return;
    }
    _timer?.cancel();
    _timer = null;
    state = AssistantSpeakerState.idle();
    unawaited(_player.stop());
  }

  /// 执行一轮「拉取 → 播放」：空队列等待、有播报则串行播完再等下一条。
  /// 供定时器逐周期调用，也便于测试直接驱动单轮。
  Future<void> pollOnce() async {
    if (_disposed || !state.enabled || _busy) {
      return;
    }
    _busy = true;
    try {
      final item = await _api.fetchNextOutSpeech();
      if (_disposed || !state.enabled) {
        return;
      }
      if (item == null) {
        // 队列为空：保持监听，等待下一条播报
        state = state.copyWith(
          status: AssistantSpeakerStatus.waiting,
          lastError: null,
        );
        return;
      }
      state = state.copyWith(status: AssistantSpeakerStatus.playing);
      await _player.play(item.wavBytes);
      if (_disposed || !state.enabled) {
        return;
      }
      state = state.copyWith(
        status: AssistantSpeakerStatus.waiting,
        playedCount: state.playedCount + 1,
        lastError: null,
      );
    } on ApiException catch (error) {
      if (_disposed || !state.enabled) {
        return;
      }
      state = state.copyWith(
        status: AssistantSpeakerStatus.error,
        lastError: error.message,
      );
    } catch (_) {
      if (_disposed || !state.enabled) {
        return;
      }
      state = state.copyWith(
        status: AssistantSpeakerStatus.error,
        lastError: '本机播放失败，请检查出声设备后重试',
      );
    } finally {
      _busy = false;
    }
  }

  @override
  void dispose() {
    if (_disposed) {
      return;
    }
    _disposed = true;
    stop();
    unawaited(_player.dispose());
    super.dispose();
  }
}
