import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';

import 'package:starvoice_app/features/douyin/presentation/douyin_bind_page.dart';
import 'package:starvoice_app/providers.dart';

import 'fake_backend.dart';

/// 三 Tab 改造后首页不再提供抖音绑定入口；绑定由券列表页（/coupons）承接。
/// 本用例直达绑定页本体，验证授权码自动填充、授权成功 pop、非法码报错。
Future<void> _pumpBindPage(WidgetTester tester, FakeBackend backend) async {
  final router = GoRouter(
    initialLocation: '/',
    routes: <RouteBase>[
      GoRoute(
        path: '/',
        builder: (context, state) => Scaffold(
          body: Center(
            child: Builder(
              builder: (innerContext) => FilledButton(
                key: const Key('openDouyinBind'),
                onPressed: () => innerContext.push('/douyin-bind'),
                child: const Text('去绑定'),
              ),
            ),
          ),
        ),
      ),
      GoRoute(
        path: '/douyin-bind',
        builder: (context, state) => const DouyinBindPage(),
      ),
    ],
  );

  await tester.pumpWidget(
    ProviderScope(
      overrides: <Override>[
        dioProvider.overrideWithValue(buildMockDio(backend)),
      ],
      child: MaterialApp.router(routerConfig: router),
    ),
  );
  await tester.pumpAndSettle();

  await tester.tap(find.byKey(const Key('openDouyinBind')));
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('绑定页冒烟：dev 自动填 mock 授权码，模拟授权成功 pop 回上一页', (
    WidgetTester tester,
  ) async {
    final backend = FakeBackend(douyinBound: false);
    await _pumpBindPage(tester, backend);

    // 绑定页：说明文案 + dev 模式已自动填入 mock 授权码
    expect(find.byKey(const Key('douyinCodeField')), findsOneWidget);
    expect(find.byKey(const Key('douyinDevCodeHint')), findsOneWidget);
    final codeField = tester.widget<TextField>(
      find.byKey(const Key('douyinCodeField')),
    );
    expect(codeField.controller?.text, startsWith('mock-'));

    // 点击「模拟抖音授权」→ bind 接口 → 成功 pop 回上一页
    await tester.tap(find.byKey(const Key('mockAuthorizeButton')));
    await tester.pumpAndSettle();

    expect(backend.douyinBound, isTrue);
    expect(find.byKey(const Key('douyinCodeField')), findsNothing);
    expect(find.byKey(const Key('openDouyinBind')), findsOneWidget);
  });

  testWidgets('绑定失败：非法授权码展示服务端错误文案，不 pop', (WidgetTester tester) async {
    final backend = FakeBackend(douyinBound: false);
    await _pumpBindPage(tester, backend);

    await tester.enterText(
      find.byKey(const Key('douyinCodeField')),
      'invalid-code',
    );
    await tester.tap(find.byKey(const Key('mockAuthorizeButton')));
    await tester.pumpAndSettle();

    expect(find.byKey(const Key('douyinBindError')), findsOneWidget);
    expect(find.text('授权码无效或已过期，请重新授权'), findsOneWidget);
    expect(backend.douyinBound, isFalse);
    expect(find.byKey(const Key('openDouyinBind')), findsNothing);
  });
}
