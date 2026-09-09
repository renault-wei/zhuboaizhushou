/// 首页「AI 语音开播」主入口冒烟测试：空态 / idle 草稿引导 / 就绪直达工作台。
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:starvoice_app/app.dart';
import 'package:starvoice_app/providers.dart';

import 'fake_backend.dart';

Map<String, dynamic> _liveJson({
  required String id,
  required String title,
  required String status,
  String? voiceId,
  String? scriptId,
}) {
  final now = DateTime.now().toUtc();
  return <String, dynamic>{
    'id': id,
    'title': title,
    'videoSourceUrl': '',
    'couponId': null,
    'rtmpUrl': null,
    'voiceId': voiceId,
    'volcPresetId': null,
    'scriptId': scriptId,
    'status': status,
    'aiBadgeShown': true,
    'startedAt': null,
    'endedAt': null,
    'createdAt': now.toIso8601String(),
    'updatedAt': now.toIso8601String(),
  };
}

/// 登录并进入首页（假后端无真实网络请求）。
Future<void> _pumpLoggedInHome(WidgetTester tester, FakeBackend backend) async {
  SharedPreferences.setMockInitialValues({});
  await tester.pumpWidget(
    ProviderScope(
      overrides: <Override>[
        dioProvider.overrideWithValue(buildMockDio(backend)),
      ],
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

/// 滚动到可视区后点按首页开播主入口按钮。
Future<void> _tapLiveStart(WidgetTester tester) async {
  final button = find.byKey(const Key('liveStartActionButton'));
  await tester.ensureVisible(button);
  await tester.pumpAndSettle();
  await tester.tap(button);
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('首页开播入口：空场次引导创建并落到新建页', (WidgetTester tester) async {
    final backend = FakeBackend();
    await _pumpLoggedInHome(tester, backend);

    expect(find.byKey(const Key('liveStartHeroCard')), findsOneWidget);
    expect(find.byKey(const Key('liveStartHeroHint')), findsOneWidget);
    expect(find.text('创建场次'), findsOneWidget);
    expect(find.textContaining('还没有直播场次'), findsOneWidget);

    await _tapLiveStart(tester);

    // 空态直达新建开播配置页
    expect(find.byKey(const Key('liveFormPage')), findsOneWidget);
    expect(find.text('新建开播配置'), findsOneWidget);
  });

  testWidgets('首页开播入口：idle 草稿无音色提示去完善并落到列表页', (WidgetTester tester) async {
    final backend = FakeBackend(
      lives: <Map<String, dynamic>>[
        _liveJson(id: 'draft-1', title: '未完善的火锅直播', status: 'idle'),
      ],
    );
    await _pumpLoggedInHome(tester, backend);

    expect(find.text('去完善'), findsOneWidget);
    expect(find.textContaining('1 个草稿待完善'), findsOneWidget);

    await _tapLiveStart(tester);

    // 落到列表页；无音色草稿的操作按钮文案为「去完善」
    expect(find.byKey(const Key('liveEdit_draft-1')), findsOneWidget);
    expect(find.text('去完善'), findsOneWidget);
  });

  testWidgets('首页开播入口：就绪场次直达现场直播工作台', (WidgetTester tester) async {
    // 放大测试视口，让工作台内容可渲染；收尾卸载页面取消轮询定时器。
    tester.view.physicalSize = const Size(1200, 2600);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);

    final backend = FakeBackend(
      lives: <Map<String, dynamic>>[
        _liveJson(
          id: 'ready-1',
          title: '晚市火锅直播',
          status: 'ready',
          voiceId: 'v-ready',
          scriptId: 's-ready',
        ),
      ],
    );
    await _pumpLoggedInHome(tester, backend);

    expect(find.text('开始直播'), findsOneWidget);
    expect(find.textContaining('晚市火锅直播'), findsOneWidget);

    final button = find.byKey(const Key('liveStartActionButton'));
    await tester.ensureVisible(button);
    await tester.pumpAndSettle();
    await tester.tap(button);
    // 工作台启动 3s 轮询与 1s 秒表定时器，禁用 pumpAndSettle，用固定时长推进
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));
    await tester.pump(const Duration(milliseconds: 50));
    await tester.pump(const Duration(milliseconds: 50));

    expect(find.byKey(const Key('liveMonitorPage')), findsOneWidget);
    expect(find.text('现场直播工作台'), findsOneWidget);

    // 卸载页面，取消工作台轮询 / 秒表定时器
    await tester.pumpWidget(const SizedBox());
    await tester.pump(const Duration(seconds: 5));
  });
}
