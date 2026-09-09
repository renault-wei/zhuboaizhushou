import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:starvoice_app/app.dart';
import 'package:starvoice_app/features/home/presentation/home_page.dart';
import 'package:starvoice_app/providers.dart';

import 'fake_backend.dart';

/// 登录并进入首页（假后端全程无真实网络请求）。
Future<void> _pumpLoggedInHome(WidgetTester tester, FakeBackend backend) async {
  SharedPreferences.setMockInitialValues({});
  await tester.pumpWidget(
    ProviderScope(
      overrides: [dioProvider.overrideWithValue(buildMockDio(backend))],
      child: const StarVoiceApp(),
    ),
  );
  await tester.pumpAndSettle();

  await tester.enterText(find.byKey(const Key('phoneField')), '13800138000');
  await tester.tap(find.byKey(const Key('sendCodeButton')));
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 100));
  await tester.tap(find.byKey(const Key('loginButton')));
  await tester.pumpAndSettle();
}

/// 滚动到目标控件：ListView 子项延迟物化，先滚动使其可见再交互。
Future<void> _scrollTo(WidgetTester tester, Finder finder) async {
  await tester.scrollUntilVisible(
    finder,
    120,
    scrollable: find.byType(Scrollable).first,
  );
  await tester.pumpAndSettle();
}

/// 首页为懒加载 ListView，目标卡片在首屏下方时先滚动到可视区再断言/点按。
Future<void> _scrollHomeTo(WidgetTester tester, Finder finder) async {
  await tester.scrollUntilVisible(
    finder,
    120,
    scrollable: find
        .descendant(
          of: find.byType(HomePage),
          matching: find.byType(Scrollable),
        )
        .first,
  );
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('首页「话术生成」入口：生成话术 → 编辑保存 → 返回后数量刷新', (WidgetTester tester) async {
    final backend = FakeBackend();
    await _pumpLoggedInHome(tester, backend);

    // 首页出现「话术生成」卡片，初始数量为 0（卡片在首页纵深，先滚动到可视区）
    await _scrollHomeTo(tester, find.byKey(const Key('scriptEntryCard')));
    expect(find.byKey(const Key('scriptEntryCard')), findsOneWidget);
    expect(find.text('话术生成'), findsOneWidget);
    final countLabel = tester.widget<Text>(
      find.byKey(const Key('scriptEntryCountLabel')),
    );
    expect(countLabel.data, '0 条');

    // 点击入口进入话术生成页
    final openButton = find.byKey(const Key('scriptEntryOpenButton'));
    await tester.ensureVisible(openButton);
    await tester.pumpAndSettle();
    await tester.tap(openButton);
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('scriptGeneratePage')), findsOneWidget);

    // 填写商品信息并生成
    await tester.enterText(find.byKey(const Key('scriptField_name')), '双人火锅套餐');
    await tester.enterText(find.byKey(const Key('scriptField_price')), '99');
    final generateButton = find.byKey(const Key('scriptGenerateButton'));
    await _scrollTo(tester, generateButton);
    await tester.tap(generateButton);
    await tester.pumpAndSettle();

    // 生成成功：新话术卡片可开播
    final card = find.byKey(const Key('scriptCard_script-001'));
    await _scrollTo(tester, card);
    expect(card, findsOneWidget);
    expect(find.text('可开播'), findsOneWidget);

    // 从卡片进入编辑页并保存修改后的干净话术
    final editButton = find.byKey(const Key('scriptEdit_script-001'));
    await _scrollTo(tester, editButton);
    await tester.tap(editButton);
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('scriptEditPage')), findsOneWidget);

    await tester.enterText(
      find.byKey(const Key('scriptEditContentField')),
      '双人火锅套餐，锅底现炒，欢迎到店品尝，快下单吧。',
    );
    final saveButton = find.byKey(const Key('scriptSaveButton'));
    await tester.ensureVisible(saveButton);
    await tester.tap(saveButton);
    await tester.pumpAndSettle();
    expect(find.text('已保存，并完成敏感词重新扫描'), findsOneWidget);

    // 返回话术页（自动刷新列表）再返回首页（入口数量刷新为 1）
    await tester.pageBack();
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('scriptGeneratePage')), findsOneWidget);

    await tester.pageBack();
    await tester.pumpAndSettle();
    final updatedLabel = tester.widget<Text>(
      find.byKey(const Key('scriptEntryCountLabel')),
    );
    expect(updatedLabel.data, '1 条');

    // 等 SnackBar 计时器结束，避免遗留 pending timer
    await tester.pump(const Duration(seconds: 5));
    await tester.pumpAndSettle();
  });
}
