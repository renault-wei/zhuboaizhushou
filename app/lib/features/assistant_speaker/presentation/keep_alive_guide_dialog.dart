import 'dart:ui' show ImageFilter;

import 'package:flutter/material.dart';

import 'package:starvoice_app/core/theme/app_colors.dart';

/// 助播保活引导弹窗（M9 手机线）：透明玻璃卡片 + 背景模糊，
/// 一次性告知「出声期间需允许 App 在后台运行」，并给一键去系统设置的入口。
///
/// 不强制：点「暂不」照常开播，只影响切后台 / 锁屏后的出声稳定性。
/// 返回的 Future 在弹窗关闭后完成（调用方据此记录「已引导过」）。
Future<void> showKeepAliveGuideDialog(
  BuildContext context, {
  required Future<void> Function() onOpenSettings,
  bool? batteryExempt,
}) {
  return showGeneralDialog<void>(
    context: context,
    barrierDismissible: true,
    barrierLabel: '保活引导',
    barrierColor: Colors.black.withValues(alpha: 0.62),
    transitionDuration: const Duration(milliseconds: 220),
    pageBuilder: (_, _, _) => const SizedBox.shrink(),
    transitionBuilder: (dialogContext, animation, _, _) {
      final curved = CurvedAnimation(
        parent: animation,
        curve: Curves.easeOutCubic,
      );
      return FadeTransition(
        opacity: curved,
        child: ScaleTransition(
          scale: Tween<double>(begin: 0.92, end: 1).animate(curved),
          child: _KeepAliveGuideCard(
            onOpenSettings: onOpenSettings,
            batteryExempt: batteryExempt,
          ),
        ),
      );
    },
  );
}

class _KeepAliveGuideCard extends StatelessWidget {
  const _KeepAliveGuideCard({
    required this.onOpenSettings,
    this.batteryExempt,
  });

  final Future<void> Function() onOpenSettings;
  final bool? batteryExempt;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 28),
        child: ClipRRect(
          borderRadius: BorderRadius.circular(26),
          child: BackdropFilter(
            filter: ImageFilter.blur(sigmaX: 18, sigmaY: 18),
            child: Container(
              key: const Key('keepAliveGuideDialog'),
              constraints: const BoxConstraints(maxWidth: 420),
              padding: const EdgeInsets.fromLTRB(22, 24, 22, 18),
              decoration: BoxDecoration(
                // 半透明深色玻璃：叠在暗色工作台上仍是同色系，不刺眼
                color: AppColors.nightBg.withValues(alpha: 0.72),
                borderRadius: BorderRadius.circular(26),
                border: Border.all(
                  color: Colors.white.withValues(alpha: 0.14),
                ),
                boxShadow: [
                  BoxShadow(
                    color: Colors.black.withValues(alpha: 0.34),
                    blurRadius: 32,
                    offset: const Offset(0, 14),
                  ),
                ],
              ),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  _buildHeader(),
                  const SizedBox(height: 16),
                  const Text(
                    '直播期间你多半会切到抖音、相机或直接锁屏，'
                    'Android 会冻结后台 App，AI 语音就可能在半路哑掉。'
                    '放行一次，助播就能一直说下去。',
                    style: TextStyle(
                      fontSize: 13,
                      height: 1.6,
                      color: AppColors.nightTextDim,
                    ),
                  ),
                  const SizedBox(height: 16),
                  const _GuidePoint(
                    icon: Icons.volume_up_outlined,
                    title: '切后台不断声',
                    desc: '前台服务 + 唤醒锁，锁屏也能继续播报',
                  ),
                  const _GuidePoint(
                    icon: Icons.wifi_tethering,
                    title: '持续拉队列',
                    desc: '不冻结进程，弹幕回复不会积压漏播',
                  ),
                  const _GuidePoint(
                    icon: Icons.shield_outlined,
                    title: '随时可关',
                    desc: '结束直播即自动释放，不常驻、不后台偷跑',
                  ),
                  const SizedBox(height: 14),
                  _buildStatusRow(),
                  const SizedBox(height: 16),
                  _buildActions(context),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }

  Widget _buildHeader() {
    return Row(
      children: [
        Container(
          width: 46,
          height: 46,
          decoration: BoxDecoration(
            gradient: const LinearGradient(
              colors: <Color>[AppColors.primary, AppColors.primaryDark],
              begin: Alignment.topLeft,
              end: Alignment.bottomRight,
            ),
            borderRadius: BorderRadius.circular(15),
            boxShadow: [
              BoxShadow(
                color: AppColors.primary.withValues(alpha: 0.36),
                blurRadius: 16,
                offset: const Offset(0, 6),
              ),
            ],
          ),
          child: const Icon(
            Icons.nightlight_round,
            size: 24,
            color: Colors.white,
          ),
        ),
        const SizedBox(width: 14),
        const Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                '让 AI 助播在后台继续说',
                style: TextStyle(
                  fontSize: 17,
                  fontWeight: FontWeight.w700,
                  color: AppColors.nightText,
                ),
              ),
              SizedBox(height: 4),
              Text(
                '手机线出声必看 · 一次性设置',
                style: TextStyle(
                  fontSize: 12,
                  color: AppColors.nightTextFaint,
                ),
              ),
            ],
          ),
        ),
      ],
    );
  }

  /// 电量优化状态行：null = 未知（原生未返回），true = 已放行，false = 未放行。
  Widget _buildStatusRow() {
    // true = 已豁免（已放行）；false = 未豁免（息屏可能被冻结）；null = 原生未返回
    final (Color color, String label, IconData icon) = switch (batteryExempt) {
      true => (AppColors.live, '电量优化已放行', Icons.check_circle_outline),
      false => (AppColors.warning, '电量优化未放行', Icons.error_outline),
      null => (AppColors.nightTextFaint, '电量优化状态未知', Icons.help_outline),
    };
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 9),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.12),
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: color.withValues(alpha: 0.28)),
      ),
      child: Row(
        children: [
          Icon(icon, size: 16, color: color),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              label,
              key: const Key('keepAliveGuideBatteryState'),
              style: TextStyle(
                fontSize: 12,
                color: color,
                fontWeight: FontWeight.w600,
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildActions(BuildContext context) {
    return Row(
      children: [
        Expanded(
          child: TextButton(
            key: const Key('keepAliveGuideLater'),
            onPressed: () => Navigator.of(context).pop(),
            style: TextButton.styleFrom(
              padding: const EdgeInsets.symmetric(vertical: 12),
              foregroundColor: AppColors.nightTextDim,
            ),
            child: const Text('暂不设置'),
          ),
        ),
        const SizedBox(width: 10),
        Expanded(
          flex: 2,
          child: DecoratedBox(
            decoration: BoxDecoration(
              gradient: const LinearGradient(
                colors: <Color>[AppColors.primary, AppColors.primaryDark],
                begin: Alignment.centerLeft,
                end: Alignment.centerRight,
              ),
              borderRadius: BorderRadius.circular(13),
              boxShadow: [
                BoxShadow(
                  color: AppColors.primary.withValues(alpha: 0.32),
                  blurRadius: 14,
                  offset: const Offset(0, 6),
                ),
              ],
            ),
            child: TextButton(
              key: const Key('keepAliveGuideGo'),
              onPressed: () async {
                final navigator = Navigator.of(context);
                await onOpenSettings();
                if (navigator.mounted) {
                  navigator.pop();
                }
              },
              style: TextButton.styleFrom(
                padding: const EdgeInsets.symmetric(vertical: 13),
                foregroundColor: Colors.white,
              ),
              child: const Text(
                '去放行',
                style: TextStyle(fontWeight: FontWeight.w700),
              ),
            ),
          ),
        ),
      ],
    );
  }
}

/// 弹窗内单条要点：图标 + 标题 + 说明。
class _GuidePoint extends StatelessWidget {
  const _GuidePoint({
    required this.icon,
    required this.title,
    required this.desc,
  });

  final IconData icon;
  final String title;
  final String desc;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Container(
            width: 30,
            height: 30,
            decoration: BoxDecoration(
              color: Colors.white.withValues(alpha: 0.07),
              borderRadius: BorderRadius.circular(10),
            ),
            child: Icon(icon, size: 16, color: AppColors.primary),
          ),
          const SizedBox(width: 11),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  title,
                  style: const TextStyle(
                    fontSize: 13.5,
                    fontWeight: FontWeight.w600,
                    color: AppColors.nightText,
                  ),
                ),
                const SizedBox(height: 2),
                Text(
                  desc,
                  style: const TextStyle(
                    fontSize: 12,
                    height: 1.4,
                    color: AppColors.nightTextFaint,
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
