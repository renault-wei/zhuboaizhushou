/// R25 氛围语页冒烟：五类都在 → 一键补齐推荐模板 → 改欢迎语并保存 → 改插播频次。
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:starvoice_app/features/atmosphere/presentation/atmosphere_page.dart';
import 'package:starvoice_app/providers.dart';

import 'fake_backend.dart';

Future<void> _pump(WidgetTester tester, FakeBackend backend) async {
  // 五张卡 + 每张都有多行文本框：页面很长，且页面内**多个 TextField 各自带 Scrollable**，
  // scrollUntilVisible 会因「Too many elements」无法自选 —— 直接把视口调高最稳。
  await tester.binding.setSurfaceSize(const Size(800, 2600));
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
  testWidgets('R25：五类氛围语都在，可一键补齐并保存欢迎语', (tester) async {
    final backend = FakeBackend();
    await _pump(tester, backend);

    for (final category in <String>['welcome', 'follow', 'thumb', 'clock', 'custom']) {
      expect(find.byKey(Key('atmosphereCard_$category')), findsOneWidget);
    }
    // 服务端下发默认档：欢迎语 60 秒/次
    expect(find.text('1 分钟/次'), findsWidgets);

    // 一键补齐：五类都不存在 → 建 5 条
    await tester.tap(find.byKey(const Key('atmosphereSeedDefaults')));
    await tester.pumpAndSettle();
    expect(backend.atmosphereTemplates, hasLength(5));
    // 注意：不要用 find.textContaining 断言输入框内容 —— TextField 内部会渲染多个
    // 含同样文本的 widget（EditableText / semantics），findsOneWidget 必然失败。
    // 这里直接断言服务端状态，才是真正要验的东西。
    expect(
      backend.atmosphereTemplates.firstWhere((t) => t['category'] == 'welcome')['text'],
      contains('欢迎[昵称]'),
    );

    // 改欢迎语文案并保存
    await tester.enterText(
      find.byKey(const Key('atmosphereTextField_welcome')),
      '欢迎[昵称]来到星辰火锅直播间，双人餐 99 元～',
    );
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('atmosphereSave_welcome')));
    await tester.pumpAndSettle();

    final welcome = backend.atmosphereTemplates.firstWhere((t) => t['category'] == 'welcome');
    expect(welcome['text'], '欢迎[昵称]来到星辰火锅直播间，双人餐 99 元～');
  });

  testWidgets('R25：可把某类改成「不插播」，也可切到别的档位', (tester) async {
    final backend = FakeBackend();
    await _pump(tester, backend);

    await tester.tap(find.byKey(const Key('atmosphereInterval_welcome')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('atmosphereIntervalOff')), findsOneWidget);

    await tester.tap(find.byKey(const Key('atmosphereIntervalOff')));
    await tester.pumpAndSettle();
    expect(backend.atmosphereIntervals['welcome'], 0);
    expect(find.text('不插播'), findsOneWidget);

    // 再切到 120 秒（欢迎语的规则区间是 1~300 秒，档位只会落在区间内）
    await tester.tap(find.byKey(const Key('atmosphereInterval_welcome')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('atmosphereInterval120')));
    await tester.pumpAndSettle();
    expect(backend.atmosphereIntervals['welcome'], 120);
    expect(find.text('2 分钟/次'), findsOneWidget);
  });
}
