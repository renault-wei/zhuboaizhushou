/// 助播机出声端控制器（P1 手机线）单测：
/// 轮询远程出声队列 → 本机播放器出声，覆盖空队列 / 串行播报 /
/// 打断停用 / 接口异常自愈，以及 ApiClient 拉取解析（204 / wav + jobId）。
/// 全程走 FakeBackend，不真实请求、不碰平台音频通道。
library;

import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:audioplayers/audioplayers.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:starvoice_app/features/assistant_speaker/data/audioplayers_speech_out_player.dart';

import 'package:starvoice_app/core/models/speech_out_item.dart';
import 'package:starvoice_app/core/network/api_client.dart';
import 'package:starvoice_app/core/platform/keep_alive_bridge.dart';
import 'package:starvoice_app/features/assistant_speaker/application/assistant_speaker_controller.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:starvoice_app/features/assistant_speaker/application/speech_out_player.dart';

import 'fake_backend.dart';

/// 测试用播放器：记录播放字节，可阻塞单次播放用于验证 stop 打断。
/// ★R78：可让前 N 次播放失败 —— 验证「失败也等一拍」（照竞品 `onError → setTimeout(1e3)`）。
class _FailingSpeechOutPlayer extends _FakeSpeechOutPlayer {
  _FailingSpeechOutPlayer({required this.failTimes});

  int failTimes;

  @override
  Future<void> playUrl(String url) async {
    if (failTimes > 0) {
      failTimes -= 1;
      playCount += 1; // 记一次「尝试」，但不算播成功
      throw StateError('链接已过期');
    }
    return super.playUrl(url);
  }
}

class _FakeSpeechOutPlayer implements SpeechOutPlayer {
  final List<Uint8List> played = <Uint8List>[];

  /// ★R72：出声链路改走 URL 后，测试看这个 ✓（`played` 只留给 play() 的残余用例）
  final List<String> playedUrls = <String>[];

  /// ★R73：播放结束事件流（推）—— 与真实实现同契约：
  /// 每次播放**恰好发一次**（正常 / 被 stop 打断 都发）✓
  final StreamController<void> _completeController =
      StreamController<void>.broadcast();

  @override
  Stream<void> get onComplete => _completeController.stream;
  int playCount = 0;
  int stopCount = 0;
  Completer<void>? _gate;

  /// 下一次 play 阻塞到 stop / 外部放行，模拟「长播报进行中」。
  void holdNextPlay() {
    _gate = Completer<void>();
  }

  void releaseGate() {
    final gate = _gate;
    if (gate != null && !gate.isCompleted) {
      gate.complete();
    }
  }

  @override
  Future<void> play(Uint8List wavBytes) async {
    playCount += 1;
    played.add(wavBytes);
    final gate = _gate;
    if (gate != null) {
      await gate.future;
    }
    _notifyComplete();
  }

  /// ★C：在途计数 —— 证「同一时刻只有一条在播」
  ///
  /// 为什么不能再用「URL 不重复」来证：C 之后脚本会**回绕循环**，
  /// 每一轮的 URL 本来就会重复出现 ✗ —— 那是正确行为，不是重叠 ✓
  int _inFlight = 0;
  bool overlapDetected = false;

  @override
  Future<void> playUrl(String url) async {
    // ★R72：助播出声链路**改走 URL** ✓ —— 与 play() 同样记账，
    // 否则测试里「播过没播过」全都看不出来 ✗（这正是本轮改动后 4 条测试挂掉的原因）
    playCount += 1;
    playedUrls.add(url);
    _inFlight += 1;
    if (_inFlight > 1) {
      overlapDetected = true;
    }
    try {
      final gate = _gate;
      if (gate != null) {
        await gate.future;
      }
      _notifyComplete();
    } finally {
      _inFlight -= 1;
    }
  }

  /// ★R73：与真实实现同契约 —— 每次播放**恰好发一次**「本条结束」✓
  void _notifyComplete() {
    if (!_completeController.isClosed) {
      _completeController.add(null);
    }
  }

  @override
  Future<void> stop() async {
    stopCount += 1;
    releaseGate();
  }

  @override
  Future<void> dispose() async {}
}

Uint8List _wavBytes(int seed) {
  return Uint8List.fromList(List<int>.generate(16, (i) => (seed + i) & 0xff));
}

/// 测试用保活桥：记录启停次数，可模拟原生抛错验证「保活失败不影响出声」。
class _FakeKeepAliveBridge implements KeepAliveBridge {
  int startCount = 0;
  int stopCount = 0;
  int settingsOpenCount = 0;

  /// true 时 start 抛错，模拟原生通道不可用。
  bool failStart = false;

  @override
  Future<void> start({String? title, String? content}) async {
    startCount += 1;
    if (failStart) {
      throw StateError('原生保活桥不可用');
    }
  }

  @override
  Future<void> stop() async {
    stopCount += 1;
  }

  @override
  Future<bool> isIgnoringBatteryOptimizations() async => true;

  @override
  Future<void> openBatteryOptimizationSettings() async {
    settingsOpenCount += 1;
  }

  /// R62：自启动设置页（厂商专有，代码无法代开，只能拉起）
  int autoStartOpenCount = 0;

  @override
  Future<bool> openAutoStartSettings() async {
    autoStartOpenCount += 1;
    return true;
  }

  /// R62：主动申请电池优化豁免（系统授权框）
  int batteryRequestCount = 0;

  @override
  Future<bool> requestIgnoreBatteryOptimizations() async {
    batteryRequestCount += 1;
    return true;
  }

  // R65：权限查询（对照竞品 xcai1618 的 checkAppNotification 等）
  @override
  Future<bool> checkNotificationPermission() async => true;

  @override
  Future<bool> checkOverlayPermission() async => true;

  @override
  Future<void> openOverlaySettings() async {}

  @override
  Future<void> openNotificationSettings() async {}
}

/// 轮询间隔拉大到一天：让 start 的即时拉取可控，测试期间不会自然再跳。
Future<void> _waitUntil(bool Function() condition) async {
  final deadline = DateTime.now().add(const Duration(seconds: 2));
  while (!condition()) {
    if (DateTime.now().isAfter(deadline)) {
      throw StateError('等待条件超时');
    }
    await Future<void>.delayed(const Duration(milliseconds: 10));
  }
}

void main() {
  test(
    'R77：fetchNextSpeechJob —— 空队列 204 返回 null；有内容返回【绝对 URL + 播完后间隔】',
    () async {
      final emptyBackend = FakeBackend();
      final emptyApi = ApiClient(buildMockDio(emptyBackend));
      final emptyResult = await emptyApi.fetchNextSpeechJob();
      expect(emptyResult, isNull);
      expect(emptyBackend.speechOutPulledCount, 0);

      final backend = FakeBackend(
        speechOut: <Uint8List>[_wavBytes(1)],
        speechOutGapSeconds: 1,
      );
      final api = ApiClient(buildMockDio(backend));
      final job = await api.fetchNextSpeechJob();
      expect(job, isNotNull);
      // 绝对地址（原生播放器要完整 URL，不能是相对路径）
      expect(job!.url, startsWith('http'));
      expect(job.url, contains('/api/out/speech/audio/speech-mock-001'));
      // ★R77：间隔随条目一起回来 —— 播放端据此在两条之间等待
      expect(job.gapAfterSeconds, 1);
      expect(backend.speechOutPulledCount, 1);
    },
  );

  test('R77：SpeechAudioJob 序列化往返；并兼容 R74 的旧纯字符串格式', () {
    const job = SpeechAudioJob(url: 'https://x.test/a.wav', gapAfterSeconds: 1.5);
    final restored = SpeechAudioJob.fromJson(jsonDecode(jsonEncode(job.toJson())));
    expect(restored, isNotNull);
    expect(restored!.url, 'https://x.test/a.wav');
    expect(restored.gapAfterSeconds, 1.5);

    // R74 旧格式：纯 URL 字符串 → gap 视作 0（升级不丢用户手机上已存的队列）
    final legacy = SpeechAudioJob.fromJson('https://x.test/b.wav');
    expect(legacy, isNotNull);
    expect(legacy!.url, 'https://x.test/b.wav');
    expect(legacy.gapAfterSeconds, 0);

    // 垃圾输入不炸、也不产出半条
    expect(SpeechAudioJob.fromJson(42), isNull);
    expect(SpeechAudioJob.fromJson(<String, Object?>{}), isNull);
    expect(SpeechAudioJob.fromJson(''), isNull);
  });

  // ---------- R77：条间间隔在【播放端】（对照竞品 bgAudio.onEnded + setTimeout） ----------
  // 2026-09-22 真机实测：服务端台本 ~1 秒/条 入队，音频本身 4.9~9.7 秒，
  // 而播放端 onComplete 一到就立刻播下一条 —— 台本里的间隔被队列吸干净，
  // 用户听到的是「语音队列循环过快、似乎没有等待」。
  test('R77：播完一条后等 gapAfterSeconds 才播下一条；等待中拉货也不抢跑', () async {
    final backend = FakeBackend(
      speechOut: <Uint8List>[_wavBytes(1), _wavBytes(2)],
      speechOutGapSeconds: 0.3,
    );
    final api = ApiClient(buildMockDio(backend));
    final player = _FakeSpeechOutPlayer();
    final controller = AssistantSpeakerController(
      api,
      player,
      const Duration(days: 1),
    );

    controller.start(liveId: 'live-001');
    await _waitUntil(() => player.playedUrls.isNotEmpty);
    expect(controller.state.playedCount, greaterThanOrEqualTo(1));

    // 间隔内：即使本轮又拉到货（pollOnce → _fillQueue → _advancePlayback），
    // 也必须被 `_gapTimer != null` 挡住 —— 这正是「绕过间隔」的那个坑
    await controller.pollOnce();
    await Future<void>.delayed(const Duration(milliseconds: 120));
    expect(player.playedUrls, hasLength(1));

    // 间隔过了 → 第二条自然会来
    // 注意：playedUrls 在**起播**时就记，playedCount 在**播完**时才加 ✓
    // 所以要等播完，不能只等起播 ✗
    await _waitUntil(() => controller.state.playedCount >= 2);
    expect(controller.state.playedCount, greaterThanOrEqualTo(2));

    controller.dispose();
  });

  test('R77：stop() 取消「两条之间」的等待，不会再推进下一条', () async {
    final backend = FakeBackend(
      speechOut: <Uint8List>[_wavBytes(1), _wavBytes(2)],
      speechOutGapSeconds: 5,
    );
    final player = _FakeSpeechOutPlayer();
    final controller = AssistantSpeakerController(
      ApiClient(buildMockDio(backend)),
      player,
      const Duration(days: 1),
    );

    controller.start(liveId: 'live-001');
    await _waitUntil(() => player.playedUrls.length == 1);

    controller.stop();
    expect(controller.state.enabled, isFalse);
    // stop 会把状态清成 idle（playedCount 一并归零），所以计数看播放器而不是 state ✓
    expect(controller.state.status, AssistantSpeakerStatus.idle);
    // 5 秒的间隔计时器若没被取消，这里会看到第二条冒出来
    await Future<void>.delayed(const Duration(milliseconds: 300));
    expect(player.playedUrls, hasLength(1));

    controller.dispose();
  });

  test('start 空队列进入监听态；stop 取消轮询回到未启用', () async {
    final controller = AssistantSpeakerController(
      ApiClient(buildMockDio(FakeBackend())),
      _FakeSpeechOutPlayer(),
      const Duration(days: 1),
    );

    controller.start();
    await _waitUntil(
      () =>
          controller.state.enabled &&
          controller.state.status == AssistantSpeakerStatus.waiting,
    );
    expect(controller.state.playedCount, 0);

    controller.stop();
    expect(controller.state.enabled, isFalse);
    expect(controller.state.status, AssistantSpeakerStatus.idle);
    controller.dispose();
  });

  test('队列有条目：拉取后交播放器播完，累计 +1 并回到监听态', () async {
    final bytes = _wavBytes(2);
    final backend = FakeBackend(speechOut: <Uint8List>[bytes]);
    final player = _FakeSpeechOutPlayer();
    final controller = AssistantSpeakerController(
      ApiClient(buildMockDio(backend)),
      player,
      const Duration(days: 1),
    );

    controller.start(liveId: 'live-001');
    await _waitUntil(() => controller.state.playedCount >= 1);
    // ★C：脚本会回绕循环，所以断言「播过」而不是「只播了一条」✓
    expect(player.playedUrls, isNotEmpty);
    expect(backend.speechOutPulledCount, greaterThanOrEqualTo(1));
    controller.dispose();
  });

  test('stop 打断播放中条目：播放器收到 stop 并回到未启用', () async {
    final backend = FakeBackend(speechOut: <Uint8List>[_wavBytes(3)]);
    final player = _FakeSpeechOutPlayer()..holdNextPlay();
    final controller = AssistantSpeakerController(
      ApiClient(buildMockDio(backend)),
      player,
      const Duration(days: 1),
    );

    controller.start(liveId: 'live-001');
    await _waitUntil(() => player.playCount == 1);
    expect(controller.state.status, AssistantSpeakerStatus.playing);

    controller.stop();
    await _waitUntil(() => player.stopCount >= 1);
    expect(controller.state.enabled, isFalse);
    expect(controller.state.status, AssistantSpeakerStatus.idle);
    // 播放中的条目不会把状态改回监听态
    await Future<void>.delayed(const Duration(milliseconds: 30));
    expect(controller.state.status, AssistantSpeakerStatus.idle);
    controller.dispose();
  });

  test('接口失败进入连接异常并保持启用；恢复后再次轮询自愈', () async {
    final backend = FakeBackend(failSpeechOut: true);
    final player = _FakeSpeechOutPlayer();
    final controller = AssistantSpeakerController(
      ApiClient(buildMockDio(backend)),
      player,
      const Duration(days: 1),
    );

    controller.start(liveId: 'live-001');
    await _waitUntil(
      () => controller.state.status == AssistantSpeakerStatus.error,
    );
    expect(controller.state.enabled, isTrue);
    expect(controller.state.lastError, contains('出声队列服务暂不可用'));

    // 服务恢复：下一条已入队，手动驱动一轮轮询应成功播报并复位错误
    backend.failSpeechOut = false;
    backend.speechOut.add(_wavBytes(4));
    await controller.pollOnce();
    // ★R73：播放改为异步发起（事件驱动），断言前必须等它真的播出去 ✓
    await _waitUntil(() => player.playedUrls.isNotEmpty);
    expect(player.playedUrls, isNotEmpty);
    expect(controller.state.playedCount, greaterThanOrEqualTo(1));
    expect(controller.state.lastError, isNull);
    controller.dispose();
  });

  test('启用出声拉起保活；停用释放（M9 手机线）', () async {
    final bridge = _FakeKeepAliveBridge();
    final controller = AssistantSpeakerController(
      ApiClient(buildMockDio(FakeBackend())),
      _FakeSpeechOutPlayer(),
      const Duration(days: 1),
      bridge,
    );

    controller.start();
    await _waitUntil(() => bridge.startCount == 1);
    expect(controller.state.enabled, isTrue);
    // 停用前不应释放
    expect(bridge.stopCount, 0);

    controller.stop();
    await _waitUntil(() => bridge.stopCount == 1);
    expect(controller.state.enabled, isFalse);
    controller.dispose();
  });

  test('保活桥 start 抛错不影响出声链路（静默降级）', () async {
    final bridge = _FakeKeepAliveBridge()..failStart = true;
    final player = _FakeSpeechOutPlayer();
    final backend = FakeBackend(speechOut: <Uint8List>[_wavBytes(9)]);
    final controller = AssistantSpeakerController(
      ApiClient(buildMockDio(backend)),
      player,
      const Duration(days: 1),
      bridge,
    );

    controller.start(liveId: 'live-001');
    await _waitUntil(() => controller.state.playedCount >= 1);
    expect(bridge.startCount, 1);
    expect(controller.state.enabled, isTrue);
    expect(player.playedUrls, isNotEmpty);
    expect(controller.state.lastError, isNull);
    controller.dispose();
  });

  // ---------- R53：场次没了要自己停，不能空转 ----------
  // 2026-09-21 实测：助播机独立于监控页在跑，场次被删后它**不会自己知道**，
  // 对着两条已删场次持续拉取，只有重启 App 才停。
  test('R53：场次被删后自动停止轮询，并留下原因', () async {
    final backend = FakeBackend(
      lives: <Map<String, dynamic>>[
        <String, dynamic>{
          'id': 'live-001',
          'title': '测试场次',
          'videoSourceUrl': '',
          'status': 'live',
          'aiBadgeShown': true,
        },
      ],
    );
    final api = ApiClient(buildMockDio(backend));
    final player = _FakeSpeechOutPlayer();
    // 轮询间隔拉大到一天：只靠测试手动驱动 pollOnce
    final controller = AssistantSpeakerController(
      api,
      player,
      const Duration(days: 1),
    );

    controller.start(liveId: 'live-001');
    // 等 start 的**首次拉取跑完**再手动驱动 —— 否则后续 pollOnce 会被 _busy 挡掉、
    // 计数根本不会涨（前两版都栽在这里）。注意不能只等 status：start() 是
    // **同步**把状态置成 waiting 的，等它等于没等。
    await Future<void>.delayed(const Duration(milliseconds: 80));

    // 还没到核对周期（15 次）：场次即使没了也不该停
    for (var i = 0; i < 14; i += 1) {
      await controller.pollOnce();
    }
    expect(controller.state.enabled, isTrue);
    expect(controller.state.lastError, isNull);

    // 场次被删
    backend.lives.clear();

    // 继续轮询直到核对周期再次命中（start 的首拉也计入，所以不能假定「再 1 次就够」）
    for (var i = 0; i < 20 && controller.state.enabled; i += 1) {
      await controller.pollOnce();
    }
    await _waitUntil(() => !controller.state.enabled);
    expect(controller.state.enabled, isFalse);
    expect(controller.state.lastError, contains('不存在'));
    // 停表后不该再有轮询（enabled=false 时 pollOnce 直接返回）
    await controller.pollOnce();
    expect(controller.state.enabled, isFalse);

    controller.dispose();
  });

  // ---------- R58：并行出声（不抢音频焦点） ----------
  // 2026-09-21 用户提出「声音应该可以并行」。根因：audioplayers 默认
  // AndroidAudioFocus.gain = 「the sole source of audio」独占 ——
  // 助播机一开口就把手机上的音乐/导航顶停。

  // ---------- R61：本地缓冲 —— 播放与拉取解耦 ----------
  // 2026-09-21 实测：App 切后台后 Dart 定时器被限流，拉取从 1 秒掉到 8~22 秒，
  // 服务端台本因此长期判「链路忙」→ 反复让位 30 秒 → 静音。
  // 修法：一次拉一批进本地缓冲，播放循环在两次 tick 之间把缓冲播完。
  test('R61：一次拉一批进本地缓冲；不再轮询也能把整批播完', () async {
    final backend = FakeBackend(
      lives: <Map<String, dynamic>>[
        <String, dynamic>{
          'id': 'live-001',
          'title': '测试场次',
          'videoSourceUrl': '',
          'status': 'live',
          'aiBadgeShown': true,
        },
      ],
    );
    for (var index = 0; index < 5; index += 1) {
      backend.speechOut.add(_wavBytes(index));
    }
    final api = ApiClient(buildMockDio(backend));
    final player = _FakeSpeechOutPlayer();
    // 轮询间隔拉大到一天：只靠一次 pollOnce 填批，之后全靠播放循环
    final controller = AssistantSpeakerController(
      api,
      player,
      const Duration(days: 1),
    );

    controller.start(liveId: 'live-001');
    await Future<void>.delayed(const Duration(milliseconds: 80));
    await controller.pollOnce();

    // ★R80：本地上限收紧到 2 —— 不再轮询也能把**缓冲里的**播完 ✓；
    //   而「服务端已拿走」与「已播出」之差**不得超过本地上限** ✓
    //   （这一条就是「条数与顺序对不上」的对齐保证：差多少 = 窗口多大）
    await _waitUntil(() => player.playedUrls.length >= 2);
    expect(
      backend.speechOutPulledCount - player.playedUrls.length,
      lessThanOrEqualTo(2),
    );

    controller.dispose();
  });

  test('R58：出声上下文只改「不抢焦点」，其余保持系统默认', () {
    final ctx = buildParallelAudioContext();
    // ★ 唯一要改的：不是 gain（独占），而是 none（不申请）——「声音应该可以并行」
    expect(ctx.android.audioFocus, AndroidAudioFocus.none);
    expect(ctx.android.stayAwake, isTrue);
    // ★★ 回归防线（2026-09-22 真机教训）：**不许**把 contentType / usageType
    //    改成 speech / assistant —— 那样音轨增益会变成 -inf（静音），
    //    用户只听到「声音阻塞」，而播放本身不报错，极难排查。
    expect(ctx.android.contentType, AndroidContentType.music);
    expect(ctx.android.usageType, AndroidUsageType.media);
  });

  // ---------- R63：播放互斥（治「部分语音一起播放」） ----------
  // 2026-09-22 用户实测：直播间打开时**几句语音一起播放**。
  // 根因是我 R61 引入的**双驱动**：`_playOneFromBuffer()` 既被每秒的定时器 tick
  // （pollOnce）调用，又被播放循环调用 —— 两者互不知情，每秒都去 player.play(...)，
  // 前一句还没播完就被切掉重放，听上去就是几句叠在一起。
  test('R63：同时驱动 tick 与播放循环，也不会重叠播放（同一时刻只有一条在播）', () async {
    final backend = FakeBackend(
      lives: <Map<String, dynamic>>[
        <String, dynamic>{
          'id': 'live-001',
          'title': '测试场次',
          'videoSourceUrl': '',
          'status': 'live',
          'aiBadgeShown': true,
        },
      ],
    );
    for (var index = 0; index < 5; index += 1) {
      backend.speechOut.add(_wavBytes(index));
    }
    final api = ApiClient(buildMockDio(backend));
    final player = _FakeSpeechOutPlayer();
    final controller = AssistantSpeakerController(
      api,
      player,
      const Duration(days: 1),
    );

    controller.start(liveId: 'live-001');
    await Future<void>.delayed(const Duration(milliseconds: 80));

    // 播放循环已在跑（start 时拉起）。此时【再并发地】多次驱动 tick ——
    // 修复前这里会不断抢播放器；修复后必须一条条来。
    await Future.wait<void>(<Future<void>>[
      controller.pollOnce(),
      controller.pollOnce(),
      controller.pollOnce(),
      controller.pollOnce(),
    ]);

    await _waitUntil(() => player.playedUrls.isNotEmpty);
    await Future<void>.delayed(const Duration(milliseconds: 200));
    // ★R80 上限收紧后不再断言具体条数；这里要证的是**互斥**：
    //   同一条不会被播两次（没有重复播放、也没有被抢占重播）✓
    expect(
      player.overlapDetected,
      isFalse,
      reason: '同一时刻只允许一条在播 —— 不该出现重叠播放',
    );

    controller.dispose();
  });

  // ---------- R74：待播队列的本地持久化（只存 URL，不存字节） ----------
  // 对照竞品：它用 store_audio + JSON 把队列存下来，切后台/断线/重启后队列还在。
  // 我们此前队列一出进程就没了；与 R69 那套「磁盘库存」的区别是——
  // **存的是几十字节的 URL 字符串，不是音频字节**，所以不会把 I/O 引进热路径。
  test('R74/R78/C：本场中断恢复 —— 只恢复**游标**，不重播本地旧 URL', () async {
    // 造一本 3 条的台本，并把游标停在 3
    final backend = FakeBackend(
      speechOut: <Uint8List>[_wavBytes(1), _wavBytes(2), _wavBytes(3)],
    );
    SharedPreferences.setMockInitialValues(<String, Object>{
      'assistant_speaker_pending_urls': jsonEncode(<String, Object?>{
        'liveId': 'live-001',
        'seq': 3,
      }),
    });

    final player = _FakeSpeechOutPlayer();
    final controller = AssistantSpeakerController(
      ApiClient(buildMockDio(backend)),
      player,
      const Duration(days: 1),
    );

    controller.start(liveId: 'live-001');

    // ★C：恢复的是**位置**——所以第一条播的就是第 3 条（jobId 后缀 003）✓
    await _waitUntil(() => player.playedUrls.isNotEmpty);
    expect(player.playedUrls.first, contains('speech-mock-003'));

    controller.dispose();
  });

  // ---------- R78：开播必须从**本场**第一条开始 ----------
  // 2026-09-22 用户实测「开播后不是从第一个音频开始」：
  // 上一场被杀的 App 在本地存着 10 条没播完的 URL，
  // 开播时被无条件 insertAll(0, …) 插到队首 → 从上一场的中途开始播 ✗
  // 对照竞品：它的本地库存是**这一轮**的（开播按 xuhao 从 0 重新要货）✓
  test('R78：上一场的残句不会被恢复（场次对不上就整队丢弃）', () async {
    SharedPreferences.setMockInitialValues(<String, Object>{
      'assistant_speaker_pending_urls': jsonEncode(<String, Object?>{
        'liveId': 'live-OLD',
        'seq': 7,
      }),
    });

    final player = _FakeSpeechOutPlayer();
    final controller = AssistantSpeakerController(
      ApiClient(buildMockDio(FakeBackend())),
      player,
      const Duration(days: 1),
    );

    controller.start(liveId: 'live-NEW');
    await Future<void>.delayed(const Duration(milliseconds: 150));
    // 服务端队列是空的 → 一条都不该播（那条是上一场的 ✗）
    expect(player.playedUrls, isEmpty);

    // 旧格式（R74~R77 的纯字符串，没有场次信息）同样必须丢弃 ✓
    final prefs = await SharedPreferences.getInstance();
    expect(prefs.getString('assistant_speaker_pending_urls'), isNull);

    controller.dispose();
  });

  test('R78：单条播放失败后**等一拍**再切下一条，不再零延迟连冲', () async {
    final backend = FakeBackend(
      speechOut: <Uint8List>[_wavBytes(1), _wavBytes(2), _wavBytes(3)],
    );
    final player = _FailingSpeechOutPlayer(failTimes: 1);
    final controller = AssistantSpeakerController(
      ApiClient(buildMockDio(backend)),
      player,
      const Duration(days: 1),
    );

    controller.start(liveId: 'live-001');
    await _waitUntil(() => player.playCount >= 1);
    // 失败之后必须**等一拍**才切下一条（竞品 onError 也是等 1 秒）
    await Future<void>.delayed(const Duration(milliseconds: 200));
    expect(player.playCount, 1, reason: '失败后不该零延迟连冲');

    // 1 秒之后自然轮到下一条（并且它成功播出去了）
    await _waitUntil(() => player.playedUrls.isNotEmpty);
    controller.dispose();
  });
}
