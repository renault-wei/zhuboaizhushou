import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:starvoice_app/app.dart';
import 'package:starvoice_app/providers.dart';

import 'fake_backend.dart';

/// 登录并进入首页（假后端全程无真实网络请求）。
Future<void> _pumpLoggedInHome(
  WidgetTester tester,
  FakeBackend backend,
) async {
  SharedPreferences.setMockInitialValues({});
  await tester.pumpWidget(
    ProviderScope(
      overrides: [dioProvider.overrideWithValue(buildMockDio(backend))],
      child: const StarVoiceApp(),
    ),
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
  testWidgets('首页「我的音色」入口：显示音色数量并进入音色库、空态引导录音', (
    WidgetTester tester,
  ) async {
    final backend = FakeBackend();
    await _pumpLoggedInHome(tester, backend);

    // 首页出现「我的音色」卡片，数量为 0
    expect(find.byKey(const Key('voiceLibraryCard')), findsOneWidget);
    expect(find.text('我的音色'), findsOneWidget);
    final countLabel = tester.widget<Text>(
      find.byKey(const Key('voiceLibraryCountLabel')),
    );
    expect(countLabel.data, '0 个');

    // 点击进入音色库页：空态文案 + 引导按钮
    final openButton = find.byKey(const Key('voiceLibraryOpenButton'));
    await tester.ensureVisible(openButton);
    await tester.pumpAndSettle();
    await tester.tap(openButton);
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('voiceLibraryPage')), findsOneWidget);
    expect(find.text('还没有音色，去录制你的第一段声音吧'), findsOneWidget);

    // 空态「去录制」跳转录音页
    await tester.tap(find.byKey(const Key('voiceLibraryGoRecordButton')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('recordingPage')), findsOneWidget);
    expect(find.byKey(const Key('passageText')), findsOneWidget);
  });
}
