/// 权限分步向导（R65，对照竞品 xcai1618 的 quanstep）Widget 测试：
/// 分步推进、按钮随授权状态切换「下一步 / 马上设置」、路径文案、状态行。
library;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

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
  // ★R77：向导入口多了一次**异步预检**（实测哪些权限真的缺）✓
  //   而 `pumpAndSettle` 只看「有没有排帧」—— 预检落地前它就直接返回了 ✗，
  //   所以这里要主动多推几帧，把弹窗等出来 ✓
  for (var i = 0; i < 10 && find.byType(AlertDialog).evaluate().isEmpty; i += 1) {
    await tester.pump(const Duration(milliseconds: 20));
  }
  await tester.pumpAndSettle();
}

void main() {
  setUp(() {
    // 每个用例都从「没走过向导」开始 —— 否则前一个用例落盘的标记会串味 ✗
    SharedPreferences.setMockInitialValues(<String, Object>{});
  });

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

  testWidgets('R77：已放行的步骤直接跳过；补上之后就能推进到下一步', (tester) async {
    // 用**可变**的授权状态：模拟「用户去系统里放行了，再回到向导」✓
    final grantedState = <KeepAlivePermissionStep, bool?>{
      KeepAlivePermissionStep.notification: true,
      KeepAlivePermissionStep.overlay: false,
    };
    await _openWizard(
      tester,
      actions: KeepAlivePermissionActions(
        check: (step) async => grantedState[step],
        open: (step) async {},
      ),
    );

    // ★R77：通知已放行 → 不再让用户白点一次，向导**直接落在悬浮窗** ✓
    expect(find.text('悬浮窗权限'), findsOneWidget);
    expect(find.text('通知权限'), findsNothing);
    expect(find.text('未放行'), findsOneWidget);
    expect(find.text('去开悬浮窗'), findsOneWidget);
    // 步数按**实际要走的**算：悬浮窗 / 电池 / 自启动 = 3 步（不再凑满 4 步）
    expect(find.textContaining('第 1 / 3 步'), findsOneWidget);

    // 用户在系统里放行了 → 回向导点一次 → 状态刷新成「已放行」，按钮变「下一步」
    grantedState[KeepAlivePermissionStep.overlay] = true;
    await tester.tap(find.byKey(const Key('keepAliveWizardAction')));
    await tester.pumpAndSettle();
    expect(find.text('已放行 ✓'), findsOneWidget);

    // 再点「下一步」→ 落到下一个**缺**的步骤（电池优化）
    await tester.tap(find.byKey(const Key('keepAliveWizardAction')));
    await tester.pumpAndSettle();
    expect(find.text('电池优化'), findsOneWidget);
    expect(find.textContaining('第 2 / 3 步'), findsOneWidget);
  });

  testWidgets('R65/R77：自启动系统查不了 → 状态行如实说明；只剩它时向导就只有一步', (tester) async {
    await _openWizard(
      tester,
      actions: _actions(granted: const <KeepAlivePermissionStep, bool?>{
        KeepAlivePermissionStep.notification: true,
        KeepAlivePermissionStep.overlay: true,
        KeepAlivePermissionStep.battery: true,
        KeepAlivePermissionStep.autoStart: null,
      }),
    );

    expect(find.textContaining('第 1 / 1 步'), findsOneWidget);
    expect(find.text('自启动 / 受保护应用'), findsOneWidget);
    expect(find.text('系统不允许应用查询，请自行确认'), findsOneWidget);
    // 查询不到就不能显示「下一步」，必须留在「去开自启动」
    expect(find.text('去开自启动'), findsOneWidget);
    // ★R77：但必须给一个**自己确认**的出口，否则向导永远走不完 → 每次都还在弹 ✓
    expect(find.byKey(const Key('keepAliveWizardDone')), findsOneWidget);
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

  // ---------- R77：权限「只需要配置一次」 ----------
  // 2026-09-22 用户实测：「权限移到最外面、只需要配置一次，还是不断弹出权限配置提示」。
  // 根因之一是向导**不管三七二十一 4 步从头走到尾** —— 已经放行过的用户
  // 每次打开都像「又在弹权限提示」。
  testWidgets('R77：全绿时不再让用户白走 4 步 —— 一句话收场', (tester) async {
    SharedPreferences.setMockInitialValues(<String, Object>{
      keepAliveWizardDoneKey: true,
    });
    await _openWizard(
      tester,
      actions: _actions(granted: const <KeepAlivePermissionStep, bool?>{
        KeepAlivePermissionStep.notification: true,
        KeepAlivePermissionStep.overlay: true,
        KeepAlivePermissionStep.battery: true,
        KeepAlivePermissionStep.autoStart: null,
      }),
    );

    expect(
      find.byKey(const Key('keepAlivePermissionAllGranted')),
      findsOneWidget,
    );
    expect(find.byKey(const Key('keepAlivePermissionWizard')), findsNothing);
  });

  testWidgets('R77：走完向导会落盘记一笔（供下次跳过查不到的自启动）', (tester) async {
    SharedPreferences.setMockInitialValues(<String, Object>{});
    await _openWizard(
      tester,
      actions: _actions(granted: const <KeepAlivePermissionStep, bool?>{
        KeepAlivePermissionStep.notification: true,
        KeepAlivePermissionStep.overlay: true,
        KeepAlivePermissionStep.battery: true,
        KeepAlivePermissionStep.autoStart: null,
      }),
    );

    await tester.tap(find.byKey(const Key('keepAliveWizardDone')));
    await tester.pumpAndSettle();

    final prefs = await SharedPreferences.getInstance();
    expect(prefs.getBool(keepAliveWizardDoneKey), isTrue);
  });

  testWidgets('R77：查不到的步骤若查询抛错，按「未知」处理（不误报成已放行）', (tester) async {
    final pending = await pendingKeepAlivePermissionSteps(
      KeepAlivePermissionActions(
        check: (step) async => throw StateError('原生桥不可用'),
        open: (step) async {},
      ),
    );
    // 全部按「未知」→ 一个都不能跳过
    expect(pending, KeepAlivePermissionStep.values);

    // 已确认过自启动之后，它才不再出现 ✓
    final pendingAgain = await pendingKeepAlivePermissionSteps(
      KeepAlivePermissionActions(
        check: (step) async => throw StateError('原生桥不可用'),
        open: (step) async {},
      ),
      autoStartConfirmed: true,
    );
    expect(
      pendingAgain.contains(KeepAlivePermissionStep.autoStart),
      isFalse,
    );
  });
}
