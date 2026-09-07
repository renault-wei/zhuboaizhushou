/// 抖音团购券数据模型：字段与服务端 /api/douyin/coupons 返回保持一致。
class Coupon {
  const Coupon({
    required this.couponId,
    required this.name,
    required this.package,
    required this.price,
    required this.originalPrice,
    required this.sales,
    required this.imageUrl,
  });

  factory Coupon.fromJson(Map<String, dynamic> json) {
    return Coupon(
      couponId: json['couponId']?.toString() ?? '',
      name: json['name']?.toString() ?? '',
      package: json['package']?.toString() ?? '',
      price: (json['price'] as num?)?.toInt() ?? 0,
      originalPrice: (json['originalPrice'] as num?)?.toInt() ?? 0,
      sales: (json['sales'] as num?)?.toInt() ?? 0,
      imageUrl: json['imageUrl']?.toString() ?? '',
    );
  }

  /// 抖音侧券 ID
  final String couponId;

  /// 券名，如「双人火锅套餐」
  final String name;

  /// 套餐内容
  final String package;

  /// 售价（元，整数）
  final int price;

  /// 原价（元，整数）
  final int originalPrice;

  /// 已售数量
  final int sales;

  /// 券图（mock 阶段为空，客户端用色块占位）
  final String imageUrl;

  /// 售价文案（带人民币符号），如「¥128」
  String get priceText => '¥$price';

  /// 原价文案，如「¥238」
  String get originalPriceText => '¥$originalPrice';

  /// 已售文案，如「已售 1200」
  String get salesText => '已售 $sales';

  /// 立省金额（元）；原价不高于售价时返回 0。
  int get savedAmount => originalPrice > price ? originalPrice - price : 0;

  /// 折扣文案，如「5.4折」；原价非法时返回空串。
  /// 折扣口径：折 = price / originalPrice * 10（如 128/238 → 5.4 折）。
  String get discountText {
    // 无真实优惠（原价缺省、价格非法或并不比原价低）一律不展示折扣，
    // 避免出现「10.0折」这类无意义文案（hasDiscount 口径保持一致）。
    if (originalPrice <= 0 || price < 0 || originalPrice <= price) {
      return '';
    }
    final discount = price / originalPrice * 10;
    return '${discount.toStringAsFixed(1)}折';
  }

  /// 是否提供可展示的折扣（有原价且原价高于售价）。
  bool get hasDiscount => originalPrice > price;
}
