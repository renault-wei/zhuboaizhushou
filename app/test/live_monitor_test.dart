/// 现场直播工作台（LiveMonitorPage）Widget 冒烟测试：
/// 真人出镜 + 后台 AI 语音主播形态下的直播间控制台渲染与测试弹幕注入。
/// 页面进入后启动 3s 轮询与 1s 本地秒表定时器，用例不得用 pumpAndSettle
/// （直播中帧会持续刷新），统一用固定时长的 pump 并在收尾卸载页面取消定时器。
library;

import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:starvoice_app/core/network/api_client.dart';
import 'package:starvoice_app/features/assistant_speaker/application/assistant_speaker_controller.dart';
import 'package:starvoice_app/features/assistant_speaker/application/speech_out_player.dart';
import 'package:starvoice_app/features/lives/presentation/live_monitor_page.dart';
import 'package:starvoice_app/providers.dart';

import 'fake_backend.dart';

/// 出声卡测试用假播放器：不碰真实音频通道，仅记录启停。
class _FakeSpeechOutPlayer implements SpeechOutPlayer {
  @override
  Future<void> play(Uint8List wavBytes) async {}

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

/// 渲染现场直播工作台并等待首次 monitor / danmaku 返回。
Future<void> _pumpMonitor(
  WidgetTester tester,
  FakeBackend backend, {
  List<Override> overrides = const <Override>[],
}) async {
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

    // 关闭开关：回到未启用
    await tester.tap(find.byKey(const Key('liveMonitorSpeakerSwitch')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));
    expect(speakerController.state.enabled, isFalse);
    expect(find.text('未启用'), findsOneWidget);

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
}
