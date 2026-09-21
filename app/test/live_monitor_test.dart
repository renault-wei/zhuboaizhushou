/// 现场直播工作台（LiveMonitorPage）Widget 冒烟测试：
/// 真人出镜 + 后台 AI 语音主播形态下的直播间控制台渲染与测试弹幕注入。
/// 页面进入后启动 3s 轮询与 1s 本地秒表定时器，用例不得用 pumpAndSettle
/// （直播中帧会持续刷新），统一用固定时长的 pump 并在收尾卸载页面取消定时器。
library;

import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:starvoice_app/core/network/api_client.dart';
import 'package:starvoice_app/features/assistant_speaker/application/assistant_speaker_controller.dart';
import 'package:starvoice_app/features/assistant_speaker/application/speech_out_player.dart';
import 'package:starvoice_app/features/lives/presentation/live_monitor_page.dart';
import 'package:starvoice_app/features/loop_scripts/presentation/loop_script_library_page.dart';
import 'package:starvoice_app/providers.dart';

import 'fake_backend.dart';

/// 出声卡测试用假播放器：不碰真实音频通道，仅记录启停。
class _FakeSpeechOutPlayer implements SpeechOutPlayer {
  @override
  Future<void> play(Uint8List wavBytes) async {}

  @override
  Future<void> playUrl(String url) async {}

  @override
  Future<void> stop() async {}

  @override
  Future<void> dispose() async {}
}

Map<String, dynamic> _liveJson({
  required String id,
  required String title,
  required String status,
  String? startedAt,
  String? endedAt,
}) {
  final now = DateTime.now().toUtc();
  return <String, dynamic>{
    'id': id,
    'title': title,
    'videoSourceUrl': '',
    'couponId': null,
    'rtmpUrl': null,
    'voiceId': null,
    'scriptId': null,
    'status': status,
    'aiBadgeShown': true,
    'startedAt': startedAt,
    'endedAt': endedAt,
    'createdAt': now.toIso8601String(),
    'updatedAt': now.toIso8601String(),
  };
}

Map<String, dynamic> _danmakuJson({
  required String liveId,
  required String id,
  required String content,
}) {
  return <String, dynamic>{
    'id': id,
    'liveId': liveId,
    'content': content,
    'senderNickname': '测试观众',
    'sentAt': DateTime.now().toUtc().toIso8601String(),
  };
}

/// 预置一条循环台本（loop-001），供「更新话术」点选换绑。
/// 内置一条话术假数据（镜像服务端 /api/scripts 返回结构）；status=blocked 时
/// sensitiveCheckStatus 同步为 blocked，用于覆盖「未过审话术不可热更」分支。
Map<String, dynamic> _scriptSeed({
  required String id,
  required String title,
  String status = 'ready',
}) {
  final now = DateTime.now().toUtc().toIso8601String();
  return <String, dynamic>{
    'id': id,
    'industry': 'restaurant',
    'title': title,
    'productSnapshot': <String, dynamic>{'name': '双人火锅套餐'},
    'content': '双人火锅套餐，锅底现炒，欢迎到店品尝。',
    'status': status,
    'sensitiveCheckStatus': status == 'blocked' ? 'blocked' : 'pass',
    'sensitiveMatchedWords': <String>[],
    'sensitiveScannedAt': now,
    'createdAt': now,
  };
}

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
    ],
  };
}

/// 走真实路由渲染工作台：覆盖「更新话术 → 台本库点选 → 换绑」闭环。
/// 页面内含 3s 轮询与 1s 秒表定时器，故全程用固定 pump，不用 pumpAndSettle。
Future<void> _pumpMonitorRouter(WidgetTester tester, FakeBackend backend) async {
  SharedPreferences.setMockInitialValues(const <String, Object>{});
  tester.view.physicalSize = const Size(1200, 2600);
  tester.view.devicePixelRatio = 1.0;
  addTearDown(tester.view.reset);
  final router = GoRouter(
    initialLocation: '/lives/live-001/monitor',
    routes: <RouteBase>[
      GoRoute(
        path: '/lives/:id/monitor',
        builder: (context, state) =>
            LiveMonitorPage(liveId: state.pathParameters['id'] ?? ''),
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
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 50));
  await tester.pump(const Duration(milliseconds: 50));
}

/// 渲染现场直播工作台并等待首次 monitor / danmaku 返回。
Future<void> _pumpMonitor(
  WidgetTester tester,
  FakeBackend backend, {
  List<Override> overrides = const <Override>[],
  Map<String, Object> initialPrefs = const <String, Object>{},
}) async {
  SharedPreferences.setMockInitialValues(initialPrefs);
  // 放大测试视口：让弹幕日志区也处于可视区（ListView 懒构建，默认视口可能不渲染）
  tester.view.physicalSize = const Size(1200, 2600);
  tester.view.devicePixelRatio = 1.0;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(
    ProviderScope(
      overrides: <Override>[
        dioProvider.overrideWithValue(buildMockDio(backend)),
        ...overrides,
      ],
      child: const MaterialApp(home: LiveMonitorPage(liveId: 'live-001')),
    ),
  );
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 50));
  await tester.pump(const Duration(milliseconds: 50));
}

/// 卸载页面：取消页内轮询 / 本地秒表 / 弹层计时器，避免收尾残留定时器。
Future<void> _unmount(WidgetTester tester) async {
  await tester.pumpWidget(const SizedBox());
  await tester.pump(const Duration(seconds: 5));
}

void main() {
  testWidgets('直播中：工作台展示状态、AI 语音主播卡、合规提示与既有弹幕', (tester) async {
    final backend = FakeBackend(
      lives: <Map<String, dynamic>>[
        _liveJson(id: 'live-001', title: '午市火锅直播', status: 'live'),
      ],
      danmaku: <Map<String, dynamic>>[
        _danmakuJson(liveId: 'live-001', id: 'dm-001', content: '双人套餐多少钱？'),
      ],
    );
    await _pumpMonitor(tester, backend);

    // 标题与状态区
    expect(find.text('现场直播工作台'), findsOneWidget);
    expect(find.byKey(const Key('liveMonitorStatus')), findsOneWidget);
    expect(find.text('直播中'), findsWidgets);
    expect(find.byKey(const Key('liveMonitorDuration')), findsOneWidget);

    // AI 语音主播卡：播报中（真人出镜 + 后台语音）
    expect(find.text('AI 语音主播'), findsOneWidget);
    expect(find.text('播报中'), findsOneWidget);
    expect(find.text('真人出镜现场，AI 语音主播在后台实时朗读弹幕、介绍产品并回复提问。'), findsOneWidget);

    // 测试弹幕入口 + 合规角标恒显
    expect(find.byKey(const Key('liveMonitorTestInput')), findsOneWidget);
    expect(find.byKey(const Key('liveMonitorTestSend')), findsOneWidget);
    expect(find.byKey(const Key('liveMonitorBadgeNote')), findsOneWidget);
    // 直播中不再展示「开播前自检」引导卡（仅就绪态出现）
    expect(find.byKey(const Key('liveMonitorPreflight')), findsNothing);

    // 既有弹幕日志
    expect(find.text('双人套餐多少钱？'), findsOneWidget);
    expect(find.text('弹幕 1 条'), findsOneWidget);

    await _unmount(tester);
  });

  testWidgets('发送测试弹幕：写入后端并出现在日志，AI 语音触发提示', (tester) async {
    final backend = FakeBackend(
      lives: <Map<String, dynamic>>[
        _liveJson(id: 'live-001', title: '午市火锅直播', status: 'live'),
      ],
    );
    await _pumpMonitor(tester, backend);

    // 空内容：发送按钮禁用
    final sendBefore = tester.widget<FilledButton>(
      find.byKey(const Key('liveMonitorTestSend')),
    );
    expect(sendBefore.onPressed, isNull);

    await tester.enterText(
      find.byKey(const Key('liveMonitorTestInput')),
      '这个套餐怎么卖？',
    );
    await tester.pump();

    // 有内容：发送按钮可点
    final sendAfter = tester.widget<FilledButton>(
      find.byKey(const Key('liveMonitorTestSend')),
    );
    expect(sendAfter.onPressed, isNotNull);

    await tester.tap(find.byKey(const Key('liveMonitorTestSend')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));
    await tester.pump(const Duration(milliseconds: 50));

    // 后端收到弹幕（模拟 G3 写入，服务端会广播给 AI 引擎与语音出口）
    expect(backend.danmaku, hasLength(1));
    expect(backend.danmaku.first['content'], '这个套餐怎么卖？');
    expect(find.text('测试弹幕已发送，AI 语音主播开始回复'), findsOneWidget);

    // 发送后立即刷新，日志区出现新弹幕
    await tester.pump(const Duration(milliseconds: 50));
    expect(find.text('这个套餐怎么卖？'), findsOneWidget);

    await _unmount(tester);
  });

  testWidgets('R61：进入直播就自动出声 —— 不需要任何设置（原「常开记忆」已移除）', (tester) async {
    final backend = FakeBackend(
      lives: <Map<String, dynamic>>[
        _liveJson(id: 'live-001', title: '午市火锅直播', status: 'live'),
      ],
    );
    final speakerController = AssistantSpeakerController(
      ApiClient(buildMockDio(backend)),
      _FakeSpeechOutPlayer(),
    );
    await _pumpMonitor(
      tester,
      backend,
      overrides: <Override>[
        assistantSpeakerControllerProvider.overrideWith(
          (ref) => speakerController,
        ),
      ],
    );
    await tester.pump(const Duration(milliseconds: 120));

    // R61：不再需要商家「开启」。助播机是一段看不见的保活 ——
    // 装上、开播、有声音。原先要先读一个本地「常开」偏好，等于把
    // 「要不要出声」推给商家，而他既没能力判断也不该关心。
    expect(speakerController.state.enabled, isTrue);

    await _unmount(tester);
    speakerController.dispose();
  });

  testWidgets('R61：一切正常时，界面不出现任何出声管理入口（开关/卡片都没有）', (tester) async {
    final backend = FakeBackend(
      lives: <Map<String, dynamic>>[
        _liveJson(id: 'live-001', title: '午市火锅直播', status: 'live'),
      ],
    );
    await _pumpMonitor(tester, backend);
    await tester.pump(const Duration(milliseconds: 120));

    // 「助播机」这个概念已经不在界面上了：没有卡片、没有开关、没有累计播报。
    expect(find.byKey(const Key('liveMonitorSpeakerCard')), findsNothing);
    expect(find.byKey(const Key('liveMonitorSpeakerSwitch')), findsNothing);
    expect(find.text('助播机出声（手机线）'), findsNothing);
    // 正常时连告警也不该有
    expect(find.byKey(const Key('liveMonitorSpeakerStaleWarn')), findsNothing);

    await _unmount(tester);
  });
  testWidgets('直播中 + 循环播报：AI 主播卡展示当前条 / 轮（M5）', (tester) async {
    final liveJson = _liveJson(id: 'live-001', title: '午市火锅直播', status: 'live');
    liveJson['loopRunning'] = true;
    liveJson['loopRound'] = 2;
    liveJson['loopCurrentSeq'] = 3;
    final backend = FakeBackend(lives: <Map<String, dynamic>>[liveJson]);
    await _pumpMonitor(tester, backend);

    // 状态胶囊：循环播报中 · 第 3 条 / 第 2 轮
    expect(find.text('循环播报中 · 第 3 条 / 第 2 轮'), findsOneWidget);
    expect(find.textContaining('正在按台本循环介绍产品'), findsOneWidget);

    await _unmount(tester);
  });

  testWidgets('直播中未绑定循环台本：AI 主播卡提示仅弹幕回复（M5）', (tester) async {
    final liveJson = _liveJson(id: 'live-001', title: '午市火锅直播', status: 'live');
    liveJson['loopMissing'] = true;
    final backend = FakeBackend(lives: <Map<String, dynamic>>[liveJson]);
    await _pumpMonitor(tester, backend);

    expect(find.text('播报中'), findsOneWidget);
    expect(find.textContaining('未绑定循环台本（仅弹幕回复）'), findsOneWidget);

    await _unmount(tester);
  });

  testWidgets('直播中结束：结算弹层展示本场分钟抵扣，余额同步扣减（按分钟计费）', (tester) async {
    final backend = FakeBackend(
      lives: <Map<String, dynamic>>[
        _liveJson(
          id: 'live-001',
          title: '午市火锅直播',
          status: 'live',
          startedAt: DateTime.now()
              .toUtc()
              .subtract(const Duration(minutes: 10))
              .toIso8601String(),
        ),
      ],
    );
    await _pumpMonitor(tester, backend);
    expect(find.byKey(const Key('liveEndButton')), findsOneWidget);
    expect(backend.balanceMinutes, 120);

    // 点击结束并确认
    await tester.tap(find.byKey(const Key('liveEndButton')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));
    expect(find.byKey(const Key('liveEndDialog')), findsOneWidget);
    await tester.tap(find.byKey(const Key('liveEndConfirmButton')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));
    await tester.pump(const Duration(milliseconds: 50));

    // 结算弹层：本场 10 分钟先扣余额；不点「知道了」，页面由测试卸载收尾
    expect(find.byKey(const Key('liveEndSummaryDialog')), findsOneWidget);
    expect(find.text('本场结算'), findsOneWidget);
    expect(find.textContaining('共结算 10 分钟'), findsOneWidget);
    expect(find.textContaining('时长余额抵扣 10 分钟'), findsOneWidget);
    expect(backend.balanceMinutes, 110);
    expect(backend.lives.single['status'], 'ended');

    await _unmount(tester);
  });

  testWidgets('直播中热更循环台词：点选台本后换绑并在下一轮生效（M4）', (tester) async {
    final backend = FakeBackend(
      lives: <Map<String, dynamic>>[
        _liveJson(id: 'live-001', title: '午市火锅直播', status: 'live'),
      ],
      loopScripts: <Map<String, dynamic>>[_loopSeed()],
    );
    await _pumpMonitorRouter(tester, backend);

    // 直播中才有热更入口；点入台本库选择模式
    expect(find.byKey(const Key('liveMonitorUpdateLoopButton')), findsOneWidget);
    await tester.tap(find.byKey(const Key('liveMonitorUpdateLoopButton')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 350));
    await tester.pump(const Duration(milliseconds: 350));
    expect(find.byKey(const Key('loopScriptLibraryPage')), findsOneWidget);

    // 点选整本台本 → 返回工作台 → 服务端换绑 + 提示
    await tester.tap(find.byKey(const Key('loopScriptCard_loop-001')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 350));
    await tester.pump(const Duration(milliseconds: 350));
    await tester.pump(const Duration(milliseconds: 100));

    expect(backend.lives.single['loopScriptId'], 'loop-001');
    expect(find.text('循环台词已更新，将在下一轮生效'), findsOneWidget);

    await _unmount(tester);
  });

  testWidgets('直播中热更话术：选「可开播」话术后换绑（新弹幕立即生效）', (tester) async {
    final backend = FakeBackend(
      lives: <Map<String, dynamic>>[
        _liveJson(id: 'live-001', title: '午市火锅直播', status: 'live'),
      ],
      scripts: <Map<String, dynamic>>[
        _scriptSeed(id: 'script-001', title: '火锅话术'),
        _scriptSeed(id: 'script-002', title: '未过审话术', status: 'blocked'),
      ],
    );
    await _pumpMonitorRouter(tester, backend);

    expect(
      find.byKey(const Key('liveMonitorUpdateScriptButton')),
      findsOneWidget,
    );
    await tester.tap(find.byKey(const Key('liveMonitorUpdateScriptButton')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 350));
    await tester.pump(const Duration(milliseconds: 350));

    // 仅「可开播」话术可选：未过审话术不出现在弹窗
    expect(find.byKey(const Key('liveMonitorScriptOption_script-001')),
        findsOneWidget);
    expect(find.byKey(const Key('liveMonitorScriptOption_script-002')),
        findsNothing);

    await tester.tap(find.byKey(const Key('liveMonitorScriptOption_script-001')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 350));
    await tester.pump(const Duration(milliseconds: 100));

    expect(backend.lives.single['scriptId'], 'script-001');
    expect(find.text('话术已更新，新弹幕将用新话术回复'), findsOneWidget);

    await _unmount(tester);
  });

  testWidgets('弹幕采集卡：贴分享链接起采集 → 监听中 → 可停止（R2 · D4.1）', (tester) async {
    final backend = FakeBackend(
      lives: <Map<String, dynamic>>[
        _liveJson(id: 'live-001', title: '午市火锅直播', status: 'live'),
      ],
    );
    await _pumpMonitor(tester, backend);

    // 未绑定：卡片在，给出输入框与「开始采集」，没有停止按钮
    expect(find.byKey(const Key('liveMonitorSourceCard')), findsOneWidget);
    expect(find.byKey(const Key('liveMonitorSourceInput')), findsOneWidget);
    expect(find.byKey(const Key('liveMonitorSourceStop')), findsNothing);

    final input = find.byKey(const Key('liveMonitorSourceInput'));
    await tester.ensureVisible(input);
    await tester.enterText(input, 'https://live.douyin.com/7686117195721837352');
    await tester.pump();

    final bindButton = find.byKey(const Key('liveMonitorSourceBind'));
    await tester.ensureVisible(bindButton);
    await tester.tap(bindButton);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 350));
    await tester.pump(const Duration(milliseconds: 350));

    // 绑定后（R49 起）：**输入框仍在**（贴新链接即可换直播间，服务端会先断旧会话），
    // 同时出现停止按钮与「换链接」按钮；状态行报「监听中 · 已收到 N 条」。
    // 改这条断言是**有意的** —— 原先「绑定后输入框收起」导致换直播间只能先停止再粘，
    // 既绕又容易停在半路，用户 2026-09-17 要求改成可直接换。
    expect(find.byKey(const Key('liveMonitorSourceInput')), findsOneWidget);
    expect(find.byKey(const Key('liveMonitorSourceStop')), findsOneWidget);
    expect(find.text('换链接'), findsOneWidget);
    final stateText = tester.widget<Text>(
      find.byKey(const Key('liveMonitorSourceState')),
    );
    expect(stateText.data, contains('监听中'));
    // 房间号来自分享文本，由服务端解析后回填
    expect(stateText.data, contains('7686117195721837352'));

    final stopButton = find.byKey(const Key('liveMonitorSourceStop'));
    await tester.ensureVisible(stopButton);
    await tester.tap(stopButton);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 350));
    await tester.pump(const Duration(milliseconds: 350));

    // 停止后回到未绑定态
    expect(find.byKey(const Key('liveMonitorSourceInput')), findsOneWidget);

    await _unmount(tester);
  });

  testWidgets('R50：场次被删后监控页给出出口，而不是永久卡死（实测踩到的现场）', (tester) async {
    final backend = FakeBackend(
      lives: <Map<String, dynamic>>[
        _liveJson(id: 'live-001', title: '午市火锅直播', status: 'live'),
      ],
    );
    await _pumpMonitor(tester, backend);
    // 正常进入：直播中底部有「结束直播」
    expect(find.byKey(const Key('liveEndButton')), findsOneWidget);

    // 模拟「场次在别处被删除」—— 2026-09-17 我验 R49 时就是这么删掉测试场次的：
    // 页面**已经加载成功过**（_monitor 非空），之后每次轮询都 404。
    backend.lives.clear();

    // 推过 3s 轮询间隔，让下一次轮询拿到 404
    await tester.pump(const Duration(seconds: 4));
    await tester.pump(const Duration(milliseconds: 400));

    // 修复前：错误分支只在 _monitor == null 时置 error → 静默重试、永久卡在旧数据上
    // （实测 10 分钟 283 次请求 / 215 次 404，用户只能杀掉 App）。
    expect(find.byKey(const Key('liveMonitorGoneText')), findsOneWidget);
    expect(find.byKey(const Key('liveMonitorGoneBack')), findsOneWidget);
    // 关键：不再出现点了也没用的「结束直播」
    expect(find.byKey(const Key('liveEndButton')), findsNothing);

    await _unmount(tester);
  });

  testWidgets('R51：采集连着但长时间零事件 → 采集卡给出警示（实测踩到的「看着正常」）', (tester) async {
    final backend = FakeBackend(
      lives: <Map<String, dynamic>>[
        _liveJson(id: 'live-001', title: '午市火锅直播', status: 'live'),
      ],
    );
    // 采集已绑定，但**5 分钟前就连上了、至今一个事件都没收到** ——
    // 2026-09-18 的真实现场：商家下播重开、房间号变了，我们连着旧房间。
    backend.danmakuSource = <String, dynamic>{
      'liveId': 'live-001',
      'platform': 'douyin',
      'roomRef': '7123456789012345678',
      'watchKey': 'douyin:douyin:7123456789012345678',
      'startedAt': DateTime.now()
          .toUtc()
          .subtract(const Duration(minutes: 5))
          .toIso8601String(),
    };
    backend.danmakuSourceEventCount = 0;
    backend.danmakuSourceLastEventAt = null;

    await _pumpMonitor(tester, backend);
    final card = find.byKey(const Key('liveMonitorSourceCard'));
    await tester.ensureVisible(card);
    await tester.pump();

    expect(find.byKey(const Key('liveMonitorSourceIdleWarn')), findsOneWidget);
    expect(find.textContaining('分钟没收到任何弹幕'), findsOneWidget);
    expect(find.textContaining('换链接'), findsWidgets);

    await _unmount(tester);
  });

  testWidgets('R51：刚连上还没事件时不误报（避免正常情况就弹黄条）', (tester) async {
    final backend = FakeBackend(
      lives: <Map<String, dynamic>>[
        _liveJson(id: 'live-001', title: '午市火锅直播', status: 'live'),
      ],
    );
    backend.danmakuSource = <String, dynamic>{
      'liveId': 'live-001',
      'platform': 'douyin',
      'roomRef': '7123456789012345678',
      'watchKey': 'douyin:douyin:7123456789012345678',
      // 刚刚连上
      'startedAt': DateTime.now().toUtc().toIso8601String(),
    };
    backend.danmakuSourceEventCount = 0;

    await _pumpMonitor(tester, backend);
    final card = find.byKey(const Key('liveMonitorSourceCard'));
    await tester.ensureVisible(card);
    await tester.pump();

    expect(find.byKey(const Key('liveMonitorSourceIdleWarn')), findsNothing);

    await _unmount(tester);
  });

  testWidgets('R53：助播机长时间没来取音频 → 出声卡给出红色告警', (tester) async {
    final backend = FakeBackend(
      lives: <Map<String, dynamic>>[
        _liveJson(id: 'live-001', title: '午市火锅直播', status: 'live'),
      ],
    );
    // 助播机 45 秒没来拉过音频（正常是每秒一次）—— 2026-09-18 的现场：
    // 手机被系统冻结，服务端早有 warn 日志，但商家看不到，AI 独自讲了 15 分钟。
    backend.speakerSecondsSincePull = 45;

    // R61：**不需要点任何开关** —— 出声是自动的，坏了也自动告诉你。
    await _pumpMonitor(tester, backend);
    await tester.pump(const Duration(milliseconds: 300));

    expect(find.byKey(const Key('liveMonitorSpeakerStaleWarn')), findsOneWidget);
    expect(find.textContaining('45 秒没取出音频'), findsOneWidget);

    await _unmount(tester);
  });

  testWidgets('R53：心跳正常 / 从未拉过时不误报', (tester) async {
    final fresh = FakeBackend(
      lives: <Map<String, dynamic>>[
        _liveJson(id: 'live-001', title: '午市火锅直播', status: 'live'),
      ],
    );
    fresh.speakerSecondsSincePull = 2; // 正常心跳
    await _pumpMonitor(tester, fresh);
    await tester.pump(const Duration(milliseconds: 120));
    expect(find.byKey(const Key('liveMonitorSpeakerStaleWarn')), findsNothing);
    expect(find.byKey(const Key('liveMonitorSpeakerCard')), findsNothing);
    await _unmount(tester);

    // null（服务端还没记到心跳）也不该报 —— 刚开播时本来就还没有心跳
    final off = FakeBackend(
      lives: <Map<String, dynamic>>[
        _liveJson(id: 'live-001', title: '午市火锅直播', status: 'live'),
      ],
    );
    await _pumpMonitor(tester, off);
    await tester.pump(const Duration(milliseconds: 120));
    expect(find.byKey(const Key('liveMonitorSpeakerStaleWarn')), findsNothing);
    await _unmount(tester);
  });

  testWidgets('R56：ready（未开播）也能编辑采集链接，按钮是「保存链接」', (tester) async {
    // 原先输入行只在 live 时渲染，而列表在 ready 时又只给「进入监控」、
    // 不给「编辑」—— 两头都改不了链接，商家只能先开播再换。
    final backend = FakeBackend(
      lives: <Map<String, dynamic>>[
        _liveJson(id: 'live-001', title: '午市火锅直播', status: 'ready'),
      ],
    );
    await _pumpMonitor(tester, backend);

    final input = find.byKey(const Key('liveMonitorSourceInput'));
    await tester.ensureVisible(input);
    await tester.pump();

    expect(input, findsOneWidget);
    expect(find.text('保存链接'), findsOneWidget);
    // 不该出现 live 才有的措辞
    expect(find.text('开始采集'), findsNothing);

    await _unmount(tester);
  });

  testWidgets('R57：互动概况把「其它原因没回复」也列出来，账要对得上', (tester) async {
    // 2026-09-21 实测：App 显示「有效提问 7 / 已回复 3 / 因频次漏掉 1」，
    // 剩下 3 条**不知去向** —— 账对不上比漏了本身更糟，商家会不再相信任何数字。
    final backend = FakeBackend(
      lives: <Map<String, dynamic>>[
        _liveJson(id: 'live-001', title: '午市火锅直播', status: 'live'),
      ],
    );
    backend.interactionStats = <String, dynamic>{
      'received': 12,
      'replied': 3,
      'throttled': 1,
      'byQuality': <String, dynamic>{'question': 7, 'smalltalk': 5},
      'skippedByReason': <String, dynamic>{
        'NO_REPLY_NEEDED': 2,
        'GENERATION_FAILED': 1,
      },
    };

    await _pumpMonitor(tester, backend);
    await tester.ensureVisible(find.byKey(const Key('liveMonitorStatsSkipped')));
    await tester.pump();

    expect(find.byKey(const Key('liveMonitorStatsSkipped')), findsOneWidget);
    expect(find.textContaining('未回复 3 条'), findsOneWidget);
    // 原因要翻成人话，而不是把 NO_REPLY_NEEDED 这种码直接甩给商家
    expect(find.textContaining('模型判无需回'), findsOneWidget);
    expect(find.textContaining('AI 生成失败'), findsOneWidget);

    await _unmount(tester);
  });
}
