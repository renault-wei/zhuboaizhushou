// App 展示元信息：与 pubspec.yaml 的 version 行保持同步。
// 发布升级包时需同时改本常量与 pubspec version（versionName+versionCode），
// 供「我的」页与「关于」页展示，避免散写多处。
class AppMeta {
  AppMeta._();

  /// 产品名（对外展示名）。
  static const String appName = '星辰语音';

  /// 一句话定位。
  static const String slogan = 'AI 智能直播助手';

  /// 当前展示版本（对齐 pubspec.yaml version）。
  static const String version = '0.3.0+92';

  /// 版权年与主体占位（正式商用前由运营补公司主体）。
  static const String copyright = '© 2026 星辰语音';
}

/// 官方客服对外联系方式：上线前由运营把真实对外微信号填入 [supportWechat]，
/// 保持为空时「官方客服」页只展示「待配置」提示，不会展示编造的号码。
class SupportContact {
  SupportContact._();

  /// 官方客服微信号（空串 = 未配置）。
  static const String supportWechat = '';

  /// 客服在线服务时段说明。
  static const String serviceHours = '每天 09:00 - 21:00';
}
