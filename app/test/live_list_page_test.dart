import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';

import 'package:starvoice_app/features/lives/presentation/live_form_page.dart';
import 'package:starvoice_app/features/lives/presentation/live_list_page.dart';
import 'package:starvoice_app/features/lives/presentation/live_monitor_page.dart';
import 'package:starvoice_app/providers.dart';

import 'fake_backend.dart';

Map<String, dynamic> _liveJson({
  required String id,
  required String title,
  required String status,
  String? voiceId,
  String? scriptId,
  String? couponId,
}) {
  final now = DateTime.now().toUtc();
  return <String, dynamic>{
    'id': id,
    'title': title,
    'videoSourceUrl': '',
    'couponId': couponId,
    'rtmpUrl': null,
    'voiceId': voiceId,
    'scriptId': scriptId,
    'status': status,
    'aiBadgeShown': true,
    'startedAt': null,
    'endedAt': null,
    'createdAt': now.toIso8601String(),
    'updatedAt': now.toIso8601String(),
  };
}

/// 直接在 MaterialApp 内渲染列表页（不涉及路由跳转的用例使用）。
Future<void> _pumpListPage(WidgetTester tester, FakeBackend backend) async {
  await tester.pumpWidget(
    ProviderScope(
      overrides: [dioProvider.overrideWithValue(buildMockDio(backend))],
      child: const MaterialApp(home: LiveListPage()),
    ),
  );
  await tester.pumpAndSettle();
}

/// 走真实路由表渲染列表页：覆盖「+ → /lives/new」跳转与表单联动。
Future<void> _pumpListRouter(WidgetTester tester, FakeBackend backend) async {
  final router = GoRouter(
    initialLocation: '/lives',
    routes: <RouteBase>[
      GoRoute(path: '/lives', builder: (context, state) => const LiveListPage()),
      GoRoute(path: '/lives/new', builder: (context, state) => const LiveFormPage()),
      GoRoute(
        path: '/lives/:id',
        builder: (context, state) => LiveFormPage(
          liveId: state.pathParameters['id'] ?? '',
        ),
      ),
      GoRoute(
        path: '/lives/:id/monitor',
        builder: (context, state) => LiveMonitorPage(
          liveId: state.pathParameters['id'] ?? '',
        ),
      ),
    ],
  );
  await tester.pumpWidget(
    ProviderScope(
      overrides: [dioProvider.overrideWithValue(buildMockDio(backend))],
      child: MaterialApp.router(routerConfig: router),
    ),
  );
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('空态：无开播配置时展示引导文案与「去创建」按钮', (WidgetTester tester) async {
    final backend = FakeBackend();
    await _pumpListPage(tester, backend);

    expect(find.byKey(const Key('liveListPage')), findsOneWidget);
    expect(find.text('开播配置'), findsOneWidget);
    expect(find.byKey(const Key('liveListEmptyText')), findsOneWidget);
    expect(find.text('还没有开播配置，点击 + 创建第一个草稿'), findsOneWidget);
    expect(find.byKey(const Key('liveListCreateButton')), findsOneWidget);
    expect(find.byKey(const Key('liveAddButton')), findsOneWidget);
    expect(find.byKey(const Key('liveRefreshButton')), findsOneWidget);
  });

  testWidgets('列表分段：草稿 / 就绪·合成中·直播中 / 已结束分组展示，摘要含绑定资源名', (WidgetTester tester) async {
    final backend = FakeBackend(
      douyinBound: true,
      voices: <Map<String, dynamic>>[
        <String, dynamic>{
          'id': 'v-ready',
          'name': '主播小美',
          'status': 'ready',
          'providerVoiceId': 'cosy-mock-v-ready',
          'sampleDurationSeconds': 200,
          'createdAt': DateTime.now().toUtc().toIso8601String(),
        },
      ],
      scripts: <Map<String, dynamic>>[
        <String, dynamic>{
          'id': 'script-001',
          'industry': 'restaurant',
          'title': '火锅套餐话术',
          'productSnapshot': <String, dynamic>{'name': '双人火锅套餐'},
          'content': '双人火锅套餐，锅底现炒，欢迎到店品尝。',
          'status': 'ready',
          'sensitiveCheckStatus': 'pass',
          'sensitiveMatchedWords': <String>[],
          'createdAt': DateTime.now().toUtc().toIso8601String(),
        },
      ],
      lives: <Map<String, dynamic>>[
        _liveJson(
          id: 'live-001',
          title: '午市循环草稿',
          status: 'idle',
          voiceId: 'v-ready',
          scriptId: 'script-001',
          couponId: 'c-001-mock',
        ),
        _liveJson(id: 'live-002', title: '晚市就绪直播', status: 'ready'),
        _liveJson(id: 'live-003', title: '昨日已结束', status: 'ended'),
      ],
    );
    await _pumpListPage(tester, backend);

    // 三分段标题
    expect(find.text('草稿（1）'), findsOneWidget);
    expect(find.text('就绪 / 合成中 / 直播中（1）'), findsOneWidget);
    expect(find.text('已结束（1）'), findsOneWidget);

    // 三张卡片与状态徽章
    expect(find.byKey(const Key('liveCard_live-001')), findsOneWidget);
    expect(find.byKey(const Key('liveCard_live-002')), findsOneWidget);
    expect(find.byKey(const Key('liveCard_live-003')), findsOneWidget);
    expect(find.byKey(const Key('liveStatus_live-001')), findsOneWidget);
    expect(find.text('草稿'), findsOneWidget);
    expect(find.text('就绪'), findsOneWidget);
    expect(find.text('已结束'), findsOneWidget);

    // 操作按钮：草稿可编辑；ready / live 统一「进入监控」（开播收口在工作台）；
    // 已结束走「查看」占位，ready 不再有列表内「开播」按钮
    expect(find.byKey(const Key('liveEdit_live-001')), findsOneWidget);
    expect(find.byKey(const Key('liveMonitor_live-002')), findsOneWidget);
    expect(find.byKey(const Key('liveView_live-003')), findsOneWidget);
    expect(find.byKey(const Key('liveStart_live-002')), findsNothing);
    expect(find.byKey(const Key('liveEdit_live-002')), findsNothing);

    // 摘要展示音色 / 话术 / 团购券名称
    expect(
      find.text('音色：主播小美 · 话术：火锅套餐话术 · 券：双人火锅套餐'),
      findsOneWidget,
    );

    // 删除保护：idle 可删，ready 的删除按钮禁用
    final idleDelete = tester.widget<IconButton>(
      find.byKey(const Key('liveDelete_live-001')),
    );
    expect(idleDelete.onPressed, isNotNull);
    final readyDelete = tester.widget<IconButton>(
      find.byKey(const Key('liveDelete_live-002')),
    );
    expect(readyDelete.onPressed, isNull);
  });

  testWidgets('合成中（processing）并入进行中分段：展示「合成中」徽章并受删除保护', (WidgetTester tester) async {
    final backend = FakeBackend(
      lives: <Map<String, dynamic>>[
        _liveJson(id: 'live-004', title: '午市合成中的直播', status: 'processing'),
      ],
    );
    await _pumpListPage(tester, backend);

    expect(find.text('就绪 / 合成中 / 直播中（1）'), findsOneWidget);
    expect(find.byKey(const Key('liveCard_live-004')), findsOneWidget);
    expect(find.byKey(const Key('liveStatus_live-004')), findsOneWidget);
    expect(find.text('合成中'), findsOneWidget);

    // 非 idle：走「查看」占位，不出现编辑按钮
    expect(find.byKey(const Key('liveView_live-004')), findsOneWidget);
    expect(find.byKey(const Key('liveEdit_live-004')), findsNothing);

    // 删除保护：processing 删除按钮禁用（服务端同样 409 拦截）
    final deleteButton = tester.widget<IconButton>(
      find.byKey(const Key('liveDelete_live-004')),
    );
    expect(deleteButton.onPressed, isNull);
  });

  testWidgets('就绪配置无列表内「开播」按钮：删除禁用不弹确认框', (WidgetTester tester) async {
    final backend = FakeBackend(
      lives: <Map<String, dynamic>>[
        _liveJson(id: 'live-002', title: '晚市就绪直播', status: 'ready'),
      ],
    );
    await _pumpListPage(tester, backend);

    // G6 收口：一键开播移入工作台，列表卡片只保留「进入监控」入口
    expect(find.byKey(const Key('liveMonitor_live-002')), findsOneWidget);
    expect(find.byKey(const Key('liveStart_live-002')), findsNothing);

    // 禁用删除：点击不弹确认框
    await tester.tap(find.byKey(const Key('liveDelete_live-002')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('liveDeleteDialog')), findsNothing);
  });

  testWidgets('删除草稿：取消不删，确认后移除并回到空态', (WidgetTester tester) async {
    final backend = FakeBackend(
      lives: <Map<String, dynamic>>[
        _liveJson(id: 'live-001', title: '午市循环草稿', status: 'idle'),
      ],
    );
    await _pumpListPage(tester, backend);
    expect(find.byKey(const Key('liveCard_live-001')), findsOneWidget);

    // 取消：草稿仍在
    await tester.tap(find.byKey(const Key('liveDelete_live-001')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('liveDeleteDialog')), findsOneWidget);
    await tester.tap(find.text('取消'));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('liveCard_live-001')), findsOneWidget);

    // 确认：删除后列表为空
    await tester.tap(find.byKey(const Key('liveDelete_live-001')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('liveDeleteConfirmButton')));
    await tester.pumpAndSettle();

    expect(backend.lives, isEmpty);
    expect(find.byKey(const Key('liveCard_live-001')), findsNothing);
    expect(find.text('还没有开播配置，点击 + 创建第一个草稿'), findsOneWidget);
    expect(find.text('已删除开播配置'), findsOneWidget);

    // 等待 SnackBar 自动消失，避免遗留计时器
    await tester.pump(const Duration(seconds: 5));
    await tester.pumpAndSettle();
  });

  testWidgets('AppBar 右上角 +：跳转到 /lives/new 新建页', (WidgetTester tester) async {
    final backend = FakeBackend();
    await _pumpListRouter(tester, backend);

    expect(find.byKey(const Key('liveListPage')), findsOneWidget);
    await tester.tap(find.byKey(const Key('liveAddButton')));
    await tester.pumpAndSettle();

    expect(find.byKey(const Key('liveFormPage')), findsOneWidget);
    expect(find.text('新建开播配置'), findsOneWidget);
  });

  testWidgets('就绪卡片点「进入监控」跳转现场直播工作台：可一键开始并转直播中', (WidgetTester tester) async {
    final backend = FakeBackend(
      lives: <Map<String, dynamic>>[
        _liveJson(id: 'live-002', title: '晚市就绪直播', status: 'ready'),
      ],
    );
    await _pumpListRouter(tester, backend);

    // G6 收口：列表不再有「开播」，就绪入口统一为「进入监控」
    expect(find.byKey(const Key('liveMonitor_live-002')), findsOneWidget);
    expect(find.byKey(const Key('liveStart_live-002')), findsNothing);

    await tester.tap(find.byKey(const Key('liveMonitor_live-002')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));

    // 工作台停在就绪态：出现「开始直播」主操作，未自动开播
    expect(find.text('现场直播工作台'), findsOneWidget);
    expect(find.byKey(const Key('liveMonitorStartButton')), findsOneWidget);
    expect(find.byKey(const Key('liveEndButton')), findsNothing);
    expect(backend.lives.first['status'], 'ready');

    // 点击开始：后端转 live，工作台进入直播中监控
    await tester.tap(find.byKey(const Key('liveMonitorStartButton')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));
    await tester.pump(const Duration(milliseconds: 50));
    expect(backend.lives.first['status'], 'live');
    expect(find.byKey(const Key('liveEndButton')), findsOneWidget);
    expect(find.byKey(const Key('liveMonitorStartButton')), findsNothing);

    // 收尾：卸载整棵树，取消工作台轮询 / 秒表定时器
    await tester.pumpWidget(const SizedBox());
    await tester.pump(const Duration(seconds: 5));
  });
}
