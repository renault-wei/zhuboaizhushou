/// 助播机出声端控制器（P1 手机线）单测：
/// 轮询远程出声队列 → 本机播放器出声，覆盖空队列 / 串行播报 /
/// 打断停用 / 接口异常自愈，以及 ApiClient 拉取解析（204 / wav + jobId）。
/// 全程走 FakeBackend，不真实请求、不碰平台音频通道。
library;

import 'dart:async';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';

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
}
