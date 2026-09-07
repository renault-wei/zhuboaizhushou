import 'package:flutter/material.dart';

import 'app_colors.dart';

/// 应用主题工厂：全 App 使用「星橙」种子色统一组件外观；
/// 现场直播工作台使用固定深色面板（workbench），不随系统主题切换。
abstract final class AppTheme {
  AppTheme._();

  /// 常规页面亮色主题。
  static ThemeData light() => _build(Brightness.light);

  /// 常规页面暗色主题（跟随系统深色模式）。
  static ThemeData dark() => _build(Brightness.dark);

  /// 现场直播工作台固定暗色主题：直播中长时间注视的操作面板。
  static ThemeData workbench() {
    return _build(Brightness.dark).copyWith(
      scaffoldBackgroundColor: AppColors.nightBg,
      colorScheme: const ColorScheme.dark(
        primary: AppColors.primary,
        onPrimary: Colors.white,
        secondary: AppColors.live,
        onSecondary: Color(0xFF0A3A1D),
        error: AppColors.danger,
        onError: Colors.white,
        surface: AppColors.nightCard,
        onSurface: AppColors.nightText,
      ),
      cardTheme: const CardThemeData(
        color: AppColors.nightCard,
        surfaceTintColor: Colors.transparent,
        elevation: 0,
        margin: EdgeInsets.zero,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.all(Radius.circular(18)),
          side: BorderSide(color: AppColors.nightStroke, width: 1),
        ),
      ),
      inputDecorationTheme: InputDecorationTheme(
        filled: true,
        fillColor: AppColors.nightCardHi,
        hintStyle: const TextStyle(color: AppColors.nightTextFaint),
        contentPadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
        enabledBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(12),
          borderSide: const BorderSide(color: AppColors.nightStroke),
        ),
        focusedBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(12),
          borderSide: const BorderSide(color: AppColors.primary, width: 1.5),
        ),
      ),
      snackBarTheme: SnackBarThemeData(
        backgroundColor: AppColors.nightCardHi,
        contentTextStyle: const TextStyle(color: AppColors.nightText),
        behavior: SnackBarBehavior.floating,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
      ),
    );
  }

  static ThemeData _build(Brightness brightness) {
    final isDark = brightness == Brightness.dark;
    final scheme = ColorScheme.fromSeed(
      seedColor: AppColors.primary,
      brightness: brightness,
    );
    return ThemeData(
      colorScheme: scheme,
      scaffoldBackgroundColor: isDark ? AppColors.nightBg : scheme.surface,
      appBarTheme: AppBarTheme(
        backgroundColor: isDark ? AppColors.nightBg : scheme.surface,
        foregroundColor: isDark ? AppColors.nightText : scheme.onSurface,
        elevation: 0,
        centerTitle: false,
        titleTextStyle: TextStyle(
          fontSize: 17,
          fontWeight: FontWeight.w600,
          color: isDark ? AppColors.nightText : scheme.onSurface,
        ),
      ),
      cardTheme: CardThemeData(
        color: isDark ? AppColors.nightCard : scheme.surface,
        surfaceTintColor: Colors.transparent,
        elevation: 0,
        margin: EdgeInsets.zero,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(16),
        ),
      ),
      dividerTheme: DividerThemeData(
        color: isDark ? AppColors.nightStroke : AppColors.divider,
        thickness: 1,
        space: 1,
      ),
      inputDecorationTheme: InputDecorationTheme(
        filled: true,
        fillColor: isDark ? AppColors.nightCardHi : AppColors.surfaceMuted,
        contentPadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
        enabledBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(12),
          borderSide: BorderSide(color: isDark ? AppColors.nightStroke : AppColors.divider),
        ),
        focusedBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(12),
          borderSide: BorderSide(color: AppColors.primary, width: 1.5),
        ),
      ),
      snackBarTheme: SnackBarThemeData(
        backgroundColor: isDark ? AppColors.nightCardHi : Color(0xFF32343A),
        behavior: SnackBarBehavior.floating,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
      ),
    );
  }
}