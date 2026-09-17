/// 氛围语页（R25）：循环台本空档自动插播的短句 + 每类的插播频次。
///
/// 为什么值得单独一页：服务端从 M10 起模板 CRUD 与频次规则就完整了，
/// 但 App 里长期 **0 处** —— 商家在手机上根本配不了「欢迎语 / 关注语」。
/// 竞品把这几项做成一族弹窗（welcome/follow/thumb/clock），本页把它们收成一张清单。
///
/// 写法约定：**一行 = 一条候选句**，服务端播报时按行随机挑；支持 `[昵称]` 占位。
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'package:starvoice_app/core/models/atmosphere.dart';
import 'package:starvoice_app/core/network/api_exception.dart';
import 'package:starvoice_app/core/theme/app_colors.dart';
import 'package:starvoice_app/providers.dart';

class AtmospherePage extends ConsumerStatefulWidget {
  const AtmospherePage({super.key});

  @override
  ConsumerState<AtmospherePage> createState() => _AtmospherePageState();
}

class _AtmospherePageState extends ConsumerState<AtmospherePage> {
  final Map<String, TextEditingController> _controllers = <String, TextEditingController>{};
  final Map<String, AtmosphereTemplate> _templates = <String, AtmosphereTemplate>{};
  final Map<String, AtmosphereSetting> _settings = <String, AtmosphereSetting>{};
  final Map<String, bool> _enabled = <String, bool>{};
  final Set<String> _saving = <String>{};

  bool _loading = true;
  bool _seeding = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    for (final category in kAtmosphereCategories) {
      _controllers[category] = TextEditingController();
      _enabled[category] = true;
    }
    WidgetsBinding.instance.addPostFrameCallback((_) => _load());
  }

  @override
  void dispose() {
    for (final controller in _controllers.values) {
      controller.dispose();
    }
    super.dispose();
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
          // 一类取第一条：推荐模板一键填充每类只建一条；多条的额外记录本页不动
          _templates.putIfAbsent(template.category, () => template);
        }
        _settings
          ..clear()
          ..addEntries(settings.map((item) => MapEntry(item.category, item)));
        for (final category in kAtmosphereCategories) {
          final template = _templates[category];
          _controllers[category]?.text = template?.text ?? '';
          _enabled[category] = template?.enabled ?? true;
        }
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

  Future<void> _seedDefaults() async {
    setState(() {
      _seeding = true;
      _error = null;
    });
    try {
      final created = await ref.read(apiClientProvider).seedAtmosphereDefaults();
      if (!mounted) {
        return;
      }
      await _load();
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(created > 0 ? '已补齐 $created 类推荐模板' : '五类模板都已存在，无需补齐'),
            duration: const Duration(seconds: 2),
          ),
        );
      }
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

  Future<void> _saveCategory(String category) async {
    final text = _controllers[category]?.text.trim() ?? '';
    if (text.isEmpty) {
      setState(() => _error = '「${kAtmosphereCategoryLabels[category]}」内容不能为空');
      return;
    }
    setState(() {
      _saving.add(category);
      _error = null;
    });
    try {
      final client = ref.read(apiClientProvider);
      final existing = _templates[category];
      final saved = existing == null
          ? await client.createAtmosphereTemplate(category: category, text: text)
          : await client.updateAtmosphereTemplate(
              existing.id,
              text: text,
              enabled: _enabled[category] ?? true,
            );
      if (!mounted) {
        return;
      }
      setState(() => _templates[category] = saved);
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text('「${kAtmosphereCategoryLabels[category]}」已保存'),
          duration: const Duration(seconds: 1),
        ),
      );
    } on ApiException catch (error) {
      if (mounted) {
        setState(() => _error = error.message);
      }
    } finally {
      if (mounted) {
        setState(() => _saving.remove(category));
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
    if (seconds % 60 == 0) {
      return '${seconds ~/ 60} 分钟/次';
    }
    return '$seconds 秒/次';
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
        setState(() => _settings[category] = saved);
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
                            '一行写一句，服务端随机挑；[昵称] 会被替换成观众名字。',
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
    final saving = _saving.contains(category);
    return Card(
      key: Key('atmosphereCard_$category'),
      margin: const EdgeInsets.only(bottom: 14),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(14, 12, 14, 10),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: <Widget>[
            Row(
              children: <Widget>[
                Text(
                  label,
                  style: theme.textTheme.bodyMedium?.copyWith(fontWeight: FontWeight.w600),
                ),
                const Spacer(),
                TextButton(
                  key: Key('atmosphereInterval_$category'),
                  onPressed: () => _pickInterval(category),
                  child: Text(_intervalLabel(category)),
                ),
              ],
            ),
            TextField(
              key: Key('atmosphereTextField_$category'),
              controller: _controllers[category],
              maxLines: 4,
              minLines: 2,
              decoration: const InputDecoration(
                hintText: '一行一句，例如：欢迎[昵称]来到直播间～',
                border: OutlineInputBorder(),
                isDense: true,
              ),
            ),
            Row(
              children: <Widget>[
                Switch(
                  key: Key('atmosphereSwitch_$category'),
                  value: _enabled[category] ?? true,
                  onChanged: (value) => setState(() => _enabled[category] = value),
                ),
                const Text('启用', style: TextStyle(fontSize: 13)),
                const Spacer(),
                TextButton(
                  key: Key('atmosphereSave_$category'),
                  onPressed: saving ? null : () => _saveCategory(category),
                  child: Text(saving ? '保存中…' : '保存'),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}
