/// 开播配置表单页：/lives/new（新建）与 /lives/:id（编辑）共用同一页面。
/// 商家绑定：音色（我的克隆音色仅 ready 可选 / 火山预设音色全可选，二选一互斥）+
/// 话术（仅 ready 可选）+
/// 循环台本（push /loop-scripts?select=1 点选后 pop 回整本）+ 团购券
/// （push /coupons 点选后 pop 回券 id）+ 直播标题。
/// 就绪开播：产品口径为平台无关 AI 语音助播，无需实景视频 —— 绑定可用音色后
/// 点「纯 AI 就绪开播」完成敏感词/音色前置校验即就绪；新建草稿先保存、再从列表进入编辑后操作。
/// 「AI 智能直播」角标由服务端强制叠加为 true，本页面没有任何关闭入口。
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import 'package:starvoice_app/core/models/coupon.dart';
import 'package:starvoice_app/core/models/live.dart';
import 'package:starvoice_app/core/models/loop_script.dart';
import 'package:starvoice_app/core/models/script.dart';
import 'package:starvoice_app/core/models/voice.dart';
import 'package:starvoice_app/core/models/volc_preset.dart';
import 'package:starvoice_app/core/network/api_exception.dart';
import 'package:starvoice_app/core/theme/app_colors.dart';
import 'package:starvoice_app/core/theme/theme_tokens.dart';
import 'package:starvoice_app/features/lives/application/live_form_controller.dart';
import 'package:starvoice_app/providers.dart';

/// 开播配置表单页面。
class LiveFormPage extends ConsumerStatefulWidget {
  const LiveFormPage({super.key, this.liveId = ''});

  /// 空串 = 新建模式；非空 = 编辑模式，预填该开播配置。
  final String liveId;

  @override
  ConsumerState<LiveFormPage> createState() => _LiveFormPageState();
}

class _LiveFormPageState extends ConsumerState<LiveFormPage> {
  late final TextEditingController _titleController;

  /// 已选择的绑定项：null 表示未绑定（提交时置空对应字段）。
  String? _voiceId;
  String? _volcPresetId;

  /// 口播语速滑块档：产品口径 50~100，默认 50（很快）；服务端按区间钳制。
  static const int _minSpeechRate = 50;
  static const int _maxSpeechRate = 100;
  static const int _defaultSpeechRate = 50;
  int _speechRate = _defaultSpeechRate;

  /// 用户是否主动改选/清空过音色：为 true 后不再回填默认音色。
  bool _voiceTouched = false;

  /// 新建模式是否已尝试回填默认音色（只调度一次，避免重复回填）。
  bool _defaultPresetApplied = false;
  String? _scriptId;
  String? _couponId;

  /// 已绑定的循环台本 id（null = 未绑定，仅弹幕回复模式）。
  String? _loopScriptId;

  /// 已绑定台本的摘要（标题 + 条数）：绑定后或编辑页预填后从台本列表匹配；
  /// 同步失败降级为 id 展示，可手动重试。
  LoopScript? _loopScriptSummary;

  /// 正在同步已绑定台本摘要。
  bool _loopSummarySyncing = false;

  /// 是否已在本页完成就绪（成功后禁用重复就绪）
  bool _composed = false;

  /// 是否正在就绪开播
  bool _preparing = false;

  /// 编辑模式初值是否已回填到本地（避免 controller 重建覆盖用户输入）。
  bool _hydrated = false;

  bool get _isEdit => widget.liveId.isNotEmpty;

  @override
  void initState() {
    super.initState();
    _titleController = TextEditingController()..addListener(_onTitleChanged);
    // 首帧后再加载可选项与初值，避免在 build 阶段发起网络请求
    WidgetsBinding.instance.addPostFrameCallback((_) {
      ref.read(liveFormControllerProvider(widget.liveId).notifier).load();
    });
  }

  @override
  void dispose() {
    _titleController.dispose();
    super.dispose();
  }

  /// 标题变化时刷新底部保存按钮的可用态。
  void _onTitleChanged() {
    if (mounted) {
      setState(() {});
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

  void _retry() {
    ref.read(liveFormControllerProvider(widget.liveId).notifier).load();
  }

  /// 编辑模式：加载完成后把初值回填到本地（仅执行一次）。
  void _applyInitial(Live? initial) {
    if (!mounted || initial == null) {
      return;
    }
    setState(() {
      _titleController.text = initial.title;
      // 克隆音色与火山预设互斥：服务端保证不同时非空，这里仍做一次兜底
      _volcPresetId = initial.volcPresetId;
      _voiceId = initial.volcPresetId != null ? null : initial.voiceId;
      // 语速档：未设过（null）回落默认「很快」档
      _speechRate = initial.speechRate ?? _defaultSpeechRate;
      _scriptId = initial.scriptId;
      _loopScriptId = initial.loopScriptId;
      _couponId = initial.couponId;
      // 已就绪场次重进编辑页时直接展示「已就绪」，禁止重复就绪
      _composed = initial.isReady;
    });
    if (initial.loopScriptId != null) {
      _refreshLoopSummary();
    }
  }

  /// 新建模式：预设目录到达后自动选中服务端下发的默认音色（推荐女声），
  /// 让商家不选音色也能直接开播；用户主动改选 / 清空后不再回填。
  void _maybeApplyDefaultPreset(LiveFormState state) {
    if (_defaultPresetApplied || _isEdit || _voiceTouched) {
      return;
    }
    if (_volcPresetId != null || _voiceId != null) {
      _defaultPresetApplied = true;
      return;
    }
    final defaultId = state.defaultPresetId;
    if (defaultId.isEmpty ||
        !state.presets.any((preset) => preset.id == defaultId)) {
      return;
    }
    _defaultPresetApplied = true;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted ||
          _voiceTouched ||
          _volcPresetId != null ||
          _voiceId != null) {
        return;
      }
      setState(() => _volcPresetId = defaultId);
    });
  }

  /// 拉取我的循环台本列表，匹配已绑定 id 的标题与条数摘要（尽力而为，
  /// 失败不阻塞表单，摘要区显示降级文案 + 重试按钮）。
  Future<void> _refreshLoopSummary() async {
    final id = _loopScriptId;
    if (id == null) {
      if (mounted) {
        setState(() {
          _loopScriptSummary = null;
          _loopSummarySyncing = false;
        });
      }
      return;
    }
    if (mounted) {
      setState(() {
        _loopSummarySyncing = true;
      });
    }
    try {
      final scripts = await ref.read(apiClientProvider).listLoopScripts();
      if (!mounted) {
        return;
      }
      LoopScript? matched;
      for (final script in scripts) {
        if (script.id == id) {
          matched = script;
          break;
        }
      }
      setState(() {
        _loopScriptSummary = matched;
        _loopSummarySyncing = false;
      });
    } on ApiException {
      if (mounted) {
        setState(() {
          _loopSummarySyncing = false;
        });
      }
    }
  }

  /// 绑定循环台本：push /loop-scripts?select=1，台本库页点选后 pop 返回整本台本，
  /// 用其 id 落库、对象直接做摘要展示（无需再拉一次列表）。
  Future<void> _openLoopScriptLibrary() async {
    final picked = await context.push<LoopScript>('/loop-scripts?select=1');
    if (!mounted || picked == null) {
      return;
    }
    setState(() {
      _loopScriptId = picked.id;
      _loopScriptSummary = picked;
      _loopSummarySyncing = false;
    });
  }

  /// 解绑循环台本：回到仅弹幕回复模式（后续可随时换绑）。
  void _unbindLoopScript() {
    setState(() {
      _loopScriptId = null;
      _loopScriptSummary = null;
      _loopSummarySyncing = false;
    });
  }

  Future<void> _save() async {
    final title = _titleController.text.trim();
    if (title.isEmpty || title.length > 100) {
      _showSnack('标题为必填项，且不超过 100 字');
      return;
    }
    try {
      await ref
          .read(liveFormControllerProvider(widget.liveId).notifier)
          .save(
            title: title,
            volcPresetId: _volcPresetId,
            speechRate: _speechRate,
            voiceId: _voiceId,
            scriptId: _scriptId,
            loopScriptId: _loopScriptId,
            couponId: _couponId,
          );
      if (!mounted) {
        return;
      }
      context.pop();
    } on ApiException catch (error) {
      if (mounted) {
        _showSnack('保存失败：${error.message}');
      }
    }
  }

  /// 就绪开播：真实调用 /api/lives/:id/prepare。纯 AI 语音模式无需实景视频，
  /// 服务端完成敏感词 / 音色前置校验后直接置 ready（可进入工作台开播）。
  Future<void> _prepareLive() async {
    setState(() {
      _preparing = true;
    });
    try {
      await ref.read(apiClientProvider).prepareLive(widget.liveId);
      if (!mounted) {
        return;
      }
      setState(() {
        _composed = true;
      });
      _showSnack('已就绪，可进入工作台开播');
    } on ApiException catch (error) {
      if (mounted) {
        _showSnack('就绪失败：${error.message}');
      }
    } finally {
      if (mounted) {
        setState(() {
          _preparing = false;
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final state = ref.watch(liveFormControllerProvider(widget.liveId));
    // 初值到达后延迟一帧回填，避免在 build 阶段修改 TextEditingController
    // 编辑模式须等 initial 到位后再回填；首帧（数据未加载）与新建模式（initial 恒空）都跳过
    if (!_hydrated &&
        state.initial != null &&
        !state.loading &&
        state.loadError == null) {
      _hydrated = true;
      final initial = state.initial;
      WidgetsBinding.instance.addPostFrameCallback((_) {
        _applyInitial(initial);
      });
    }
    return Scaffold(
      key: const Key('liveFormPage'),
      appBar: AppBar(title: Text(_isEdit ? '编辑开播配置' : '新建开播配置')),
      body: _buildBody(state),
    );
  }

  Widget _buildBody(LiveFormState state) {
    if (state.loading) {
      return const Center(
        child: CircularProgressIndicator(key: Key('liveFormLoading')),
      );
    }
    if (state.loadError != null) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(
                '开播配置加载失败：${state.loadError}',
                key: const Key('liveFormLoadErrorText'),
                textAlign: TextAlign.center,
              ),
              const SizedBox(height: 12),
              OutlinedButton(
                key: const Key('liveFormRetryButton'),
                onPressed: _retry,
                child: const Text('重试'),
              ),
            ],
          ),
        ),
      );
    }
    return _buildForm(state);
  }

  Widget _buildForm(LiveFormState state) {
    // 新建模式：目录到达后回填默认音色（只调度一次）
    _maybeApplyDefaultPreset(state);
    final canSave = !state.saving && _titleController.text.trim().isNotEmpty;
    final voice = _selectedVoice(state);
    final script = _selectedScript(state);
    final coupon = _selectedCoupon(state);
    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        TextField(
          key: const Key('liveTitleField'),
          controller: _titleController,
          maxLength: 100,
          decoration: const InputDecoration(
            labelText: '标题（1-100 字）',
            hintText: '例如：火锅店午市循环直播',
            border: OutlineInputBorder(),
          ),
        ),
        const SizedBox(height: 4),
        Text(
          '绑定素材：音色可选「我的音色」（克隆）或火山预设音色，话术来自话术库，'
          '团购券来自已绑定的抖音号。',
          style: TextStyle(fontSize: 12, color: context.tokenTextBody),
        ),
        const SizedBox(height: 12),
        _buildVoicePicker(state, voice),
        const SizedBox(height: 12),
        _buildSpeechRateSection(state.saving),
        const SizedBox(height: 12),
        _buildScriptPicker(state, script),
        const SizedBox(height: 12),
        _buildLoopScriptSection(state.saving),
        const SizedBox(height: 12),
        _buildCouponPicker(state, coupon),
        const SizedBox(height: 12),
        _buildReadySection(state),
        const SizedBox(height: 12),
        _buildComplianceNote(),
        const SizedBox(height: 20),
        FilledButton(
          key: const Key('liveSaveButton'),
          onPressed: canSave ? _save : null,
          style: FilledButton.styleFrom(minimumSize: const Size.fromHeight(48)),
          child: state.saving
              ? const SizedBox(
                  width: 20,
                  height: 20,
                  child: CircularProgressIndicator(strokeWidth: 2),
                )
              : const Text('保存草稿'),
        ),
        const SizedBox(height: 24),
      ],
    );
  }

  /// 音色选择：弹底部面板，仅 status=ready 的音色可选中。
  Widget _buildVoicePicker(LiveFormState state, Voice? voice) {
    final preset = _selectedPreset(state);
    String value;
    if (preset != null) {
      value = '${preset.name}（火山预设）';
    } else if (voice != null) {
      value = voice.name;
    } else {
      value = _voiceId == null ? '未选择' : _voiceId!;
    }
    return ListTile(
      key: const Key('liveVoiceSelector'),
      contentPadding: EdgeInsets.zero,
      leading: const Icon(Icons.record_voice_over_outlined),
      title: const Text('绑定音色'),
      subtitle: Text(
        value,
        key: const Key('liveVoiceValue'),
        style: TextStyle(fontSize: 13, color: context.tokenTextBody),
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
      ),
      trailing: const Icon(Icons.chevron_right),
      onTap: state.saving ? null : () => _pickVoice(state),
    );
  }

  /// 口播语速滑块（系统风：图标 + 标题 + 当前档位 + 一行说明）。
  /// 区间 50~100，默认 50（很快）；空档期的弹幕回复沿用同档语速。
  Widget _buildSpeechRateSection(bool saving) {
    return Column(
      key: const Key('liveSpeechRateSection'),
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        Row(
          children: <Widget>[
            const Icon(Icons.speed_rounded, size: 18),
            const SizedBox(width: 6),
            const Text(
              '口播语速',
              style: TextStyle(fontSize: 14, fontWeight: FontWeight.bold),
            ),
            const Spacer(),
            Text(
              '$_speechRate',
              key: const Key('liveSpeechRateValue'),
              style: TextStyle(fontSize: 13, color: context.tokenTextBody),
            ),
          ],
        ),
        Slider(
          key: const Key('liveSpeechRateSlider'),
          min: _minSpeechRate.toDouble(),
          max: _maxSpeechRate.toDouble(),
          divisions: _maxSpeechRate - _minSpeechRate,
          value: _speechRate.toDouble(),
          label: '$_speechRate',
          onChanged: saving
              ? null
              : (value) => setState(() => _speechRate = value.round()),
        ),
        Text(
          '数值越大口播越快，默认 50（很快）；弹幕回复同速。',
          style: TextStyle(fontSize: 12, color: context.tokenTextBody),
        ),
      ],
    );
  }

  /// 话术选择：弹底部面板，仅 status=ready 的话术可选中。
  Widget _buildScriptPicker(LiveFormState state, Script? script) {
    final value = script == null
        ? (_scriptId == null ? '未选择' : _scriptId!)
        : script.displayTitle;
    return ListTile(
      key: const Key('liveScriptSelector'),
      contentPadding: EdgeInsets.zero,
      leading: const Icon(Icons.notes_rounded),
      title: const Text('绑定话术'),
      subtitle: Text(
        value,
        key: const Key('liveScriptValue'),
        style: TextStyle(fontSize: 13, color: context.tokenTextBody),
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
      ),
      trailing: const Icon(Icons.chevron_right),
      onTap: state.saving ? null : () => _pickScript(state),
    );
  }

  /// 循环台词区块（M3 §7.2，位于「绑定话术」下方）：未绑 → 副文案 +
  /// 「去新建/去生成」；已绑 → 标题 + 条数摘要 + 换绑/解绑。允许不绑保存
  /// （仅弹幕回复模式）；绑定值随保存写入 loopScriptId。
  Widget _buildLoopScriptSection(bool saving) {
    return Container(
      key: const Key('liveLoopScriptSection'),
      width: double.infinity,
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: context.tokenSurfaceFill,
        border: Border.all(color: context.tokenDivider),
        borderRadius: BorderRadius.circular(8),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          const Row(
            children: <Widget>[
              Icon(Icons.playlist_play_rounded, size: 18),
              SizedBox(width: 6),
              Text(
                '循环台词',
                style: TextStyle(fontSize: 14, fontWeight: FontWeight.bold),
              ),
            ],
          ),
          const SizedBox(height: 4),
          Text(
            '绑定一条循环台本后，开播会按节奏循环口播商品与团购券；'
            '不绑定则本场仅弹幕回复。',
            style: TextStyle(fontSize: 12, color: context.tokenTextBody),
          ),
          const SizedBox(height: 8),
          if (_loopScriptId == null)
            _buildLoopScriptEmptyRow(saving)
          else
            _buildLoopScriptBoundRow(saving),
        ],
      ),
    );
  }

  /// 未绑台本：副文案 + 「去新建/去生成」（跳台本库选择模式，可先新建再点选）。
  Widget _buildLoopScriptEmptyRow(bool saving) {
    return Row(
      children: <Widget>[
        Expanded(
          child: Text(
            '循环口播需绑定一条循环台本',
            key: Key('liveLoopScriptEmptyText'),
            style: TextStyle(fontSize: 13, color: context.tokenTextBody),
          ),
        ),
        OutlinedButton.icon(
          key: const Key('liveLoopScriptBindButton'),
          onPressed: saving ? null : _openLoopScriptLibrary,
          icon: const Icon(Icons.add, size: 18),
          label: const Text('去新建/去生成'),
        ),
      ],
    );
  }

  /// 已绑台本：标题 + 条数摘要 + 换绑/解绑；摘要同步失败时降级显示 id 并可重试。
  Widget _buildLoopScriptBoundRow(bool saving) {
    return Row(
      key: const Key('liveLoopScriptBoundRow'),
      children: <Widget>[
        Expanded(
          child: _loopSummarySyncing
              ? const SizedBox(
                  key: Key('liveLoopScriptSyncing'),
                  width: 20,
                  height: 20,
                  child: CircularProgressIndicator(strokeWidth: 2),
                )
              : Text(
                  _loopSummaryLabel(),
                  key: const Key('liveLoopScriptValue'),
                  style: TextStyle(fontSize: 13, color: context.tokenTextBody),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
        ),
        if (!_loopSummarySyncing && _loopScriptSummary == null)
          TextButton(
            key: const Key('liveLoopScriptRetryButton'),
            onPressed: saving ? null : _refreshLoopSummary,
            child: const Text('重试'),
          ),
        TextButton(
          key: const Key('liveLoopScriptChangeButton'),
          onPressed: saving ? null : _openLoopScriptLibrary,
          child: const Text('换绑'),
        ),
        TextButton(
          key: const Key('liveLoopScriptUnbindButton'),
          onPressed: saving ? null : _unbindLoopScript,
          child: const Text('解绑'),
        ),
      ],
    );
  }

  /// 已绑台本的摘要文案：标题 + 条数；同步失败降级为 id（可点「重试」）。
  String _loopSummaryLabel() {
    final summary = _loopScriptSummary;
    if (summary != null) {
      final title = summary.hasEmptyTitle ? '（未命名台本）' : summary.title;
      return '$title · ${summary.itemCount} 条';
    }
    final id = _loopScriptId;
    return id == null ? '' : '台本 $id（摘要同步失败，可重试）';
  }

  /// 团购券选择：直接进入 /coupons?select=1，点选后 pop 回券 id。
  Widget _buildCouponPicker(LiveFormState state, Coupon? coupon) {
    final value = coupon == null
        ? (_couponId == null ? '未选择' : _couponId!)
        : coupon.name;
    return ListTile(
      key: const Key('liveCouponSelector'),
      contentPadding: EdgeInsets.zero,
      leading: const Icon(Icons.confirmation_number_outlined),
      title: const Text('绑定团购券'),
      subtitle: Text(
        value,
        key: const Key('liveCouponValue'),
        style: TextStyle(fontSize: 13, color: context.tokenTextBody),
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
      ),
      trailing: const Icon(Icons.chevron_right),
      onTap: state.saving ? null : _pickCoupon,
    );
  }

  /// 开播准备区：纯 AI 语音模式主入口（无需实景视频）。绑定可用音色后点
  /// 「纯 AI 就绪开播」，由服务端完成敏感词 / 音色前置校验后就绪；就绪后进入工作台开播。
  Widget _buildReadySection(LiveFormState state) {
    final busy = _preparing;
    // 仅编辑模式且初始为草稿（idle）可操作；就绪 / 直播中等由服务端保护
    final canOperate = _isEdit && !busy && (state.initial?.isEditable ?? false);
    final voice = _selectedVoice(state);
    final preset = _selectedPreset(state);
    final cloneVoiceReady = voice?.isReady ?? false;
    final hasVoiceChoice = preset != null || cloneVoiceReady;
    final canPrepare = canOperate && !_composed && hasVoiceChoice;
    final String statusLabel;
    if (_composed) {
      statusLabel = '已就绪，可进入工作台开播';
    } else if (hasVoiceChoice) {
      statusLabel = '已绑定音色，可直接就绪开播';
    } else {
      statusLabel = '尚未绑定可用音色，先在上方选择后即可就绪';
    }
    // 状态为积极（已就绪）时以绿色对勾呈现，避免看起来像报错
    final statusReady = _composed;
    return Container(
      key: const Key('liveReadySection'),
      width: double.infinity,
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: context.tokenSurfaceFill,
        border: Border.all(color: context.tokenDivider),
        borderRadius: BorderRadius.circular(8),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Row(
            children: [
              Icon(Icons.play_circle_outline, size: 18),
              SizedBox(width: 6),
              Text(
                '开播准备',
                style: TextStyle(fontSize: 14, fontWeight: FontWeight.bold),
              ),
            ],
          ),
          const SizedBox(height: 4),
          Text(
            '纯 AI 语音模式无需实景视频：绑定可用音色后点下方按钮完成敏感词 / 音色预检并就绪，'
            '就绪后进入工作台即可开始直播。',
            style: TextStyle(fontSize: 12, color: context.tokenTextBody),
          ),
          if (!_isEdit) ...[
            const SizedBox(height: 8),
            Text(
              '新建草稿先保存，再从列表进入编辑后绑定可用音色即可就绪开播。',
              key: const Key('liveReadyNewModeHint'),
              style: TextStyle(fontSize: 12, color: context.tokenTextBody),
            ),
          ],
          const SizedBox(height: 10),
          if (busy)
            _buildPrepareBusyHint()
          else ...[
            Row(
              children: [
                Icon(
                  statusReady ? Icons.check_circle_outline : Icons.info_outline,
                  size: 16,
                  color: statusReady ? AppColors.live : context.tokenTextHint,
                ),
                const SizedBox(width: 6),
                Expanded(
                  child: Text(
                    statusLabel,
                    key: const Key('liveReadyStatusText'),
                    style: TextStyle(
                      fontSize: 12,
                      color: statusReady ? AppColors.live : context.tokenTextBody,
                    ),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 12),
            SizedBox(
              width: double.infinity,
              child: FilledButton(
                key: const Key('livePrepareButton'),
                onPressed: canPrepare ? _prepareLive : null,
                style: FilledButton.styleFrom(
                  minimumSize: const Size.fromHeight(44),
                ),
                child: const Text('纯 AI 就绪开播'),
              ),
            ),
            if (_isEdit && !canOperate && !_composed)
              Padding(
                padding: const EdgeInsets.only(top: 8),
                child: Text(
                  '仅草稿状态可操作（就绪 / 直播中等不可重复就绪）',
                  style: TextStyle(fontSize: 12, color: context.tokenTextHint),
                ),
              ),
          ],
        ],
      ),
    );
  }

  /// 就绪开播进行中的进度提示。
  Widget _buildPrepareBusyHint() {
    return Row(
      children: [
        const SizedBox(
          width: 16,
          height: 16,
          child: CircularProgressIndicator(strokeWidth: 2),
        ),
        const SizedBox(width: 10),
        Expanded(
          child: Text(
            '正在就绪开播…',
            key: const Key('livePrepareBusyText'),
            style: TextStyle(fontSize: 13, color: context.tokenTextBody),
          ),
        ),
      ],
    );
  }

  /// 合规提示：角标由服务端强制叠加，不可关闭、客户端无开关入口。
  Widget _buildComplianceNote() {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
      decoration: BoxDecoration(
        color: AppColors.warningSoft,
        borderRadius: BorderRadius.circular(8),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Icon(
            Icons.gpp_good_outlined,
            size: 16,
            color: AppColors.warning,
          ),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              '合规说明：直播画面将强制叠加「AI 智能直播」角标，'
              '由服务端统一控制（aiBadgeShown 恒为 true），无法关闭。',
              style: TextStyle(fontSize: 12, color: AppColors.warning),
            ),
          ),
        ],
      ),
    );
  }

  /// 当前选中的音色对象；已被删除等失效情况返回 null（摘要退化为 id）。
  Voice? _selectedVoice(LiveFormState state) {
    final id = _voiceId;
    if (id == null) {
      return null;
    }
    for (final voice in state.voices) {
      if (voice.id == id) {
        return voice;
      }
    }
    return null;
  }

  /// 当前选中的火山预设音色对象；失效等异常情况返回 null（摘要退化为 id）。
  VolcPresetVoice? _selectedPreset(LiveFormState state) {
    final id = _volcPresetId;
    if (id == null) {
      return null;
    }
    for (final preset in state.presets) {
      if (preset.id == id) {
        return preset;
      }
    }
    return null;
  }

  /// 当前选中的话术对象；已被删除等失效情况返回 null（摘要退化为 id）。
  Script? _selectedScript(LiveFormState state) {
    final id = _scriptId;
    if (id == null) {
      return null;
    }
    for (final script in state.scripts) {
      if (script.id == id) {
        return script;
      }
    }
    return null;
  }

  /// 当前选中的团购券对象；已被删除等失效情况返回 null（摘要退化为券 id）。
  Coupon? _selectedCoupon(LiveFormState state) {
    final id = _couponId;
    if (id == null) {
      return null;
    }
    for (final coupon in state.coupons) {
      if (coupon.couponId == id) {
        return coupon;
      }
    }
    return null;
  }

  Future<void> _pickVoice(LiveFormState state) async {
    final result = await showModalBottomSheet<({String kind, String id})>(
      context: context,
      isScrollControlled: true,
      builder: (sheetContext) {
        return SafeArea(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Padding(
                padding: EdgeInsets.fromLTRB(16, 16, 16, 0),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      '选择音色',
                      style:
                          TextStyle(fontSize: 16, fontWeight: FontWeight.bold),
                    ),
                    SizedBox(height: 4),
                    Text(
                      '我的克隆音色需「可用」才可选（真实复刻待接入，开播暂用演示音色）；'
                      '火山预设音色全可选，推荐音色已置顶',
                      style: TextStyle(fontSize: 12),
                    ),
                  ],
                ),
              ),
              Flexible(
                child: ListView(
                  shrinkWrap: true,
                  children: [
                    ListTile(
                      key: const Key('liveVoiceClearOption'),
                      leading: const Icon(Icons.block),
                      title: const Text('不绑定音色'),
                      onTap: () => Navigator.of(sheetContext)
                          .pop((kind: 'clone', id: '')),
                    ),
                    if (state.voices.isNotEmpty) ...[
                      _buildSheetGroupHeader('我的音色（克隆）'),
                      for (final voice in state.voices)
                        _buildVoiceSheetItem(sheetContext, voice),
                    ],
                    if (state.presets.isNotEmpty) ...[
                      _buildSheetGroupHeader('火山预设音色'),
                      for (final group in _presetGroups(state)) ...[
                        // 旧服务端未下发分组时只有一组，省掉多余的分组标题
                        if (state.presetGroups.isNotEmpty)
                          _buildSheetSubHeader(group.label),
                        for (final preset in group.voices)
                          _buildPresetSheetItem(sheetContext, preset),
                      ],
                    ],
                  ],
                ),
              ),
            ],
          ),
        );
      },
    );
    if (result == null || !mounted) {
      return;
    }
    setState(() {
      _voiceTouched = true;
      final id = result.id;
      if (id.isEmpty) {
        _voiceId = null;
        _volcPresetId = null;
      } else if (result.kind == 'preset') {
        _volcPresetId = id;
        _voiceId = null;
      } else {
        _voiceId = id;
        _volcPresetId = null;
      }
    });
  }

  Widget _buildVoiceSheetItem(BuildContext sheetContext, Voice voice) {
    final style = _voiceStatusStyle(voice.status);
    final enabled = voice.isReady;
    return ListTile(
      key: Key('liveVoiceOption_${voice.id}'),
      enabled: enabled,
      title: Text(voice.name),
      subtitle: Text(
        '${style.label} · 时长 ${(voice.sampleDurationSeconds / 60).floor()} 分'
        '${enabled ? ' · 复刻待接入（开播暂用演示音色）' : ''}',
        style: TextStyle(fontSize: 12, color: context.tokenTextBody),
      ),
      trailing: enabled && _volcPresetId == null && voice.id == _voiceId
          ? Icon(Icons.check, color: AppColors.live)
          : null,
      onTap: enabled
          ? () => Navigator.of(sheetContext)
              .pop((kind: 'clone', id: voice.id))
          : null,
    );
  }

  /// 底部面板分组标题。
  Widget _buildSheetGroupHeader(String title) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 10, 16, 4),
      child: Align(
        alignment: Alignment.centerLeft,
        child: Text(
          title,
          style: TextStyle(
            fontSize: 12,
            fontWeight: FontWeight.w600,
            color: context.tokenTextHint,
          ),
        ),
      ),
    );
  }

  /// 预设音色的二级分组标题（带货口播 / 讲解解说 / 客服营销）。
  Widget _buildSheetSubHeader(String title) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 8, 16, 2),
      child: Text(
        title,
        style: TextStyle(fontSize: 11, color: context.tokenTextHint),
      ),
    );
  }

  /// 预设音色按服务端分组顺序整理（推荐置顶；旧服务端未下发分组时退化为单组）。
  List<PresetVoiceGroup> _presetGroups(LiveFormState state) {
    return groupVolcPresets(state.presets, state.presetGroups);
  }

  /// 火山预设音色条目：全可选，选中后与克隆音色互斥；推荐音色带「推荐」标。
  Widget _buildPresetSheetItem(
      BuildContext sheetContext, VolcPresetVoice preset) {
    return ListTile(
      key: Key('livePresetOption_${preset.id}'),
      title: Row(
        children: <Widget>[
          Flexible(
            child: Text(preset.name, overflow: TextOverflow.ellipsis),
          ),
          if (preset.recommended) ...[
            const SizedBox(width: 6),
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
              decoration: BoxDecoration(
                color: AppColors.live.withValues(alpha: 0.12),
                borderRadius: BorderRadius.circular(999),
              ),
              child: Text(
                '推荐',
                key: Key('livePresetRecommended_${preset.id}'),
                style: TextStyle(fontSize: 11, color: AppColors.live),
              ),
            ),
          ],
        ],
      ),
      subtitle: Text(
        '${preset.isFemale ? '女声' : '男声'} · 火山预设音色',
        style: TextStyle(fontSize: 12, color: context.tokenTextBody),
      ),
      trailing: preset.id == _volcPresetId
          ? Icon(Icons.check, color: AppColors.live)
          : null,
      onTap: () => Navigator.of(sheetContext)
          .pop((kind: 'preset', id: preset.id)),
    );
  }

  Future<void> _pickScript(LiveFormState state) async {
    final result = await showModalBottomSheet<String>(
      context: context,
      isScrollControlled: true,
      builder: (sheetContext) {
        return SafeArea(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Padding(
                padding: EdgeInsets.all(16),
                child: Text(
                  '选择话术（仅「可开播」话术可选）',
                  style: TextStyle(fontSize: 16, fontWeight: FontWeight.bold),
                ),
              ),
              Flexible(
                child: ListView(
                  shrinkWrap: true,
                  children: [
                    ListTile(
                      key: const Key('liveScriptClearOption'),
                      leading: const Icon(Icons.block),
                      title: const Text('不绑定话术'),
                      onTap: () => Navigator.of(sheetContext).pop(''),
                    ),
                    for (final script in state.scripts)
                      _buildScriptSheetItem(sheetContext, script),
                  ],
                ),
              ),
            ],
          ),
        );
      },
    );
    if (result == null || !mounted) {
      return;
    }
    setState(() {
      _scriptId = result.isEmpty ? null : result;
    });
  }

  Widget _buildScriptSheetItem(BuildContext sheetContext, Script script) {
    final enabled = script.isReady;
    return ListTile(
      key: Key('liveScriptOption_${script.id}'),
      enabled: enabled,
      title: Text(
        script.displayTitle,
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
      ),
      subtitle: Text(
        '${_industryLabel(script.industry)} · ${_scriptPreview(script)}',
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
        style: TextStyle(fontSize: 12, color: context.tokenTextBody),
      ),
      trailing: enabled && script.id == _scriptId
          ? Icon(Icons.check, color: AppColors.live)
          : null,
      onTap: enabled ? () => Navigator.of(sheetContext).pop(script.id) : null,
    );
  }

  /// 选券：push /coupons?select=1，CouponListPage 点选卡片后 pop 返回券 id。
  Future<void> _pickCoupon() async {
    final picked = await context.push<String>('/coupons?select=1');
    if (!mounted || picked == null || picked.isEmpty) {
      return;
    }
    setState(() {
      _couponId = picked;
    });
  }
}

/// 音色状态徽章（与音色库页一致）：pending 克隆中 / processing 处理中 /
/// ready 可用 / failed 失败。
({String label, Color color}) _voiceStatusStyle(String status) {
  switch (status) {
    case 'pending':
      return (label: '克隆中', color: AppColors.warning);
    case 'processing':
      return (label: '处理中', color: AppColors.info);
    case 'ready':
      return (label: '可用', color: AppColors.live);
    case 'failed':
      return (label: '失败', color: AppColors.danger);
    default:
      return (label: status, color: AppColors.warning);
  }
}

/// 行业 code → 中文展示名。
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

/// 话术摘要：取正文首句，超长截断。
String _scriptPreview(Script script) {
  final text = script.content.trim().replaceAll('\n', ' ');
  if (text.isEmpty) {
    return '（无正文）';
  }
  final first = text.split('。').first.trim();
  if (first.length <= 30) {
    return first;
  }
  return '${first.substring(0, 30)}…';
}
