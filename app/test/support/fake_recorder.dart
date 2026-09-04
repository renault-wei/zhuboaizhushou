import 'dart:async';

import 'package:record/record.dart';

import 'package:starvoice_app/features/recording/application/recorder_controller.dart';

/// 可控时钟：测试中手动拨快，模拟录音时间的真实流逝。
class MutableClock {
  MutableClock([DateTime? start]) : value = start ?? DateTime(2026, 9, 4, 10);

  DateTime value;

  void advance(Duration delta) => value = value.add(delta);
}

/// 假录音机：注入 record 插件最小接口，测试全程不触碰真实麦克风。
class FakeRecorder implements AudioRecorderAdapter {
  bool permissionGranted = true;
  int startCount = 0;
  int pauseCount = 0;
  int resumeCount = 0;
  int stopCount = 0;
  int cancelCount = 0;
  String? lastPath;

  final StreamController<Amplitude> _amplitude =
      StreamController<Amplitude>.broadcast(sync: true);

  @override
  Future<bool> hasPermission({bool request = true}) async => permissionGranted;

  @override
  Future<void> start(RecordConfig config, {required String path}) async {
    startCount++;
    lastPath = path;
  }

  @override
  Future<void> pause() async => pauseCount++;

  @override
  Future<void> resume() async => resumeCount++;

  @override
  Future<String?> stop() async {
    stopCount++;
    return lastPath;
  }

  @override
  Future<void> cancel() async => cancelCount++;

  @override
  Stream<Amplitude> onAmplitudeChanged(Duration interval) => _amplitude.stream;

  @override
  Future<void> dispose() async {}

  /// 模拟一次平台振幅回调（dBFS），同步分发便于直接断言。
  void emitAmplitude(double dbFS) {
    _amplitude.add(Amplitude(current: dbFS, max: dbFS));
  }
}

/// 假录音目录：避免在测试中访问真实应用文档目录。
Future<String> fakeRecordingsDirectory() async => '/fake/recordings';
