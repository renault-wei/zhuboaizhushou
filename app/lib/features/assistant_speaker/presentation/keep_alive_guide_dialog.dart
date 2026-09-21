import 'package:flutter/material.dart';

import 'package:starvoice_app/core/theme/app_colors.dart';

/// 助播保活引导弹窗（M9 手机线 / R62 扩充）：
/// 对齐竞品口径 —— 标题「提示」+ 一句说明 + 若干按钮，不做花哨玻璃卡片。
///
/// R62 为什么要扩：2026-09-21 真机实测（华为 ELS-AN10）证明——
/// 只放行「电量优化」还不够。华为/小米/OPPO/vivo 各有自己一套后台管制，
/// **自启动白名单**不打开的话，前台服务照起（isForeground=true、有通知），
/// 系统照样**强制释放 WakeLock**、冻掉定时器，表现为「后台没声音」。
/// 而这一项**代码无法申请**，只能引导用户手动点。
///
/// 不强制：点「暂不设置」照常开播，只影响切后台 / 锁屏后的出声稳定性。
/// 返回的 Future 在弹窗关闭后完成（调用方据此记录「已引导过」）。
Future<void> showKeepAliveGuideDialog(
  BuildContext context, {
  required Future<bool> Function() onRequestBatteryExemption,
  required Future<bool> Function() onOpenAutoStartSettings,
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
        children: <Widget>[
          const Text('直播中锁屏或切后台，系统可能冻结 App，让 AI 声音中断。需要放行两项：'),
          const SizedBox(height: 10),
          const Text('① 电量优化', style: TextStyle(fontWeight: FontWeight.w600)),
          _BatteryStateText(batteryExempt: batteryExempt),
          const SizedBox(height: 10),
          const Text('② 自启动 / 受保护应用', style: TextStyle(fontWeight: FontWeight.w600)),
          const Text(
            '华为等机型必须开，且系统不允许 App 代开，只能手动点。',
            key: Key('keepAliveGuideAutoStartHint'),
            style: TextStyle(fontSize: 13),
          ),
        ],
      ),
      actions: <Widget>[
        TextButton(
          key: const Key('keepAliveGuideLater'),
          onPressed: () => Navigator.of(dialogContext).pop(),
          child: const Text('暂不设置'),
        ),
        TextButton(
          key: const Key('keepAliveGuideBattery'),
          onPressed: () async {
            // R62：调系统正规 API 弹授权框（而不是把用户丢进设置页让他自己找）
            await onRequestBatteryExemption();
          },
          child: const Text('去放行电量'),
        ),
        TextButton(
          key: const Key('keepAliveGuideAutoStart'),
          onPressed: () async {
            // 少数机型没有独立的自启动页 —— 拉不起来也别把弹窗卡住，
            // 文案里已经说明「只能手动点」，用户知道去系统设置里找。
            await onOpenAutoStartSettings();
          },
          child: const Text('去开自启动'),
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
