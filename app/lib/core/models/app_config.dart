// 服务端开关（app_config）下发模型：字段与 GET /api/app/config 返回的
// config 对象保持一致（商家端只读，管理端在 admin 后台维护）。

/// 预充时长档位（服务端下发，管理后台可改）。
class PricePack {
  const PricePack({required this.hours, required this.amountCents});

  factory PricePack.fromJson(Map<String, dynamic> json) {
    return PricePack(
      hours: (json['hours'] as num?)?.toInt() ?? 0,
      amountCents: (json['amountCents'] as num?)?.toInt() ?? 0,
    );
  }

  /// 档位时长（小时，正整数）。
  final int hours;

  /// 档位价格（单位：分）。
  final int amountCents;

  /// 元金额（分 ÷ 100），如 990 → 9.9。
  double get yuan => amountCents / 100;
}

/// 商家端公开配置：充值入口显隐 + 档位 + 公告。
class PublicAppConfig {
  const PublicAppConfig({
    required this.showCharge,
    required this.pricePacks,
    required this.notice,
  });

  /// 从 GET /api/app/config 返回的 config 对象解析（不含外层包裹）。
  factory PublicAppConfig.fromJson(Map<String, dynamic> json) {
    final packsRaw = json['pricePacks'];
    return PublicAppConfig(
      showCharge: json['showCharge'] == true,
      pricePacks: packsRaw is List
          ? packsRaw
                .whereType<Map>()
                .map(
                  (item) => PricePack.fromJson(Map<String, dynamic>.from(item)),
                )
                .toList()
          : <PricePack>[],
      notice: json['notice']?.toString() ?? '',
    );
  }

  /// 是否展示充值入口（服务端开关，管理端可关停）。
  final bool showCharge;
  final List<PricePack> pricePacks;

  /// 公告弹窗文案（空串 = 不弹）。
  final String notice;

  bool get hasNotice => notice.trim().isNotEmpty;
}
