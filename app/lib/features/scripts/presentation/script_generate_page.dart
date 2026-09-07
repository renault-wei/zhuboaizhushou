import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import 'package:starvoice_app/core/models/script.dart';
import 'package:starvoice_app/core/network/api_exception.dart';
import 'package:starvoice_app/features/scripts/application/script_controller.dart';
import 'package:starvoice_app/providers.dart';

/// 行业选项（与服务端 scriptTemplates 保持一致，仅做展示与表单标签）。
class ScriptIndustryOption {
  const ScriptIndustryOption({
    required this.code,
    required this.label,
    required this.productFields,
  });

  final String code;
  final String label;

  /// 商品字段名 → 字段中文名（name / package / price / sellingPoints）
  final Map<String, String> productFields;
}

const List<ScriptIndustryOption> kScriptIndustryOptions = <ScriptIndustryOption>[
  ScriptIndustryOption(
    code: 'restaurant',
    label: '餐饮',
    productFields: <String, String>{
      'name': '团购券名',
      'package': '套餐内容',
      'price': '价格',
      'sellingPoints': '卖点',
    },
  ),
  ScriptIndustryOption(
    code: 'local_service',
    label: '到店服务',
    productFields: <String, String>{
      'name': '服务名',
      'package': '服务内容',
      'price': '价格',
      'sellingPoints': '卖点',
    },
  ),
  ScriptIndustryOption(
    code: 'retail',
    label: '零售',
    productFields: <String, String>{
      'name': '商品名',
      'package': '规格',
      'price': '价格',
      'sellingPoints': '卖点',
    },
  ),
];

/// 商品表单固定字段顺序，标签随行业切换。
const List<String> _scriptFieldKeys = <String>['name', 'package', 'price', 'sellingPoints'];

String _twoDigits(int value) => value.toString().padLeft(2, '0');

/// 展示用创建时间：ISO 字符串 → yyyy-MM-dd HH:mm（本地时区）。
String _formatCreatedAt(String iso) {
  final time = DateTime.tryParse(iso);
  if (time == null) {
    return '';
  }
  final local = time.toLocal();
  return '${local.year}-${_twoDigits(local.month)}-${_twoDigits(local.day)} '
      '${_twoDigits(local.hour)}:${_twoDigits(local.minute)}';
}

String _industryLabel(String code) {
  for (final option in kScriptIndustryOptions) {
    if (option.code == code) {
      return option.label;
    }
  }
  return code;
}

/// 话术生成页（路由 /scripts）：顶部选行业 + 商品表单 → DeepSeek 生成，
/// 下方展示「我的话术」列表（含敏感词拦截警示与编辑入口）。
class ScriptGeneratePage extends ConsumerStatefulWidget {
  const ScriptGeneratePage({super.key});

  @override
  ConsumerState<ScriptGeneratePage> createState() => _ScriptGeneratePageState();
}

class _ScriptGeneratePageState extends ConsumerState<ScriptGeneratePage> {
  String _industry = 'restaurant';
  late final Map<String, TextEditingController> _fieldControllers;

  @override
  void initState() {
    super.initState();
    _fieldControllers = <String, TextEditingController>{
      for (final key in _scriptFieldKeys) key: TextEditingController(),
    };
    // 首帧后再拉取列表，避免在 build 阶段发起网络请求
    WidgetsBinding.instance.addPostFrameCallback((_) {
      ref.read(scriptControllerProvider.notifier).load();
    });
  }

  @override
  void dispose() {
    for (final controller in _fieldControllers.values) {
      controller.dispose();
    }
    super.dispose();
  }

  Future<void> _reload() async {
    await ref.read(scriptControllerProvider.notifier).load();
  }

  void _showSnack(String message) {
    if (!mounted) {
      return;
    }
    ScaffoldMessenger.of(context)
      ..clearSnackBars()
      ..showSnackBar(SnackBar(content: Text(message)));
  }

  ScriptIndustryOption _industryOption(String code) {
    return kScriptIndustryOptions.firstWhere(
      (option) => option.code == code,
      orElse: () => kScriptIndustryOptions.first,
    );
  }

  /// 组装商品信息并调 DeepSeek 生成话术；失败用 SnackBar 透传中文提示。
  Future<void> _handleGenerate() async {
    final product = <String, String>{};
    for (final key in _scriptFieldKeys) {
      final text = _fieldControllers[key]?.text.trim() ?? '';
      if (text.isNotEmpty) {
        product[key] = text;
      }
    }
    if (product.isEmpty) {
      _showSnack('请先填写商品信息');
      return;
    }
    try {
      final created = await ref.read(scriptControllerProvider.notifier).generate(
            industry: _industry,
            product: product,
          );
      final note = created.generationNote;
      if (note != null && note.isNotEmpty) {
        // 初稿被自动改写/兜底时一次性告知，成品本身可直接开播
        _showSnack(note);
      }
    } on ApiException catch (error) {
      _showSnack('生成失败：${error.message}');
    }
  }

  Future<void> _openEdit(Script script) async {
    await context.push('/scripts/${script.id}/edit');
    if (!mounted) {
      return;
    }
    // 编辑页可能保存了新内容 / 改变了拦截状态，返回后重新拉取列表
    await ref.read(scriptControllerProvider.notifier).load();
  }

  @override
  Widget build(BuildContext context) {
    final state = ref.watch(scriptControllerProvider);
    final option = _industryOption(_industry);
    return Scaffold(
      key: const Key('scriptGeneratePage'),
      appBar: AppBar(
        title: const Text('话术生成'),
        actions: <Widget>[
          IconButton(
            key: const Key('scriptRefreshButton'),
            onPressed: state.loading || state.generating ? null : _reload,
            icon: const Icon(Icons.refresh),
            tooltip: '刷新',
          ),
        ],
      ),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: <Widget>[
          Text(
            '选择行业',
            style: Theme.of(context)
                .textTheme
                .titleMedium
                ?.copyWith(fontWeight: FontWeight.bold),
          ),
          const SizedBox(height: 8),
          Wrap(
            spacing: 8,
            children: <Widget>[
              for (final item in kScriptIndustryOptions)
                ChoiceChip(
                  key: Key('scriptIndustry_${item.code}'),
                  label: Text(item.label),
                  selected: _industry == item.code,
                  onSelected: (_) {
                    setState(() {
                      _industry = item.code;
                    });
                  },
                ),
            ],
          ),
          const SizedBox(height: 20),
          Text(
            '商品信息',
            style: Theme.of(context)
                .textTheme
                .titleMedium
                ?.copyWith(fontWeight: FontWeight.bold),
          ),
          const SizedBox(height: 8),
          for (final key in _scriptFieldKeys)
            Padding(
              padding: const EdgeInsets.only(bottom: 12),
              child: TextField(
                key: Key('scriptField_$key'),
                controller: _fieldControllers[key],
                maxLines: key == 'sellingPoints' ? 2 : 1,
                decoration: InputDecoration(
                  labelText: option.productFields[key] ?? key,
                  border: const OutlineInputBorder(),
                ),
              ),
            ),
          FilledButton(
            key: const Key('scriptGenerateButton'),
            onPressed: state.generating ? null : _handleGenerate,
            style: FilledButton.styleFrom(
              minimumSize: const Size.fromHeight(48),
            ),
            child: state.generating
                ? const SizedBox(
                    width: 20,
                    height: 20,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                : const Text('生成话术'),
          ),
          const SizedBox(height: 28),
          Text(
            '我的话术（${state.scripts.length}）',
            style: Theme.of(context)
                .textTheme
                .titleMedium
                ?.copyWith(fontWeight: FontWeight.bold),
          ),
          const SizedBox(height: 12),
          ..._buildScriptList(state),
        ],
      ),
    );
  }

  List<Widget> _buildScriptList(ScriptState state) {
    if (state.loading && state.scripts.isEmpty) {
      return const <Widget>[
        Padding(
          padding: EdgeInsets.symmetric(vertical: 32),
          child: Center(
            child: CircularProgressIndicator(key: Key('scriptListLoading')),
          ),
        ),
      ];
    }
    if (state.error != null && state.scripts.isEmpty) {
      return <Widget>[
        Padding(
          padding: const EdgeInsets.symmetric(vertical: 24),
          child: Column(
            children: <Widget>[
              Text('话术列表加载失败：${state.error}'),
              const SizedBox(height: 12),
              OutlinedButton(
                key: const Key('scriptListRetryButton'),
                onPressed: _reload,
                child: const Text('重试'),
              ),
            ],
          ),
        ),
      ];
    }
    if (state.scripts.isEmpty) {
      return const <Widget>[
        Padding(
          padding: EdgeInsets.symmetric(vertical: 24),
          child: Center(
            child: Text(
              '还没有话术，先在上方填写商品信息生成第一条吧',
              key: Key('scriptEmptyText'),
            ),
          ),
        ),
      ];
    }
    final children = <Widget>[];
    for (var i = 0; i < state.scripts.length; i++) {
      if (i > 0) {
        children.add(const SizedBox(height: 12));
      }
      final script = state.scripts[i];
      children.add(
        _ScriptCard(script: script, onEdit: () => _openEdit(script)),
      );
    }
    return children;
  }
}

/// 单条话术卡片：标题、状态徽章（可开播 / 已拦截 / 草稿）、
/// blocked 红色警示条（命中词 + 不可开播标注）、正文预览与「编辑」入口。
class _ScriptCard extends StatelessWidget {
  const _ScriptCard({required this.script, required this.onEdit});

  final Script script;
  final VoidCallback onEdit;

  ({String label, Color color}) _statusStyle() {
    if (script.isReady) {
      return (label: '可开播', color: Colors.green.shade700);
    }
    if (script.isBlocked) {
      return (label: '已拦截', color: Colors.red);
    }
    return (label: '草稿', color: Colors.grey);
  }

  @override
  Widget build(BuildContext context) {
    final style = _statusStyle();
    final words = script.sensitiveMatchedWords;
    final bannerText = words.isEmpty
        ? '命中拦截级敏感词，话术不可开播'
        : '命中敏感词：${words.join('、')}，话术不可开播';
    return Card(
      key: Key('scriptCard_${script.id}'),
      margin: EdgeInsets.zero,
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Row(
              children: <Widget>[
                Flexible(
                  child: Text(
                    script.displayTitle,
                    style: const TextStyle(
                      fontSize: 16,
                      fontWeight: FontWeight.bold,
                    ),
                    overflow: TextOverflow.ellipsis,
                  ),
                ),
                const SizedBox(width: 8),
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                  decoration: BoxDecoration(
                    color: style.color.withValues(alpha: 0.12),
                    borderRadius: BorderRadius.circular(999),
                  ),
                  child: Text(
                    style.label,
                    key: Key('scriptStatus_${script.id}'),
                    style: TextStyle(
                      fontSize: 12,
                      color: style.color,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                ),
              ],
            ),
            if (script.isBlocked) ...<Widget>[
              const SizedBox(height: 10),
              Container(
                width: double.infinity,
                padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
                decoration: BoxDecoration(
                  color: Colors.red.withValues(alpha: 0.08),
                  borderRadius: BorderRadius.circular(8),
                ),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    const Icon(
                      Icons.warning_amber_rounded,
                      size: 16,
                      color: Colors.red,
                    ),
                    const SizedBox(width: 6),
                    Expanded(
                      child: Text(
                        bannerText,
                        key: Key('scriptBlockedBanner_${script.id}'),
                        style: const TextStyle(fontSize: 12, color: Colors.red),
                      ),
                    ),
                  ],
                ),
              ),
            ],
            const SizedBox(height: 8),
            Text(
              script.content,
              maxLines: 3,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(
                fontSize: 13,
                height: 1.4,
                color: Colors.grey.shade800,
              ),
            ),
            const SizedBox(height: 4),
            Row(
              children: <Widget>[
                Expanded(
                  child: Text(
                    '${_industryLabel(script.industry)} · '
                    '创建于 ${_formatCreatedAt(script.createdAt)}',
                    style: TextStyle(fontSize: 12, color: Colors.grey.shade600),
                  ),
                ),
                TextButton(
                  key: Key('scriptEdit_${script.id}'),
                  onPressed: onEdit,
                  child: const Text('编辑'),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}
