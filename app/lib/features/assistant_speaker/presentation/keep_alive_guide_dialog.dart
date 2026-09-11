import 'package:flutter/material.dart';

import 'package:starvoice_app/core/theme/app_colors.dart';

/// 助播保活引导弹窗（M9 手机线 / 极简系统风）：
/// 对齐竞品口径 —— 标题「提示」+ 一句说明 + 两个按钮，不做花哨玻璃卡片。
///
/// 不强制：点「暂不设置」照常开播，只影响切后台 / 锁屏后的出声稳定性。
/// 返回的 Future 在弹窗关闭后完成（调用方据此记录「已引导过」）。
Future<void> showKeepAliveGuideDialog(
  BuildContext context, {
  required Future<void> Function() onOpenSettings,
  bool? batteryExempt,
}) {
  return showDialog<void>(
    context: context,
    barrierDismissible: true,
    builder: (dialogContext) => AlertDialog(
      key: const Key('keepAliveGuideDialog'),
      title: const Text('提示'),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Text('直播中锁屏会让 AI 声音中断，需放行后台运行。'),
          const SizedBox(height: 10),
          _BatteryStateText(batteryExempt: batteryExempt),
        ],
      ),
      actions: [
        TextButton(
          key: const Key('keepAliveGuideLater'),
          onPressed: () => Navigator.of(dialogContext).pop(),
          child: const Text('暂不设置'),
        ),
        TextButton(
          key: const Key('keepAliveGuideGo'),
          onPressed: () async {
            final navigator = Navigator.of(dialogContext);
            await onOpenSettings();
            if (navigator.mounted) {
              navigator.pop();
            }
          },
          child: const Text('去放行'),
        ),
      ],
    ),
  );
}

/// 电量优化状态行：null = 未知（原生未返回），true = 已放行，false = 未放行。
class _BatteryStateText extends StatelessWidget {
  const _BatteryStateText({this.batteryExempt});

  final bool? batteryExempt;

  @override
  Widget build(BuildContext context) {
    final (Color color, String label) = switch (batteryExempt) {
      true => (AppColors.live, '电量优化已放行'),
      false => (AppColors.warning, '电量优化未放行'),
      null => (AppColors.info, '电量优化状态未知'),
    };
    return Text(
      label,
      key: const Key('keepAliveGuideBatteryState'),
      style: TextStyle(fontSize: 13, color: color),
    );
  }
}
