/// 助播机出声端控制器（P1 手机线）单测：
/// 轮询远程出声队列 → 本机播放器出声，覆盖空队列 / 串行播报 /
/// 打断停用 / 接口异常自愈，以及 ApiClient 拉取解析（204 / wav + jobId）。
/// 全程走 FakeBackend，不真实请求、不碰平台音频通道。
library;

import 'dart:async';
import 'dart:typed_data';

import 'package:audioplayers/audioplayers.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:starvoice_app/features/assistant_speaker/data/audioplayers_speech_out_player.dart';

import 'package:starvoice_app/core/network/api_client.dart';
import 'package:starvoice_app/core/platform/keep_alive_bridge.dart';
import 'package:starvoice_app/features/assistant_speaker/application/assistant_speaker_controller.dart';
import 'package:starvoice_app/features/assistant_speaker/application/speech_out_player.dart';

import 'fake_backend.dart';

/// 测试用播放器：记录播放字节，可阻塞单次播放用于验证 stop 打断。
class _FakeSpeechOutPlayer implements SpeechOutPlayer {
  final List<Uint8List> played = <Uint8List>[];
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
  }

  @override
  Future<void> playUrl(String url) async {
    // 助播出声链路只播字节流，URL 试听不经过这里；保持接口完整即可
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
    'ApiClient.fetchNextOutSpeech：空队列 204 返回 null，有内容返回 wav + jobId',
    () async {
      final emptyBackend = FakeBackend();
      final emptyApi = ApiClient(buildMockDio(emptyBackend));
      final emptyResult = await emptyApi.fetchNextOutSpeech();
      expect(emptyResult, isNull);
      expect(emptyBackend.speechOutPulledCount, 0);

      final bytes = _wavBytes(1);
      final backend = FakeBackend(speechOut: <Uint8List>[bytes]);
      final api = ApiClient(buildMockDio(backend));
      final item = await api.fetchNextOutSpeech();
      expect(item, isNotNull);
      expect(item!.jobId, 'speech-mock-001');
      expect(item.wavBytes, bytes);
      expect(backend.speechOutPulledCount, 1);
    },
  );

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

    controller.start();
    await _waitUntil(() => controller.state.playedCount == 1);
    expect(player.played, hasLength(1));
    expect(player.played.first, bytes);
    expect(backend.speechOutPulledCount, 1);
    expect(controller.state.status, AssistantSpeakerStatus.waiting);
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

    controller.start();
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

    controller.start();
    await _waitUntil(
      () => controller.state.status == AssistantSpeakerStatus.error,
    );
    expect(controller.state.enabled, isTrue);
    expect(controller.state.lastError, contains('出声队列服务暂不可用'));

    // 服务恢复：下一条已入队，手动驱动一轮轮询应成功播报并复位错误
    backend.failSpeechOut = false;
    backend.speechOut.add(_wavBytes(4));
    await controller.pollOnce();
    expect(player.played, hasLength(1));
    expect(controller.state.playedCount, 1);
    expect(controller.state.status, AssistantSpeakerStatus.waiting);
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

    controller.start();
    await _waitUntil(() => controller.state.playedCount == 1);
    expect(bridge.startCount, 1);
    expect(controller.state.enabled, isTrue);
    expect(player.played, hasLength(1));
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

    // ★ 关键：只 tick 了一次，但五条都应该播出去 ——
    //   旧实现是「一条 tick 播一条」，这里会永远停在 1。
    await _waitUntil(() => player.played.length >= 5);
    expect(player.played, hasLength(5));
    expect(backend.speechOut, isEmpty);
    expect(controller.state.playedCount, 5);

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

    await _waitUntil(() => player.played.length >= 5);
    // 一条不多、一条不少 —— 说明没有重复播、也没有被抢掉
    expect(player.played, hasLength(5));
    expect(controller.state.playedCount, 5);

    controller.dispose();
  });
}
