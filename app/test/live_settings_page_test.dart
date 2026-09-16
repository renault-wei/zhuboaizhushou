/// R23 直播设置页冒烟：读到设置 → 改频次 → 改违禁词 → 保存落回后端。
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:starvoice_app/features/live_settings/presentation/live_settings_page.dart';
import 'package:starvoice_app/providers.dart';

import 'fake_backend.dart';

Future<void> _pump(WidgetTester tester, FakeBackend backend) async {
  // 设置页较长，且页面内**多个多行文本框各自带 Scrollable** —— scrollUntilVisible 会因
  // 「Too many elements」无法自选。最稳的做法是把测试视口调高，直接让保存按钮进可见区。
  await tester.binding.setSurfaceSize(const Size(800, 1800));
  addTearDown(() => tester.binding.setSurfaceSize(null));
  await tester.pumpWidget(
    ProviderScope(
      overrides: <Override>[dioProvider.overrideWithValue(buildMockDio(backend))],
      child: const MaterialApp(home: LiveSettingsPage()),
    ),
  );
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('R23：读到设置 → 改频次与违禁词 → 保存', (tester) async {
    final backend = FakeBackend();
    await _pump(tester, backend);

    // 初始：回复开着、频次 5 秒
    expect(tester.widget<SwitchListTile>(find.byKey(const Key('replyEnabledSwitch'))).value, isTrue);
    expect(find.text('5 秒/次'), findsOneWidget);

    // 档位面板：与竞品 replyOptions 同款 —— 不回复 / 1 / 5 / 10 / 20 / 自定义
    await tester.tap(find.byKey(const Key('replyIntervalTile')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('replyIntervalOff')), findsOneWidget);
    expect(find.byKey(const Key('replyInterval1')), findsOneWidget);
    expect(find.byKey(const Key('replyIntervalCustom')), findsOneWidget);

    await tester.tap(find.byKey(const Key('replyInterval20')));
    await tester.pumpAndSettle();
    expect(find.text('20 秒/次'), findsOneWidget);

    // 违禁词：顿号分隔
    await tester.enterText(find.byKey(const Key('bannedWordsField')), '最低价、绝对');
    await tester.pumpAndSettle();

    await tester.tap(find.byKey(const Key('liveSettingsSave')));
    await tester.pumpAndSettle();

    expect(backend.liveSettings['replyIntervalSeconds'], 20);
    expect(backend.liveSettings['bannedWords'], '最低价、绝对');
    expect(backend.liveSettings['replyEnabled'], isTrue);
  });

  testWidgets('R23：选「不回复」→ 频次显示为不回复，保存写回开关为 false', (tester) async {
    final backend = FakeBackend();
    await _pump(tester, backend);

    await tester.tap(find.byKey(const Key('replyIntervalTile')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('replyIntervalOff')));
    await tester.pumpAndSettle();
    expect(find.text('不回复'), findsOneWidget);

    await tester.tap(find.byKey(const Key('liveSettingsSave')));
    await tester.pumpAndSettle();
    expect(backend.liveSettings['replyEnabled'], isFalse);
  });
}
