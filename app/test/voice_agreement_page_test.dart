import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:starvoice_app/app.dart';
import 'package:starvoice_app/providers.dart';

import 'fake_backend.dart';

/// 走登录流程直达首页（假后端全程无真实网络请求）。
Future<void> _pumpLoggedInHome(WidgetTester tester, FakeBackend backend) async {
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
  testWidgets('声音授权冒烟：首页去签署 → 协议页阅读 → 勾选 → 签署成功返回首页刷新', (
    WidgetTester tester,
  ) async {
    final backend = FakeBackend();
    await _pumpLoggedInHome(tester, backend);

    // 未签署：首页声音授权卡片展示警示提示与「去签署」入口
    expect(find.byKey(const Key('voiceAgreementCard')), findsOneWidget);
    expect(find.byKey(const Key('voiceAgreementWarningHint')), findsOneWidget);
    final goSign = find.byKey(const Key('goVoiceAgreementButton'));
    await tester.ensureVisible(goSign);
    await tester.pumpAndSettle();
    await tester.tap(goSign);
    await tester.pumpAndSettle();

    // 协议页：全文可滚动阅读，签署按钮在未勾选时禁用
    expect(find.byKey(const Key('voiceAgreementContent')), findsOneWidget);
    expect(find.textContaining('授权范围'), findsOneWidget);
    expect(find.byKey(const Key('voiceAgreementCheckbox')), findsOneWidget);
    final signButtonFinder = find.byKey(const Key('voiceAgreementSignButton'));
    expect(tester.widget<FilledButton>(signButtonFinder).onPressed, isNull);

    // 勾选「我已阅读并同意」后签署按钮可点
    await tester.tap(find.byKey(const Key('voiceAgreementCheckbox')));
    await tester.pump();
    expect(tester.widget<FilledButton>(signButtonFinder).onPressed, isNotNull);

    // 签署成功返回首页，卡片刷新为已签署（版本 + 时间），不再展示「去签署」
    await tester.tap(signButtonFinder);
    await tester.pumpAndSettle();

    expect(find.byKey(const Key('goVoiceAgreementButton')), findsNothing);
    expect(find.byKey(const Key('voiceAgreementSignedText')), findsOneWidget);
    expect(find.textContaining('已签署 v1.0'), findsOneWidget);
    expect(find.textContaining('签署时间：'), findsOneWidget);
    expect(backend.agreementSigned, isTrue);
  });
}
