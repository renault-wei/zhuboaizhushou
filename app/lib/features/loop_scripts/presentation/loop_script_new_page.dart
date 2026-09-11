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
  const LoopScriptNewPage({super.key, this.copySourceId, this.sampleSourceId});

  /// `?copy=<id>`：把现有台本复制为新草稿编辑，保存后生成新台本
  final String? copySourceId;

  /// `?samples=<sampleId>`：套用谈单演示内置示例，预填编辑器后保存生成新台本
  final String? sampleSourceId;

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

  /// 生成场景：group_buy（默认到店团购）/ single_product 单品卖货 / custom 自定义
  String _scenario = 'group_buy';

  /// 自定义场景的参考素材输入（默认预填示例，客户按需改写）
  late final TextEditingController _customBriefController;
  static const String _defaultCustomBrief =
      '【产品】麻辣自热小火锅；【人群】加班党/宿舍党；【主打】8 分钟出餐、真牛油底料；'
      '【风格】热情快节奏；【禁忌】不要说最辣、最好吃';
  String? _sourceScriptId;
  String? _generationNote;
  bool _sampleApplying = false;
  bool _fromSample = false;
  String _draftTitle = '';
  List<LoopScriptItem> _draftItems = <LoopScriptItem>[];

  @override
  void initState() {
    super.initState();
    _couponController = TextEditingController();
    _customBriefController = TextEditingController(text: _defaultCustomBrief);
    // 复制为草稿：进入即加载原台本内容
    final copySourceId = widget.copySourceId;
    if (copySourceId != null && copySourceId.isNotEmpty) {
      WidgetsBinding.instance.addPostFrameCallback(
        (_) => _loadCopy(copySourceId),
      );
      return;
    }
    // 套用谈单演示示例：拉取内置示例并预填编辑器（示例不落库，保存才入库）
    final sampleId = widget.sampleSourceId;
    if (sampleId != null && sampleId.isNotEmpty) {
      WidgetsBinding.instance.addPostFrameCallback(
        (_) => _loadSample(sampleId),
      );
    }
  }

  @override
  void dispose() {
    _couponController.dispose();
    _customBriefController.dispose();
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

  /// 套用谈单演示示例：拉取内置示例（只读、不落库），成功后一次性带入编辑器。
  /// 等待期间显示加载态，避免编辑器以空初值先建、示例回来后不生效。
  Future<void> _loadSample(String sampleId) async {
    if (mounted) {
      setState(() {
        _sampleApplying = true;
      });
    }
    try {
      final samples =
          await ref.read(apiClientProvider).fetchLoopScriptSamples();
      if (!mounted) {
        return;
      }
      LoopScriptSample? matched;
      for (final sample in samples) {
        if (sample.sampleId == sampleId) {
          matched = sample;
          break;
        }
      }
      if (matched == null) {
        setState(() {
          _sampleApplying = false;
        });
        _showSnack('示例不存在或已更新，请返回台本库重选');
        context.pop();
        return;
      }
      final selectedSample = matched;
      setState(() {
        _draftTitle = selectedSample.title;
        _draftItems = selectedSample.items;
        _fromSample = true;
        _stage = 'editor';
        _sampleApplying = false;
      });
    } on ApiException catch (error) {
      if (!mounted) {
        return;
      }
      setState(() {
        _sampleApplying = false;
      });
      _showSnack('示例加载失败：${error.message}');
      context.pop();
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
      _fromSample = false;
    });
    _loadScripts();
  }

  void _pickBlankWay() {
    setState(() {
      _stage = 'editor';
      _draftTitle = '';
      _draftItems = <LoopScriptItem>[];
      _sourceScriptId = null;
      _fromSample = false;
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
            scenario: _scenario,
            customBrief: _scenario == 'custom'
                ? _customBriefController.text.trim()
                : null,
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
        _fromSample = false;
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
      if (_fromSample) {
        return '套用示例 · 编辑预览';
      }
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
      body: _sampleApplying
          ? const Center(
              child: CircularProgressIndicator(
                key: Key('loopScriptSamplePrefillLoading'),
              ),
            )
          : _stage == 'editor'
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
          Text(
            '生成场景',
            style: Theme.of(context).textTheme.titleSmall
                ?.copyWith(fontWeight: FontWeight.bold),
          ),
          const SizedBox(height: 8),
          Wrap(
            spacing: 8,
            children: <Widget>[
              ChoiceChip(
                key: const Key('loopScriptScenarioGroupBuy'),
                label: const Text('到店团购'),
                selected: _scenario == 'group_buy',
                onSelected: _generating
                    ? null
                    : (_) => setState(() => _scenario = 'group_buy'),
              ),
              ChoiceChip(
                key: const Key('loopScriptScenarioSingleProduct'),
                label: const Text('单品卖货'),
                selected: _scenario == 'single_product',
                onSelected: _generating
                    ? null
                    : (_) => setState(() => _scenario = 'single_product'),
              ),
              ChoiceChip(
                key: const Key('loopScriptScenarioCustom'),
                label: const Text('自定义'),
                selected: _scenario == 'custom',
                onSelected: _generating
                    ? null
                    : (_) => setState(() => _scenario = 'custom'),
              ),
            ],
          ),
          if (_scenario == 'custom') ...<Widget>[
            const SizedBox(height: 12),
            TextField(
              key: const Key('loopScriptCustomBrief'),
              controller: _customBriefController,
              maxLines: 3,
              maxLength: 300,
              decoration: const InputDecoration(
                labelText: '参考素材',
                hintText: '按示例填写产品、人群、主打卖点与风格',
                helperText: '未写到的信息 AI 不会编造，宁少说不虚构',
                border: OutlineInputBorder(),
              ),
            ),
          ],
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
