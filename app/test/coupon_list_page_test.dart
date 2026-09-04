import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:starvoice_app/features/coupons/presentation/coupon_list_page.dart';
import 'package:starvoice_app/providers.dart';

import 'fake_backend.dart';

Future<void> _pumpCouponPage(
  WidgetTester tester,
  FakeBackend backend,
) async {
  await tester.pumpWidget(
    ProviderScope(
      overrides: [dioProvider.overrideWithValue(buildMockDio(backend))],
      child: const MaterialApp(home: CouponListPage()),
    ),
  );
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('未绑定抖音号：展示引导去绑定的提示与按钮', (WidgetTester tester) async {
    final backend = FakeBackend(douyinBound: false);
    await _pumpCouponPage(tester, backend);

    expect(find.byKey(const Key('couponListPage')), findsOneWidget);
    expect(find.text('团购券'), findsOneWidget);
    expect(find.text('请先绑定抖音号，才能拉取团购券'), findsOneWidget);
    expect(find.byKey(const Key('couponGoBindButton')), findsOneWidget);
  });

  testWidgets('已绑定：渲染团购券名称、售价、折扣与已售数量', (WidgetTester tester) async {
    final backend = FakeBackend(douyinBound: true);
    await _pumpCouponPage(tester, backend);

    expect(find.byKey(const Key('couponCard_c-001-mock')), findsOneWidget);
    expect(find.text('双人火锅套餐'), findsOneWidget);
    expect(find.text('¥128'), findsOneWidget);
    expect(find.text('5.4折'), findsOneWidget);
    expect(find.text('已售 1200'), findsOneWidget);
  });

  testWidgets('列表接口失败：展示错误提示与重试按钮', (WidgetTester tester) async {
    final backend = FakeBackend(douyinBound: true, failCouponsList: true);
    await _pumpCouponPage(tester, backend);

    expect(find.text('团购券加载失败：团购券服务暂不可用'), findsOneWidget);
    expect(find.byKey(const Key('couponListRetryButton')), findsOneWidget);
  });

  testWidgets('已绑定但无券：展示空态引导', (WidgetTester tester) async {
    final backend = FakeBackend(
      douyinBound: true,
      coupons: <Map<String, dynamic>>[],
    );
    await _pumpCouponPage(tester, backend);

    expect(find.text('暂无团购券，请到抖音生活服务后台创建'), findsOneWidget);
  });
}
