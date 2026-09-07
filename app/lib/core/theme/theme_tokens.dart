import 'package:flutter/material.dart';

import 'app_colors.dart';

/// 常规页主题语义色扩展（UI-1/UI-2 收敛「视觉死灰」的唯一入口）。
/// 用途：把散写在页面里的 Colors.grey.* / Colors.white 收口为深浅双模式都成立的令牌，
/// 亮色页跟随系统深浅（对照 docs/UI-DESIGN-SPEC.md §2）。
extension ThemeTokensX on BuildContext {
  ThemeData get _theme => Theme.of(this);

  bool get _isDark => _theme.brightness == Brightness.dark;

  /// 主文字（标题 / 关键信息）：亮色 = textPrimary，深色 = onSurface。
  Color get tokenTextStrong => _theme.colorScheme.onSurface;

  /// 次级说明文字：亮色 = textSecondary，深色 = nightTextDim。
  Color get tokenTextBody =>
      _isDark ? AppColors.nightTextDim : AppColors.textSecondary;

  /// 弱化 / 占位文字：亮色 = textHint，深色 = nightTextFaint。
  Color get tokenTextHint =>
      _isDark ? AppColors.nightTextFaint : AppColors.textHint;

  /// 输入框 / 浅灰底填充：亮色 = surfaceMuted，深色 = nightCardHi。
  Color get tokenSurfaceFill =>
      _isDark ? AppColors.nightCardHi : AppColors.surfaceMuted;

  /// 分隔线 / 描边：亮色 = divider，深色 = nightStroke。
  Color get tokenDivider => _isDark ? AppColors.nightStroke : AppColors.divider;
}
