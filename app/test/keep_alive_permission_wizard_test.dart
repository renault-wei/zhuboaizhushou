/// 权限分步向导（R65，对照竞品 xcai1618 的 quanstep）Widget 测试：
/// 分步推进、按钮随授权状态切换「下一步 / 马上设置」、路径文案、状态行。
library;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:starvoice_app/features/assistant_speaker/presentation/keep_alive_permission_wizard.dart';

/// 造一个可控的 actions：按步骤返回预设的授权状态，并记录「去设置」调用。
KeepAlivePermissionActions _actions({
  required Map<KeepAlivePermissionStep, bool?> granted,
  List<KeepAlivePermissionStep>? opened,
}) {
  return KeepAlivePermissionActions(
    check: (step) async => granted[step],
    open: (step) async {
      opened?.add(step);
    },
  );
}

Future<void> _openWizard(
  WidgetTester tester, {
  required KeepAlivePermissionActions actions,
}) async {
  await tester.pumpWidget(
    MaterialApp(
      home: Scaffold(
        body: Builder(
          builder: (context) => Center(
            child: TextButton(
              key: const Key('openWizard'),
              onPressed: () => showKeepAlivePermissionWizard(
                context,
                actions: actions,
              ),
              child: const Text('open'),
            ),
          ),
        ),
      ),
    ),
  );
  await tester.tap(find.byKey(const Key('openWizard')));
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('R65：向导从第 1 步开始，并展示系统里的中文路径', (tester) async {
    await _openWizard(
      tester,
      actions: _actions(granted: const <KeepAlivePermissionStep, bool?>{
        KeepAlivePermissionStep.notification: false,
      }),
    );

    expect(find.byKey(const Key('keepAlivePermissionWizard')), findsOneWidget);
    expect(find.textContaining('第 1 / 4 步'), findsOneWidget);
    expect(find.text('通知权限'), findsOneWidget);
    // 竞品口径：把菜单层级写进文案，而不是笼统的「去设置里找」
    expect(find.byKey(const Key('keepAliveWizardPath')), findsOneWidget);
  });

  testWidgets('R65：未放行 → 按钮是「去开通知」；点了会拉起设置页', (tester) async {
    final opened = <KeepAlivePermissionStep>[];
    await _openWizard(
      tester,
      actions: _actions(
        granted: const <KeepAlivePermissionStep, bool?>{
          KeepAlivePermissionStep.notification: false,
        },
        opened: opened,
      ),
    );

    expect(find.text('未放行'), findsOneWidget);
    expect(find.text('去开通知'), findsOneWidget);
    await tester.tap(find.byKey(const Key('keepAliveWizardAction')));
    await tester.pumpAndSettle();
    expect(opened, <KeepAlivePermissionStep>[KeepAlivePermissionStep.notification]);
  });

  testWidgets('R65：已放行 → 按钮变「下一步」并推进到第 2 步（悬浮窗）', (tester) async {
    await _openWizard(
      tester,
      actions: _actions(granted: const <KeepAlivePermissionStep, bool?>{
        KeepAlivePermissionStep.notification: true,
        KeepAlivePermissionStep.overlay: false,
      }),
    );

    expect(find.text('已放行 ✓'), findsOneWidget);
    expect(find.text('下一步'), findsOneWidget);
    await tester.tap(find.byKey(const Key('keepAliveWizardAction')));
    await tester.pumpAndSettle();
    expect(find.textContaining('第 2 / 4 步'), findsOneWidget);
    expect(find.text('悬浮窗权限'), findsOneWidget);
  });

  testWidgets('R65：自启动那一步系统查不了 → 状态行如实说明，不误报为未授权', (tester) async {
    await _openWizard(
      tester,
      actions: _actions(granted: const <KeepAlivePermissionStep, bool?>{
        KeepAlivePermissionStep.notification: true,
        KeepAlivePermissionStep.overlay: true,
        KeepAlivePermissionStep.battery: true,
        KeepAlivePermissionStep.autoStart: null,
      }),
    );

    // 连点三次「下一步」走到第 4 步
    for (var i = 0; i < 3; i += 1) {
      await tester.tap(find.byKey(const Key('keepAliveWizardAction')));
      await tester.pumpAndSettle();
    }
    expect(find.textContaining('第 4 / 4 步'), findsOneWidget);
    expect(find.text('自启动 / 受保护应用'), findsOneWidget);
    expect(find.text('系统不允许应用查询，请自行确认'), findsOneWidget);
    // 查询不到就不能显示「下一步」，必须留在「去开自启动」
    expect(find.text('去开自启动'), findsOneWidget);
  });

  testWidgets('R65：「暂不设置」不阻断，直接关闭且不拉任何设置页', (tester) async {
    final opened = <KeepAlivePermissionStep>[];
    await _openWizard(
      tester,
      actions: _actions(
        granted: const <KeepAlivePermissionStep, bool?>{
          KeepAlivePermissionStep.notification: false,
        },
        opened: opened,
      ),
    );

    await tester.tap(find.byKey(const Key('keepAliveWizardLater')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('keepAlivePermissionWizard')), findsNothing);
    expect(opened, isEmpty);
  });
}
