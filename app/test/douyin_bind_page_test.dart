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
  testWidgets('绑定页冒烟：dev 自动填 mock 码，模拟授权绑定成功回首页刷新', (WidgetTester tester) async {
    final backend = FakeBackend();
    await _pumpLoggedInHome(tester, backend);

    // 未绑定 → 首页展示「去绑定」
    expect(find.byKey(const Key('douyinBindButton')), findsOneWidget);

    await tester.tap(find.byKey(const Key('douyinBindButton')));
    await tester.pumpAndSettle();

    // 绑定页：说明文案 + dev 模式已自动填入 mock 授权码
    expect(find.byKey(const Key('douyinCodeField')), findsOneWidget);
    expect(find.byKey(const Key('douyinDevCodeHint')), findsOneWidget);
    final codeField =
        tester.widget<TextField>(find.byKey(const Key('douyinCodeField')));
    expect(codeField.controller?.text, startsWith('mock-'));

    // 点击「模拟抖音授权」→ bind 接口 → 成功返回首页
    await tester.tap(find.byKey(const Key('mockAuthorizeButton')));
    await tester.pumpAndSettle();

    // 首页卡片已刷新为已绑定：展示抖音昵称与解绑按钮
    expect(find.text(backend.douyinNickname), findsOneWidget);
    expect(find.byKey(const Key('douyinUnbindButton')), findsOneWidget);
    expect(find.byKey(const Key('douyinBindButton')), findsNothing);
  });

  testWidgets('绑定后解绑：确认弹窗后卡片回到未绑定', (WidgetTester tester) async {
    final backend = FakeBackend();
    await _pumpLoggedInHome(tester, backend);

    await tester.tap(find.byKey(const Key('douyinBindButton')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('mockAuthorizeButton')));
    await tester.pumpAndSettle();
    expect(find.text(backend.douyinNickname), findsOneWidget);

    // 解绑需二次确认
    await tester.tap(find.byKey(const Key('douyinUnbindButton')));
    await tester.pumpAndSettle();
    expect(find.text('解绑抖音号'), findsOneWidget);

    await tester.tap(find.byKey(const Key('douyinUnbindConfirmButton')));
    await tester.pumpAndSettle();

    // 等 SnackBar 计时器走完再结束用例，避免 pending timer
    await tester.pump(const Duration(seconds: 5));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('douyinBindButton')), findsOneWidget);
    expect(find.text(backend.douyinNickname), findsNothing);
  });
}
