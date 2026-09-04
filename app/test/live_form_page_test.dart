import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';

import 'package:starvoice_app/features/coupons/presentation/coupon_list_page.dart';
import 'package:starvoice_app/features/lives/presentation/live_form_page.dart';
import 'package:starvoice_app/features/lives/presentation/live_list_page.dart';
import 'package:starvoice_app/providers.dart';

import 'fake_backend.dart';

Map<String, dynamic> _voiceJson({
  required String id,
  required String name,
  required String status,
}) {
  return <String, dynamic>{
    'id': id,
    'name': name,
    'status': status,
    'providerVoiceId': 'cosyvoice-mock-$id',
    'sampleDurationSeconds': 200,
    'createdAt': DateTime.now().toUtc().toIso8601String(),
  };
}

Map<String, dynamic> _scriptJson({
  required String id,
  required String title,
  required String status,
}) {
  return <String, dynamic>{
    'id': id,
    'industry': 'restaurant',
    'title': title,
    'productSnapshot': <String, dynamic>{'name': '双人火锅套餐'},
    'content': '双人火锅套餐，锅底现炒，欢迎到店品尝。',
    'status': status,
    'sensitiveCheckStatus': status == 'blocked' ? 'blocked' : 'pass',
    'sensitiveMatchedWords': <String>[],
    'sensitiveScannedAt': DateTime.now().toUtc().toIso8601String(),
    'createdAt': DateTime.now().toUtc().toIso8601String(),
  };
}

Map<String, dynamic> _liveJson({
  required String id,
  required String title,
  String status = 'idle',
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

/// 直接在 MaterialApp 内渲染表单页（不触发保存后 pop 的用例使用）。
Future<void> _pumpFormPage(
  WidgetTester tester,
  FakeBackend backend, {
  String liveId = '',
}) async {
  await tester.pumpWidget(
    ProviderScope(
      overrides: [dioProvider.overrideWithValue(buildMockDio(backend))],
      child: MaterialApp(home: LiveFormPage(liveId: liveId)),
    ),
  );
  await tester.pumpAndSettle();
}

/// 走真实路由：从 /lives 空列表进入新建页，覆盖「保存 → pop → 列表刷新」闭环。
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
        path: '/coupons',
        builder: (context, state) => CouponListPage(
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

/// 便捷断言：查找 key 后校验 widget 类型。
T _widget<T extends Widget>(WidgetTester tester, Key key) {
  return tester.widget<T>(find.byKey(key));
}

void main() {
  testWidgets('新建模式：标题为空 / 纯空白时保存按钮禁用，输入后可用', (WidgetTester tester) async {
    final backend = FakeBackend();
    await _pumpFormPage(tester, backend);

    expect(find.byKey(const Key('liveFormPage')), findsOneWidget);
    expect(find.text('新建开播配置'), findsOneWidget);
    expect(find.text('T11 上传视频后回填，当前置灰'), findsOneWidget);

    // 未输入标题：保存按钮禁用
    var saveButton = _widget<FilledButton>(tester, const Key('liveSaveButton'));
    expect(saveButton.onPressed, isNull);

    // 纯空白标题仍禁用
    await tester.enterText(find.byKey(const Key('liveTitleField')), '   ');
    await tester.pump();
    saveButton = _widget<FilledButton>(tester, const Key('liveSaveButton'));
    expect(saveButton.onPressed, isNull);

    // 输入合法标题后可保存
    await tester.enterText(find.byKey(const Key('liveTitleField')), '火锅店午市循环直播');
    await tester.pump();
    saveButton = _widget<FilledButton>(tester, const Key('liveSaveButton'));
    expect(saveButton.onPressed, isNotNull);
  });

  testWidgets('选择音色 / 话术：仅 ready 可选，选中后展示名称', (WidgetTester tester) async {
    final backend = FakeBackend(
      voices: <Map<String, dynamic>>[
        _voiceJson(id: 'v-ready', name: '主播小美', status: 'ready'),
        _voiceJson(id: 'v-pending', name: '克隆中的声音', status: 'pending'),
      ],
      scripts: <Map<String, dynamic>>[
        _scriptJson(id: 'script-001', title: '火锅套餐话术', status: 'ready'),
        _scriptJson(id: 'script-blocked', title: '命中拦截词', status: 'blocked'),
      ],
    );
    await _pumpFormPage(tester, backend);

    // 选择音色：pending 禁用、ready 可点
    await tester.tap(find.byKey(const Key('liveVoiceSelector')));
    await tester.pumpAndSettle();
    expect(find.text('选择音色（仅「可用」音色可选）'), findsOneWidget);
    expect(
      _widget<ListTile>(tester, const Key('liveVoiceOption_v-pending')).enabled,
      isFalse,
    );
    expect(
      _widget<ListTile>(tester, const Key('liveVoiceOption_v-ready')).enabled,
      isTrue,
    );
    await tester.tap(find.byKey(const Key('liveVoiceOption_v-ready')));
    await tester.pumpAndSettle();
    expect(
      tester.widget<Text>(find.byKey(const Key('liveVoiceValue'))).data,
      '主播小美',
    );

    // 选择话术：blocked 禁用、ready 可点
    await tester.tap(find.byKey(const Key('liveScriptSelector')));
    await tester.pumpAndSettle();
    expect(find.text('选择话术（仅「可开播」话术可选）'), findsOneWidget);
    expect(
      _widget<ListTile>(tester, const Key('liveScriptOption_script-blocked'))
          .enabled,
      isFalse,
    );
    expect(
      _widget<ListTile>(tester, const Key('liveScriptOption_script-001')).enabled,
      isTrue,
    );
    await tester.tap(find.byKey(const Key('liveScriptOption_script-001')));
    await tester.pumpAndSettle();
    expect(
      tester.widget<Text>(find.byKey(const Key('liveScriptValue'))).data,
      '火锅套餐话术',
    );
  });

  testWidgets('编辑模式：标题与音色 / 话术 / 券选择预填', (WidgetTester tester) async {
    final backend = FakeBackend(
      douyinBound: true,
      voices: <Map<String, dynamic>>[
        _voiceJson(id: 'v-ready', name: '主播小美', status: 'ready'),
      ],
      scripts: <Map<String, dynamic>>[
        _scriptJson(id: 'script-001', title: '火锅套餐话术', status: 'ready'),
      ],
      lives: <Map<String, dynamic>>[
        _liveJson(
          id: 'live-001',
          title: '午市循环直播',
          voiceId: 'v-ready',
          scriptId: 'script-001',
          couponId: 'c-001-mock',
        ),
      ],
    );
    await _pumpFormPage(tester, backend, liveId: 'live-001');

    expect(find.text('编辑开播配置'), findsOneWidget);
    final titleField = tester.widget<TextField>(
      find.byKey(const Key('liveTitleField')),
    );
    expect(titleField.controller?.text, '午市循环直播');
    expect(
      tester.widget<Text>(find.byKey(const Key('liveVoiceValue'))).data,
      '主播小美',
    );
    expect(
      tester.widget<Text>(find.byKey(const Key('liveScriptValue'))).data,
      '火锅套餐话术',
    );
    expect(
      tester.widget<Text>(find.byKey(const Key('liveCouponValue'))).data,
      '双人火锅套餐',
    );

    // 合规提示在表单页可见
    expect(
      find.textContaining('「AI 智能直播」角标'),
      findsOneWidget,
    );
  });

  testWidgets('端到端：列表 → 新建（选音色/话术/券）→ 保存 → 返回列表出现草稿', (WidgetTester tester) async {
    final backend = FakeBackend(
      douyinBound: true,
      voices: <Map<String, dynamic>>[
        _voiceJson(id: 'v-ready', name: '主播小美', status: 'ready'),
      ],
      scripts: <Map<String, dynamic>>[
        _scriptJson(id: 'script-001', title: '火锅套餐话术', status: 'ready'),
      ],
    );
    await _pumpListRouter(tester, backend);
    expect(find.byKey(const Key('liveListPage')), findsOneWidget);
    expect(find.text('还没有开播配置，点击 + 创建第一个草稿'), findsOneWidget);

    // 进入新建页
    await tester.tap(find.byKey(const Key('liveAddButton')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('liveFormPage')), findsOneWidget);

    // 填标题
    await tester.enterText(
      find.byKey(const Key('liveTitleField')),
      '火锅店午市循环直播',
    );
    await tester.pump();

    // 选音色
    await tester.tap(find.byKey(const Key('liveVoiceSelector')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('liveVoiceOption_v-ready')));
    await tester.pumpAndSettle();

    // 选话术
    await tester.tap(find.byKey(const Key('liveScriptSelector')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('liveScriptOption_script-001')));
    await tester.pumpAndSettle();

    // 选团购券：push /coupons 点选后 pop 回券 id
    await tester.tap(find.byKey(const Key('liveCouponSelector')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('couponListPage')), findsOneWidget);
    await tester.tap(find.byKey(const Key('couponCard_c-001-mock')));
    await tester.pumpAndSettle();
    expect(
      tester.widget<Text>(find.byKey(const Key('liveCouponValue'))).data,
      '双人火锅套餐',
    );

    // 保存草稿：成功后 pop 回列表并刷新出新卡片
    final saveButton = find.byKey(const Key('liveSaveButton'));
    await _scrollTo(tester, saveButton);
    await tester.tap(saveButton);
    await tester.pumpAndSettle();

    expect(find.byKey(const Key('liveListPage')), findsOneWidget);
    expect(find.byKey(const Key('liveCard_live-001')), findsOneWidget);
    expect(find.text('火锅店午市循环直播'), findsOneWidget);
    expect(find.text('草稿'), findsOneWidget);
    expect(find.text('音色：主播小美 · 话术：火锅套餐话术 · 券：双人火锅套餐'), findsOneWidget);

    // 服务端落库语义：status=idle、合规角标恒为 true、绑定字段完整
    expect(backend.lives, hasLength(1));
    final created = backend.lives.single;
    expect(created['title'], '火锅店午市循环直播');
    expect(created['status'], 'idle');
    expect(created['aiBadgeShown'], isTrue);
    expect(created['voiceId'], 'v-ready');
    expect(created['scriptId'], 'script-001');
    expect(created['couponId'], 'c-001-mock');
  });
}