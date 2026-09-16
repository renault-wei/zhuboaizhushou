/// 独立弹幕监控页（R16b）Widget 冒烟测试：贴链接 → 起监控 → 轮询拉到弹幕 → 停止。
/// 页面内含 2s 轮询定时器，故全程用固定 pump，不用 pumpAndSettle。
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:starvoice_app/features/danmaku_watch/presentation/danmaku_watch_page.dart';
import 'package:starvoice_app/providers.dart';

import 'fake_backend.dart';

Future<void> _pumpWatch(WidgetTester tester, FakeBackend backend) async {
  await tester.pumpWidget(
    ProviderScope(
      overrides: <Override>[dioProvider.overrideWithValue(buildMockDio(backend))],
      child: const MaterialApp(home: DanmakuWatchPage()),
    ),
  );
  // 首帧后拉一次「有没有已在跑的监控」
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 60));
}

void main() {
  testWidgets('弹幕监控：贴链接起监控 → 轮询拉到弹幕 → 停止', (tester) async {
    final backend = FakeBackend();
    await _pumpWatch(tester, backend);

    // 未开始：有输入框与开始按钮
    expect(find.byKey(const Key('danmakuWatchStartCard')), findsOneWidget);
    expect(find.byKey(const Key('danmakuWatchInput')), findsOneWidget);
    expect(find.byKey(const Key('danmakuWatchRunningCard')), findsNothing);

    await tester.enterText(
      find.byKey(const Key('danmakuWatchInput')),
      'https://live.douyin.com/7686079594273327906',
    );
    await tester.pump();
    await tester.tap(find.byKey(const Key('danmakuWatchStart')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 120));

    // 起监控后：输入卡收起，出现运行卡；房间号来自服务端解析结果
    expect(find.byKey(const Key('danmakuWatchStartCard')), findsNothing);
    expect(find.byKey(const Key('danmakuWatchRunningCard')), findsOneWidget);
    expect(find.textContaining('7686079594273327906'), findsOneWidget);

    // 往假后端的缓冲里塞一条真弹幕，等下一次轮询（2s）把它拉回来
    backend.danmakuWatchEvents['mon-001']!.add(<String, dynamic>{
      'seq': 1,
      'msgType': 'chat',
      'content': '豆豆健康就行',
      'senderNickname': '软糖酱',
      'happenedAt': DateTime.now().toUtc().toIso8601String(),
    });
    await tester.pump(const Duration(seconds: 2));
    await tester.pump(const Duration(milliseconds: 120));

    // 先看有没有报错、计数有没有涨——比直接断言正文更好定位
    expect(find.byKey(const Key('danmakuWatchError')), findsNothing);
    final countText = tester.widget<Text>(
      find.byKey(const Key('danmakuWatchCount')),
    );
    expect(countText.data, '共 1 条');
    expect(find.text('豆豆健康就行'), findsOneWidget);

    // 停止后回到未开始态
    await tester.tap(find.byKey(const Key('danmakuWatchStop')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 120));
    expect(find.byKey(const Key('danmakuWatchStartCard')), findsOneWidget);
    expect(backend.danmakuWatches, isEmpty);

    // 卸载页面，取消轮询定时器
    await tester.pumpWidget(const SizedBox());
  });
}
