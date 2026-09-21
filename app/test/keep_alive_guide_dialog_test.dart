/// 助播保活引导弹窗（M9 / R62）Widget 测试：
/// 两项放行（电量优化 + 自启动）的渲染、状态行随入参变化、各按钮的回调行为。
library;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:starvoice_app/features/assistant_speaker/presentation/keep_alive_guide_dialog.dart';

/// 渲染宿主并打开引导弹窗。
Future<void> _openGuide(
  WidgetTester tester, {
  bool? exempt,
  VoidCallback? onOpenBattery,
  VoidCallback? onOpenAutoStart,
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
                onRequestBatteryExemption: () async {
                  onOpenBattery?.call();
                  return true;
                },
                onOpenAutoStartSettings: () async {
                  onOpenAutoStart?.call();
                  return true;
                },
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
  testWidgets('R62：弹窗同时列出两项放行（电量优化 + 自启动）', (tester) async {
    await _openGuide(tester, exempt: false);

    expect(find.byKey(const Key('keepAliveGuideDialog')), findsOneWidget);
    expect(find.text('提示'), findsOneWidget);
    expect(find.text('① 电量优化'), findsOneWidget);
    expect(find.text('② 自启动 / 受保护应用'), findsOneWidget);
    // 必须告诉用户「只能手动点」—— 代码代开不了
    expect(find.byKey(const Key('keepAliveGuideAutoStartHint')), findsOneWidget);
    expect(find.byKey(const Key('keepAliveGuideBattery')), findsOneWidget);
    expect(find.byKey(const Key('keepAliveGuideAutoStart')), findsOneWidget);
    expect(find.byKey(const Key('keepAliveGuideLater')), findsOneWidget);
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

  testWidgets('「暂不设置」关闭弹窗且不触发任何回调', (tester) async {
    var battery = false;
    var autoStart = false;
    await _openGuide(
      tester,
      exempt: false,
      onOpenBattery: () => battery = true,
      onOpenAutoStart: () => autoStart = true,
    );

    await tester.tap(find.byKey(const Key('keepAliveGuideLater')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('keepAliveGuideDialog')), findsNothing);
    expect(battery, isFalse);
    expect(autoStart, isFalse);
  });

  testWidgets('「去放行电量」触发电量回调，并保持弹窗可继续操作', (tester) async {
    var battery = false;
    await _openGuide(tester, exempt: false, onOpenBattery: () => battery = true);

    await tester.tap(find.byKey(const Key('keepAliveGuideBattery')));
    await tester.pumpAndSettle();
    expect(battery, isTrue);
  });

  testWidgets('「去开自启动」触发自启动回调（代码代开不了，只能拉起设置页）', (tester) async {
    var autoStart = false;
    await _openGuide(
      tester,
      exempt: false,
      onOpenAutoStart: () => autoStart = true,
    );

    await tester.tap(find.byKey(const Key('keepAliveGuideAutoStart')));
    await tester.pumpAndSettle();
    expect(autoStart, isTrue);
  });
}
