import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:starvoice_app/features/scripts/presentation/script_generate_page.dart';
import 'package:starvoice_app/providers.dart';

import 'fake_backend.dart';

Future<void> _pumpGeneratePage(
  WidgetTester tester,
  FakeBackend backend,
) async {
  await tester.pumpWidget(
    ProviderScope(
      overrides: [dioProvider.overrideWithValue(buildMockDio(backend))],
      child: const MaterialApp(home: ScriptGeneratePage()),
    ),
  );
  await tester.pumpAndSettle();
}

/// 滚动到目标控件（ListView 子项可能延迟物化，先滚动再交互更稳）。
Future<void> _scrollTo(WidgetTester tester, Finder finder) async {
  await tester.scrollUntilVisible(
    finder,
    120,
    scrollable: find.byType(Scrollable).first,
  );
  await tester.pumpAndSettle();
}

/// 填写生成话术必需的商品信息并点击「生成话术」。
Future<void> _fillAndGenerate(
  WidgetTester tester, {
  String name = '双人火锅套餐',
  String package = '锅底+毛肚+时蔬，两人份',
  String price = '99',
}) async {
  await _scrollTo(tester, find.byKey(const Key('scriptField_name')));
  await tester.enterText(find.byKey(const Key('scriptField_name')), name);
  await tester.enterText(find.byKey(const Key('scriptField_package')), package);
  await tester.enterText(find.byKey(const Key('scriptField_price')), price);
  final button = find.byKey(const Key('scriptGenerateButton'));
  await _scrollTo(tester, button);
  await tester.tap(button);
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('空态：默认餐饮行业、商品表单字段与空态提示齐全', (WidgetTester tester) async {
    final backend = FakeBackend();
    await _pumpGeneratePage(tester, backend);

    expect(find.byKey(const Key('scriptGeneratePage')), findsOneWidget);
    // 默认选中「餐饮」行业
    final chip = tester.widget<ChoiceChip>(
      find.byKey(const Key('scriptIndustry_restaurant')),
    );
    expect(chip.selected, isTrue);

    // 行业三选
    expect(find.byKey(const Key('scriptIndustry_restaurant')), findsOneWidget);
    expect(find.byKey(const Key('scriptIndustry_local_service')), findsOneWidget);
    expect(find.byKey(const Key('scriptIndustry_retail')), findsOneWidget);

    // 商品表单字段（餐饮模板标签）
    expect(find.text('团购券名'), findsOneWidget);
    expect(find.text('套餐内容'), findsOneWidget);
    expect(find.text('价格'), findsOneWidget);
    expect(find.text('卖点'), findsOneWidget);

    // 空态引导文案
    await _scrollTo(tester, find.text('我的话术（0）'));
    expect(find.text('还没有话术，先在上方填写商品信息生成第一条吧'), findsOneWidget);
  });

  testWidgets('切换行业：商品字段标签随模板切换为零售', (WidgetTester tester) async {
    final backend = FakeBackend();
    await _pumpGeneratePage(tester, backend);

    await tester.tap(find.byKey(const Key('scriptIndustry_retail')));
    await tester.pumpAndSettle();

    expect(find.text('商品名'), findsOneWidget);
    expect(find.text('规格'), findsOneWidget);
    expect(find.text('价格'), findsOneWidget);
  });

  testWidgets('商品信息为空时点生成：提示先填写', (WidgetTester tester) async {
    final backend = FakeBackend();
    await _pumpGeneratePage(tester, backend);

    final button = find.byKey(const Key('scriptGenerateButton'));
    await _scrollTo(tester, button);
    await tester.tap(button);
    await tester.pump();

    expect(find.text('请先填写商品信息'), findsOneWidget);

    // 等待 SnackBar 计时器结束，避免遗留 pending timer
    await tester.pump(const Duration(seconds: 5));
    await tester.pumpAndSettle();
  });

  testWidgets('生成成功：展示可开播话术卡片', (WidgetTester tester) async {
    final backend = FakeBackend();
    await _pumpGeneratePage(tester, backend);

    await _fillAndGenerate(tester);

    final card = find.byKey(const Key('scriptCard_script-001'));
    await _scrollTo(tester, card);
    expect(card, findsOneWidget);
    expect(find.byKey(const Key('scriptStatus_script-001')), findsOneWidget);
    expect(find.text('可开播'), findsOneWidget);
    expect(find.text('未命名话术'), findsOneWidget);
    expect(
      find.descendant(of: card, matching: find.textContaining('双人火锅套餐')),
      findsOneWidget,
    );
    expect(find.text('我的话术（1）'), findsOneWidget);
  });

  testWidgets('命中拦截级敏感词：红色警示条展示命中词并标注不可开播', (WidgetTester tester) async {
    final backend = FakeBackend(
      generatedScriptContent: '这是最划算的套餐，欢迎到店品尝。',
    );
    await _pumpGeneratePage(tester, backend);

    await _fillAndGenerate(tester);

    final card = find.byKey(const Key('scriptCard_script-001'));
    await _scrollTo(tester, card);
    expect(find.text('已拦截'), findsOneWidget);
    expect(
      find.byKey(const Key('scriptBlockedBanner_script-001')),
      findsOneWidget,
    );
    expect(find.text('命中敏感词：最，话术不可开播'), findsOneWidget);
  });

  testWidgets('DeepSeek 生成失败：SnackBar 透传中文错误', (WidgetTester tester) async {
    final backend = FakeBackend(failScriptGenerate: true);
    await _pumpGeneratePage(tester, backend);

    await _fillAndGenerate(tester);

    expect(find.text('生成失败：话术生成服务暂不可用'), findsOneWidget);

    await tester.pump(const Duration(seconds: 5));
    await tester.pumpAndSettle();
  });
}
