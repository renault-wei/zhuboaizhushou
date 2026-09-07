/// 循环台本新建页（/loop-scripts/new）：
/// 两种创建方式 —— ① 选我的「可开播」话术 → 一键生成草稿 → 编辑预览后保存；
/// ② 新建空台本手填。支持 `?copy=<id>` 把现有台本复制为草稿（保存后生成新台本）。
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import 'package:starvoice_app/core/models/loop_script.dart';
import 'package:starvoice_app/core/models/script.dart';
import 'package:starvoice_app/core/network/api_exception.dart';
import 'package:starvoice_app/core/theme/app_colors.dart';
import 'package:starvoice_app/core/theme/theme_tokens.dart';
import 'package:starvoice_app/features/loop_scripts/presentation/loop_script_editor_panel.dart';
import 'package:starvoice_app/providers.dart';

String _industryLabel(String code) {
  switch (code) {
    case 'restaurant':
      return '餐饮';
    case 'local_service':
      return '本地生活';
    case 'retail':
      return '零售';
    default:
      return code;
  }
}

/// 循环台本新建页。
class LoopScriptNewPage extends ConsumerStatefulWidget {
  const LoopScriptNewPage({super.key, this.copySourceId});

  /// `?copy=<id>`：把现有台本复制为新草稿编辑，保存后生成新台本
  final String? copySourceId;

  @override
  ConsumerState<LoopScriptNewPage> createState() => _LoopScriptNewPageState();
}

class _LoopScriptNewPageState extends ConsumerState<LoopScriptNewPage> {
  /// choose = 选择创建方式；source = 选择来源话术；editor = 编辑预览
  String _stage = 'choose';

  bool _scriptsLoading = false;
  bool _generating = false;
  String? _scriptsError;
  List<Script> _scripts = <Script>[];
  String? _selectedScriptId;
  late final TextEditingController _couponController;
  String? _sourceScriptId;
  String? _generationNote;
  String _draftTitle = '';
  List<LoopScriptItem> _draftItems = <LoopScriptItem>[];

  @override
  void initState() {
    super.initState();
    _couponController = TextEditingController();
    // 复制为草稿：进入即加载原台本内容
    final copySourceId = widget.copySourceId;
    if (copySourceId != null && copySourceId.isNotEmpty) {
      WidgetsBinding.instance.addPostFrameCallback(
        (_) => _loadCopy(copySourceId),
      );
    }
  }

  @override
  void dispose() {
    _couponController.dispose();
    super.dispose();
  }

  Future<void> _loadCopy(String id) async {
    setState(() {
      _stage = 'editor';
    });
    try {
      final script = await ref.read(apiClientProvider).getLoopScript(id);
      if (!mounted) {
        return;
      }
      setState(() {
        _draftTitle = script.hasEmptyTitle ? '' : '${script.title}（副本）';
        _draftItems = script.items;
      });
    } on ApiException catch (error) {
      if (mounted) {
        ScaffoldMessenger.of(context)
          ..clearSnackBars()
          ..showSnackBar(SnackBar(content: Text('复制失败：${error.message}')));
      }
    }
  }

  void _showSnack(String message) {
    if (!mounted) {
      return;
    }
    ScaffoldMessenger.of(context)
      ..clearSnackBars()
      ..showSnackBar(SnackBar(content: Text(message)));
  }

  Future<void> _loadScripts() async {
    if (mounted) {
      setState(() {
        _scriptsLoading = true;
        _scriptsError = null;
      });
    }
    try {
      final scripts = await ref.read(apiClientProvider).listScripts();
      if (!mounted) {
        return;
      }
      setState(() {
        _scripts = scripts;
        _scriptsLoading = false;
      });
    } on ApiException catch (error) {
      if (!mounted) {
        return;
      }
      setState(() {
        _scriptsError = error.message;
        _scriptsLoading = false;
      });
    }
  }

  void _pickGenerateWay() {
    setState(() {
      _stage = 'source';
    });
    _loadScripts();
  }

  void _pickBlankWay() {
    setState(() {
      _stage = 'editor';
      _draftTitle = '';
      _draftItems = <LoopScriptItem>[];
      _sourceScriptId = null;
    });
  }

  /// 一键生成：DeepSeek 按来源话术/商品快照/券文案生成草稿条目（不落库），
  /// 生成成功进入编辑预览；生成链路已含自动改写，成品不含敏感词。
  Future<void> _generate() async {
    final scriptId = _selectedScriptId;
    if (scriptId == null) {
      _showSnack('请先选择一条可开播的正式话术作为生成来源');
      return;
    }
    setState(() {
      _generating = true;
    });
    try {
      final draft = await ref
          .read(apiClientProvider)
          .generateLoopScriptDraft(
            sourceScriptId: scriptId,
            couponText: _couponController.text.trim().isEmpty
                ? null
                : _couponController.text.trim(),
          );
      if (!mounted) {
        return;
      }
      Script? source;
      for (final script in _scripts) {
        if (script.id == scriptId) {
          source = script;
          break;
        }
      }
      setState(() {
        _sourceScriptId = scriptId;
        _generationNote = draft.generationNote;
        _draftItems = draft.items;
        _draftTitle = source == null ? '' : '${source.displayTitle} · 循环';
        _stage = 'editor';
        _generating = false;
      });
    } on ApiException catch (error) {
      if (mounted) {
        _showSnack('生成失败：${error.message}');
        setState(() {
          _generating = false;
        });
      }
    }
  }

  Future<void> _save(String title, List<LoopScriptItem> items) async {
    await ref
        .read(apiClientProvider)
        .createLoopScript(
          title: title,
          items: <Map<String, dynamic>>[
            for (final item in items) item.toPayload(),
          ],
          sourceScriptId: _sourceScriptId,
        );
    if (mounted) {
      ScaffoldMessenger.of(context)
        ..clearSnackBars()
        ..showSnackBar(const SnackBar(content: Text('循环台本已创建')));
      context.pop();
    }
  }

  String get _appBarTitle {
    if (_stage == 'editor') {
      return _sourceScriptId != null ? '生成结果预览' : '新建循环台本';
    }
    if (_stage == 'source') {
      return '从话术生成';
    }
    return '新建循环台本';
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      key: const Key('loopScriptNewPage'),
      appBar: AppBar(title: Text(_appBarTitle)),
      body: _stage == 'editor'
          ? LoopScriptEditorPanel(
              initialTitle: _draftTitle,
              initialItems: _draftItems,
              generationNote: _generationNote,
              saveButtonKey: const Key('loopScriptNewSaveButton'),
              onSave: _save,
            )
          : (_stage == 'source' ? _buildSourceStep() : _buildChooseStep()),
    );
  }

  Widget _buildChooseStep() {
    return ListView(
      padding: const EdgeInsets.all(16),
      children: <Widget>[
        Text(
          '选择创建方式',
          style: Theme.of(context).textTheme.titleMedium
              ?.copyWith(fontWeight: FontWeight.bold),
        ),
        const SizedBox(height: 12),
        Card(
          key: const Key('loopScriptGenerateWayCard'),
          margin: EdgeInsets.zero,
          child: ListTile(
            leading: const Icon(Icons.auto_awesome_outlined),
            title: const Text('从我的话术一键生成'),
            subtitle: const Text('选一条已就绪的正式话术，AI 生成开场、产品介绍等循环条目'),
            trailing: const Icon(Icons.chevron_right),
            onTap: _pickGenerateWay,
          ),
        ),
        const SizedBox(height: 12),
        Card(
          key: const Key('loopScriptBlankWayCard'),
          margin: EdgeInsets.zero,
          child: ListTile(
            leading: const Icon(Icons.edit_note_outlined),
            title: const Text('新建空台本手填'),
            subtitle: const Text('不依赖 AI，自己逐句编写口播台词'),
            trailing: const Icon(Icons.chevron_right),
            onTap: _pickBlankWay,
          ),
        ),
      ],
    );
  }

  Widget _buildSourceStep() {
    return ListView(
      padding: const EdgeInsets.all(16),
      children: <Widget>[
        Text(
          '选择来源话术（仅「可开播」话术可选）',
          style: Theme.of(context).textTheme.titleMedium
              ?.copyWith(fontWeight: FontWeight.bold),
        ),
        const SizedBox(height: 12),
        if (_scriptsLoading && _scripts.isEmpty)
          const Padding(
            padding: EdgeInsets.symmetric(vertical: 24),
            child: Center(
              child: CircularProgressIndicator(
                key: Key('loopScriptSourceLoading'),
              ),
            ),
          )
        else if (_scriptsError != null && _scripts.isEmpty)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 24),
            child: Column(
              children: <Widget>[
                Text('话术列表加载失败：$_scriptsError'),
                const SizedBox(height: 12),
                OutlinedButton(
                  key: const Key('loopScriptSourceRetryButton'),
                  onPressed: _loadScripts,
                  child: const Text('重试'),
                ),
              ],
            ),
          )
        else if (_scripts.isEmpty)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 24),
            child: Text(
              '暂无话术，请先到「话术生成」创建并完善一条正式话术',
              textAlign: TextAlign.center,
              style: TextStyle(color: context.tokenTextHint),
            ),
          )
        else ...<Widget>[
          RadioGroup<String>(
            groupValue: _selectedScriptId,
            onChanged: (value) {
              if (value != null && mounted) {
                setState(() {
                  _selectedScriptId = value;
                });
              }
            },
            child: Column(
              children: <Widget>[
                for (final script in _scripts)
                  Card(
                    key: Key('loopScriptSourceOption_${script.id}'),
                    margin: const EdgeInsets.symmetric(vertical: 4),
                    child: RadioListTile<String>(
                      value: script.id,
                      enabled: script.isReady,
                      title: Text(
                        script.displayTitle,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                      ),
                      subtitle: Text(
                        '${_industryLabel(script.industry)} · '
                        '${script.isReady ? '可开播' : '未就绪不可选'}',
                        style: TextStyle(
                          fontSize: 12,
                          color: script.isReady
                              ? context.tokenTextBody
                              : AppColors.danger,
                        ),
                      ),
                    ),
                  ),
              ],
            ),
          ),
          const SizedBox(height: 16),
          TextField(
            key: const Key('loopScriptCouponText'),
            controller: _couponController,
            maxLength: 100,
            decoration: const InputDecoration(
              labelText: '团购券文案（可选）',
              hintText: '例如：招牌双人火锅套餐券 ¥99',
              border: OutlineInputBorder(),
            ),
          ),
          const SizedBox(height: 4),
          Text(
            '填写券文案时，AI 会生成独立的券讲解段落，循环向观众介绍团购券。',
            style: TextStyle(fontSize: 12, color: context.tokenTextBody),
          ),
          const SizedBox(height: 12),
          FilledButton(
            key: const Key('loopScriptGenerateButton'),
            onPressed: _generating ? null : _generate,
            style: FilledButton.styleFrom(
              minimumSize: const Size.fromHeight(48),
            ),
            child: _generating
                ? const SizedBox(
                    width: 20,
                    height: 20,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                : const Text('一键生成并预览'),
          ),
        ],
      ],
    );
  }
}
