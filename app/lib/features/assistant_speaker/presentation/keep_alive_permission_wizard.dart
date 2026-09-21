import 'package:flutter/material.dart';

import 'package:starvoice_app/core/platform/keep_alive_bridge.dart';
import 'package:starvoice_app/core/theme/app_colors.dart';

/// 权限向导的步骤（对照竞品 xcai1618 的 `quanstep` 分步状态机）。
///
/// 竞品把开播前的权限检查做成了**逐项引导**：每一步都有
///   「已授权 → 按钮显示[下一步]」/「未授权 → 按钮显示[马上设置]」
/// 并且把系统菜单层级写进文案（如「应用管理-应用信息-其他权限-悬浮窗打开」）。
/// 我们原先只弹一次「两个按钮」的对话框，用户看完还是不知道去哪点 ✗。
enum KeepAlivePermissionStep {
  /// ① 通知权限：没有它，前台服务的常驻通知不显示（合规口径要求可见）
  notification,
  /// ② 悬浮窗：持有该权限的进程在多数 ROM 上更不容易被冻结
  overlay,
  /// ③ 电池优化：未豁免时息屏会被冻结（系统提供正规 API 可直接申请）
  battery,
  /// ④ 自启动 / 受保护应用：**系统不允许 App 查询或代开**，只能引导用户手动点
  autoStart,
}

/// 单个步骤的展示信息。
class _StepSpec {
  const _StepSpec({
    required this.title,
    required this.why,
    required this.path,
    required this.actionLabel,
  });

  final String title;
  final String why;
  /// 系统里的中文路径（竞品会把菜单层级写全）
  final String path;
  final String actionLabel;
}

const Map<KeepAlivePermissionStep, _StepSpec> _specs =
    <KeepAlivePermissionStep, _StepSpec>{
  KeepAlivePermissionStep.notification: _StepSpec(
    title: '通知权限',
    why: '直播期间会常驻一条「AI 语音助播运行中」的通知，让观众与你都知道 AI 在替你播。',
    path: '设置 - 通知管理 - 星辰语音 - 允许通知',
    actionLabel: '去开通知',
  ),
  KeepAlivePermissionStep.overlay: _StepSpec(
    title: '悬浮窗权限',
    why: '持有该权限的应用更不容易被系统冻结，是后台出声稳定的前提之一。',
    path: '设置 - 应用管理 - 应用信息 - 其他权限 - 悬浮窗打开',
    actionLabel: '去开悬浮窗',
  ),
  KeepAlivePermissionStep.battery: _StepSpec(
    title: '电池优化',
    why: '未豁免时息屏后系统会冻结应用，声音会中断。系统会弹一个授权框，点「允许」即可。',
    path: '系统授权框（点「允许」）；找不到时：设置 - 电池 - 更多电池设置',
    actionLabel: '去放行电量',
  ),
  KeepAlivePermissionStep.autoStart: _StepSpec(
    title: '自启动 / 受保护应用',
    why: '华为等机型独有的一道闸。不开它，前面的前台服务与唤醒锁都会被系统越过 —— '
        '这一步系统不允许应用代开，只能手动点。',
    path: '设置 - 应用 - 应用启动管理 - 星辰语音 - 关闭「自动管理」- 三项全勾（自启动/关联启动/后台活动）',
    actionLabel: '去开自启动',
  ),
};

/// 向导需要的外部能力（由调用方从 KeepAliveBridge 装配，便于测试注入）。
class KeepAlivePermissionActions {
  const KeepAlivePermissionActions({
    required this.check,
    required this.open,
  });

  /// 查询某一步是否已放行；返回 null 表示「系统不允许查询」（自启动那一步）
  final Future<bool?> Function(KeepAlivePermissionStep step) check;
  /// 执行某一步的「去设置」
  final Future<void> Function(KeepAlivePermissionStep step) open;
}

/// 从原生桥装配出向导动作（生产用；测试直接构造 KeepAlivePermissionActions）。
KeepAlivePermissionActions buildPermissionActions(KeepAliveBridge bridge) {
  return KeepAlivePermissionActions(
    check: (step) async {
      switch (step) {
        case KeepAlivePermissionStep.notification:
          return bridge.checkNotificationPermission();
        case KeepAlivePermissionStep.overlay:
          return bridge.checkOverlayPermission();
        case KeepAlivePermissionStep.battery:
          return bridge.isIgnoringBatteryOptimizations();
        case KeepAlivePermissionStep.autoStart:
          // 系统不提供查询口子 —— 只能让用户自己确认
          return null;
      }
    },
    open: (step) async {
      switch (step) {
        case KeepAlivePermissionStep.notification:
          await bridge.openNotificationSettings();
        case KeepAlivePermissionStep.overlay:
          await bridge.openOverlaySettings();
        case KeepAlivePermissionStep.battery:
          await bridge.requestIgnoreBatteryOptimizations();
        case KeepAlivePermissionStep.autoStart:
          await bridge.openAutoStartSettings();
      }
    },
  );
}

/// 权限向导标题行：`第 N / 4 步 · 步骤名`。
String wizardStepLabel(int index) => '第 ${index + 1} / ${KeepAlivePermissionStep.values.length} 步';
/// 权限向导弹窗（对照竞品的分步引导）。
///
/// 每一步的按钮文案**随授权状态切换**：
///   已放行 → 「下一步」；未放行 → 「马上设置」（＝竞品的 `quanbutton`）。
/// 每一步都给出**系统里的中文路径**，而不是笼统的「去设置里找」✗。
///
/// 返回 true 表示用户走完了最后一步（调用方据此记录「已引导」）。
Future<bool> showKeepAlivePermissionWizard(
  BuildContext context, {
  required KeepAlivePermissionActions actions,
}) async {
  final granted = await showDialog<bool>(
    context: context,
    barrierDismissible: true,
    builder: (dialogContext) => _WizardDialog(actions: actions),
  );
  return granted ?? false;
}

class _WizardDialog extends StatefulWidget {
  const _WizardDialog({required this.actions});

  final KeepAlivePermissionActions actions;

  @override
  State<_WizardDialog> createState() => _WizardDialogState();
}

class _WizardDialogState extends State<_WizardDialog> {
  int _index = 0;
  /// 当前步骤的授权状态：null = 系统不允许查询（自启动）
  bool? _granted;
  bool _checking = true;

  KeepAlivePermissionStep get _step => KeepAlivePermissionStep.values[_index];

  @override
  void initState() {
    super.initState();
    _refresh();
  }

  Future<void> _refresh() async {
    setState(() => _checking = true);
    bool? granted;
    try {
      granted = await widget.actions.check(_step);
    } catch (_) {
      // 查询失败按「未知」处理，不误报成未授权
      granted = null;
    }
    if (!mounted) {
      return;
    }
    setState(() {
      _granted = granted;
      _checking = false;
    });
  }

  Future<void> _open() async {
    try {
      await widget.actions.open(_step);
    } catch (_) {
      // 拉不起设置页也别把向导卡住：文案里有完整路径，用户能自己找
    }
    if (!mounted) {
      return;
    }
    // 用户从系统设置回来后重查一次 —— 这正是「下一步 / 马上设置」切换的时机
    await _refresh();
  }

  void _next() {
    if (_index >= KeepAlivePermissionStep.values.length - 1) {
      Navigator.of(context).pop(true);
      return;
    }
    setState(() {
      _index += 1;
      _granted = null;
    });
    _refresh();
  }

  @override
  Widget build(BuildContext context) {
    final spec = _specs[_step]!;
    final isLast = _index >= KeepAlivePermissionStep.values.length - 1;
    // 只有「明确已放行」才升级成「下一步」；未知与未授权都留在「马上设置」
    final satisfied = _granted == true;
    return AlertDialog(
      key: const Key('keepAlivePermissionWizard'),
      title: Text('开启直播间前的权限设置 · ${wizardStepLabel(_index)}'),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Text(spec.title, style: const TextStyle(fontWeight: FontWeight.w600)),
          const SizedBox(height: 6),
          Text(spec.why, style: const TextStyle(fontSize: 13, height: 1.5)),
          const SizedBox(height: 8),
          Text(
            spec.path,
            key: const Key('keepAliveWizardPath'),
            style: const TextStyle(fontSize: 12, height: 1.5, color: AppColors.info),
          ),
          const SizedBox(height: 10),
          _StateLine(checking: _checking, granted: _granted),
        ],
      ),
      actions: <Widget>[
        TextButton(
          key: const Key('keepAliveWizardLater'),
          onPressed: () => Navigator.of(context).pop(false),
          child: const Text('暂不设置'),
        ),
        TextButton(
          key: const Key('keepAliveWizardAction'),
          onPressed: _checking ? null : (satisfied ? _next : _open),
          child: Text(satisfied ? (isLast ? '完成' : '下一步') : spec.actionLabel),
        ),
      ],
    );
  }
}

/// 状态行：查询中 / 已放行 / 未放行 / 系统不允许查询。
class _StateLine extends StatelessWidget {
  const _StateLine({required this.checking, required this.granted});

  final bool checking;
  final bool? granted;

  @override
  Widget build(BuildContext context) {
    final (Color color, String label) = checking
        ? (AppColors.nightTextFaint, '检查中…')
        : switch (granted) {
            true => (AppColors.live, '已放行 ✓'),
            false => (AppColors.warning, '未放行'),
            null => (AppColors.info, '系统不允许应用查询，请自行确认'),
          };
    return Text(
      label,
      key: const Key('keepAliveWizardState'),
      style: TextStyle(fontSize: 13, color: color),
    );
  }
}
