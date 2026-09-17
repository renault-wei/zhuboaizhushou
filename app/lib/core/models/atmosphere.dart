/// 氛围语（M10 · R25）：循环台本空档自动插播的短句 + 每类的插播频次。
///
/// 服务端从 M10 起就已完整（模板 CRUD + 频次设置），但 App 里长期是 **0 处** —— 本页补上。
/// 五类：welcome 欢迎 / follow 关注 / thumb 点赞 / clock 整点报时 / custom 自定义暖场。
///
/// 模板文本**一行 = 一条候选句**（服务端按行随机挑），支持 `[昵称]` 占位。
library;

/// 类别 → 中文名（与 server ATMOSPHERE_CATEGORIES 同序）
const Map<String, String> kAtmosphereCategoryLabels = <String, String>{
  'welcome': '欢迎语',
  'follow': '关注语',
  'thumb': '点赞互动',
  'clock': '整点报时',
  'custom': '自定义暖场',
};

const List<String> kAtmosphereCategories = <String>[
  'welcome',
  'follow',
  'thumb',
  'clock',
  'custom',
];

/// 一条氛围语模板（一条记录里可含多行 = 多条候选句）。
class AtmosphereTemplate {
  const AtmosphereTemplate({
    required this.id,
    required this.category,
    required this.text,
    required this.enabled,
  });

  factory AtmosphereTemplate.fromJson(Map<String, dynamic> json) {
    return AtmosphereTemplate(
      id: json['id']?.toString() ?? '',
      category: json['category']?.toString() ?? '',
      text: json['text']?.toString() ?? '',
      enabled: json['enabled'] != false,
    );
  }

  final String id;
  final String category;
  final String text;
  final bool enabled;

  String get label => kAtmosphereCategoryLabels[category] ?? category;
}

/// 某一类的插播频次规则（服务端下发，App 不自己推默认值）。
class AtmosphereFrequencyRule {
  const AtmosphereFrequencyRule({
    required this.defaultSeconds,
    required this.minSeconds,
    required this.maxSeconds,
    required this.disabledSeconds,
  });

  factory AtmosphereFrequencyRule.fromJson(Map<String, dynamic> json) {
    return AtmosphereFrequencyRule(
      defaultSeconds: (json['defaultSeconds'] as num?)?.toInt() ?? 60,
      minSeconds: (json['minSeconds'] as num?)?.toInt() ?? 1,
      maxSeconds: (json['maxSeconds'] as num?)?.toInt() ?? 300,
      disabledSeconds: (json['disabledSeconds'] as num?)?.toInt() ?? 0,
    );
  }

  final int defaultSeconds;
  final int minSeconds;
  final int maxSeconds;
  /// 0 —— 恒为合法值，代表「不插播」
  final int disabledSeconds;

  bool get supportsDisabled => disabledSeconds == 0;
}

/// 某一类的当前频次设置。
class AtmosphereSetting {
  const AtmosphereSetting({
    required this.category,
    required this.intervalSeconds,
    required this.isCustom,
    required this.rule,
  });

  factory AtmosphereSetting.fromJson(Map<String, dynamic> json) {
    final rawRule = json['rule'];
    return AtmosphereSetting(
      category: json['category']?.toString() ?? '',
      intervalSeconds: (json['intervalSeconds'] as num?)?.toInt() ?? 60,
      isCustom: json['isCustom'] == true,
      rule: AtmosphereFrequencyRule.fromJson(
        rawRule is Map ? Map<String, dynamic>.from(rawRule) : <String, dynamic>{},
      ),
    );
  }

  final String category;
  /// 0 = 不插播
  final int intervalSeconds;
  final bool isCustom;
  final AtmosphereFrequencyRule rule;

  String get label => kAtmosphereCategoryLabels[category] ?? category;
  bool get disabled => intervalSeconds == rule.disabledSeconds;
}
