import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:starvoice_app/features/coupons/presentation/coupon_list_page.dart';
import 'package:starvoice_app/features/lives/presentation/live_form_page.dart';
import 'package:starvoice_app/features/lives/presentation/live_list_page.dart';
import 'package:starvoice_app/core/network/api_client.dart';
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
  String videoSourceUrl = '',
  String? voiceId,
  String? volcPresetId,
  int? speechRate,
  String? scriptId,
  String? couponId,
}) {
  final now = DateTime.now().toUtc();
  return <String, dynamic>{
    'id': id,
    'title': title,
    'videoSourceUrl': videoSourceUrl,
    'couponId': couponId,
    'rtmpUrl': null,
    'voiceId': voiceId,
    'volcPresetId': volcPresetId,
    'speechRate': speechRate,
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

/// 向上滚动到目标控件（配合 _scrollTo 在顶部输入框与底部按钮间来回切换）。
Future<void> _scrollUpTo(WidgetTester tester, Finder finder) async {
  await tester.scrollUntilVisible(
    finder,
    -120,
    scrollable: find.byType(Scrollable).first,
  );
  await tester.pumpAndSettle();
}

/// 便捷断言：查找 key 后校验 widget 类型。
T _widget<T extends Widget>(WidgetTester tester, Key key) {
  return tester.widget<T>(find.byKey(key));
}

void main() {
  // 开播表单会读写音色本地缓存（服务端为准、本地回落），测试统一用内存实现隔离
  setUp(() => SharedPreferences.setMockInitialValues(<String, Object>{}));

  testWidgets('新建模式：标题为空 / 纯空白时保存按钮禁用，输入后可用', (WidgetTester tester) async {
    final backend = FakeBackend();
    await _pumpFormPage(tester, backend);

    expect(find.byKey(const Key('liveFormPage')), findsOneWidget);
    expect(find.text('新建开播配置'), findsOneWidget);
    // 新建草稿尚无 liveId，开播准备区提示先保存、再从列表进入编辑后操作
    await _scrollTo(tester, find.byKey(const Key('liveReadyNewModeHint')));
    expect(
      find.byKey(const Key('liveReadyNewModeHint')),
      findsOneWidget,
    );

    // 保存按钮位于表单底部，先滚动到视野内再取控件
    final saveButtonFinder = find.byKey(const Key('liveSaveButton'));
    final titleFieldFinder = find.byKey(const Key('liveTitleField'));

    // 未输入标题：保存按钮禁用
    await _scrollTo(tester, saveButtonFinder);
    var saveButton = _widget<FilledButton>(tester, const Key('liveSaveButton'));
    expect(saveButton.onPressed, isNull);

    // 纯空白标题仍禁用
    await _scrollUpTo(tester, titleFieldFinder);
    await tester.enterText(titleFieldFinder, '   ');
    await tester.pump();
    await _scrollTo(tester, saveButtonFinder);
    saveButton = _widget<FilledButton>(tester, const Key('liveSaveButton'));
    expect(saveButton.onPressed, isNull);

    // 输入合法标题后可保存
    await _scrollUpTo(tester, titleFieldFinder);
    await tester.enterText(titleFieldFinder, '火锅店午市循环直播');
    await tester.pump();
    await _scrollTo(tester, saveButtonFinder);
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
    expect(find.text('选择音色'), findsOneWidget);
    expect(find.text('我的音色（克隆）'), findsOneWidget);
    expect(find.text('火山预设音色'), findsOneWidget);
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
    await _scrollTo(tester, find.textContaining('「AI 智能直播」角标'));
    expect(
      find.textContaining('「AI 智能直播」角标'),
      findsOneWidget,
    );
  });

  testWidgets('编辑模式：克隆音色就绪 → 「纯 AI 就绪开播」可点，就绪后状态推进并防重复', (WidgetTester tester) async {
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

    // 无需实景视频：绑定可用克隆音色即进入「纯 AI 就绪开播」入口
    final prepareButtonFinder = find.byKey(const Key('livePrepareButton'));
    await _scrollTo(tester, prepareButtonFinder);
    expect(find.byKey(const Key('liveReadySection')), findsOneWidget);
    expect(
      tester.widget<Text>(find.byKey(const Key('liveReadyStatusText'))).data,
      '已绑定音色，可直接就绪开播',
    );
    expect(find.text('纯 AI 就绪开播'), findsOneWidget);
    expect(
      _widget<FilledButton>(tester, const Key('livePrepareButton')).onPressed,
      isNotNull,
    );

    // 点击就绪：真实调用 prepareLive（服务端前置校验），纯 AI 不触发视频合成
    await tester.tap(prepareButtonFinder);
    await tester.pumpAndSettle();

    expect(backend.lives.single['status'], 'ready');
    expect(backend.lives.single['videoSourceUrl'], isEmpty);
    expect(
      tester.widget<Text>(find.byKey(const Key('liveReadyStatusText'))).data,
      '已就绪，可进入工作台开播',
    );
    expect(find.text('已就绪，可进入工作台开播'), findsWidgets);

    // 已就绪后按钮置灰，防止重复就绪
    expect(
      _widget<FilledButton>(tester, const Key('livePrepareButton')).onPressed,
      isNull,
    );

    // 等待 SnackBar 自动消失，避免遗留计时器
    await tester.pump(const Duration(seconds: 5));
    await tester.pumpAndSettle();
  });

  testWidgets('未绑定可用音色：开播准备提示先绑音色且就绪按钮置灰', (WidgetTester tester) async {
    final backend = FakeBackend(
      douyinBound: true,
      scripts: <Map<String, dynamic>>[
        _scriptJson(id: 'script-001', title: '火锅套餐话术', status: 'ready'),
      ],
      lives: <Map<String, dynamic>>[
        _liveJson(
          id: 'live-001',
          title: '午市循环直播',
          scriptId: 'script-001',
          couponId: 'c-001-mock',
        ),
      ],
    );
    await _pumpFormPage(tester, backend, liveId: 'live-001');

    final prepareButtonFinder = find.byKey(const Key('livePrepareButton'));
    await _scrollTo(tester, prepareButtonFinder);
    expect(
      tester.widget<Text>(find.byKey(const Key('liveReadyStatusText'))).data,
      '尚未绑定可用音色，先在上方选择后即可就绪',
    );
    expect(
      _widget<FilledButton>(tester, const Key('livePrepareButton')).onPressed,
      isNull,
    );
  });

  test('ApiClient.uploadLiveVideo：multipart 真实上传临时文件后回填 videoSourceUrl', () async {
    final tempDir = await Directory.systemTemp.createTemp('starvoice_upload_');
    addTearDown(() async {
      // Windows 下 dio 可能短暂持有文件句柄，重试几次再清理，避免偶发占用失败
      for (var attempt = 0; attempt < 20; attempt++) {
        try {
          await tempDir.delete(recursive: true);
          return;
        } on FileSystemException {
          await Future<void>.delayed(const Duration(milliseconds: 100));
        }
      }
    });
    final file = File(
      '${tempDir.path}${Platform.pathSeparator}scene.mp4',
    )..writeAsBytesSync(<int>[0, 1, 2, 3, 4]);

    final backend = FakeBackend(
      douyinBound: true,
      lives: <Map<String, dynamic>>[
        _liveJson(id: 'live-001', title: '午市循环直播'),
      ],
    );
    final client = ApiClient(buildMockDio(backend));

    final live = await client.uploadLiveVideo('live-001', file.path);

    expect(live.videoSourceUrl, '/uploads/videos/live-001.mp4');
    expect(backend.lives.single['videoSourceUrl'], '/uploads/videos/live-001.mp4');
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
    await _scrollTo(tester, find.byKey(const Key('liveCouponSelector')));
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

  testWidgets('端到端：新建选火山预设音色 → 保存 → 列表摘要展示预设且 voiceId 为空', (WidgetTester tester) async {
    final backend = FakeBackend(
      douyinBound: true,
      scripts: <Map<String, dynamic>>[
        _scriptJson(id: 'script-001', title: '火锅套餐话术', status: 'ready'),
      ],
    );
    await _pumpListRouter(tester, backend);
    expect(find.text('还没有开播配置，点击 + 创建第一个草稿'), findsOneWidget);

    // 进入新建页并填标题
    await tester.tap(find.byKey(const Key('liveAddButton')));
    await tester.pumpAndSettle();
    await tester.enterText(
      find.byKey(const Key('liveTitleField')),
      '火锅店午市循环直播',
    );
    await tester.pump();

    // 音色选火山预设：无克隆音色时只展示预设组，选中后展示「名称（火山预设）」
    await tester.tap(find.byKey(const Key('liveVoiceSelector')));
    await tester.pumpAndSettle();
    expect(find.text('火山预设音色'), findsOneWidget);
    await tester.tap(
      find.byKey(const Key('livePresetOption_zh_female_vv_uranus_bigtts')),
    );
    await tester.pumpAndSettle();
    expect(
      tester.widget<Text>(find.byKey(const Key('liveVoiceValue'))).data,
      'Vivi 2.0（火山预设）',
    );

    // 绑定就绪话术
    await tester.tap(find.byKey(const Key('liveScriptSelector')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('liveScriptOption_script-001')));
    await tester.pumpAndSettle();

    // 保存草稿：pop 回列表并展示火山预设摘要
    final saveButton = find.byKey(const Key('liveSaveButton'));
    await _scrollTo(tester, saveButton);
    await tester.tap(saveButton);
    await tester.pumpAndSettle();

    expect(find.byKey(const Key('liveCard_live-001')), findsOneWidget);
    expect(find.textContaining('音色：Vivi 2.0（火山预设）'), findsOneWidget);
    // 落库语义：预设 id 落库、克隆音色互斥置空
    final created = backend.lives.single;
    expect(created['volcPresetId'], 'zh_female_vv_uranus_bigtts');
    expect(created['voiceId'], isNull);
    expect(created['scriptId'], 'script-001');
  });

  testWidgets('纯 AI 就绪开播：火山预设音色 + 无实景视频 → prepare 直接 ready 且不合成回填', (WidgetTester tester) async {
    final backend = FakeBackend(
      douyinBound: true,
      scripts: <Map<String, dynamic>>[
        _scriptJson(id: 'script-001', title: '火锅套餐话术', status: 'ready'),
      ],
      lives: <Map<String, dynamic>>[
        _liveJson(
          id: 'live-001',
          title: '火锅店循环直播',
          status: 'idle',
          volcPresetId: 'zh_female_vv_uranus_bigtts',
          scriptId: 'script-001',
        ),
      ],
    );
    await _pumpFormPage(tester, backend, liveId: 'live-001');

    // 编辑预填：音色值展示火山预设；无需实景视频即展示纯 AI 就绪入口
    expect(
      tester.widget<Text>(find.byKey(const Key('liveVoiceValue'))).data,
      'Vivi 2.0（火山预设）',
    );
    final prepareButton = find.byKey(const Key('livePrepareButton'));
    await _scrollTo(tester, prepareButton);
    expect(find.text('纯 AI 就绪开播'), findsOneWidget);
    expect(
      tester.widget<Text>(find.byKey(const Key('liveReadyStatusText'))).data,
      '已绑定音色，可直接就绪开播',
    );

    await tester.tap(prepareButton);
    await tester.pumpAndSettle();

    expect(backend.lives.single['status'], 'ready');
    // 纯 AI 就绪不触发视频合成：videoSourceUrl 保持空、无 /uploads/lives 回填
    expect(backend.lives.single['videoSourceUrl'], isEmpty);
    expect(
      tester.widget<Text>(find.byKey(const Key('liveReadyStatusText'))).data,
      '已就绪，可进入工作台开播',
    );
    expect(find.text('已就绪，可进入工作台开播'), findsWidgets);
    // 已就绪后按钮置灰，防止重复就绪
    expect(
      _widget<FilledButton>(tester, const Key('livePrepareButton')).onPressed,
      isNull,
    );

    // 等待 SnackBar 自动消失，避免遗留计时器
    await tester.pump(const Duration(seconds: 5));
    await tester.pumpAndSettle();
  });

  testWidgets('口播语速：默认 50（很快），拖动滑块后随保存请求落库', (WidgetTester tester) async {
    final backend = FakeBackend(
      douyinBound: true,
      voices: <Map<String, dynamic>>[
        _voiceJson(id: 'v-ready', name: '主播小美', status: 'ready'),
      ],
    );
    await _pumpListRouter(tester, backend);

    await tester.tap(find.byKey(const Key('liveAddButton')));
    await tester.pumpAndSettle();

    // 标题在列表顶部，先填再滚动，避免输入框被滚出视口
    await tester.enterText(
      find.byKey(const Key('liveTitleField')),
      '火锅店晚间循环直播',
    );
    await tester.pump();

    // 默认档：50（很快），滑块与展示值一致
    final sliderFinder = find.byKey(const Key('liveSpeechRateSlider'));
    await _scrollTo(tester, sliderFinder);
    expect(
      tester.widget<Slider>(sliderFinder).value,
      50,
    );
    expect(
      tester.widget<Text>(find.byKey(const Key('liveSpeechRateValue'))).data,
      '50',
    );

    // 拖动到 80 档：直接触发 onChanged，避免像素级拖拽不稳定
    tester.widget<Slider>(sliderFinder).onChanged!(80);
    await tester.pump();
    expect(
      tester.widget<Text>(find.byKey(const Key('liveSpeechRateValue'))).data,
      '80',
    );

    // 保存：请求体带上当前档位
    final saveButton = find.byKey(const Key('liveSaveButton'));
    await _scrollTo(tester, saveButton);
    await tester.tap(saveButton);
    await tester.pumpAndSettle();

    expect(backend.lives, hasLength(1));
    expect(backend.lives.single['speechRate'], 80);
  });

  testWidgets('编辑模式：语速回填服务端已设档位', (WidgetTester tester) async {
    final backend = FakeBackend(
      douyinBound: true,
      lives: <Map<String, dynamic>>[
        _liveJson(id: 'live-001', title: '午市循环直播', speechRate: 88),
      ],
    );
    await _pumpFormPage(tester, backend, liveId: 'live-001');
    final sliderFinder = find.byKey(const Key('liveSpeechRateSlider'));
    await _scrollTo(tester, sliderFinder);
    expect(tester.widget<Slider>(sliderFinder).value, 88);
  });
}
