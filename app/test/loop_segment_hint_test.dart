/// R19：编辑器要把「这段台词会被切成几段合成」展示出来。
/// 放开 200 字限制后，长话术走「按标点切段 → 逐段合成 → 拼回单段音频」，
/// 用户需要看得见份数；份数一律以服务端为准（客户端不另写一份实现）。
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:starvoice_app/core/models/loop_script.dart';
import 'package:starvoice_app/features/loop_scripts/presentation/loop_script_editor_panel.dart';
import 'package:starvoice_app/providers.dart';

import 'fake_backend.dart';

void main() {
  testWidgets('R19：编辑器展示「合成 N 段」，长话术不再被 200 字拦住', (tester) async {
    final backend = FakeBackend();
    // 240 字（Dart 无字符串乘法，用 join 构造）
    final longText = List<String>.filled(30, '欢迎来到直播间。').join();
    expect(longText.length, 240);

    await tester.pumpWidget(
      ProviderScope(
        overrides: <Override>[dioProvider.overrideWithValue(buildMockDio(backend))],
        child: MaterialApp(
          home: Scaffold(
            body: LoopScriptEditorPanel(
              initialTitle: 'R19 测试台本',
              initialItems: <LoopScriptItem>[LoopScriptItem(text: longText)],
              onSave: (String title, List<LoopScriptItem> items) async {},
            ),
          ),
        ),
      ),
    );
    // 首次预览走一次网络（假后端），等它回来
    await tester.pumpAndSettle();

    expect(find.byKey(const Key('loopItemSegmentHint')), findsOneWidget);
    expect(find.textContaining('240 字'), findsOneWidget);
    expect(find.textContaining('合成 2 段'), findsOneWidget);
  });

  testWidgets('R19：服务端已回带份数时直接用，不再多打一次预览', (tester) async {
    final backend = FakeBackend();
    await tester.pumpWidget(
      ProviderScope(
        overrides: <Override>[dioProvider.overrideWithValue(buildMockDio(backend))],
        child: MaterialApp(
          home: Scaffold(
            body: LoopScriptEditorPanel(
              initialTitle: 'R19 测试台本',
              initialItems: <LoopScriptItem>[
                LoopScriptItem(text: '一句话就够。', ttsSegmentCount: 1),
              ],
              onSave: (String title, List<LoopScriptItem> items) async {},
            ),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.textContaining('合成 1 段'), findsOneWidget);
  });
}
