import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'package:starvoice_app/core/models/live.dart';
import 'package:starvoice_app/core/models/speech_out_item.dart';
import 'package:starvoice_app/core/network/api_client.dart';
import 'package:starvoice_app/core/network/api_exception.dart';
import 'package:starvoice_app/core/platform/keep_alive_bridge.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'speaker_supervisor.dart';
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

  /// ★R69：**本地库存**（磁盘）—— 替代原先的纯内存缓冲。
  ///
  /// ★★R72：**待播 URL 队列（纯内存）** ✓
  ///
  /// 与 R69 那套磁盘库存的区别是**根本性的**：
  ///   这里只存 **URL 字符串**（几十字节），字节由**原生播放器自己拉** ✓。
  ///   于是热路径上**没有任何 I/O** —— 不写磁盘、不读磁盘、不碰平台通道 ✓✓
  ///
  /// 为什么必须这样（2026-09-22 实测定案）：
  ///   过载手机上 `path_provider` 的平台通道会**挂起**（既不返回也不抛错）✗，
  ///   而播放循环是每秒几十次的热路径 —— 挂一次就永久卡死 ✓
  ///   （现象：App 在**前台停在监控页**，一分钟 0 次拉取 ✓）
  ///   竞品反编译包的做法正是 `src = url; play();`，与本设计同构 ✓
  /// ★★R77：每条 = **URL + 本条播完后的间隔秒数** ✓
  /// （R72~R76 这里只存 URL 字符串 ✗ —— 于是播放端完全不知道台本里的间隔，
  ///  onComplete 一到就立刻播下一条，听感就是「循环过快、没有等待」✓）
  final List<SpeechAudioJob> _pending = <SpeechAudioJob>[];

  // 【历史】R69~R71 曾在此处引入一个**磁盘库存**（SpeechOutStore），
  //   用于「播完不丢、后台拉不动时用本地存货顶着播」。
  //   它在 2026-09-22 被整套删除，原因是**架构错位** ✗：
  //   · 它把「写磁盘 / 读磁盘」放进了每秒几十次的播放热路径 ✗
  //   · 而 `path_provider` 走平台通道，在过载手机上**会挂起**（不返回也不抛错）
  //   · 挂一次 → `_playing` 卡死 → 播放循环每秒空转 20 次、且一个音都出不来 ✗
  //   连修三版（R69 加锁 / R71 加门闩与超时 / R71 去掉等待）都没跳出这个框 ✗
  //   —— 因为问题不在实现，在**「Dart 侧搬字节」这个前提本身** ✓
  //
  //   最终做法（R72）：**只存 URL，字节交给原生播放器** ✓
  //   与竞品反编译包同构（`bgAudio.src = url; play();`，其文件系统调用计数为 0 ✓）

  /// ★R69：库存「已就绪」的门闩 —— **R71 起不再被 await** ✗。
  /// 保留它只是为了在 dispose/诊断时知道「准备跑过没有」；
  /// 出声链路一律不等它（见上方那段注释：要等本身就是错的需求）✓
  ///
  /// 存在的理由是一个**真实竞态**：`start()` 里 `_prepareStore`（会 init + 清理，
  /// 其中 init 会 `_items.clear()` 后重建索引）与首次 `pollOnce`（会往里写）
  /// 是并发跑的 ✗ —— 清理可能把刚存进去的条目清掉，表现就是「拉到了却不播」✓
  /// 所以读写库存前一律先等它 ✓


  /// 播放循环空闲时等的信号：**可被唤醒**，而不是死等一个 Future.delayed。
  ///
  /// 为什么要这样：`future.delayed` 在停用/dispose 后仍会悬挂着，
  /// 测试收尾会报 `timersPending`，真机上也是白占一个定时器。
  /// 换成 Completer 之后，停用/销毁能立刻把循环叫醒退出。
  /// 播放驱动是否已挂上（同一时刻只允许一个）
  bool _playLoopRunning = false;

  /// ★R73：`onComplete` 的订阅句柄 —— 停用时必须取消，否则会跨场次重复推进 ✗
  StreamSubscription<void>? _completeSub;

  /// ★★R77：**条间间隔计时器** —— 非空即表示「正停在两条之间」✓
  ///
  /// 对照竞品 `app-service.js:5679`：`onEnded` 之后 `setTimeout(Endlater, n)`，
  /// n 取自服务端下发的 `audio_delay` —— **间隔在播放端** ✓
  ///
  /// 一个字段同时承担「等多久」与「是不是在等」两件事 ✓，
  /// 于是不存在「标志位与定时器不同步」的第二种状态 ✓
  Timer? _gapTimer;

  /// 正在播那条的「播完后间隔」（秒）—— 由 [_advancePlayback] 发起时记下 ✓
  double _currentGapSeconds = 0;

  /// ★R63：**播放互斥** —— 同一时刻只允许一条音频在播。
  ///
  /// 为什么必须有（2026-09-22 用户实测「直播间打开时部分语音一起播放」）：
  /// 当时有两个驱动源（每秒的定时器 tick 与播放循环）互不知情，
  /// 于是每秒都去 `player.play(...)`，**前一句还没播完就被切掉重放** ✗。
  ///
  /// R73 之后驱动源已收敛为一个事件流 ✓，但**这道闸仍然必要**：
  ///   `_advancePlayback` 的调用点有 6 处（恢复 / 填缓冲 / 事件 / 启动 / 兜底 / 轮询）✗，
  ///   互斥保证「同一时刻只有一条在途」，是那些调用点能安全重复调用的前提 ✓
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
    // ★R68：把「本次出声属于哪个场次」落到本地 ——
    // 应用级监督者（SpeakerSupervisor）靠它跨页面、跨进程重启把出声拉回来 ✓
    unawaited(_rememberLiveId(liveId));
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
    // ★★R74：先恢复上次没播完的待播队列（竞品做法：只存元数据不存字节 ✓）
    //   价值：切后台 / 断网 / 重启后，队列不该凭空消失 ✗
    //   安全：存的是几十字节的 URL 字符串 ✓（不是音频字节 ✗）——
    //   写盘走平台通道，所以一律 unawaited，**绝不阻塞出声主线** ✓
    //   （R69 正是因为热路径上 await 平台通道，才挂死整条链路 ✓）
    unawaited(_restorePendingUrls());
    unawaited(pollOnce());
    _startPlayDriver();
  }

  /// ★R74：待播 URL 的本地持久化（只存元数据，不存字节 ✓）。
  ///
  /// 对照竞品补的：它用 store_audio + JSON 把队列存下来 ✓，
  /// 于是切后台 / 断线 / 重启后队列还在 ✓；我们此前队列一出进程就没了 ✗。
  ///
  /// 与 R69 那套磁盘库存的本质区别：**存的是 URL 字符串，不是音频字节** ✓
  ///   · 不碰音频数据 → 不会把大块 I/O 引进热路径 ✓
  ///   · 写失败 / 挂起都无所谓（没人 await 它 ✓）
  ///   · URL 过期（服务端 TTL 10 分钟）时播放器报错 → 按单条失败跳过 ✓
  static const String _pendingUrlsKey = 'assistant_speaker_pending_urls';

  /// 持久化代际：**只允许最新一代的快照落盘** ✓
  ///
  /// 为什么需要（R74 自查发现）：本方法是 fire-and-forget ✓，多次调用会并发写 ✗，
  /// 而异步写完的顺序不保证与发起顺序一致 ✓。
  /// 最坏情况：`stop()` 清空队列后写「空列表」✓，
  /// 但一个更早发出的写入**后完成**✗ → 落盘的是旧的非空列表 ✗
  /// → 下次开播把**用户已经放弃的音频复活** ✗（正是本机制想防的事 ✓）
  int _persistGeneration = 0;

  /// 把当前待播队列写回本地（fire-and-forget ✓，绝不 await ✗）
  void _persistPendingUrls() {
    final generation = ++_persistGeneration;
    final snapshot = jsonEncode(
      _pending.map((job) => job.toJson()).toList(growable: false),
    );
    unawaited(() async {
      try {
        final prefs = await SharedPreferences.getInstance();
        // 落盘前再比一次：本代若已过时就直接放弃 ✗
        // （这一步把「旧快照覆盖新状态」挡在门外 ✓）
        if (generation != _persistGeneration) {
          return;
        }
        await prefs.setString(_pendingUrlsKey, snapshot);
      } catch (_) {
        // 存不下不影响出声 ✓
      }
    }());
  }

  /// 恢复上次没播完的待播队列（缺失 / 解析失败都当空 ✓）
  Future<void> _restorePendingUrls() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      final raw = prefs.getString(_pendingUrlsKey);
      if (raw == null || raw.isEmpty) {
        return;
      }
      final decoded = jsonDecode(raw);
      if (decoded is! List) {
        return;
      }
      if (_disposed || !state.enabled) {
        return;
      }
      // 只补进当前队列**前面** —— 恢复的应当是「还没播的」那部分 ✓
      // ★R77：现在存的是 {url, gap} 对象；fromJson 同时兼容 R74 的纯字符串旧格式 ✓
      final restored = decoded
          .map(SpeechAudioJob.fromJson)
          .whereType<SpeechAudioJob>()
          .toList(growable: false);
      if (restored.isEmpty) {
        return;
      }
      _pending.insertAll(0, restored);
      unawaited(_advancePlayback());
    } catch (_) {
      // 恢复失败按空处理 ✓
    }
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
    // ★R68：停用时忘掉场次线索 —— 否则监督者会把它再拉起来（与用户意图相反）
    unawaited(_rememberLiveId(null));
    // ★R77：先把「两条之间」的等待取消掉 ✗ ——
    //   少了这一步，stop 之后那个定时器仍会醒来推进下一条 ✓
    //   （与 R73 漏复位 _playLoopRunning 是同一类病灶）
    _gapTimer?.cancel();
    _gapTimer = null;
    _currentGapSeconds = 0;
    // 停用清空待播 URL ✓
    _pending.clear();
    // ★R74：持久化的那份也要清 ✗ —— 否则下次开播会把「用户已经放弃的」音频复活 ✓
    _persistPendingUrls();
    // ★R73：取消事件订阅并复位标志 ✗
    //   少了复位，下次开播时 `_startPlayDriver` 会因为「已在跑」直接返回 ✓
    //   → 出声再也起不来，而且没有任何报错（极难查 ✗）
    //
    // ⚠️ **顺序依赖**（R74 自查确认，改这里之前先读）：
    //   `cancel()` 是异步的 ✗，而下面 `_player.stop()` 会触发一次 `onComplete` ✓，
    //   所以事件处理器**可能仍被调用一次** ✓。
    //   之所以安全，是因为上面已经把状态置为 idle ✓ ——
    //   处理器进不去 `if (_disposed || !state.enabled) return;` 之后的逻辑 ✓，
    //   既不会错误累加计数，也不会重新起播 ✓
    //   若未来把 `state = idle` 挪到本行之后，这个安全性就没了 ✗
    unawaited(_completeSub?.cancel());
    _completeSub = null;
    _playLoopRunning = false;
    _playing = false;
    state = AssistantSpeakerState.idle();
    unawaited(_player.stop());
    unawaited(_syncKeepAlive(false));
  }

  /// 记下 / 忘掉「在播的场次」，供应用级监督者读取（R68）。
  /// 失败一律吞掉：这只是保命机制的线索，丢了最多是恢复不了，不该影响出声。
  Future<void> _rememberLiveId(String? liveId) async {
    try {
      final prefs = await SharedPreferences.getInstance();
      if (liveId == null || liveId.isEmpty) {
        await prefs.remove(speakerLiveIdKey);
      } else {
        await prefs.setString(speakerLiveIdKey, liveId);
      }
    } catch (_) {
      // 读写偏好失败不影响出声链路
    }
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
    if (_pending.length >= _bufferMaxItems) {
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
    while (_pending.length < _bufferMaxItems && fetched < pending.length) {
      // ★R72：只取 URL，**不取字节** ✓ —— 字节由原生播放器拉
      // ★R77：连同「本条播完后的间隔」一起带回来 ✓
      final job = await _api.fetchNextSpeechJob(liveId: _liveId);
      if (job == null) {
        // 清单说还有，但已被别的取走 / 已过期 —— 本次到此为止
        break;
      }
      _pending.add(job);
      fetched += 1;
    }
    if (fetched > 0) {
      _persistPendingUrls();
    }
    // 有货了 → 主动推进一条 ✓
    // （事件驱动下没有「空闲等待中的循环」可叫醒 ✗ —— 旧实现靠 _wakeIdle 唤醒它）
    unawaited(_advancePlayback());
    if (_disposed || !state.enabled) {
      return;
    }
    // ★R73：**不能无条件覆盖状态** ✗
    //   本函数在收尾前已经触发了播放（上面那句 _advancePlayback）✓，
    //   此时状态已是 playing —— 再写 waiting 会把它冲掉，
    //   上层看到的就永远不是「播报中」（真机上表现为状态灯乱跳 ✗）
    if (state.status != AssistantSpeakerStatus.playing) {
      state = state.copyWith(
        status: AssistantSpeakerStatus.waiting,
        lastError: null,
      );
    }
  }


  /// ★★R73：**事件驱动的播放推进**（对照竞品 `bgAudio.onEnded(...)`）✓
  ///
  /// 与旧实现的根本区别 —— **推 vs 拉**：
  ///   旧：`while (…) { await _playOneFromBuffer(); }` —— **拉** ✗
  ///        整条链路的进展依赖「那个 future 一定会 resolve」✗
  ///        今晚 5 个 bug（双驱动 / 空转 / 互斥漏放闸 / 磁盘挂起 / …）形状完全一样 ✓
  ///   新：**播放器主动发 `onComplete` 事件** → 上层推进下一条 ✓
  ///        Dart 侧不再有「必须 resolve 的 future」✓ —— 这类问题从结构上消失 ✓
  ///
  /// 为什么 `_advancePlayback` **不 await** `playUrl`：
  ///   若这里也 await，播完它继续往下走 ✓，而 `onComplete` 监听器同时也在推进 ✗
  ///   → **双驱动**，正是 R61 那个「几句一起播」的形状 ✓
  ///   所以：**播放只负责发起，推进只由事件负责** ✓（职责单一）
  void _startPlayDriver() {
    if (_playLoopRunning) {
      return;
    }
    _playLoopRunning = true;
    _completeSub = _player.onComplete.listen((_) {
      // 事件到了 = 这一条结束了（正常 / 超时 / 失败 / 被打断都会来 ✓）
      _playing = false;
      if (_disposed || !state.enabled) {
        return;
      }
      state = state.copyWith(
        status: AssistantSpeakerStatus.waiting,
        playedCount: state.playedCount + 1,
        lastError: null,
      );
      // ★★R77：**先等本条自己的间隔，再播下一条** ✓
      //   （竞品：`onEnded` → `setTimeout(Endlater, n)`，见 app-service.js:5679）
      _scheduleNextAfterGap();
    });
    unawaited(_advancePlayback());
  }

  /// ★★R77：**条间间隔** —— 本条播完后等 `gapAfterSeconds` 秒，再推进下一条 ✓
  ///
  /// 对照竞品 `app-service.js:5679`：
  ///   `bgAudio.onEnded(() => { n = 随机(audio_delay); setTimeout(Endlater, n) })`
  /// —— 它的间隔**在播放端**等，所以听众真的听得到那口气 ✓
  ///
  /// 我们原先的间隔只在**生产端**（服务端 `loopCaster` 里 `await sleep(gap)`）✗，
  /// 而远程链路 `speak` 是**入队即返回** → 台本 ~1 秒/条 灌进队列，
  /// 播放端却要 6.8 秒才念完一条（实测 wav 4.9~9.7s）→ 队列被灌满，
  /// 播放端一有货就**背靠背念** ✗ → 台本里的间隔被队列吸收干净，
  /// 用户听到的就是「循环过快、似乎没有等待」✓
  void _scheduleNextAfterGap() {
    final gapMilliseconds = (_currentGapSeconds * 1000).round();
    _currentGapSeconds = 0;
    if (gapMilliseconds <= 0) {
      // 没配间隔（插播的回复 / 氛围语走的也是这条路）→ 立刻推进 ✓
      unawaited(_advancePlayback());
      return;
    }
    _gapTimer?.cancel();
    _gapTimer = Timer(Duration(milliseconds: gapMilliseconds), () {
      _gapTimer = null;
      if (_disposed || !state.enabled) {
        return;
      }
      unawaited(_advancePlayback());
    });
  }

  /// 播下一条（幂等：在途 / 停在两条之间 / 已停用 / 队列空 → 直接返回 ✓）
  ///
  /// 队列空时**不做任何等待** ✗ —— 等下次 `_fillBuffer` 拉到货再调一次即可 ✓
  /// （旧实现的 `_waitIdle` 门闩属于「必须 resolve 的 future」那一类，随之删除 ✓）
  Future<void> _advancePlayback() async {
    // ★R77：`_gapTimer != null` = 正停在两条之间 ✓ —— 必须早退，
    //   否则 `_fillBuffer` 拉到货后那句 `_advancePlayback()` 会**绕过间隔**直接起播 ✗
    if (_disposed || !state.enabled || _playing || _gapTimer != null) {
      return;
    }
    if (_pending.isEmpty) {
      return;
    }
    // 先出队再发起 —— 顺序很重要：发起失败也不能让这条卡住队列 ✓
    final job = _pending.removeAt(0);
    // ★R77：记下这条的间隔 —— 它属于**刚发起的这条**，等它播完才用得上 ✓
    _currentGapSeconds = job.gapAfterSeconds;
    // 出队即持久化（fire-and-forget ✓）—— 崩溃后恢复时不会重播已经播过的 ✓
    _persistPendingUrls();
    _playing = true;
    state = state.copyWith(status: AssistantSpeakerStatus.playing);
    // ★★R76 修复（2026-09-22 真机实测「又停住了、但取号照常」）：
    //
    // 这里原先是 `try { unawaited(playUrl(url)); } catch (_) { 放闸 }` ✗ ——
    // `unawaited` 会把 Future 的**异步失败直接吞掉** ✗，catch 只接得住**同步**抛出的异常 ✓
    // 而 `playUrl` 内部（player.stop / player.play）失败都是**异步**的 ✗
    //   → `_playing` 永远停在 true ✗
    //   → `_advancePlayback` 此后**永久早退** ✗
    //   → `onComplete` 也不会来（播放压根没开始 ✓）
    //   → 现象：**一条都不播，但轮询/取号照常** ✓（服务端看到的就是「音频 GET 恒为 0」）
    //
    // 正确写法：把错误处理**挂在 Future 上** ✓（而不是靠外层 try）
    unawaited(
      _player.playUrl(job.url).catchError((Object error) {
        // 异步失败：放闸并继续下一条，绝不卡住链条 ✓
        // （单条失败不该让整场静音 —— 服务端 TTL 过了的链接就会走到这里 ✓）
        _playing = false;
        // ★R77：这条压根没播成 → 不补间隔，立刻放下一条 ✓
        _currentGapSeconds = 0;
        if (!_disposed && state.enabled) {
          unawaited(_advancePlayback());
        }
      }),
    );
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
      // ★R73：**只发起、不等待** ✓ —— 推进由 onComplete 事件负责
      // （旧实现这里 await 播放，于是「轮询」与「播放循环」成了两个驱动源 ✗）
      unawaited(_advancePlayback());
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
