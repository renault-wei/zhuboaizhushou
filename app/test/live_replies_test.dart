/// R24 监控页「AI 回复」区冒烟：空态提示 + 有回复时逐条展示 + 兜底话术有标记。
/// 这是「让商家看得见 AI 到底回了什么」的前端那一半。
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:starvoice_app/features/lives/presentation/live_monitor_page.dart';
import 'package:starvoice_app/providers.dart';

import 'fake_backend.dart';

Future<void> _pump(WidgetTester tester, FakeBackend backend) async {
  await tester.binding.setSurfaceSize(const Size(900, 2600));
  addTearDown(() => tester.binding.setSurfaceSize(null));
  await tester.pumpWidget(
    ProviderScope(
      overrides: <Override>[dioProvider.overrideWithValue(buildMockDio(backend))],
      child: const MaterialApp(home: LiveMonitorPage(liveId: 'live-mon-1')),
    ),
  );
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 120));
}

void main() {
  testWidgets('R24：没有回复时给出空态提示', (tester) async {
    final backend = FakeBackend(lives: <Map<String, dynamic>>[
      <String, dynamic>{'id': 'live-mon-1', 'status': 'live', 'title': '测试场次'},
    ]);
    await _pump(tester, backend);

    expect(find.text('AI 回复'), findsOneWidget);
    expect(find.byKey(const Key('liveMonitorRepliesEmpty')), findsOneWidget);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('R24：有回复时逐条展示，兜底话术被标出来', (tester) async {
    final backend = FakeBackend(lives: <Map<String, dynamic>>[
      <String, dynamic>{'id': 'live-mon-1', 'status': 'live', 'title': '测试场次'},
    ]);
    backend.liveReplies['live-mon-1'] = <Map<String, dynamic>>[
      <String, dynamic>{
        'senderNickname': '吃货小王',
        'text': '咱家双人套餐 99 元，锅底现炒～',
        'source': 'generated',
        'createdAt': '2026-09-17T10:00:02.000Z',
      },
      <String, dynamic>{
        'senderNickname': null,
        'text': '您问的这个问题我帮您记下了，稍等我确认好再为您解答～',
        'source': 'fallback',
        'createdAt': '2026-09-17T10:00:01.000Z',
      },
    ];
    await _pump(tester, backend);

    expect(find.byKey(const Key('liveMonitorRepliesEmpty')), findsNothing);
    expect(find.text('共 2 条'), findsWidgets);
    expect(find.text('咱家双人套餐 99 元，锅底现炒～'), findsOneWidget);
    expect(find.text('回给 吃货小王'), findsOneWidget);
    // 命中内置敏感词的兜底话术要有醒目标记 —— 商家得知道那句不是 AI 想的
    expect(find.text('兜底话术'), findsOneWidget);
    await tester.pumpWidget(const SizedBox());
  });
}
