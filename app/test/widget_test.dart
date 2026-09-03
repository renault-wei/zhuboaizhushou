import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:starvoice_app/app.dart';
import 'package:starvoice_app/providers.dart';

import 'fake_backend.dart';

void main() {
  testWidgets('登录页冒烟：获取验证码自动填码并登录成功进首页', (WidgetTester tester) async {
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
    final codeField = tester.widget<TextField>(find.byKey(const Key('codeField')));
    expect(codeField.controller?.text, '123456');
    // 60 秒倒计时已启动，按钮进入倒计时禁用态
    expect(find.textContaining('重新获取('), findsOneWidget);

    // 点击登录：mock 后端返回 token/user，应自动跳转首页
    await tester.tap(find.byKey(const Key('loginButton')));
    await tester.pumpAndSettle();

    expect(find.textContaining('138****8000'), findsOneWidget);
    expect(find.textContaining('user-001'), findsOneWidget);
    expect(find.byKey(const Key('logoutButton')), findsOneWidget);

    // 首页抖音账号卡片：未绑定时展示「去绑定」入口
    expect(find.byKey(const Key('douyinCard')), findsOneWidget);
    expect(find.byKey(const Key('douyinBindButton')), findsOneWidget);
  });
}
