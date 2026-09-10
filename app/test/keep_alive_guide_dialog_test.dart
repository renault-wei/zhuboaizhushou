/// 助播保活引导弹窗（M9 手机线）Widget 测试：透明玻璃卡片渲染、
/// 电量优化状态随入参变化、两个动作按钮的关闭与回调行为。
library;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:starvoice_app/features/assistant_speaker/presentation/keep_alive_guide_dialog.dart';

/// 渲染宿主并打开引导弹窗。
Future<void> _openGuide(
  WidgetTester tester, {
  bool? exempt,
  VoidCallback? onOpen,
}) async {
  await tester.pumpWidget(
    MaterialApp(
      home: Scaffold(
        body: Builder(
          builder: (context) => Center(
            child: TextButton(
              key: const Key('openGuide'),
              onPressed: () => showKeepAliveGuideDialog(
                context,
                batteryExempt: exempt,
                onOpenSettings: () async => onOpen?.call(),
              ),
              child: const Text('open'),
            ),
          ),
        ),
      ),
    ),
  );
  await tester.tap(find.byKey(const Key('openGuide')));
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('渲染透明玻璃卡片：标题 + 三条要点 + 两个动作按钮', (tester) async {
    await _openGuide(tester, exempt: false);

    expect(find.byKey(const Key('keepAliveGuideDialog')), findsOneWidget);
    expect(find.text('让 AI 助播在后台继续说'), findsOneWidget);
    expect(find.text('切后台不断声'), findsOneWidget);
    expect(find.text('持续拉队列'), findsOneWidget);
    expect(find.text('随时可关'), findsOneWidget);
    expect(find.byKey(const Key('keepAliveGuideLater')), findsOneWidget);
    expect(find.byKey(const Key('keepAliveGuideGo')), findsOneWidget);
  });

  testWidgets('电量优化状态行随入参变化', (tester) async {
    await _openGuide(tester, exempt: true);
    expect(find.text('电量优化已放行'), findsOneWidget);

    await tester.tap(find.byKey(const Key('keepAliveGuideLater')));
    await tester.pumpAndSettle();
    await _openGuide(tester, exempt: false);
    expect(find.text('电量优化未放行'), findsOneWidget);

    await tester.tap(find.byKey(const Key('keepAliveGuideLater')));
    await tester.pumpAndSettle();
    await _openGuide(tester, exempt: null);
    expect(find.text('电量优化状态未知'), findsOneWidget);
  });

  testWidgets('「暂不设置」关闭弹窗且不触发去设置回调', (tester) async {
    var opened = false;
    await _openGuide(tester, exempt: false, onOpen: () => opened = true);

    await tester.tap(find.byKey(const Key('keepAliveGuideLater')));
    await tester.pumpAndSettle();

    expect(find.byKey(const Key('keepAliveGuideDialog')), findsNothing);
    expect(opened, isFalse);
  });

  testWidgets('「去放行」触发去设置回调并关闭弹窗', (tester) async {
    var opened = false;
    await _openGuide(tester, exempt: false, onOpen: () => opened = true);

    await tester.tap(find.byKey(const Key('keepAliveGuideGo')));
    await tester.pumpAndSettle();

    expect(opened, isTrue);
    expect(find.byKey(const Key('keepAliveGuideDialog')), findsNothing);
  });
}
