import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:starvoice_app/features/recording/application/recorder_controller.dart';
import 'package:starvoice_app/features/recording/presentation/recording_page.dart';
import 'package:starvoice_app/providers.dart';

import 'support/fake_recorder.dart';

void main() {
  testWidgets('录音页冒烟：进入 → 录音并完成第 1 段 → 进度刷新', (WidgetTester tester) async {
    SharedPreferences.setMockInitialValues({});
    final recorder = FakeRecorder();
    final clock = MutableClock();
    final controller = RecorderController(
      recorder,
      fakeRecordingsDirectory,
      now: () => clock.value,
    );

    await tester.pumpWidget(
      ProviderScope(
        overrides: [recorderControllerProvider.overrideWith((ref) => controller)],
        child: const MaterialApp(home: RecordingPage()),
      ),
    );
    await tester.pumpAndSettle();

    // 进入：展示第 1 段念稿与总进度
    expect(find.byKey(const Key('recordingPage')), findsOneWidget);
    expect(find.text('第 1/2 段'), findsOneWidget);
    expect(find.text('已完成 0/2'), findsOneWidget);
    expect(find.byKey(const Key('passageText')), findsOneWidget);

    // 开始录音：按钮变「暂停」，出现计时与实时波形画布
    await tester.tap(find.byKey(const Key('recordButton')));
    await tester.pumpAndSettle();
    expect(recorder.startCount, 1);
    expect(find.text('暂停'), findsOneWidget);
    expect(find.byKey(const Key('waveformCanvas')), findsOneWidget);

    // 拨快时钟 6 秒，计时器应刷新到 00:06
    clock.advance(const Duration(seconds: 6));
    await tester.pump(const Duration(milliseconds: 300));
    expect(find.text('00:06'), findsOneWidget);

    // 完成本段：进度刷新为 1/2，展示本段时长并允许重录
    await tester.tap(find.byKey(const Key('finishSegmentButton')));
    await tester.pumpAndSettle();
    expect(find.text('第 2/2 段'), findsOneWidget);
    expect(find.text('已完成 1/2'), findsOneWidget);
    expect(find.text('总时长 00:06'), findsOneWidget);
    expect(find.byKey(const Key('recentSegmentBanner')), findsOneWidget);
    expect(find.textContaining('第 1 段已录制 00:06'), findsOneWidget);

    // 仅完成 1 段时「提交克隆」保持禁用
    final submit = tester.widget<FilledButton>(
      find.byKey(const Key('submitCloneButton')),
    );
    expect(submit.onPressed, isNull);
  });

  testWidgets('录音中返回：自动停止录音并保存当前段进度', (WidgetTester tester) async {
    SharedPreferences.setMockInitialValues({});
    final recorder = FakeRecorder();
    final clock = MutableClock();
    final controller = RecorderController(
      recorder,
      fakeRecordingsDirectory,
      now: () => clock.value,
    );

    await tester.pumpWidget(
      ProviderScope(
        overrides: [recorderControllerProvider.overrideWith((ref) => controller)],
        child: const MaterialApp(home: _RecordingLauncher()),
      ),
    );
    await tester.tap(find.byKey(const Key('openRecordingButton')));
    await tester.pumpAndSettle();

    await tester.tap(find.byKey(const Key('recordButton')));
    await tester.pumpAndSettle();
    expect(recorder.startCount, 1);

    // 录音中返回上一页：应自动停止并保存当前段进度
    clock.advance(const Duration(seconds: 4));
    await tester.tap(find.byType(BackButton));
    await tester.pumpAndSettle();

    expect(find.byKey(const Key('recordingPage')), findsNothing);
    expect(controller.state.phase, RecorderPhase.idle);
    expect(controller.state.segments[0]!.durationSeconds, 4);
    expect(recorder.stopCount, 1);

    // 段落数据已持久化，重进页面可恢复
    final prefs = await SharedPreferences.getInstance();
    final raw = prefs.getString('recording_segments_v1');
    expect(raw, isNotNull);
    expect(raw, contains('segment_01.m4a'));
  });
}

/// 测试入口页：可真实压栈打开录音页，验证返回时的中断保护。
class _RecordingLauncher extends StatelessWidget {
  const _RecordingLauncher();

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Center(
        child: ElevatedButton(
          key: const Key('openRecordingButton'),
          onPressed: () {
            Navigator.of(context).push(
              MaterialPageRoute<void>(builder: (_) => const RecordingPage()),
            );
          },
          child: const Text('进入录音'),
        ),
      ),
    );
  }
}
