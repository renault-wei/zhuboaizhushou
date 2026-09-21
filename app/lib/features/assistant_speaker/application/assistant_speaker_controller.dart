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

  /// R61：本地缓冲上限（条）—— 与清单接口的单次上限 10 一致。
  static const int _bufferMaxItems = 10;

  /// 播放循环空闲时等的信号：**可被唤醒**，而不是死等一个 Future.delayed。
  ///
  /// 为什么要这样：`future.delayed` 在停用/dispose 后仍会悬挂着，
  /// 测试收尾会报 `timersPending`，真机上也是白占一个定时器。
  /// 换成 Completer 之后，停用/销毁能立刻把循环叫醒退出。
  Completer<void>? _idleGate;

  /// R61：**本地缓冲**（待播 wav，按服务端入队顺序）。
  ///
  /// 为什么放内存而不是磁盘：规格 §11.2 已经明确「进程崩溃丢缓冲可接受」——
  /// 那内存就完全够用，还省掉一整套文件生命周期管理。
  final List<Uint8List> _buffer = <Uint8List>[];

  /// 播放循环是否已在跑（同一时刻只允许一个）
  bool _playLoopRunning = false;

  /// ★R63：**播放互斥** —— 同一时刻只允许一条音频在播。
  ///
  /// 为什么必须有（2026-09-22 用户实测「直播间打开时部分语音一起播放」）：
  /// `_playOneFromBuffer()` 有**两个调用方** —— 每秒的定时器 tick（`pollOnce`）
  /// 与播放循环。两者互不知情，于是每秒都去 `player.play(...)`，
  /// **前一句还没播完就被切掉重放**，听上去就是几句叠在一起 ✗。
  /// 加了这道闸之后：谁先取到谁播，另一个直接跳过，等下一轮。
  bool _playing = false;

  // R63 记录一次**抄歪了**的尝试（写给未来的我）：
  //   竞品的 `firstaudio` 语义是「第一条【直接播】，不走排队/垫音逻辑」。
  //   但它那套队列里有「垫音」分支，所以首播确实需要特判绕开；
  //   而**我们本来就是直接播**（填完缓冲立刻播），没有需要绕开的东西。
  //   我一度把它实现成「首播只保留最新一条、其余丢掉」——那是**丢好音频** ✗，
  //   与 R61 的批量缓冲设计冲突，被 R61/R63 两条测试当场抓住。已撤销。
  //   真正需要治的「陈旧积压」放在**服务端**（MAX_REMOTE_SPEECH_AGE_MS，>20s 直接丢），
  //   那才是对症的位置：一句台词该不该播，取决于它多久以前说的 ✗ 排第几位。

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
    // R61：两个循环各司其职 ——
    //   ① 定时器只负责**把缓冲填满**（一次问清单、批量下载）；
    //   ② 播放循环自己从缓冲里取，**不等定时器**。
    // 这样即使 App 切后台、定时器被系统限流到十几秒一次，
    // 已经缓冲好的音频仍能连续播出去（原先拉和播是同一个循环，一起被拖慢）。
    _timer = Timer.periodic(_pollInterval, (_) => unawaited(pollOnce()));
    unawaited(_syncKeepAlive(true));
    unawaited(pollOnce());
    unawaited(_playLoop());
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
    // R61：缓冲一起清掉 —— 停用还继续播旧音频会更奇怪（播放循环靠 enabled 退出）
    _buffer.clear();
    _wakeIdle();
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

  ///
  /// R61：把本地缓冲尽量填满 —— 一次问清单，再按清单逐条下载。
  ///
  /// 为什么是「问清单 + 逐条下载」而不是「直接拉 N 条」：
  /// 下载走的是 `/next`（服务端**原子取出**），所以清单只是「有几条」的快照，
  /// 两条 App 同时拉也不会重复播。
  Future<void> _fillBuffer() async {
    if (_buffer.length >= _bufferMaxItems) {
      return;
    }
    final pending = await _api.fetchPendingOutSpeech(liveId: _liveId);
    if (pending.isEmpty) {
      state = state.copyWith(
        status: AssistantSpeakerStatus.waiting,
        lastError: null,
      );
      return;
    }
    var fetched = 0;
    while (_buffer.length < _bufferMaxItems && fetched < pending.length) {
      final item = await _api.fetchNextOutSpeech(liveId: _liveId);
      if (item == null) {
        // 清单说还有，但已被别的取走 —— 本次到此为止
        break;
      }
      _buffer.add(item.wavBytes);
      fetched += 1;
    }
    // 有货了 → 把可能正在空闲等待的播放循环叫醒，别让它白等
    _wakeIdle();
    if (_disposed || !state.enabled) {
      return;
    }
    state = state.copyWith(status: AssistantSpeakerStatus.waiting, lastError: null);
  }

  ///
  /// 等待「有新音频」或「被叫醒停用」—— 见 [_idleGate] 的注释。
  Future<void> _waitIdle() async {
    final gate = Completer<void>();
    _idleGate = gate;
    await gate.future;
    if (identical(_idleGate, gate)) {
      _idleGate = null;
    }
  }

  /// 叫醒空闲中的播放循环（停用 / dispose / 有新音频时都该调）
  void _wakeIdle() {
    final gate = _idleGate;
    if (gate != null && !gate.isCompleted) {
      gate.complete();
    }
  }

  /// 从缓冲取一条播出去；缓冲空返回 false。
  ///
  /// 播放循环与每轮 tick（[pollOnce]）共用它 —— 只有一个出入口，
  /// 而 `removeAt(0)` 是同步的，两边同时进来也不会重复播同一条。
  Future<bool> _playOneFromBuffer() async {
    // ★R63：在途互斥 —— 有音频正在播就什么都不做。
    // 少了这一句，定时器 tick 与播放循环会互相抢播放器，把前一句切碎重放。
    if (_playing || _buffer.isEmpty) {
      return false;
    }
    _playing = true;
    final bytes = _buffer.removeAt(0);
    state = state.copyWith(status: AssistantSpeakerStatus.playing);
    try {
      await _player.play(bytes);
    } catch (_) {
      // 单条播放失败（文件损坏等）不该整体停：丢掉它继续下一条
    } finally {
      // ★R63：任何路径都要放闸 —— 漏了这一步会永久卡死后续播放
      _playing = false;
    }
    if (_disposed || !state.enabled) {
      return true;
    }
    state = state.copyWith(
      status: AssistantSpeakerStatus.waiting,
      playedCount: state.playedCount + 1,
      lastError: null,
    );
    _playing = false;
    return true;
  }

  ///
  /// R61：**播放循环** —— 自己从本地缓冲取，不等定时器。
  ///
  /// 关键：一条 wav 的播放时长由音频本身决定（几秒），循环的节奏因此是「音频速度」而不是
  /// 「定时器速度」。哪怕 App 在后台、定时器被限流到十几秒一次，只要缓冲里有货就照播。
  Future<void> _playLoop() async {
    if (_playLoopRunning) {
      return;
    }
    _playLoopRunning = true;
    try {
      while (!_disposed && state.enabled) {
        if (_buffer.isEmpty) {
          await _waitIdle();
          continue;
        }
        await _playOneFromBuffer();
      }
    } finally {
      _playLoopRunning = false;
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
      // R61：这一轮负责**填满缓冲**，并顺手播一条。
      //
      // 注意与旧实现的区别：旧的是「拉一条 → 播一条 → 再拉」，**拉被限流时播放一起被拖慢**；
      // 现在是「一次填一批 → 播一条」，剩下的由播放循环在 tick 之间继续播完 ——
      // 所以定时器被限流到十几秒一次，缓冲里的音频照样能连续出去。
      await _fillBuffer();
      await _playOneFromBuffer();
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
