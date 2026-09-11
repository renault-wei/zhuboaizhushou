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

  testWidgets('直播中助播机出声卡：开关启停驱动轮询并展示状态', (tester) async {
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

    // 直播中展示出声卡，初始未启用
    expect(find.byKey(const Key('liveMonitorSpeakerCard')), findsOneWidget);
    expect(find.text('助播机出声（手机线）'), findsOneWidget);
    expect(find.text('未启用'), findsOneWidget);
    final switchBefore = tester.widget<Switch>(
      find.byKey(const Key('liveMonitorSpeakerSwitch')),
    );
    expect(switchBefore.value, isFalse);

    // 打开开关：控制器进入监听态并展示状态
    await tester.tap(find.byKey(const Key('liveMonitorSpeakerSwitch')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));
    expect(speakerController.state.enabled, isTrue);
    expect(find.text('监听中'), findsOneWidget);
    // 常开记忆已写回本地，供下次直播自动恢复
    var prefs = await SharedPreferences.getInstance();
    expect(prefs.getBool('assistant_speaker_always_on'), isTrue);

    // 关闭开关：回到未启用
    await tester.tap(find.byKey(const Key('liveMonitorSpeakerSwitch')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));
    expect(speakerController.state.enabled, isFalse);
    expect(find.text('未启用'), findsOneWidget);
    prefs = await SharedPreferences.getInstance();
    expect(prefs.getBool('assistant_speaker_always_on'), isFalse);

    await _unmount(tester);
    speakerController.dispose();
  });

  testWidgets('直播中 + 常开记忆：偏好开启时进入直播自动启用助播出声（Q5）', (tester) async {
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
      initialPrefs: <String, Object>{'assistant_speaker_always_on': true},
    );
    await tester.pump(const Duration(milliseconds: 50));

    // 进入直播态即按常开记忆自动启用，无需再次手动打开
    expect(speakerController.state.enabled, isTrue);
    expect(find.text('监听中'), findsOneWidget);
    final switchOn = tester.widget<Switch>(
      find.byKey(const Key('liveMonitorSpeakerSwitch')),
    );
    expect(switchOn.value, isTrue);

    await _unmount(tester);
    speakerController.dispose();
  });

  testWidgets('已结束：AI 播报停止，测试弹幕入口禁用并提示', (tester) async {
    final endedAt = DateTime.now().toUtc().toIso8601String();
    final backend = FakeBackend(
      lives: <Map<String, dynamic>>[
        _liveJson(
          id: 'live-001',
          title: '午市火锅直播',
          status: 'ended',
          startedAt: endedAt,
          endedAt: endedAt,
        ),
      ],
    );
    await _pumpMonitor(tester, backend);

    expect(find.text('已停止'), findsOneWidget);
    expect(find.text('直播已结束，AI 语音播报已停止。'), findsOneWidget);
    expect(find.text('直播已结束，无法再发送测试弹幕。'), findsOneWidget);

    final send = tester.widget<FilledButton>(
      find.byKey(const Key('liveMonitorTestSend')),
    );
    expect(send.onPressed, isNull);
    final input = tester.widget<TextField>(
      find.byKey(const Key('liveMonitorTestInput')),
    );
    expect(input.enabled, isFalse);

    await _unmount(tester);
  });

  testWidgets('就绪：工作台展示「开始直播」，点击后转直播中并出现结束按钮', (tester) async {
    final backend = FakeBackend(
      lives: <Map<String, dynamic>>[
        _liveJson(id: 'live-001', title: '晚市就绪直播', status: 'ready'),
      ],
    );
    await _pumpMonitor(tester, backend);

    // 就绪态：主操作是「开始直播」，未开播不发弹幕、AI 待开播
    expect(find.byKey(const Key('liveMonitorStartButton')), findsOneWidget);
    expect(find.byKey(const Key('liveEndButton')), findsNothing);
    // 就绪态展示「开播前自检」引导卡
    expect(find.byKey(const Key('liveMonitorPreflight')), findsOneWidget);
    expect(find.text('开播前自检'), findsOneWidget);
    expect(find.text('配置已就绪，点击下方「开始直播」后 AI 语音主播将上线播报。'), findsOneWidget);
    expect(find.text('尚未开播，无法发送测试弹幕；点击「开始直播」进入直播后即可联调。'), findsOneWidget);

    // 点击开始：后端转 live，工作台切入直播中监控
    await tester.tap(find.byKey(const Key('liveMonitorStartButton')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));
    await tester.pump(const Duration(milliseconds: 50));
    await tester.pump(const Duration(milliseconds: 50));

    expect(backend.lives.single['status'], 'live');
    expect(find.byKey(const Key('liveMonitorStartButton')), findsNothing);
    expect(find.byKey(const Key('liveEndButton')), findsOneWidget);
    expect(find.byKey(const Key('liveMonitorPreflight')), findsNothing);
    expect(find.text('播报中'), findsOneWidget);
    expect(find.text('直播已开始，AI 语音主播已上线'), findsOneWidget);

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

  testWidgets('直播中热更话术：点选台本后换绑并在下一轮生效（M4）', (tester) async {
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
    expect(find.text('话术已更新，将在下一轮生效'), findsOneWidget);

    await _unmount(tester);
  });
}
