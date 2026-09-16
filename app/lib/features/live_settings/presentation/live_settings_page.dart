/// 账号级直播设置页（R23）：智能回复 / 自定义违禁词 / 语速默认档。
///
/// 对标反编译竞品（docs/LIVE-SETTINGS-PLAN.md）：竞品把回复做成 6 档频次单选
/// `["1s/次","5s/次","10s/次","20s/次","自定义","不回复"]`，我们沿用这套档位，
/// 但**保留文案可编辑**（竞品文案写死在它服务端）—— 补充知识与违禁词都可改。
///
/// 分级说明：本页三项都是**账号级**（用户拍板：一个商家一套直播习惯）。
/// 定时关播是**场次级**，在现场次表单里配。
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'package:starvoice_app/core/models/live_settings.dart';
import 'package:starvoice_app/core/network/api_exception.dart';
import 'package:starvoice_app/core/theme/app_colors.dart';
import 'package:starvoice_app/providers.dart';

/// 频次档位：与竞品 replyOptions 同款（末位「自定义」单独处理）
const List<int> _presetReplySeconds = <int>[1, 5, 10, 20];

class LiveSettingsPage extends ConsumerStatefulWidget {
  const LiveSettingsPage({super.key});

  @override
  ConsumerState<LiveSettingsPage> createState() => _LiveSettingsPageState();
}

class _LiveSettingsPageState extends ConsumerState<LiveSettingsPage> {
  final TextEditingController _extraController = TextEditingController();
  final TextEditingController _bannedController = TextEditingController();

  LiveSettings? _loaded;
  LiveSettingsLimits _limits = const LiveSettingsLimits(
    replyIntervalMin: 1,
    replyIntervalMax: 60,
    autoEndMinMinutes: 10,
    autoEndMaxMinutes: 1440,
    speechRateMin: -20,
    speechRateMax: 60,
    maxTextLength: 2000,
  );
  bool _loading = true;
  bool _saving = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _load());
  }

  @override
  void dispose() {
    _extraController.dispose();
    _bannedController.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    try {
      final client = ref.read(apiClientProvider);
      final results = await Future.wait(<Future<Object>>[
        client.fetchLiveSettings(),
        client.fetchLiveSettingsLimits(),
      ]);
      if (!mounted) {
        return;
      }
      final settings = results[0] as LiveSettings;
      setState(() {
        _loaded = settings;
        _limits = results[1] as LiveSettingsLimits;
        _extraController.text = settings.replyExtraKnowledge ?? '';
        _bannedController.text = settings.bannedWords ?? '';
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

  /// 当前草稿（把两个文本框的即时值并进来）
  LiveSettings get _draft {
    final base = _loaded ?? const LiveSettings(replyEnabled: true, replyIntervalSeconds: 5);
    final extra = _extraController.text.trim();
    final banned = _bannedController.text.trim();
    return base.copyWith(
      replyExtraKnowledge: extra.isEmpty ? null : extra,
      bannedWords: banned.isEmpty ? null : banned,
    );
  }

  Future<void> _save() async {
    setState(() {
      _saving = true;
      _error = null;
    });
    try {
      final saved = await ref.read(apiClientProvider).updateLiveSettings(_draft);
      if (!mounted) {
        return;
      }
      setState(() {
        _loaded = saved;
        _extraController.text = saved.replyExtraKnowledge ?? '';
        _bannedController.text = saved.bannedWords ?? '';
      });
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(const SnackBar(content: Text('已保存'), duration: Duration(seconds: 1)));
    } on ApiException catch (error) {
      if (mounted) {
        setState(() => _error = error.message);
      }
    } finally {
      if (mounted) {
        setState(() => _saving = false);
      }
    }
  }

  /// 频次档位的人话描述（对标竞品那 6 档的展示口径）
  String get _replyIntervalLabel {
    final settings = _loaded;
    if (settings == null || !settings.replyEnabled) {
      return '不回复';
    }
    final seconds = settings.replyIntervalSeconds;
    return _presetReplySeconds.contains(seconds) ? '$seconds 秒/次' : '自定义（$seconds 秒/次）';
  }

  Future<void> _pickReplyInterval() async {
    final settings = _loaded;
    if (settings == null) {
      return;
    }
    final picked = await showModalBottomSheet<String>(
      context: context,
      // 必读：7 个档位 + 标题会超过 modal sheet 的默认高度上限，
      // 不套滚动容器会在小屏（与测试默认 800x600）上直接 RenderFlex 溢出。
      builder: (sheetContext) => SafeArea(
        child: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: <Widget>[
            const Padding(
              padding: EdgeInsets.fromLTRB(16, 16, 16, 8),
              child: Align(
                alignment: Alignment.centerLeft,
                child: Text('多久回复一次', style: TextStyle(fontWeight: FontWeight.w600)),
              ),
            ),
            ListTile(
              key: const Key('replyIntervalOff'),
              title: const Text('不回复'),
              subtitle: const Text('完全关闭智能回复（服务端连 AI 都不调）'),
              trailing: !settings.replyEnabled ? const Icon(Icons.check_rounded) : null,
              onTap: () => Navigator.of(sheetContext).pop('off'),
            ),
            for (final seconds in _presetReplySeconds)
              ListTile(
                key: Key('replyInterval$seconds'),
                title: Text('$seconds 秒/次'),
                trailing: settings.replyEnabled && settings.replyIntervalSeconds == seconds
                    ? const Icon(Icons.check_rounded)
                    : null,
                onTap: () => Navigator.of(sheetContext).pop(seconds.toString()),
              ),
            ListTile(
              key: const Key('replyIntervalCustom'),
              title: const Text('自定义'),
              subtitle: Text('当前 ${settings.replyIntervalSeconds} 秒/次'),
              trailing: settings.replyEnabled &&
                      !_presetReplySeconds.contains(settings.replyIntervalSeconds)
                  ? const Icon(Icons.check_rounded)
                  : null,
              onTap: () => Navigator.of(sheetContext).pop('custom'),
            ),
            ],
          ),
        ),
      ),
    );
    if (picked == null || !mounted) {
      return;
    }
    if (picked == 'off') {
      setState(() => _loaded = settings.copyWith(replyEnabled: false));
      return;
    }
    if (picked == 'custom') {
      final seconds = await _askCustomSeconds(settings.replyIntervalSeconds);
      if (seconds == null || !mounted) {
        return;
      }
      setState(
        () => _loaded = settings.copyWith(replyEnabled: true, replyIntervalSeconds: seconds),
      );
      return;
    }
    final seconds = int.tryParse(picked);
    if (seconds != null) {
      setState(
        () => _loaded = settings.copyWith(replyEnabled: true, replyIntervalSeconds: seconds),
      );
    }
  }

  Future<int?> _askCustomSeconds(int current) async {
    final controller = TextEditingController(text: '$current');
    final result = await showDialog<int>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: const Text('自定义回复间隔'),
        content: TextField(
          key: const Key('customReplySecondsField'),
          controller: controller,
          keyboardType: TextInputType.number,
          autofocus: true,
          decoration: InputDecoration(
            suffixText: '秒',
            helperText: '范围 ${_limits.replyIntervalMin}~${_limits.replyIntervalMax} 秒',
            border: const OutlineInputBorder(),
            isDense: true,
          ),
        ),
        actions: <Widget>[
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(),
            child: const Text('取消'),
          ),
          FilledButton(
            key: const Key('customReplySecondsConfirm'),
            onPressed: () {
              final parsed = int.tryParse(controller.text.trim());
              if (parsed == null ||
                  parsed < _limits.replyIntervalMin ||
                  parsed > _limits.replyIntervalMax) {
                return;
              }
              Navigator.of(dialogContext).pop(parsed);
            },
            child: const Text('确定'),
          ),
        ],
      ),
    );
    controller.dispose();
    return result;
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Scaffold(
      key: const Key('liveSettingsPage'),
      appBar: AppBar(title: const Text('直播设置')),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : ListView(
              padding: const EdgeInsets.fromLTRB(16, 12, 16, 32),
              children: <Widget>[
                _sectionTitle(theme, '智能回复'),
                Card(
                  margin: EdgeInsets.zero,
                  child: Column(
                    children: <Widget>[
                      SwitchListTile(
                        key: const Key('replyEnabledSwitch'),
                        value: _loaded?.replyEnabled ?? true,
                        onChanged: (value) => setState(
                          () => _loaded = (_loaded ?? const LiveSettings(replyEnabled: true, replyIntervalSeconds: 5))
                              .copyWith(replyEnabled: value),
                        ),
                        title: const Text('开启智能回复'),
                        subtitle: const Text('有观众提问时，AI 用你的话术知识作答'),
                      ),
                      const Divider(height: 1),
                      ListTile(
                        key: const Key('replyIntervalTile'),
                        enabled: _loaded?.replyEnabled ?? true,
                        onTap: _pickReplyInterval,
                        title: const Text('回复频次'),
                        subtitle: const Text('同一场直播里最多多久回一条，防刷屏'),
                        trailing: Text(
                          _replyIntervalLabel,
                          key: const Key('replyIntervalValue'),
                          style: TextStyle(
                            color: (_loaded?.replyEnabled ?? true)
                                ? AppColors.primary
                                : AppColors.textHint,
                          ),
                        ),
                      ),
                    ],
                  ),
                ),
                const SizedBox(height: 10),
                TextField(
                  key: const Key('extraKnowledgeField'),
                  controller: _extraController,
                  maxLines: 4,
                  minLines: 3,
                  maxLength: _limits.maxTextLength,
                  decoration: const InputDecoration(
                    labelText: '补充知识（选填）',
                    helperText: '绑定话术前先按话术回答，这里只作更正与补充',
                    helperMaxLines: 2,
                    border: OutlineInputBorder(),
                    alignLabelWithHint: true,
                  ),
                ),
                const SizedBox(height: 20),
                _sectionTitle(theme, '违禁词'),
                TextField(
                  key: const Key('bannedWordsField'),
                  controller: _bannedController,
                  maxLines: 4,
                  minLines: 3,
                  maxLength: _limits.maxTextLength,
                  decoration: const InputDecoration(
                    labelText: '不想让 AI 说出口的词',
                    helperText: '用中文顿号「、」隔开；命中即整条不播。单个字会被忽略（避免误伤）',
                    helperMaxLines: 2,
                    border: OutlineInputBorder(),
                    alignLabelWithHint: true,
                  ),
                ),
                const SizedBox(height: 20),
                _sectionTitle(theme, '默认语速'),
                Card(
                  margin: EdgeInsets.zero,
                  child: Padding(
                    padding: const EdgeInsets.fromLTRB(16, 12, 16, 4),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: <Widget>[
                        Row(
                          children: <Widget>[
                            const Text('口播语速'),
                            const Spacer(),
                            Text(
                              '${_loaded?.defaultSpeechRate ?? 0}',
                              key: const Key('speechRateValue'),
                              style: TextStyle(color: AppColors.primary),
                            ),
                          ],
                        ),
                        Slider(
                          key: const Key('speechRateSlider'),
                          min: _limits.speechRateMin.toDouble(),
                          max: _limits.speechRateMax.toDouble(),
                          divisions: _limits.speechRateMax - _limits.speechRateMin,
                          value: (_loaded?.defaultSpeechRate ?? 0)
                              .clamp(_limits.speechRateMin, _limits.speechRateMax)
                              .toDouble(),
                          label: '${_loaded?.defaultSpeechRate ?? 0}',
                          onChanged: (value) => setState(
                            () => _loaded = (_loaded ?? const LiveSettings(replyEnabled: true, replyIntervalSeconds: 5))
                                .copyWith(defaultSpeechRate: value.round()),
                          ),
                        ),
                        Text(
                          '负值更慢（-10 接近真人主播节奏）；新建场次默认用它，场次里可单独覆盖。',
                          style: theme.textTheme.bodySmall?.copyWith(
                            color: AppColors.textSecondary,
                          ),
                        ),
                        const SizedBox(height: 8),
                      ],
                    ),
                  ),
                ),
                if (_error != null) ...<Widget>[
                  const SizedBox(height: 12),
                  Text(
                    _error!,
                    key: const Key('liveSettingsError'),
                    style: const TextStyle(color: AppColors.danger, fontSize: 13),
                  ),
                ],
                const SizedBox(height: 20),
                FilledButton(
                  key: const Key('liveSettingsSave'),
                  onPressed: _saving ? null : _save,
                  child: _saving
                      ? const SizedBox(
                          width: 16,
                          height: 16,
                          child: CircularProgressIndicator(strokeWidth: 2),
                        )
                      : const Text('保存'),
                ),
              ],
            ),
    );
  }

  Widget _sectionTitle(ThemeData theme, String title) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Text(
        title,
        style: theme.textTheme.titleSmall?.copyWith(fontWeight: FontWeight.w600),
      ),
    );
  }
}
