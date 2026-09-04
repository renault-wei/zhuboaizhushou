import 'package:flutter_test/flutter_test.dart';

import 'package:starvoice_app/core/network/api_client.dart';
import 'package:starvoice_app/features/coupons/application/coupon_controller.dart';

import 'fake_backend.dart';

void main() {
  test('load 拉取已绑定账号的团购券列表', () async {
    final backend = FakeBackend(douyinBound: true);
    final controller = CouponController(ApiClient(buildMockDio(backend)));

    await controller.load();
    expect(controller.state.loading, isFalse);
    expect(controller.state.coupons.length, 5);
    expect(controller.state.coupons.first.name, '双人火锅套餐');
    expect(controller.state.error, isNull);
    expect(controller.state.notBound, isFalse);

    controller.dispose();
  });

  test('未绑定抖音号：state 记录 DOUYIN_NOT_BOUND', () async {
    final backend = FakeBackend(douyinBound: false);
    final controller = CouponController(ApiClient(buildMockDio(backend)));

    await controller.load();
    expect(controller.state.coupons, isEmpty);
    expect(controller.state.notBound, isTrue);
    expect(controller.state.error, '请先绑定抖音号');

    controller.dispose();
  });

  test('列表接口 500：state 记录中文错误提示', () async {
    final backend = FakeBackend(douyinBound: true, failCouponsList: true);
    final controller = CouponController(ApiClient(buildMockDio(backend)));

    await controller.load();
    expect(controller.state.coupons, isEmpty);
    expect(controller.state.error, '团购券服务暂不可用');
    expect(controller.state.notBound, isFalse);

    controller.dispose();
  });
}
