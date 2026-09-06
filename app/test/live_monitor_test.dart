/// 现场直播工作台（LiveMonitorPage）Widget 冒烟测试：
/// 真人出镜 + 后台 AI 语音主播形态下的直播间控制台渲染与测试弹幕注入。
/// 页面进入后启动 3s 轮询与 1s 本地秒表定时器，用例不得用 pumpAndSettle
/// （直播中帧会持续刷新），统一用固定时长的 pump 并在收尾卸载页面取消定时器。
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:starvoice_app/features/lives/presentation/live_monitor_page.dart';
import 'package:starvoice_app/providers.dart';

import 'fake_backend.dart';

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
Future<void> _pumpMonitor(WidgetTester tester, FakeBackend backend) async {
  // 放大测试视口：让弹幕日志区也处于可视区（ListView 懒构建，默认视口可能不渲染）
  tester.view.physicalSize = const Size(1200, 2600);
  tester.view.devicePixelRatio = 1.0;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(
    ProviderScope(
      overrides: [dioProvider.overrideWithValue(buildMockDio(backend))],
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
    expect(
      find.text('真人出镜现场，AI 语音主播在后台实时朗读弹幕、介绍产品并回复提问。'),
      findsOneWidget,
    );

    // 测试弹幕入口 + 合规角标恒显
    expect(find.byKey(const Key('liveMonitorTestInput')), findsOneWidget);
    expect(find.byKey(const Key('liveMonitorTestSend')), findsOneWidget);
    expect(find.byKey(const Key('liveMonitorBadgeNote')), findsOneWidget);

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
    expect(
      find.text('直播已结束，无法再发送测试弹幕。'),
      findsOneWidget,
    );

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
}
