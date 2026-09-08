import 'package:flutter_test/flutter_test.dart';

import 'package:starvoice_app/core/network/api_client.dart';
import 'package:starvoice_app/features/wallet/application/wallet_controller.dart';

import 'fake_backend.dart';

void main() {
  test('load 拉取钱包总览与服务端开关', () async {
    final backend = FakeBackend();
    final controller = WalletController(ApiClient(buildMockDio(backend)));

    await controller.load();

    expect(controller.state.loading, isFalse);
    expect(controller.state.error, isNull);
    expect(controller.state.overview?.balanceMinutes, 120);
    expect(controller.state.overview?.monthlyLive.remainingMinutes, 480);
    expect(controller.state.overview?.rechargeOrders, hasLength(1));
    expect(controller.state.overview?.transactions, hasLength(2));
    expect(controller.state.config?.showCharge, isTrue);
    expect(controller.state.config?.pricePacks, hasLength(2));
    expect(controller.state.showCharge, isTrue);

    controller.dispose();
  });

  test('服务端关闭充值入口：showCharge 为 false', () async {
    final backend = FakeBackend(showCharge: false);
    final controller = WalletController(ApiClient(buildMockDio(backend)));

    await controller.load();

    expect(controller.state.config?.showCharge, isFalse);
    expect(controller.state.showCharge, isFalse);

    controller.dispose();
  });

  test('加载失败进入错误态，重试成功后清空 error', () async {
    final backend = FakeBackend(failWalletLoad: true);
    final controller = WalletController(ApiClient(buildMockDio(backend)));

    await controller.load();
    expect(controller.state.error, '钱包服务暂不可用');
    expect(controller.state.overview, isNull);

    backend.failWalletLoad = false;
    await controller.load();
    expect(controller.state.error, isNull);
    expect(controller.state.overview?.balanceMinutes, 120);

    controller.dispose();
  });

  test('扫码下单创建订单，运营确权后轮询 paid 并刷新余额', () async {
    final backend = FakeBackend();
    final controller = WalletController(ApiClient(buildMockDio(backend)));

    await controller.load();
    final scan = await controller.startScan(10);

    expect(scan, isNotNull);
    expect(scan?.order.hours, 10);
    expect(scan?.mockChannel, isTrue);
    expect(backend.scanOrders, hasLength(1));

    // 本地验收 mock 通道：运营后台人工确权
    backend.confirmScanOrder(scan!.order.id);
    final poll = await controller.pollRecharge(scan.order.id);
    expect(poll?.paid, isTrue);

    await controller.load();
    expect(controller.state.overview?.balanceMinutes, 720);

    controller.dispose();
  });

  test('卡密核销成功：余额增加且入账流水可见', () async {
    final backend = FakeBackend();
    final controller = WalletController(ApiClient(buildMockDio(backend)));

    await controller.load();
    final result = await controller.redeemCard('TESTCARD0001');

    expect(result, isNotNull);
    expect(result?.creditedMinutes, 600);
    expect(result?.balanceMinutes, 720);
    expect(controller.state.overview?.balanceMinutes, 720);
    expect(
      controller.state.overview?.transactions.first.sourceKind,
      'card_redeem',
    );

    controller.dispose();
  });

  test('卡密核销失败：返回 null 并写入 actionError', () async {
    final backend = FakeBackend();
    final controller = WalletController(ApiClient(buildMockDio(backend)));

    await controller.load();
    final result = await controller.redeemCard('NOT-A-CARD');

    expect(result, isNull);
    expect(controller.state.actionError, '卡密不存在或已失效');
    expect(controller.state.overview?.balanceMinutes, 120);

    controller.dispose();
  });
}
