import 'package:flutter_test/flutter_test.dart';

import 'package:starvoice_app/core/models/coupon.dart';

void main() {
  group('Coupon', () {
    test('fromJson 解析完整字段', () {
      final coupon = Coupon.fromJson(<String, dynamic>{
        'couponId': 'c-001-abc',
        'name': '双人火锅套餐',
        'package': '锅底1份+肥牛1份',
        'price': 128,
        'originalPrice': 238,
        'sales': 1200,
        'imageUrl': '',
        // 服务端多下发的字段应被忽略，不参与解析
        'provider': 'douyin',
      });

      expect(coupon.couponId, 'c-001-abc');
      expect(coupon.name, '双人火锅套餐');
      expect(coupon.package, '锅底1份+肥牛1份');
      expect(coupon.price, 128);
      expect(coupon.originalPrice, 238);
      expect(coupon.sales, 1200);
      expect(coupon.imageUrl, '');
    });

    test('缺失字段与数值类型容错', () {
      final coupon = Coupon.fromJson(<String, dynamic>{
        'couponId': 1001,
        'price': 39.0,
      });

      expect(coupon.couponId, '1001');
      expect(coupon.name, '');
      expect(coupon.package, '');
      expect(coupon.price, 39);
      expect(coupon.originalPrice, 0);
      expect(coupon.sales, 0);
    });

    test('价格与折扣文案', () {
      const coupon = Coupon(
        couponId: 'c-001',
        name: '双人火锅套餐',
        package: 'x',
        price: 128,
        originalPrice: 238,
        sales: 1200,
        imageUrl: '',
      );

      expect(coupon.priceText, '¥128');
      expect(coupon.originalPriceText, '¥238');
      expect(coupon.salesText, '已售 1200');
      expect(coupon.savedAmount, 110);
      expect(coupon.discountText, '5.4折');
      expect(coupon.hasDiscount, isTrue);
    });

    test('原价不高于售价时不展示折扣', () {
      const coupon = Coupon(
        couponId: 'c-002',
        name: 'x',
        package: 'y',
        price: 100,
        originalPrice: 100,
        sales: 0,
        imageUrl: '',
      );

      expect(coupon.hasDiscount, isFalse);
      expect(coupon.savedAmount, 0);
      expect(coupon.discountText, '');
    });
  });
}
