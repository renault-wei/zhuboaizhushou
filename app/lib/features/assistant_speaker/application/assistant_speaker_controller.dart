import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'package:starvoice_app/core/models/live.dart';
import 'package:starvoice_app/core/network/api_client.dart';
import 'package:starvoice_app/core/network/api_exception.dart';
import 'package:starvoice_app/core/platform/keep_alive_bridge.dart';

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
///
/// 同时联动「保活」（M9 手机线）：启用出声时拉起 Android 前台服务，
/// 停用时释放，避免切后台 / 锁屏后轮询与放音被系统冻结；保活失败静默降级，
/// 不影响前台正常播报。
class AssistantSpeakerController extends StateNotifier<AssistantSpeakerState> {
  AssistantSpeakerController(
    this._api,
    this._player, [
    this._pollInterval = const Duration(milliseconds: 1000),
    KeepAliveBridge? keepAlive,
  ]) : _keepAlive = keepAlive ?? const NoopKeepAliveBridge(),
       super(AssistantSpeakerState.idle());

  final ApiClient _api;
  final SpeechOutPlayer _player;
  final Duration _pollInterval;
  final KeepAliveBridge _keepAlive;

  Timer? _timer;

  /// R53：核对本场是否还在直播；不在（或已不存在）就停掉出声。
  ///
  /// 与监控页 R50 的「场次被删后给出口」是**同一类病灶**：该停的时候要停。
  /// 区别在于助播机可能**根本没有页面在看着**，所以必须自己发现问题。
  Future<void> _checkLiveStillRunning() async {
    final liveId = _liveId;
    if (liveId == null) {
      return;
    }
    try {
      final live = await _api.getLive(liveId);
      if (live.status != LiveStatus.live) {
        _stopBecauseLiveEnded('本场已不在直播中，已自动停止出声');
      }
    } on ApiException catch (error) {
      if (error.code == 'LIVE_NOT_FOUND' || error.statusCode == 404) {
        _stopBecauseLiveEnded('这场直播已不存在（可能已被删除），已自动停止出声');
      }
      // 其它错误（网络抖动 / 服务端临时不可用）不在这里处理：
      // 交给正常轮询的错误分支，避免一次抖动就把出声停掉。
    }
  }

  /// 停表并留下原因（stop() 会把状态清成 idle，所以原因要在它之后写）
  void _stopBecauseLiveEnded(String reason) {
    if (_disposed || !state.enabled) {
      return;
    }
    stop();
    state = state.copyWith(
      status: AssistantSpeakerStatus.error,
      lastError: reason,
    );
  }

  /// 防止上一轮 poll 未结束时下一轮重入（播放中不重复拉取）。
  bool _busy = false;

  /// R53：本次出声服务于哪一场。
  ///
  /// 为什么必须带上：不带 liveId 时服务端只能走「全局队列」，**无法告诉助播机
  /// 「这场已经没了」** —— 于是场次被删后助播机会无限空转（2026-09-21 实测：
  /// 两条已删场次被持续拉取，只有重启 App 才停）。带上之后，服务端能回 404/409。
  String? _liveId;

  /// R53：每 N 次轮询核对一次「本场还在播吗」。
  ///
  /// 为什么必要：助播机是**独立于监控页**在跑的（页面关掉它还在拉）。
  /// 场次被删 / 结束后它不会自己知道，就会对着一个不存在的场次无限空转
  /// （2026-09-21 实测：两条已删场次被持续拉取，只有重启 App 才停）。
  /// 15 秒一次足够及时，也不会给服务端添多少负担。
  static const int _liveCheckEveryNPolls = 15;
  int _pollsSinceLiveCheck = 0;

  /// dispose 后不再触碰 state：在途轮询回来时直接返回（stop/dispose 竞态兜底）。
  bool _disposed = false;

  /// 启用出声：置 listening 态并启动轮询；先立即拉一次，不必等首个周期。
  void start({String? liveId}) {
    if (_disposed || state.enabled) {
      return;
    }
    _liveId = liveId;
    state = AssistantSpeakerState(
      enabled: true,
      status: AssistantSpeakerStatus.waiting,
      playedCount: state.playedCount,
    );
    _timer = Timer.periodic(_pollInterval, (_) => unawaited(pollOnce()));
    unawaited(_syncKeepAlive(true));
    unawaited(pollOnce());
  }

  /// 停用出声：停表、打断播放并回到 idle（幂等，页面收尾 / 直播结束时调用）。
  void stop() {
    if (_disposed) {
      return;
    }
    if (!state.enabled && state.status == AssistantSpeakerStatus.idle) {
      return;
    }
    _timer?.cancel();
    _timer = null;
    _liveId = null;
    state = AssistantSpeakerState.idle();
    unawaited(_player.stop());
    unawaited(_syncKeepAlive(false));
  }

  /// 保活联动：启用出声时拉起前台服务，停用时释放。
  /// 失败只吞掉 —— 保活最多决定「切后台会不会被冻结」，不应影响前台出声。
  Future<void> _syncKeepAlive(bool enabled) async {
    try {
      if (enabled) {
        await _keepAlive.start(
          title: 'AI 语音助播运行中',
          content: '正在轮询播报队列并出声，请勿清理后台',
        );
      } else {
        await _keepAlive.stop();
      }
    } catch (_) {
      // 原生桥不可用（非 Android / 通道缺失）时静默降级
    }
  }

  /// 执行一轮「拉取 → 播放」：空队列等待、有播报则串行播完再等下一条。
  /// 供定时器逐周期调用，也便于测试直接驱动单轮。
  Future<void> pollOnce() async {
    if (_disposed || !state.enabled || _busy) {
      return;
    }
    _busy = true;
    try {
      // R53：周期性核对场次是否还在播 —— 不在就停，别空转
      _pollsSinceLiveCheck += 1;
      if (_pollsSinceLiveCheck >= _liveCheckEveryNPolls) {
        _pollsSinceLiveCheck = 0;
        await _checkLiveStillRunning();
        if (_disposed || !state.enabled) {
          return;
        }
      }
      final item = await _api.fetchNextOutSpeech(liveId: _liveId);
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
      // ★R53：场次不存在 / 已不在播 = **终态**，必须停下来、不能无限重试。
      // 这正是 R50 在监控页修过的同一类病灶，只是发生在助播机组件里。
      if (error.code == 'LIVE_NOT_FOUND' || error.code == 'LIVE_NOT_LIVE') {
        stop();
        state = state.copyWith(
          status: AssistantSpeakerStatus.error,
          lastError: error.message,
        );
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
    // 先停表收口再置位：stop 依赖 _disposed 守卫兜底迟到的停用调用，
    // 若先置位会导致 stop 直接返回而遗留轮询定时器。
    stop();
    _disposed = true;
    unawaited(_player.dispose());
    super.dispose();
  }
}
