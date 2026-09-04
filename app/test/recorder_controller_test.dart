import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:starvoice_app/features/recording/application/recorder_controller.dart';

import 'support/fake_recorder.dart';

void main() {
  late FakeRecorder recorder;
  late MutableClock clock;
  late RecorderController controller;

  RecorderController buildController() {
    recorder = FakeRecorder();
    clock = MutableClock();
    controller = RecorderController(
      recorder,
      fakeRecordingsDirectory,
      now: () => clock.value,
    );
    addTearDown(controller.dispose);
    return controller;
  }

  test('开始→暂停→恢复→完成：暂停不计时，恢复后继续累计', () async {
    SharedPreferences.setMockInitialValues({});
    final c = buildController();
    await c.init();
    expect(c.state.phase, RecorderPhase.idle);
    expect(c.state.completedCount, 0);

    await c.startCurrentSegment();
    expect(recorder.startCount, 1);
    expect(c.state.phase, RecorderPhase.recording);
    expect(c.state.elapsedSeconds, 0);
    expect(c.state.segments[0], isNull);

    clock.advance(const Duration(seconds: 8));
    await c.pauseCurrentSegment();
    expect(recorder.pauseCount, 1);
    expect(c.state.phase, RecorderPhase.paused);
    expect(c.state.elapsedSeconds, 8);

    // 暂停 3 秒不应计入时长
    clock.advance(const Duration(seconds: 3));
    await c.resumeCurrentSegment();
    expect(recorder.resumeCount, 1);
    expect(c.state.phase, RecorderPhase.recording);
    expect(c.state.elapsedSeconds, 8);

    clock.advance(const Duration(seconds: 4));
    final finished = await c.finishCurrentSegment();
    expect(finished, isTrue);
    expect(recorder.stopCount, 1);
    expect(c.state.phase, RecorderPhase.idle);
    expect(c.state.completedCount, 1);
    expect(c.state.currentIndex, 1);
    final segment = c.state.segments[0]!;
    expect(segment.fileName, 'segment_01.m4a');
    expect(segment.durationSeconds, 12);
    expect(c.state.totalSeconds, 12);
  });

  test('重录本段：覆盖旧时长并复用同一文件名', () async {
    SharedPreferences.setMockInitialValues({});
    final c = buildController();
    await c.init();

    await c.startCurrentSegment();
    clock.advance(const Duration(seconds: 6));
    await c.finishCurrentSegment();
    expect(c.state.segments[0]!.durationSeconds, 6);

    await c.recordSegment(0);
    expect(c.state.phase, RecorderPhase.recording);
    expect(c.state.segments[0], isNull);
    expect(recorder.lastPath, contains('segment_01.m4a'));

    clock.advance(const Duration(seconds: 4));
    await c.finishCurrentSegment();
    final segment = c.state.segments[0]!;
    expect(segment.fileName, 'segment_01.m4a');
    expect(segment.durationSeconds, 4);
    expect(recorder.startCount, 2);
    expect(recorder.stopCount, 2);
  });

  test('本段时长为 0 时完成本段不落盘', () async {
    SharedPreferences.setMockInitialValues({});
    final c = buildController();
    await c.init();

    await c.startCurrentSegment();
    final finished = await c.finishCurrentSegment();
    expect(finished, isFalse);
    expect(c.state.phase, RecorderPhase.idle);
    expect(c.state.completedCount, 0);
    expect(c.state.totalSeconds, 0);
    expect(recorder.stopCount, 1);
  });

  test('波形采样：归一化并保留最近 N 个采样点', () async {
    SharedPreferences.setMockInitialValues({});
    final c = buildController();
    await c.init();
    await c.startCurrentSegment();

    // 超过容量后丢弃最早采样，仅保留最近 N 个
    for (var i = 0; i < waveformSampleCount + 7; i++) {
      recorder.emitAmplitude(-30); // 归一化后为 0.5
    }
    expect(c.state.waveform.length, waveformSampleCount);
    expect(c.state.waveform.every((v) => v == 0.5), isTrue);

    // 边界值夹到 0..1
    expect(c.normalizeAmplitude(-60), 0.0);
    expect(c.normalizeAmplitude(0), 1.0);
    expect(c.normalizeAmplitude(-120), 0.0);
    expect(c.normalizeAmplitude(20), 1.0);

    // 停止后清空波形，避免残留旧段数据
    clock.advance(const Duration(seconds: 3));
    await c.finishCurrentSegment();
    expect(c.state.waveform, isEmpty);
    expect(c.state.completedCount, 1);
  });

  test('页面销毁保存进度：录音中自动停止并落盘当前段', () async {
    SharedPreferences.setMockInitialValues({});
    final c = buildController();
    await c.init();
    await c.startCurrentSegment();

    clock.advance(const Duration(seconds: 5));
    await c.saveProgressAndStop();
    expect(recorder.stopCount, 1);
    expect(c.state.phase, RecorderPhase.idle);
    expect(c.state.segments[0]!.durationSeconds, 5);
    expect(c.state.currentIndex, 1);
  });

  test('从 shared_preferences 恢复上次进度（文件名+时长 JSON）', () async {
    SharedPreferences.setMockInitialValues({
      'recording_segments_v1': jsonEncode(<Map<String, dynamic>>[
        {'index': 2, 'fileName': 'segment_03.m4a', 'durationSeconds': 42},
        {'index': 7, 'fileName': 'segment_08.m4a', 'durationSeconds': 31},
      ]),
    });
    final c = buildController();
    expect(c.state.restoring, isTrue);

    await c.init();
    expect(c.state.restoring, isFalse);
    expect(c.state.completedCount, 2);
    expect(c.state.currentIndex, 0);
    expect(c.state.totalSeconds, 73);
    expect(c.state.segments[2]!.fileName, 'segment_03.m4a');
    expect(c.state.segments[7]!.durationSeconds, 31);
  });

  test('麦克风权限被拒：提示错误且不启动录音', () async {
    SharedPreferences.setMockInitialValues({});
    final c = buildController();
    recorder.permissionGranted = false;
    await c.init();

    await c.startCurrentSegment();
    expect(recorder.startCount, 0);
    expect(c.state.phase, RecorderPhase.idle);
    expect(c.state.errorMessage, isNotNull);
  });
}
