import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:starvoice_app/app.dart';
import 'package:starvoice_app/providers.dart';

import 'fake_backend.dart';

void main() {
  testWidgets('登录页冒烟：获取验证码自动填码并登录成功进首页', (WidgetTester tester) async {
    // 加高视口：让「我的」页账号区与页脚按钮完整可见（避免懒加载截断断言）
    tester.view.physicalSize = const Size(1080, 3000);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    SharedPreferences.setMockInitialValues({});
    final backend = FakeBackend();

    await tester.pumpWidget(
      ProviderScope(
        overrides: [dioProvider.overrideWithValue(buildMockDio(backend))],
        child: const StarVoiceApp(),
      ),
    );

    // 等待启动会话恢复完成：无本地 token 应落在登录页
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('phoneField')), findsOneWidget);

    // 输入手机号并获取验证码
    await tester.enterText(find.byKey(const Key('phoneField')), '13800138000');
    await tester.tap(find.byKey(const Key('sendCodeButton')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 100));

    // dev 模式：send-code 响应携带 code，应自动填入并展示灰色提示
    expect(find.text('开发模式：验证码已自动填入'), findsOneWidget);
    final codeField = tester.widget<TextField>(
      find.byKey(const Key('codeField')),
    );
    expect(codeField.controller?.text, '123456');
    // 60 秒倒计时已启动，按钮进入倒计时禁用态
    expect(find.textContaining('重新获取('), findsOneWidget);

    // 点击登录：mock 后端返回 token/user，应自动跳转首页（三 Tab 外壳）
    await tester.tap(find.byKey(const Key('loginButton')));
    await tester.pumpAndSettle();

    // 首页：品牌头 + 「AI 语音开播」主入口；不再展示抖音绑定与账号信息
    expect(find.text('星辰语音'), findsOneWidget);
    expect(find.byKey(const Key('liveStartHeroCard')), findsOneWidget);
    expect(find.byKey(const Key('douyinCard')), findsNothing);
    expect(find.byKey(const Key('douyinBindButton')), findsNothing);
    expect(find.byKey(const Key('tabHome')), findsOneWidget);
    expect(find.byKey(const Key('tabLive')), findsOneWidget);
    expect(find.byKey(const Key('tabMe')), findsOneWidget);

    // 账号信息与退出登录收敛到「我的」Tab
    await tester.tap(find.text('我的'));
    await tester.pumpAndSettle();
    expect(find.textContaining('138****8000'), findsOneWidget);
    expect(find.textContaining('user-001'), findsOneWidget);
    expect(find.byKey(const Key('logoutButton')), findsOneWidget);
    expect(find.byKey(const Key('profileWalletEntry')), findsOneWidget);
  });
}
