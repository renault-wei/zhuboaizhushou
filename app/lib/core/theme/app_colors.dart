import 'package:flutter/material.dart';

/// 星辰语音 · 颜色令牌（唯一视觉事实源 = docs/UI-DESIGN-SPEC.md）。
/// 「星橙」= 品牌主色（直播带货氛围）；「现场暗色」系列用于直播工作台等
/// 长时间注视的操作面板；亮色令牌用于配置 / 素材等常规页面。
abstract final class AppColors {
  AppColors._();

  // ---- 品牌与语义色 ----
  static const Color primary = Color(0xFFFF6B35); // 星橙（主行动）
  static const Color primaryDark = Color(0xFFE2541D);
  static const Color primarySoft = Color(0x1FFF6B35); // 主色低透明底
  static const Color live = Color(0xFF22C55E); // 在播 / 成功
  static const Color danger = Color(0xFFEF4444); // 静音 / 失败 / 结束
  static const Color warning = Color(0xFFF59E0B); // 合规提示 / 待处理
  static const Color warningSoft = Color(0x24F59E0B);
  static const Color info = Color(0xFF3B82F6); // 信息 / 待机

  // ---- 亮色页中性色 ----
  static const Color textPrimary = Color(0xFF1C2430);
  static const Color textSecondary = Color(0xFF5B6472);
  static const Color textHint = Color(0xFF8A93A2);
  static const Color surfaceMuted = Color(0xFFF5F6F8);
  static const Color divider = Color(0xFFE5E8EE);

  // ---- 现场暗色面板（直播工作台）----
  static const Color nightBg = Color(0xFF0E1220); // 页面底
  static const Color nightCard = Color(0xFF1A2132); // 卡片底
  static const Color nightCardHi = Color(0xFF242D44); // 输入/图标底、高亮区
  static const Color nightStroke = Color(0xFF2E3852); // 描边
  static const Color nightText = Color(0xFFF2F4F9); // 主文字
  static const Color nightTextDim = Color(0xFFA9B2C6); // 次级文字
  static const Color nightTextFaint = Color(0xFF77809A); // 弱化文字
}