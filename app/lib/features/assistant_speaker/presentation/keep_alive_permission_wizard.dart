import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';

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

/// 权限向导标题行：`第 N / M 步`（M = **本次实际要走的步数**，不再恒为 4 ✓）。
///
/// ★R77：只列真的缺的那几步之后，步数就不是固定 4 了 ——
/// 还硬写 `values.length` 会让用户看到「第 1 / 4 步」却只有一步可走 ✗
String wizardStepLabel(int index, int total) => '第 ${index + 1} / $total 步';
/// ★R77：用户走完过一次向导的痕迹。
///
/// 为什么需要：自启动那道闸**系统不允许应用查询**（见下方 check 返回 null），
/// 于是「放行没放行」只有用户自己知道 ✓。
/// 记一笔之后，下次再打开向导就不必让他白走一遍了 ✓
const String keepAliveWizardDoneKey = 'assistant_keep_alive_wizard_done';

/// ★R77 自查补：预检的**超时上限**。
///
/// 为什么必须有（2026-09-22 真机教训，同 R72 那条）：这些预检全都要**过平台通道**
///   （KeepAliveBridge → MethodChannel，以及 SharedPreferences），
///   而在一台过载手机上，平台通道会**挂起** —— 既不返回也不抛错 ✗。
///   没有超时的话，用户点「权限与保活设置」的结果是**什么都不发生** ✗ ——
///   正是最难查的一类故障（R69 的磁盘库存就是这么把整条出声链路挂死的 ✓）。
///
/// 超时的语义一律记作「**未知**」→ 该步照常列出来引导 ✓ ——
///   宁可多让用户看一眼，也绝不把没放行的当成已放行 ✓
const Duration keepAliveProbeTimeout = Duration(milliseconds: 1200);

Future<bool> _loadWizardDone() async {
  try {
    // ★R77 自查补：读偏好也走平台通道 → 同样带超时，否则向导永远不出现 ✗
    final prefs = await SharedPreferences.getInstance()
        .timeout(keepAliveProbeTimeout);
    return prefs.getBool(keepAliveWizardDoneKey) ?? false;
  } catch (_) {
    // 读不到（含超时）最多是下次多引导一遍，不影响出声 ✓
    return false;
  }
}

Future<void> _markWizardDone() async {
  try {
    final prefs = await SharedPreferences.getInstance()
        .timeout(keepAliveProbeTimeout);
    await prefs
        .setBool(keepAliveWizardDoneKey, true)
        .timeout(keepAliveProbeTimeout);
  } catch (_) {
    // 同上：存不下不影响出声 ✓
  }
}

/// 探一步：**失败与超时一律按「未知」** → 该步照常引导 ✓（绝不误报成已放行）
Future<bool?> _probe(
  KeepAlivePermissionActions actions,
  KeepAlivePermissionStep step,
) async {
  try {
    return await actions.check(step).timeout(keepAliveProbeTimeout);
  } catch (_) {
    return null;
  }
}

/// ★R77：**只列真的缺**的那几步。
///
/// 为什么（2026-09-22 用户实测「权限只需要配置一次，还是不断弹出权限配置提示」）：
///   原先不管三七二十一，4 步从头走到尾 ✗ ——
///   对已经放行过的用户来说，每次打开都像「又在弹权限提示」✓
///   现在先实测一遍：明确的绿不列、只列缺的 ✓
///
/// 判定口径：**只有 `true` 才算放行** ——
///   `false`（确实没给）与 `null`（系统不给查，如自启动）都还要引导 ✓
/// ★R77 自查补：这些查询**并发**跑，且**每一步都带超时** ✓ ——
///   · 串行：4 步各过一次平台通道，坏手机上最坏要等 4 倍 ✗
///   · 无超时：通道一挂，弹窗**永远不出现**（点了没反应）✗
Future<List<KeepAlivePermissionStep>> pendingKeepAlivePermissionSteps(
  KeepAlivePermissionActions actions, {
  bool autoStartConfirmed = false,
}) async {
  final steps = KeepAlivePermissionStep.values
      .where(
        // 自启动：系统查不到，只能认「用户曾走完过向导」这一笔 ✓
        (step) =>
            !(step == KeepAlivePermissionStep.autoStart && autoStartConfirmed),
      )
      .toList(growable: false);
  final results = await Future.wait(steps.map((step) => _probe(actions, step)));
  final pending = <KeepAlivePermissionStep>[];
  for (var index = 0; index < steps.length; index += 1) {
    if (results[index] != true) {
      pending.add(steps[index]);
    }
  }
  return pending;
}

/// 权限向导弹窗（对照竞品的分步引导）。
///
/// 每一步的按钮文案**随授权状态切换**：
///   已放行 → 「下一步」；未放行 → 「马上设置」（＝竞品的 `quanbutton`）。
/// 每一步都给出**系统里的中文路径**，而不是笼统的「去设置里找」✗。
///
/// ★R77：进门先实测 —— **只把真的缺的摆出来** ✓；
///   全绿就一句话收场，不再让用户白点 4 次 ✓（这就是「只需要配置一次」）
///
/// 返回 true 表示「该放行的都放行了」（用户走完了最后一步，或本来就全绿）。
Future<bool> showKeepAlivePermissionWizard(
  BuildContext context, {
  required KeepAlivePermissionActions actions,
}) async {
  final steps = await pendingKeepAlivePermissionSteps(
    actions,
    autoStartConfirmed: await _loadWizardDone(),
  );
  if (!context.mounted) {
    return false;
  }
  if (steps.isEmpty) {
    await showDialog<void>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        key: const Key('keepAlivePermissionAllGranted'),
        title: const Text('权限已就绪'),
        content: const Text(
          '后台运行需要的权限都已经放行，锁屏和切到后台都不会被系统掐掉。'
          '以后不用再设置了。',
        ),
        actions: <Widget>[
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(),
            child: const Text('知道了'),
          ),
        ],
      ),
    );
    return true;
  }
  final granted = await showDialog<bool>(
    context: context,
    barrierDismissible: true,
    builder: (dialogContext) => _WizardDialog(actions: actions, steps: steps),
  );
  final completed = granted ?? false;
  if (completed) {
    await _markWizardDone();
  }
  return completed;
}

class _WizardDialog extends StatefulWidget {
  const _WizardDialog({required this.actions, required this.steps});

  final KeepAlivePermissionActions actions;

  /// ★R77：**只含实测缺**的步骤 —— 已放行的不再让用户白点一遍 ✓
  final List<KeepAlivePermissionStep> steps;

  @override
  State<_WizardDialog> createState() => _WizardDialogState();
}

class _WizardDialogState extends State<_WizardDialog> {
  int _index = 0;
  /// 当前步骤的授权状态：null = 系统不允许查询（自启动）
  bool? _granted;
  bool _checking = true;

  /// ★R77：步骤清单来自外部（只含缺的那几步），不再恒为 4 步 ✓
  KeepAlivePermissionStep get _step => widget.steps[_index];

  @override
  void initState() {
    super.initState();
    _refresh();
  }

  Future<void> _refresh() async {
    setState(() => _checking = true);
    // ★R77 自查补：同样带超时 —— 平台通道一挂，「检查中…」会永远转下去 ✗
    //   （超时按「未知」处理 → 按钮回落成「去设置」，用户仍能往下走 ✓）
    final granted = await _probe(widget.actions, _step);
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
    if (_index >= widget.steps.length - 1) {
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
    final isLast = _index >= widget.steps.length - 1;
    // 只有「明确已放行」才升级成「下一步」；未知与未授权都留在「马上设置」
    final satisfied = _granted == true;
    return AlertDialog(
      key: const Key('keepAlivePermissionWizard'),
      title: Text('后台运行权限设置 · ${wizardStepLabel(_index, widget.steps.length)}'),
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
        // ★★R77：最后一步若**系统不给查**（自启动那道闸），只能由用户自己确认 ✓
        //
        // 为什么必须留这个出口：没有它，向导**永远走不完** ✗ ——
        //   自启动查不到 → 这一步永远是「缺的」→ 每次打开都还在弹 ✓
        //   这正是用户抱怨的「权限只需要配置一次，还是不断弹出」✓
        if (isLast && _granted == null)
          TextButton(
            key: const Key('keepAliveWizardDone'),
            onPressed: () => Navigator.of(context).pop(true),
            child: const Text('已完成设置'),
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
