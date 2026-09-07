import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:starvoice_app/features/recording/application/recorder_controller.dart';
import 'package:starvoice_app/features/recording/presentation/recording_page.dart';
import 'package:starvoice_app/features/voices/presentation/voice_library_page.dart';
import 'package:starvoice_app/providers.dart';

import 'fake_backend.dart';
import 'support/fake_recorder.dart';

/// 预置 2 段全完成且总时长 80 秒的本地进度，页面恢复后即可点「开始克隆」。
Future<void> _seedAllSegmentsComplete() async {
  final entries = <Map<String, dynamic>>[];
  for (var i = 0; i < recordingSegmentCount; i++) {
    entries.add(<String, dynamic>{
      'index': i,
      'fileName': 'segment_${(i + 1).toString().padLeft(2, '0')}.m4a',
      'durationSeconds': 40,
    });
  }
  SharedPreferences.setMockInitialValues(<String, Object>{
    'recording_segments_v1': jsonEncode(entries),
  });
}

/// 用测试路由挂载录音页：录音完成后需跳 /voices，故不能只包 MaterialApp。
Future<void> _pumpRecordingPage(
  WidgetTester tester,
  FakeBackend backend,
) async {
  await _seedAllSegmentsComplete();
  final router = GoRouter(
    initialLocation: '/recording',
    routes: <GoRoute>[
      GoRoute(path: '/recording', builder: (context, state) => const RecordingPage()),
      GoRoute(path: '/voices', builder: (context, state) => const VoiceLibraryPage()),
      GoRoute(
        path: '/voice-agreement',
        builder: (context, state) => const Scaffold(
          key: Key('agreementStub'),
          body: Text('协议页占位'),
        ),
      ),
    ],
  );
  await tester.pumpWidget(
    ProviderScope(
      overrides: <Override>[
        dioProvider.overrideWithValue(buildMockDio(backend)),
        recorderControllerProvider.overrideWith(
          (ref) => RecorderController(FakeRecorder(), fakeRecordingsDirectory),
        ),
      ],
      child: MaterialApp.router(routerConfig: router),
    ),
  );
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('录音全部完成 → 开始克隆 → 进入音色库看到克隆中', (WidgetTester tester) async {
    final backend = FakeBackend(agreementSigned: true);
    await _pumpRecordingPage(tester, backend);

    // 2 段已恢复完成：展示完成面板，按钮文案为「开始克隆」
    expect(find.byKey(const Key('recordingPage')), findsOneWidget);
    expect(find.text('2 段已全部录完'), findsOneWidget);
    expect(find.text('总时长 01:20'), findsOneWidget);
    final submit = tester.widget<FilledButton>(
      find.byKey(const Key('submitCloneButton')),
    );
    expect(submit.onPressed, isNotNull);
    expect(find.text('开始克隆'), findsOneWidget);

    // 命名对话框：默认名「我的声音」，确认即创建克隆任务
    await tester.tap(find.byKey(const Key('submitCloneButton')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('cloneNameDialog')), findsOneWidget);
    // 预填默认名「我的声音」（输入框内部可能同时保留隐藏的 hint 文案，故直接断言 controller）
    final nameField = tester.widget<TextField>(
      find.byKey(const Key('cloneNameField')),
    );
    expect(nameField.controller?.text, '我的声音');

    await tester.tap(find.byKey(const Key('cloneNameConfirmButton')));
    await tester.pumpAndSettle();

    // 创建成功并跳转音色库：能看到 pending 的「克隆中」卡片
    expect(find.byKey(const Key('voiceLibraryPage')), findsOneWidget);
    expect(find.byKey(const Key('voiceCard_voice-001')), findsOneWidget);
    expect(find.text('我的声音'), findsOneWidget);
    expect(find.text('克隆中'), findsOneWidget);
    expect(backend.voices.length, 1);
    expect(backend.voices.single['name'], '我的声音');

    // 卸载页面停止轮询定时器，避免遗留计时器
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('未签署协议：创建被 403 拦截并引导去签署', (WidgetTester tester) async {
    final backend = FakeBackend(); // agreementSigned 默认 false
    await _pumpRecordingPage(tester, backend);

    await tester.tap(find.byKey(const Key('submitCloneButton')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('cloneNameConfirmButton')));
    await tester.pumpAndSettle();

    // 提示去签署并落在协议页，未产生任何音色
    expect(find.byKey(const Key('agreementStub')), findsOneWidget);
    expect(find.text('克隆声音前需先签署《声音授权协议》，请先完成授权'), findsOneWidget);
    expect(backend.voices, isEmpty);

    // 等待 SnackBar 自动消失，避免遗留计时器
    await tester.pump(const Duration(seconds: 5));
    await tester.pumpAndSettle();
  });
}
