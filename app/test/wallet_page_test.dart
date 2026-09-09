import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:starvoice_app/features/wallet/presentation/wallet_page.dart';
import 'package:starvoice_app/providers.dart';

import 'fake_backend.dart';

/// 直接渲染收银台页（数据走假后端，不出真网）。
Future<void> _pumpWalletPage(WidgetTester tester, FakeBackend backend) async {
  await tester.pumpWidget(
    ProviderScope(
      overrides: [dioProvider.overrideWithValue(buildMockDio(backend))],
      child: const MaterialApp(home: WalletPage()),
    ),
  );
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('加载成功：展示余额、免费配额、充值区与订单/流水', (WidgetTester tester) async {
    tester.view.physicalSize = const Size(1080, 3000);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    await _pumpWalletPage(tester, FakeBackend());

    expect(find.byKey(const Key('walletPage')), findsOneWidget);
    expect(find.byKey(const Key('walletBalanceCard')), findsOneWidget);
    expect(
      tester
          .widget<Text>(find.byKey(const Key('walletBalanceMinutesText')))
          .data,
      '120',
    );
    final quotaBar = tester.widget<LinearProgressIndicator>(
      find.byKey(const Key('walletQuotaBar')),
    );
    expect(quotaBar.value, closeTo(0.8, 0.001));

    expect(find.byKey(const Key('walletChargeCard')), findsOneWidget);
    expect(find.byKey(const Key('walletChargeButton')), findsOneWidget);
    expect(find.textContaining('¥9.9 / 1 小时'), findsOneWidget);
    expect(find.textContaining('¥89.9 / 10 小时'), findsOneWidget);
    expect(find.byKey(const Key('walletRedeemCard')), findsOneWidget);

    expect(find.byKey(const Key('walletOrdersTitle')), findsOneWidget);
    expect(
      find.byKey(const Key('walletOrderItem_order-paid-001')),
      findsOneWidget,
    );
    expect(find.byKey(const Key('walletTransactionsTitle')), findsOneWidget);
    expect(
      find.byKey(const Key('walletTxnItem_wallet-tx-001')),
      findsOneWidget,
    );
  });

  testWidgets('服务端关闭充值入口：隐藏充值区但保留余额与卡密', (WidgetTester tester) async {
    await _pumpWalletPage(tester, FakeBackend(showCharge: false));

    expect(find.byKey(const Key('walletBalanceCard')), findsOneWidget);
    expect(find.byKey(const Key('walletChargeCard')), findsNothing);
    expect(find.byKey(const Key('walletChargeButton')), findsNothing);
    expect(find.byKey(const Key('walletRedeemCard')), findsOneWidget);
  });

  testWidgets('加载失败：整页错误 + 重试按钮', (WidgetTester tester) async {
    await _pumpWalletPage(tester, FakeBackend(failWalletLoad: true));

    expect(find.text('收银台加载失败：钱包服务暂不可用'), findsOneWidget);
    expect(find.byKey(const Key('walletRetryButton')), findsOneWidget);
    expect(find.byKey(const Key('walletBalanceCard')), findsNothing);
  });

  testWidgets('扫码充值：生成收款单并展示微信收款码', (WidgetTester tester) async {
    final backend = FakeBackend();
    await _pumpWalletPage(tester, backend);

    await tester.tap(find.byKey(const Key('walletChargeButton')));
    await tester.pumpAndSettle();

    expect(find.byKey(const Key('walletScanDialog')), findsOneWidget);
    expect(find.byKey(const Key('walletScanWechatQrImage')), findsOneWidget);
    expect(find.byKey(const Key('walletScanHint')), findsOneWidget);
    expect(backend.scanOrders, hasLength(1));
    expect(backend.scanOrders.single['hours'], 1);

    await tester.tap(find.byKey(const Key('walletScanCloseButton')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('walletScanDialog')), findsNothing);
  });

  testWidgets('卡密兑换：入账并刷新余额', (WidgetTester tester) async {
    await _pumpWalletPage(tester, FakeBackend());

    await tester.enterText(
      find.byKey(const Key('walletRedeemInput')),
      'TESTCARD0001',
    );
    await tester.tap(find.byKey(const Key('walletRedeemButton')));
    await tester.pumpAndSettle();

    expect(
      tester
          .widget<Text>(find.byKey(const Key('walletBalanceMinutesText')))
          .data,
      '720',
    );
    expect(find.textContaining('兑换成功：入账 10 小时'), findsOneWidget);

    // 等待 SnackBar 自动消失，避免遗留计时器
    await tester.pump(const Duration(seconds: 5));
    await tester.pumpAndSettle();
  });
}
