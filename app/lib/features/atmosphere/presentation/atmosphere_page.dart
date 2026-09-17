/// 氛围语页（R25）：循环台本空档自动插播的短句 + 每类的插播频次。
///
/// 为什么值得单独一页：服务端从 M10 起模板 CRUD 与频次规则就完整了，
/// 但 App 里长期 **0 处** —— 商家在手机上根本配不了「欢迎语 / 关注语」。
///
/// **一类多条**（用户 2026-09-17 拍板 (b)）：服务端 atmosphere_templates 本来就是一对多，
/// 多条候选句由服务端随机挑，比一条长文本更自然。所以本页按「一类一张列表」渲染，
/// 每条可单独启停 / 编辑 / 删除。
///
/// 写法约定：一条模板内**一行 = 一句候选**；支持 [昵称] 占位。
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'package:starvoice_app/core/models/atmosphere.dart';
import 'package:starvoice_app/core/network/api_exception.dart';
import 'package:starvoice_app/core/theme/app_colors.dart';
import 'package:starvoice_app/providers.dart';

/// 模板编辑弹窗：**自己持有并释放** TextEditingController。
///
/// 为什么不可以在外面 new 一个 controller、`await showDialog(...)` 之后立刻 dispose：
/// 弹窗关闭有**退场动画**，动画期间 TextField 仍在引用 controller ——
/// 立刻 dispose 会抛「A TextEditingController was used after being disposed」。
/// （2026-09-17 被 widget 测试抓出来；真机 debug 构建同样会炸。）
class _AtmosphereEditorDialog extends StatefulWidget {
  const _AtmosphereEditorDialog({required this.title, required this.initialText});

  final String title;
  final String initialText;

  @override
  State<_AtmosphereEditorDialog> createState() => _AtmosphereEditorDialogState();
}

class _AtmosphereEditorDialogState extends State<_AtmosphereEditorDialog> {
  late final TextEditingController _controller = TextEditingController(text: widget.initialText);

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: Text(widget.title),
      content: TextField(
        key: const Key('atmosphereEditorField'),
        controller: _controller,
        maxLines: 5,
        minLines: 3,
        autofocus: true,
        decoration: const InputDecoration(
          hintText: '一行一句，例如：欢迎[昵称]来到直播间～',
          helperText: '多条候选句之间换行；服务端会随机挑一句',
          helperMaxLines: 2,
          border: OutlineInputBorder(),
        ),
      ),
      actions: <Widget>[
        TextButton(
          onPressed: () => Navigator.of(context).pop(),
          child: const Text('取消'),
        ),
        FilledButton(
          key: const Key('atmosphereEditorSave'),
          onPressed: () {
            final value = _controller.text.trim();
            if (value.isEmpty) {
              return;
            }
            Navigator.of(context).pop(value);
          },
          child: const Text('保存'),
        ),
      ],
    );
  }
}

class AtmospherePage extends ConsumerStatefulWidget {
  const AtmospherePage({super.key});

  @override
  ConsumerState<AtmospherePage> createState() => _AtmospherePageState();
}

class _AtmospherePageState extends ConsumerState<AtmospherePage> {
  /// category → 该类下的全部模板（服务端 updatedAt 倒序）
  final Map<String, List<AtmosphereTemplate>> _templates = <String, List<AtmosphereTemplate>>{};
  final Map<String, AtmosphereSetting> _settings = <String, AtmosphereSetting>{};
  /// 正在请求中的模板 id（禁用按钮，防连点）
  final Set<String> _busy = <String>{};

  bool _loading = true;
  bool _seeding = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _load());
  }

  Future<void> _load() async {
    try {
      final client = ref.read(apiClientProvider);
      final results = await Future.wait(<Future<Object>>[
        client.fetchAtmosphereTemplates(),
        client.fetchAtmosphereSettings(),
      ]);
      if (!mounted) {
        return;
      }
      final templates = results[0] as List<AtmosphereTemplate>;
      final settings = results[1] as List<AtmosphereSetting>;
      setState(() {
        _templates.clear();
        for (final template in templates) {
          _templates.putIfAbsent(template.category, () => <AtmosphereTemplate>[]).add(template);
        }
        _settings
          ..clear()
          ..addEntries(settings.map((item) => MapEntry(item.category, item)));
        _loading = false;
        _error = null;
      });
    } on ApiException catch (error) {
      if (mounted) {
        setState(() {
          _loading = false;
          _error = error.message;
        });
      }
    }
  }

  void _toast(String message) {
    if (!mounted) {
      return;
    }
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text(message), duration: const Duration(seconds: 2)),
    );
  }

  Future<void> _seedDefaults() async {
    setState(() {
      _seeding = true;
      _error = null;
    });
    try {
      final created = await ref.read(apiClientProvider).seedAtmosphereDefaults();
      await _load();
      _toast(created > 0 ? '已补齐 $created 类推荐模板' : '五类模板都已存在，无需补齐');
    } on ApiException catch (error) {
      if (mounted) {
        setState(() => _error = error.message);
      }
    } finally {
      if (mounted) {
        setState(() => _seeding = false);
      }
    }
  }

  /// 新增 / 编辑弹窗：文案由弹窗自己持有与释放（见 _AtmosphereEditorDialog 的注释）
  Future<void> _openEditor(String category, {AtmosphereTemplate? existing}) async {
    final label = kAtmosphereCategoryLabels[category] ?? category;
    final text = await showDialog<String>(
      context: context,
      builder: (dialogContext) => _AtmosphereEditorDialog(
        title: existing == null ? '新增「$label」' : '编辑「$label」',
        initialText: existing?.text ?? '',
      ),
    );
    if (text == null || !mounted) {
      return;
    }
    try {
      final client = ref.read(apiClientProvider);
      if (existing == null) {
        await client.createAtmosphereTemplate(category: category, text: text);
        _toast('已新增');
      } else {
        await client.updateAtmosphereTemplate(
          existing.id,
          category: category,
          text: text,
          enabled: existing.enabled,
        );
        _toast('已保存');
      }
      await _load();
    } on ApiException catch (error) {
      if (mounted) {
        setState(() => _error = error.message);
      }
    }
  }

  /// 单条启停：服务端 PUT 是整体替换口径，所以文案一并回传
  Future<void> _toggle(AtmosphereTemplate template, bool enabled) async {
    setState(() => _busy.add(template.id));
    try {
      await ref.read(apiClientProvider).updateAtmosphereTemplate(
        template.id,
        category: template.category,
        text: template.text,
        enabled: enabled,
      );
      await _load();
    } on ApiException catch (error) {
      if (mounted) {
        setState(() => _error = error.message);
      }
    } finally {
      if (mounted) {
        setState(() => _busy.remove(template.id));
      }
    }
  }

  Future<void> _delete(AtmosphereTemplate template) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: const Text('删除这一条？'),
        content: Text(template.text, maxLines: 3, overflow: TextOverflow.ellipsis),
        actions: <Widget>[
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(false),
            child: const Text('取消'),
          ),
          FilledButton(
            key: const Key('atmosphereDeleteConfirm'),
            onPressed: () => Navigator.of(dialogContext).pop(true),
            child: const Text('删除'),
          ),
        ],
      ),
    );
    if (confirmed != true || !mounted) {
      return;
    }
    setState(() => _busy.add(template.id));
    try {
      await ref.read(apiClientProvider).deleteAtmosphereTemplate(template.id);
      _toast('已删除');
      await _load();
    } on ApiException catch (error) {
      if (mounted) {
        setState(() => _error = error.message);
      }
    } finally {
      if (mounted) {
        setState(() => _busy.remove(template.id));
      }
    }
  }

  /// 档位候选：从规则区间里挑几个「像人话」的值，并保证含服务端默认档
  List<int> _presetsFor(AtmosphereFrequencyRule rule) {
    const candidates = <int>[30, 60, 90, 120, 180, 300, 600, 1800];
    final list = candidates
        .where((seconds) => seconds >= rule.minSeconds && seconds <= rule.maxSeconds)
        .toList();
    if (!list.contains(rule.defaultSeconds)) {
      list.insert(0, rule.defaultSeconds);
    }
    return list.take(5).toList();
  }

  String _intervalLabel(String category) {
    final setting = _settings[category];
    if (setting == null) {
      return '—';
    }
    if (setting.disabled) {
      return '不插播';
    }
    final seconds = setting.intervalSeconds;
    return seconds % 60 == 0 ? '${seconds ~/ 60} 分钟/次' : '$seconds 秒/次';
  }

  Future<void> _pickInterval(String category) async {
    final setting = _settings[category];
    if (setting == null) {
      return;
    }
    final presets = _presetsFor(setting.rule);
    final picked = await showModalBottomSheet<int>(
      context: context,
      builder: (sheetContext) => SafeArea(
        child: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: <Widget>[
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 16, 16, 8),
                child: Align(
                  alignment: Alignment.centerLeft,
                  child: Text(
                    '${setting.label}·多久插一次',
                    style: const TextStyle(fontWeight: FontWeight.w600),
                  ),
                ),
              ),
              if (setting.rule.supportsDisabled)
                ListTile(
                  key: const Key('atmosphereIntervalOff'),
                  title: const Text('不插播'),
                  trailing: setting.disabled ? const Icon(Icons.check_rounded) : null,
                  onTap: () => Navigator.of(sheetContext).pop(setting.rule.disabledSeconds),
                ),
              for (final seconds in presets)
                ListTile(
                  key: Key('atmosphereInterval$seconds'),
                  title: Text(seconds % 60 == 0 ? '${seconds ~/ 60} 分钟/次' : '$seconds 秒/次'),
                  trailing: !setting.disabled && setting.intervalSeconds == seconds
                      ? const Icon(Icons.check_rounded)
                      : null,
                  onTap: () => Navigator.of(sheetContext).pop(seconds),
                ),
            ],
          ),
        ),
      ),
    );
    if (picked == null || !mounted) {
      return;
    }
    try {
      final saved = await ref
          .read(apiClientProvider)
          .updateAtmosphereInterval(category, picked);
      if (mounted) {
        setState(() {
          // 服务端 PUT 只回 category / intervalSeconds / isCustom，**不回带 rule** ——
          // 保留本地那份 rule，否则档位区间会退回客户端默认值。
          _settings[category] = AtmosphereSetting(
            category: saved.category,
            intervalSeconds: saved.intervalSeconds,
            isCustom: saved.isCustom,
            rule: setting.rule,
          );
        });
      }
    } on ApiException catch (error) {
      if (mounted) {
        setState(() => _error = error.message);
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Scaffold(
      key: const Key('atmospherePage'),
      appBar: AppBar(title: const Text('氛围语')),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : ListView(
              padding: const EdgeInsets.fromLTRB(16, 12, 16, 32),
              children: <Widget>[
                Card(
                  margin: EdgeInsets.zero,
                  color: AppColors.info.withValues(alpha: 0.08),
                  child: Padding(
                    padding: const EdgeInsets.all(14),
                    child: Row(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: <Widget>[
                        const Icon(Icons.campaign_outlined, size: 18, color: AppColors.info),
                        const SizedBox(width: 10),
                        Expanded(
                          child: Text(
                            '循环台本每句播完的空档里自动插一句，让直播间不冷场。'
                            '一条里可以写多行，服务端随机挑一句；[昵称] 会被替换成观众名字。',
                            style: theme.textTheme.bodySmall?.copyWith(height: 1.5),
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
                const SizedBox(height: 12),
                OutlinedButton.icon(
                  key: const Key('atmosphereSeedDefaults'),
                  onPressed: _seeding ? null : _seedDefaults,
                  icon: const Icon(Icons.auto_awesome_outlined, size: 18),
                  label: Text(_seeding ? '补齐中…' : '一键补齐推荐模板'),
                ),
                if (_error != null) ...<Widget>[
                  const SizedBox(height: 12),
                  Text(
                    _error!,
                    key: const Key('atmosphereError'),
                    style: const TextStyle(color: AppColors.danger, fontSize: 13),
                  ),
                ],
                const SizedBox(height: 8),
                for (final category in kAtmosphereCategories) _buildCategoryCard(theme, category),
              ],
            ),
    );
  }

  Widget _buildCategoryCard(ThemeData theme, String category) {
    final label = kAtmosphereCategoryLabels[category] ?? category;
    final items = _templates[category] ?? const <AtmosphereTemplate>[];
    return Card(
      key: Key('atmosphereCard_$category'),
      margin: const EdgeInsets.only(bottom: 14),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(14, 12, 14, 8),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: <Widget>[
            Row(
              children: <Widget>[
                Text(
                  label,
                  style: theme.textTheme.bodyMedium?.copyWith(fontWeight: FontWeight.w600),
                ),
                const SizedBox(width: 6),
                Text(
                  '${items.length} 条',
                  style: const TextStyle(fontSize: 11, color: AppColors.textHint),
                ),
                const Spacer(),
                TextButton(
                  key: Key('atmosphereInterval_$category'),
                  onPressed: () => _pickInterval(category),
                  child: Text(_intervalLabel(category)),
                ),
              ],
            ),
            if (items.isEmpty)
              Padding(
                padding: const EdgeInsets.symmetric(vertical: 14),
                child: Text(
                  '这一类还没有内容，点下面「添加一句」或一键补齐',
                  style: theme.textTheme.bodySmall?.copyWith(color: AppColors.textHint),
                ),
              )
            else
              for (final item in items) _buildTemplateRow(theme, item),
            Align(
              alignment: Alignment.centerLeft,
              child: TextButton.icon(
                key: Key('atmosphereAdd_$category'),
                onPressed: () => _openEditor(category),
                icon: const Icon(Icons.add, size: 18),
                label: const Text('添加一句'),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildTemplateRow(ThemeData theme, AtmosphereTemplate item) {
    final busy = _busy.contains(item.id);
    return Container(
      key: Key('atmosphereItem_${item.id}'),
      margin: const EdgeInsets.only(bottom: 8),
      padding: const EdgeInsets.fromLTRB(12, 8, 4, 4),
      decoration: BoxDecoration(
        color: AppColors.surfaceMuted,
        borderRadius: BorderRadius.circular(10),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Text(
            item.text,
            maxLines: 4,
            overflow: TextOverflow.ellipsis,
            style: theme.textTheme.bodySmall?.copyWith(
              height: 1.5,
              color: item.enabled ? AppColors.textPrimary : AppColors.textHint,
            ),
          ),
          Row(
            children: <Widget>[
              Switch(
                key: Key('atmosphereToggle_${item.id}'),
                value: item.enabled,
                onChanged: busy ? null : (value) => _toggle(item, value),
              ),
              Text(
                item.enabled ? '启用' : '已停用',
                style: const TextStyle(fontSize: 12, color: AppColors.textSecondary),
              ),
              const Spacer(),
              IconButton(
                key: Key('atmosphereEdit_${item.id}'),
                tooltip: '编辑',
                onPressed: busy ? null : () => _openEditor(item.category, existing: item),
                icon: const Icon(Icons.edit_outlined, size: 18),
              ),
              IconButton(
                key: Key('atmosphereDelete_${item.id}'),
                tooltip: '删除',
                onPressed: busy ? null : () => _delete(item),
                icon: const Icon(Icons.delete_outline, size: 18, color: AppColors.danger),
              ),
            ],
          ),
        ],
      ),
    );
  }
}
