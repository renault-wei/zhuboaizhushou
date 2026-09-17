/// R25 氛围语页冒烟（一类多条）：五类都在 → 一键补齐 → 单条启停 / 新增 / 删除 / 改频次。
/// 「一类多条」是用户 2026-09-17 拍板的口径（选项 b）。
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:starvoice_app/features/atmosphere/presentation/atmosphere_page.dart';
import 'package:starvoice_app/providers.dart';

import 'fake_backend.dart';

Future<void> _pump(WidgetTester tester, FakeBackend backend) async {
  // 列表式页面很长，且内部多个 TextField 各自带 Scrollable —— 直接把视口调高最稳。
  await tester.binding.setSurfaceSize(const Size(800, 3200));
  addTearDown(() => tester.binding.setSurfaceSize(null));
  await tester.pumpWidget(
    ProviderScope(
      overrides: <Override>[dioProvider.overrideWithValue(buildMockDio(backend))],
      child: const MaterialApp(home: AtmospherePage()),
    ),
  );
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('R25：五类都在，一键补齐后每类出现多条模板', (tester) async {
    final backend = FakeBackend();
    await _pump(tester, backend);

    for (final category in <String>['welcome', 'follow', 'thumb', 'clock', 'custom']) {
      expect(find.byKey(Key('atmosphereCard_$category')), findsOneWidget);
    }
    // 服务端下发默认档：欢迎语 60 秒 → 显示 1 分钟/次
    expect(find.text('1 分钟/次'), findsWidgets);

    await tester.tap(find.byKey(const Key('atmosphereSeedDefaults')));
    await tester.pumpAndSettle();
    expect(backend.atmosphereTemplates, hasLength(5));
    expect(
      backend.atmosphereTemplates.firstWhere((t) => t['category'] == 'welcome')['text'],
      contains('欢迎[昵称]'),
    );
  });

  testWidgets('R25：一类多条 —— 可单独启停、可新增、可删除', (tester) async {
    final backend = FakeBackend();
    // 预置同类两条，验证「一类多条」是真的被渲染成两条独立行
    backend.atmosphereTemplates.addAll(<Map<String, dynamic>>[
      <String, dynamic>{'id': 'w1', 'category': 'welcome', 'text': '欢迎[昵称]来到直播间～', 'enabled': true},
      <String, dynamic>{'id': 'w2', 'category': 'welcome', 'text': '欢迎新来的朋友～', 'enabled': true},
    ]);
    await _pump(tester, backend);

    expect(find.byKey(const Key('atmosphereItem_w1')), findsOneWidget);
    expect(find.byKey(const Key('atmosphereItem_w2')), findsOneWidget);

    // 停用第二条：服务端 PUT 是整体替换，文案要一并回传
    await tester.tap(find.byKey(const Key('atmosphereToggle_w2')));
    await tester.pumpAndSettle();
    expect(
      backend.atmosphereTemplates.firstWhere((t) => t['id'] == 'w2')['enabled'],
      isFalse,
    );
    expect(
      backend.atmosphereTemplates.firstWhere((t) => t['id'] == 'w2')['text'],
      '欢迎新来的朋友～',
    );

    // 新增一条
    await tester.tap(find.byKey(const Key('atmosphereAdd_welcome')));
    await tester.pumpAndSettle();
    await tester.enterText(find.byKey(const Key('atmosphereEditorField')), '新朋友扣个 1 让我看到你～');
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('atmosphereEditorSave')));
    await tester.pumpAndSettle();
    expect(backend.atmosphereTemplates.where((t) => t['category'] == 'welcome'), hasLength(3));

    // 删除一条
    await tester.tap(find.byKey(const Key('atmosphereDelete_w1')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('atmosphereDeleteConfirm')));
    await tester.pumpAndSettle();
    expect(backend.atmosphereTemplates.where((t) => t['id'] == 'w1'), isEmpty);
  });

  testWidgets('R25：可把某类改成「不插播」', (tester) async {
    final backend = FakeBackend();
    await _pump(tester, backend);

    await tester.tap(find.byKey(const Key('atmosphereInterval_welcome')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('atmosphereIntervalOff')));
    await tester.pumpAndSettle();
    expect(backend.atmosphereIntervals['welcome'], 0);
    expect(find.text('不插播'), findsOneWidget);
  });
}
