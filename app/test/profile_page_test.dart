import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:starvoice_app/app.dart';
import 'package:starvoice_app/providers.dart';

import 'fake_backend.dart';

/// 登录并进入「我的」Tab（假后端无真实网络请求）。
Future<void> _pumpLoggedInProfile(
  WidgetTester tester,
  FakeBackend backend,
) async {
  SharedPreferences.setMockInitialValues({});
  tester.view.physicalSize = const Size(1080, 3000);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);
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

  await tester.tap(find.text('我的'));
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('我的页：钱包时长摘要展示预充余额与本月免费剩余', (WidgetTester tester) async {
    // FakeBackend 默认：balanceMinutes=120、monthlyQuotaMinutes=600、monthlyUsedMinutes=120
    final backend = FakeBackend();
    await _pumpLoggedInProfile(tester, backend);

    expect(find.byKey(const Key('profileWalletEntry')), findsOneWidget);
    final balanceText = tester.widget<Text>(
      find.byKey(const Key('profileBalanceValue')),
    );
    expect(balanceText.data, '2 小时');
    expect(find.text('本月免费剩余 8 小时'), findsOneWidget);
    expect(find.text('去充值'), findsOneWidget);

    // 页脚版本与「关于」副标题展示当前版本
    final footerVersion = tester.widget<Text>(
      find.byKey(const Key('profileFooterVersion')),
    );
    expect(footerVersion.data, 'v0.3.0+91');
  });

  testWidgets('我的页：静态子页导航 — 官方客服提示与关于页版本', (WidgetTester tester) async {
    final backend = FakeBackend();
    await _pumpLoggedInProfile(tester, backend);

    // 官方客服：微信号未配置前仅提示待配置，点复制给出提示而不是编造号码
    await tester.tap(find.byKey(const Key('profileSupportOpenButton')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('supportPage')), findsOneWidget);
    expect(find.text('待配置（运营上线前提供）'), findsOneWidget);
    expect(
      find.byKey(const Key('profileCopySupportWechatButton')),
      findsOneWidget,
    );
    await tester.tap(find.byKey(const Key('profileCopySupportWechatButton')));
    await tester.pump();
    expect(find.text('客服微信号待配置，敬请期待'), findsOneWidget);

    // 等 SnackBar 自动消失，避免遗留计时器
    await tester.pumpAndSettle(const Duration(seconds: 5));

    // 返回「我的」页并进入关于页
    await tester.pageBack();
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('profilePage')), findsOneWidget);

    await tester.tap(find.byKey(const Key('profileAboutOpenButton')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('aboutPage')), findsOneWidget);
    final versionLabel = tester.widget<Text>(
      find.byKey(const Key('profileVersionLabel')),
    );
    expect(versionLabel.data, 'v0.3.0+91');
  });

  testWidgets('我的页：隐私政策子页展示初稿提示', (WidgetTester tester) async {
    final backend = FakeBackend();
    await _pumpLoggedInProfile(tester, backend);

    await tester.tap(find.byKey(const Key('profilePrivacyOpenButton')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('privacyPolicyPage')), findsOneWidget);
    expect(find.text('本文为产品演示初稿，正式对外前需经法务复核并以公示版本为准。'), findsOneWidget);
  });
}
