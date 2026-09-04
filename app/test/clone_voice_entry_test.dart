import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:starvoice_app/app.dart';
import 'package:starvoice_app/features/recording/application/recorder_controller.dart';
import 'package:starvoice_app/providers.dart';

import 'fake_backend.dart';
import 'support/fake_recorder.dart';

/// 登录并进入首页（假后端无真实网络请求）。
Future<void> _pumpLoggedInHome(
  WidgetTester tester,
  FakeBackend backend, {
  RecorderController? recorderController,
}) async {
  SharedPreferences.setMockInitialValues({});
  final overrides = <Override>[
    dioProvider.overrideWithValue(buildMockDio(backend)),
  ];
  if (recorderController != null) {
    overrides.add(
      recorderControllerProvider.overrideWith((ref) => recorderController),
    );
  }
  await tester.pumpWidget(
    ProviderScope(overrides: overrides, child: const StarVoiceApp()),
  );
  await tester.pumpAndSettle();

  await tester.enterText(find.byKey(const Key('phoneField')), '13800138000');
  await tester.tap(find.byKey(const Key('sendCodeButton')));
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 100));
  await tester.tap(find.byKey(const Key('loginButton')));
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('录音入口：协议未签署 → 提示并跳转协议页', (WidgetTester tester) async {
    final backend = FakeBackend(); // agreementSigned 默认 false
    await _pumpLoggedInHome(tester, backend);

    expect(find.byKey(const Key('cloneVoiceCard')), findsOneWidget);
    expect(find.text('未授权'), findsOneWidget);

    final startButton = find.byKey(const Key('cloneVoiceStartButton'));
    await tester.ensureVisible(startButton);
    await tester.pumpAndSettle();
    await tester.tap(startButton);
    await tester.pumpAndSettle();

    // 提示「请先完成声音授权」并落在协议页
    expect(find.text('请先完成声音授权'), findsOneWidget);
    expect(find.byKey(const Key('voiceAgreementContent')), findsOneWidget);

    // 等待提示条自动消失，避免遗留计时器
    await tester.pump(const Duration(seconds: 5));
    await tester.pumpAndSettle();
  });

  testWidgets('录音入口：协议已签署 → 进入录音页', (WidgetTester tester) async {
    final backend = FakeBackend(agreementSigned: true);
    final recorderController = RecorderController(
      FakeRecorder(),
      fakeRecordingsDirectory,
    );
    await _pumpLoggedInHome(
      tester,
      backend,
      recorderController: recorderController,
    );

    expect(find.text('已授权'), findsOneWidget);
    final startButton = find.byKey(const Key('cloneVoiceStartButton'));
    await tester.ensureVisible(startButton);
    await tester.pumpAndSettle();
    await tester.tap(startButton);
    await tester.pumpAndSettle();

    // 进入录音页并展示第 1 段念稿
    expect(find.byKey(const Key('recordingPage')), findsOneWidget);
    expect(find.text('声音克隆录音'), findsOneWidget);
    expect(find.byKey(const Key('passageText')), findsOneWidget);
  });
}
