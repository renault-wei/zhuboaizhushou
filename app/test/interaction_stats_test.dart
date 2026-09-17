/// R45 监控页「互动概况」冒烟：让商家看得见覆盖情况，并在频次偏紧时给出可执行建议。
/// 这是判断「回复频次是不是设得太紧」的唯一依据。
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:starvoice_app/features/lives/presentation/live_monitor_page.dart';
import 'package:starvoice_app/providers.dart';

import 'fake_backend.dart';

Future<void> _pump(WidgetTester tester, FakeBackend backend) async {
  await tester.binding.setSurfaceSize(const Size(900, 3000));
  addTearDown(() => tester.binding.setSurfaceSize(null));
  await tester.pumpWidget(
    ProviderScope(
      overrides: <Override>[dioProvider.overrideWithValue(buildMockDio(backend))],
      child: const MaterialApp(home: LiveMonitorPage(liveId: 'live-mon-1')),
    ),
  );
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 150));
}

FakeBackend _backendWith(Map<String, dynamic> stats, {int pending = 0}) {
  final backend = FakeBackend(lives: <Map<String, dynamic>>[
    <String, dynamic>{'id': 'live-mon-1', 'status': 'live', 'title': '测试场次'},
  ]);
  backend.interactionStats = stats;
  backend.pendingReplies = pending;
  return backend;
}

void main() {
  testWidgets('R45：展示收到/有效/已回/因频次漏掉，并列出挡掉的无效弹幕', (tester) async {
    final backend = _backendWith(<String, dynamic>{
      'received': 128,
      'replied': 18,
      'throttled': 24,
      'byQuality': <String, dynamic>{
        'question': 30,
        'need': 12,
        'greeting': 5,
        'smalltalk': 20,
        'spam': 61,
      },
    });
    await _pump(tester, backend);

    expect(find.byKey(const Key('liveMonitorStatsCard')), findsOneWidget);
    expect(find.text('收到 128 条'), findsOneWidget);
    expect(find.text('42'), findsOneWidget); // 有效 = 提问 30 + 需求 12
    expect(find.text('18'), findsOneWidget); // 已回
    expect(find.text('24'), findsOneWidget); // 因频次漏掉
    expect(find.textContaining('挡掉无效弹幕 86 条'), findsOneWidget);
    expect(find.textContaining('灌水 61'), findsOneWidget);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('R45：频次偏紧时给出可执行建议（漏掉的比回出去的还多）', (tester) async {
    final backend = _backendWith(<String, dynamic>{
      'received': 60,
      'replied': 3,
      'throttled': 25,
      'byQuality': <String, dynamic>{'question': 20, 'need': 8},
    }, pending: 4);
    await _pump(tester, backend);

    expect(find.byKey(const Key('liveMonitorStatsHint')), findsOneWidget);
    expect(find.textContaining('把回复频次放宽'), findsOneWidget);
    expect(find.byKey(const Key('liveMonitorStatsPending')), findsOneWidget);
    expect(find.textContaining('排队中 4 条'), findsOneWidget);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('R45：频次正常时不打扰（不显示建议）', (tester) async {
    final backend = _backendWith(<String, dynamic>{
      'received': 40,
      'replied': 12,
      'throttled': 1,
      'byQuality': <String, dynamic>{'question': 10, 'need': 3, 'spam': 27},
    });
    await _pump(tester, backend);

    expect(find.byKey(const Key('liveMonitorStatsHint')), findsNothing);
    await tester.pumpWidget(const SizedBox());
  });
}
