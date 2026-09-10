import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:starvoice_app/features/lives/presentation/live_form_page.dart';
import 'package:starvoice_app/features/lives/presentation/live_list_page.dart';
import 'package:starvoice_app/features/loop_scripts/presentation/loop_script_library_page.dart';
import 'package:starvoice_app/providers.dart';

import 'fake_backend.dart';

/// 预置一条循环台本（loop-001，3 条合规台词），供绑定点选与摘要断言。
Map<String, dynamic> _loopSeed() {
  final now = DateTime.now().toUtc().toIso8601String();
  return <String, dynamic>{
    'id': 'loop-001',
    'title': '午市循环',
    'sourceScriptId': null,
    'createdAt': now,
    'updatedAt': now,
    'items': <Map<String, dynamic>>[
      <String, dynamic>{
        'id': 'li-1',
        'seq': 1,
        'kind': 'opening',
        'text': '欢迎新进直播间的朋友',
        'gapAfterSeconds': 6,
      },
      <String, dynamic>{
        'id': 'li-2',
        'seq': 2,
        'kind': 'product',
        'text': '双人火锅套餐锅底现炒，欢迎到店品尝',
        'gapAfterSeconds': 8,
      },
      <String, dynamic>{
        'id': 'li-3',
        'seq': 3,
        'kind': 'closing',
        'text': '喜欢的朋友抓紧下单',
        'gapAfterSeconds': 6,
      },
    ],
  };
}

/// 预置草稿开播配置（可带已绑定的循环台本）。
Map<String, dynamic> _liveJson({String? loopScriptId}) {
  final now = DateTime.now().toUtc().toIso8601String();
  return <String, dynamic>{
    'id': 'live-001',
    'title': '火锅店午市循环直播',
    'videoSourceUrl': '',
    'couponId': null,
    'rtmpUrl': null,
    'voiceId': null,
    'scriptId': null,
    'loopScriptId': loopScriptId,
    'status': 'idle',
    'aiBadgeShown': true,
    'startedAt': null,
    'endedAt': null,
    'createdAt': now,
    'updatedAt': now,
  };
}

/// 走真实路由：覆盖「列表 → 表单 → 台本库点选 → 返回绑定」闭环。
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
        path: '/loop-scripts',
        builder: (context, state) => LoopScriptLibraryPage(
          selectable: state.uri.queryParameters['select'] == '1',
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

/// 滚动到目标控件（ListView 子项延迟物化，先滚动再交互更稳）。
Future<void> _scrollTo(WidgetTester tester, Finder finder) async {
  await tester.scrollUntilVisible(
    finder,
    120,
    scrollable: find.byType(Scrollable).first,
  );
  await tester.pumpAndSettle();
}

void main() {
  setUp(() => SharedPreferences.setMockInitialValues(<String, Object>{}));

  testWidgets('新建开播配置：点选循环台本后保存，loopScriptId 落库', (WidgetTester tester) async {
    final backend = FakeBackend(loopScripts: <Map<String, dynamic>>[_loopSeed()]);
    await _pumpListRouter(tester, backend);

    // 进入新建页并填标题
    await tester.tap(find.byKey(const Key('liveAddButton')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('liveFormPage')), findsOneWidget);
    await tester.enterText(
      find.byKey(const Key('liveTitleField')),
      '火锅店午市循环直播',
    );
    await tester.pump();

    // 循环台词区块：未绑状态 → 去台本库点选
    final bindButton = find.byKey(const Key('liveLoopScriptBindButton'));
    await _scrollTo(tester, bindButton);
    expect(find.byKey(const Key('liveLoopScriptEmptyText')), findsOneWidget);
    expect(find.text('循环口播需绑定一条循环台本'), findsOneWidget);
    await tester.tap(bindButton);
    await tester.pumpAndSettle();

    // 台本库选择模式：提示 + 卡片可见，点选返回整本台本
    expect(find.byKey(const Key('loopScriptLibraryPage')), findsOneWidget);
    expect(find.byKey(const Key('loopScriptSelectHint')), findsOneWidget);
    expect(find.byKey(const Key('loopScriptCard_loop-001')), findsOneWidget);
    await tester.tap(find.byKey(const Key('loopScriptCard_loop-001')));
    await tester.pumpAndSettle();

    // 返回表单：已绑摘要 = 标题 + 条数
    expect(find.byKey(const Key('liveFormPage')), findsOneWidget);
    expect(find.text('午市循环 · 3 条'), findsOneWidget);

    // 保存草稿：成功后回列表并落库 loopScriptId
    final saveButton = find.byKey(const Key('liveSaveButton'));
    await _scrollTo(tester, saveButton);
    await tester.tap(saveButton);
    await tester.pumpAndSettle();

    expect(find.byKey(const Key('liveListPage')), findsOneWidget);
    expect(find.byKey(const Key('liveCard_live-001')), findsOneWidget);
    expect(find.text('火锅店午市循环直播'), findsOneWidget);
    expect(backend.lives, hasLength(1));
    expect(backend.lives.single['title'], '火锅店午市循环直播');
    expect(backend.lives.single['loopScriptId'], 'loop-001');
    expect(backend.lives.single['status'], 'idle');
  });

  testWidgets('编辑已绑配置：摘要预填，解绑后保存 loopScriptId 置空', (WidgetTester tester) async {
    final backend = FakeBackend(
      loopScripts: <Map<String, dynamic>>[_loopSeed()],
      lives: <Map<String, dynamic>>[
        _liveJson(loopScriptId: 'loop-001'),
      ],
    );
    await _pumpListRouter(tester, backend);

    // 列表草稿卡 → 编辑页：摘要自动预填
    await tester.tap(find.byKey(const Key('liveEdit_live-001')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('liveFormPage')), findsOneWidget);
    expect(find.text('午市循环 · 3 条'), findsOneWidget);

    // 解绑：回到未绑状态
    await tester.tap(find.byKey(const Key('liveLoopScriptUnbindButton')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('liveLoopScriptEmptyText')), findsOneWidget);

    // 保存：loopScriptId 置空，标题等其余字段保留
    final saveButton = find.byKey(const Key('liveSaveButton'));
    await _scrollTo(tester, saveButton);
    await tester.tap(saveButton);
    await tester.pumpAndSettle();

    expect(find.byKey(const Key('liveListPage')), findsOneWidget);
    expect(backend.lives, hasLength(1));
    expect(backend.lives.single['title'], '火锅店午市循环直播');
    expect(backend.lives.single['loopScriptId'], isNull);
  });
}
