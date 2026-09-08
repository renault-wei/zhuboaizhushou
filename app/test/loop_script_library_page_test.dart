import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';

import 'package:starvoice_app/features/loop_scripts/presentation/loop_script_library_page.dart';
import 'package:starvoice_app/features/loop_scripts/presentation/loop_script_new_page.dart';
import 'package:starvoice_app/providers.dart';

import 'fake_backend.dart';

/// 走真实路由：台本库列表 → 顶部「示例台本」→ 套用直达新建编辑器预填 → 保存落库闭环。
Future<void> _pumpLibraryRouter(WidgetTester tester, FakeBackend backend) async {
  final router = GoRouter(
    initialLocation: '/loop-scripts',
    routes: <RouteBase>[
      GoRoute(
        path: '/loop-scripts',
        builder: (context, state) => LoopScriptLibraryPage(
          selectable: state.uri.queryParameters['select'] == '1',
        ),
      ),
      GoRoute(
        path: '/loop-scripts/new',
        builder: (context, state) => LoopScriptNewPage(
          copySourceId: state.uri.queryParameters['copy'],
          sampleSourceId: state.uri.queryParameters['samples'],
        ),
      ),
    ],
  );
  await tester.pumpWidget(
    ProviderScope(
      overrides: [
        dioProvider.overrideWithValue(buildMockDio(backend)),
      ],
      child: MaterialApp.router(routerConfig: router),
    ),
  );
  await tester.pumpAndSettle();
}

/// 滚动到目标控件（ListView 子项延迟物化，先滚动再交互更稳）。
Future<void> _scrollTo(WidgetTester tester, Finder finder) async {
  await tester.scrollUntilVisible(
    finder,
    120,
    scrollable: find.byType(Scrollable).first,
  );
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('台本库展示内置示例，套用直达新建编辑器预填，保存后生成独立新台本', (tester) async {
    final backend = FakeBackend();
    await _pumpLibraryRouter(tester, backend);

    // 顶部示例区展示 2 套火锅示例
    expect(find.byKey(const Key('loopScriptLibraryPage')), findsOneWidget);
    expect(find.text('示例台本（谈单演示）'), findsOneWidget);
    expect(find.byKey(const Key('loopScriptSampleCard_hotpot-set-a')), findsOneWidget);
    expect(find.byKey(const Key('loopScriptSampleCard_hotpot-set-b')), findsOneWidget);

    // 套用示例一：进入新建页「套用示例 · 编辑预览」，标题与条目预填
    await tester.tap(find.byKey(const Key('loopScriptSampleApply_hotpot-set-a')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('loopScriptNewPage')), findsOneWidget);
    expect(find.text('套用示例 · 编辑预览'), findsOneWidget);
    final titleField = tester.widget<TextField>(
      find.byKey(const Key('loopScriptTitleField')),
    );
    expect(titleField.controller!.text, '午市双人火锅套餐 · 示例一');
    expect(find.text('台本条目（4）'), findsOneWidget);

    // 保存：落库生成独立新台本（不写入示例本身）
    final saveButton = find.byKey(const Key('loopScriptNewSaveButton'));
    await _scrollTo(tester, saveButton);
    await tester.tap(saveButton);
    await tester.pumpAndSettle();

    expect(find.byKey(const Key('loopScriptNewPage')), findsNothing);
    expect(backend.loopScripts, hasLength(1));
    expect(backend.loopScripts.single['title'], '午市双人火锅套餐 · 示例一');
    final items = backend.loopScripts.single['items'] as List<dynamic>;
    expect(items, hasLength(4));
    expect(backend.loopScripts.single['id'].toString(), startsWith('loop-'));
    // 回到库页：示例区仍在 + 我的台本出现新卡
    expect(find.byKey(const Key('loopScriptSampleCard_hotpot-set-a')), findsOneWidget);
    expect(find.byKey(Key('loopScriptCard_${backend.loopScripts.single['id']}')), findsOneWidget);
  });

  testWidgets('示例接口异常：错误文案 + 重试按钮，重试成功后恢复展示', (tester) async {
    final backend = FakeBackend(failLoopScriptSamples: true);
    await _pumpLibraryRouter(tester, backend);

    expect(find.textContaining('示例台本加载失败'), findsOneWidget);
    expect(find.byKey(const Key('loopScriptSamplesRetryButton')), findsOneWidget);

    backend.failLoopScriptSamples = false;
    await tester.tap(find.byKey(const Key('loopScriptSamplesRetryButton')));
    await tester.pumpAndSettle();

    expect(find.byKey(const Key('loopScriptSampleCard_hotpot-set-a')), findsOneWidget);
    expect(find.byKey(const Key('loopScriptSamplesRetryButton')), findsNothing);
  });
}
