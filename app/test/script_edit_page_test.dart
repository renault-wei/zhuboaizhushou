import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:starvoice_app/features/scripts/presentation/script_edit_page.dart';
import 'package:starvoice_app/providers.dart';

import 'fake_backend.dart';

Map<String, dynamic> _scriptJson({
  required String id,
  required String status,
  String title = '火锅套餐话术',
  String content = '双人火锅套餐，锅底现炒，欢迎到店品尝。',
  List<String> matchedWords = const <String>[],
}) {
  return <String, dynamic>{
    'id': id,
    'industry': 'restaurant',
    'title': title,
    'productSnapshot': <String, dynamic>{
      'name': '双人火锅套餐',
      'price': '99 元',
    },
    'content': content,
    'status': status,
    'sensitiveCheckStatus': matchedWords.isEmpty ? 'pass' : 'blocked',
    'sensitiveMatchedWords': matchedWords,
    'sensitiveScannedAt': DateTime.now().toUtc().toIso8601String(),
    'createdAt': DateTime.now().toUtc().toIso8601String(),
    'updatedAt': DateTime.now().toUtc().toIso8601String(),
  };
}

Future<void> _pumpEditPage(
  WidgetTester tester,
  FakeBackend backend, {
  required String scriptId,
}) async {
  await tester.pumpWidget(
    ProviderScope(
      overrides: [dioProvider.overrideWithValue(buildMockDio(backend))],
      child: MaterialApp(home: ScriptEditPage(scriptId: scriptId)),
    ),
  );
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('加载详情：标题与正文预填，扫描通过提示展示', (WidgetTester tester) async {
    final backend = FakeBackend(
      scripts: <Map<String, dynamic>>[
        _scriptJson(id: 'script-001', status: 'ready'),
      ],
    );
    await _pumpEditPage(tester, backend, scriptId: 'script-001');

    expect(find.byKey(const Key('scriptEditPage')), findsOneWidget);
    final titleField = tester.widget<TextField>(
      find.byKey(const Key('scriptEditTitleField')),
    );
    final contentField = tester.widget<TextField>(
      find.byKey(const Key('scriptEditContentField')),
    );
    expect(titleField.controller?.text, '火锅套餐话术');
    expect(contentField.controller?.text, contains('双人火锅套餐'));
    expect(find.byKey(const Key('scriptEditReadyHint')), findsOneWidget);
    expect(find.text('扫描通过，当前话术可开播'), findsOneWidget);
  });

  testWidgets('话术不存在：加载失败提示与重试按钮', (WidgetTester tester) async {
    final backend = FakeBackend(
      scripts: <Map<String, dynamic>>[
        _scriptJson(id: 'script-001', status: 'ready'),
      ],
    );
    await _pumpEditPage(tester, backend, scriptId: 'script-999');

    expect(find.text('话术加载失败：话术不存在'), findsOneWidget);
    expect(find.byKey(const Key('scriptEditRetryButton')), findsOneWidget);
  });

  testWidgets('内容清空后保存：提示不能为空且不调用保存', (WidgetTester tester) async {
    final backend = FakeBackend(
      scripts: <Map<String, dynamic>>[
        _scriptJson(id: 'script-001', status: 'ready'),
      ],
    );
    await _pumpEditPage(tester, backend, scriptId: 'script-001');

    await tester.enterText(
      find.byKey(const Key('scriptEditContentField')),
      '   ',
    );
    final saveButton = find.byKey(const Key('scriptSaveButton'));
    await tester.ensureVisible(saveButton);
    await tester.tap(saveButton);
    await tester.pump();

    expect(find.text('话术内容不能为空'), findsOneWidget);
    // 服务端内容未被改写
    expect(backend.scripts.single['content'], contains('双人火锅套餐'));

    await tester.pump(const Duration(seconds: 5));
    await tester.pumpAndSettle();
  });

  testWidgets('保存干净内容：重新扫描通过并展示可开播提示', (WidgetTester tester) async {
    final backend = FakeBackend(
      scripts: <Map<String, dynamic>>[
        _scriptJson(id: 'script-001', status: 'ready'),
      ],
    );
    await _pumpEditPage(tester, backend, scriptId: 'script-001');

    await tester.enterText(
      find.byKey(const Key('scriptEditContentField')),
      '双人火锅套餐，锅底现炒，欢迎到店品尝，现在下单送饮料。',
    );
    final saveButton = find.byKey(const Key('scriptSaveButton'));
    await tester.ensureVisible(saveButton);
    await tester.tap(saveButton);
    await tester.pumpAndSettle();

    expect(find.text('已保存，并完成敏感词重新扫描'), findsOneWidget);
    expect(find.byKey(const Key('scriptEditReadyHint')), findsOneWidget);
    expect(backend.scripts.single['status'], 'ready');
    expect(backend.scripts.single['sensitiveCheckStatus'], 'pass');

    await tester.pump(const Duration(seconds: 5));
    await tester.pumpAndSettle();
  });

  testWidgets('编辑引入敏感词：保存后重新扫描命中并展示红色警示', (WidgetTester tester) async {
    final backend = FakeBackend(
      scripts: <Map<String, dynamic>>[
        _scriptJson(id: 'script-001', status: 'ready'),
      ],
    );
    await _pumpEditPage(tester, backend, scriptId: 'script-001');

    await tester.enterText(
      find.byKey(const Key('scriptEditContentField')),
      '本店独家优惠，欢迎到店品尝。',
    );
    final saveButton = find.byKey(const Key('scriptSaveButton'));
    await tester.ensureVisible(saveButton);
    await tester.tap(saveButton);
    await tester.pumpAndSettle();

    expect(find.byKey(const Key('scriptEditBlockedBanner')), findsOneWidget);
    expect(find.text('命中敏感词：独家，话术不可开播'), findsOneWidget);
    expect(backend.scripts.single['status'], 'blocked');
    expect(backend.scripts.single['sensitiveCheckStatus'], 'blocked');

    await tester.pump(const Duration(seconds: 5));
    await tester.pumpAndSettle();
  });
}
