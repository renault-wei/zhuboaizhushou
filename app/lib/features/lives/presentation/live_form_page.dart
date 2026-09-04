/// 开播配置表单页：/lives/new（新建）与 /lives/:id（编辑）共用同一页面。
/// 商家绑定：音色（来自我的音色，仅 ready 可选）+ 话术（仅 ready 可选）+
/// 团购券（push /coupons 点选后 pop 回券 id）+ 直播标题。
/// T11 点亮实景视频区：上传实景视频（MVP 简化为本机 mp4 路径输入）+「生成直播视频」合成，
/// 产物为本地文件、不推流（推流 T12）；新建草稿先保存、再从列表进入编辑后操作。
/// 「AI 智能直播」角标由服务端强制叠加为 true，本页面没有任何关闭入口。
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import 'package:starvoice_app/core/models/coupon.dart';
import 'package:starvoice_app/core/models/live.dart';
import 'package:starvoice_app/core/models/script.dart';
import 'package:starvoice_app/core/models/voice.dart';
import 'package:starvoice_app/core/network/api_exception.dart';
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
  late final TextEditingController _videoPathController;

  /// 已选择的绑定项：null 表示未绑定（提交时置空对应字段）。
  String? _voiceId;
  String? _scriptId;
  String? _couponId;

  /// 服务端回填的实景视频源：上传 → /uploads/videos/...，合成成功 → /uploads/lives/...
  String _videoSourceUrl = '';

  /// 是否已在本页完成合成（成功后禁用重复生成）
  bool _composed = false;

  /// 是否正在上传视频
  bool _videoUploading = false;

  /// 是否正在生成直播视频
  bool _preparing = false;

  /// 编辑模式初值是否已回填到本地（避免 controller 重建覆盖用户输入）。
  bool _hydrated = false;

  bool get _isEdit => widget.liveId.isNotEmpty;

  @override
  void initState() {
    super.initState();
    _titleController = TextEditingController()..addListener(_onTitleChanged);
    _videoPathController = TextEditingController()
      ..addListener(_onVideoPathChanged);
    // 首帧后再加载可选项与初值，避免在 build 阶段发起网络请求
    WidgetsBinding.instance.addPostFrameCallback((_) {
      ref.read(liveFormControllerProvider(widget.liveId).notifier).load();
    });
  }

  @override
  void dispose() {
    _titleController.dispose();
    _videoPathController.dispose();
    super.dispose();
  }

  /// 标题变化时刷新底部保存按钮的可用态。
  void _onTitleChanged() {
    if (mounted) {
      setState(() {});
    }
  }

  /// 视频路径变化时刷新「上传实景视频」按钮可用态。
  void _onVideoPathChanged() {
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
      _voiceId = initial.voiceId;
      _scriptId = initial.scriptId;
      _couponId = initial.couponId;
      _videoSourceUrl = initial.videoSourceUrl;
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
            voiceId: _voiceId,
            scriptId: _scriptId,
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

  /// 上传实景视频：真实调用 /api/lives/:id/video（multipart），成功后回填视频源。
  Future<void> _uploadVideo() async {
    final path = _videoPathController.text.trim();
    if (path.isEmpty) {
      _showSnack('请先填写本机 mp4 文件路径');
      return;
    }
    setState(() {
      _videoUploading = true;
    });
    try {
      final live = await ref
          .read(apiClientProvider)
          .uploadLiveVideo(widget.liveId, path);
      if (!mounted) {
        return;
      }
      setState(() {
        _videoSourceUrl = live.videoSourceUrl;
        _composed = false;
      });
      _showSnack('实景视频已上传，可点击「生成直播视频」');
    } on ApiException catch (error) {
      if (mounted) {
        _showSnack('视频上传失败：${error.message}');
      }
    } finally {
      if (mounted) {
        setState(() {
          _videoUploading = false;
        });
      }
    }
  }

  /// 生成直播视频：真实调用 /api/lives/:id/prepare（FFmpeg 合成），
  /// 成功后提示可开播（T12）。T11 不推流，只产出本地合成文件。
  Future<void> _prepareLive() async {
    setState(() {
      _preparing = true;
    });
    try {
      final live = await ref
          .read(apiClientProvider)
          .prepareLive(widget.liveId);
      if (!mounted) {
        return;
      }
      setState(() {
        _videoSourceUrl = live.videoSourceUrl;
        _composed = true;
      });
      _showSnack('已生成，可开播（T12）');
    } on ApiException catch (error) {
      if (mounted) {
        _showSnack('生成失败：${error.message}');
      }
    } finally {
      if (mounted) {
        setState(() {
          _preparing = false;
        });
      }
    }
  }

  /// 从 URL 或本机路径里取文件名段（Windows 与 POSIX 分隔符都兼容）。
  String _videoFileName(String source) {
    final segment = source.split(RegExp(r'[\\/]')).last;
    return segment.isEmpty ? source : segment;
  }

  @override
  Widget build(BuildContext context) {
    final state = ref.watch(liveFormControllerProvider(widget.liveId));
    // 初值到达后延迟一帧回填，避免在 build 阶段修改 TextEditingController
    // 编辑模式须等 initial 到位后再回填；首帧（数据未加载）与新建模式（initial 恒空）都跳过
    if (!_hydrated && state.initial != null && !state.loading && state.loadError == null) {
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
          '绑定素材：音色来自「我的音色」，话术来自话术库，团购券来自已绑定的抖音号。',
          style: TextStyle(fontSize: 12, color: Colors.grey.shade600),
        ),
        const SizedBox(height: 12),
        _buildVoicePicker(state, voice),
        const SizedBox(height: 12),
        _buildScriptPicker(state, script),
        const SizedBox(height: 12),
        _buildCouponPicker(state, coupon),
        const SizedBox(height: 12),
        _buildVideoSources(state),
        const SizedBox(height: 12),
        _buildComplianceNote(),
        const SizedBox(height: 20),
        FilledButton(
          key: const Key('liveSaveButton'),
          onPressed: canSave ? _save : null,
          style: FilledButton.styleFrom(
            minimumSize: const Size.fromHeight(48),
          ),
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
    final value = voice?.name ?? (_voiceId == null ? '未选择' : _voiceId!);
    return ListTile(
      key: const Key('liveVoiceSelector'),
      contentPadding: EdgeInsets.zero,
      leading: const Icon(Icons.record_voice_over_outlined),
      title: const Text('绑定音色'),
      subtitle: Text(
        value,
        key: const Key('liveVoiceValue'),
        style: TextStyle(fontSize: 13, color: Colors.grey.shade700),
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
      ),
      trailing: const Icon(Icons.chevron_right),
      onTap: state.saving ? null : () => _pickVoice(state),
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
        style: TextStyle(fontSize: 13, color: Colors.grey.shade700),
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
      ),
      trailing: const Icon(Icons.chevron_right),
      onTap: state.saving ? null : () => _pickScript(state),
    );
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
        style: TextStyle(fontSize: 13, color: Colors.grey.shade700),
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
      ),
      trailing: const Icon(Icons.chevron_right),
      onTap: state.saving ? null : _pickCoupon,
    );
  }

  /// 实景视频区（T11 点亮）：本机 mp4 路径输入 + 上传实景视频 + 「生成直播视频」合成。
  /// 新建草稿还没有 liveId，先保存、再从列表进入编辑后操作；
  /// prepare 由服务端做前置校验（视频 / 话术敏感词 / 音色）后同步合成，
  /// 产物为本地合成文件：T11 不推流、不接 RTMP。
  Widget _buildVideoSources(LiveFormState state) {
    final busy = _videoUploading || _preparing;
    // 仅编辑模式且初始为草稿（idle）可操作；合成中/就绪等由服务端保护
    final canOperate = _isEdit && !busy && (state.initial?.isEditable ?? false);
    final hasSource = _videoSourceUrl.isNotEmpty;
    final canUpload =
        canOperate && _videoPathController.text.trim().isNotEmpty;
    final canPrepare = canOperate && hasSource && !_composed;
    final sourceLabel = _composed
        ? '已生成：${_videoFileName(_videoSourceUrl)}'
        : (hasSource
            ? '已上传：${_videoFileName(_videoSourceUrl)}'
            : '尚未上传实景视频');
    return Container(
      key: const Key('liveVideoSection'),
      width: double.infinity,
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: Colors.indigo.withValues(alpha: 0.04),
        border: Border.all(color: Colors.indigo.shade100),
        borderRadius: BorderRadius.circular(8),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Row(
            children: [
              Icon(Icons.videocam_outlined, size: 18),
              SizedBox(width: 6),
              Text(
                '实景视频',
                style: TextStyle(fontSize: 14, fontWeight: FontWeight.bold),
              ),
            ],
          ),
          const SizedBox(height: 4),
          Text(
            '上传本机实景视频，再生成直播视频（循环播放 + 音轨 + 角标合成到本地文件）。',
            style: TextStyle(fontSize: 12, color: Colors.grey.shade600),
          ),
          if (!_isEdit) ...[
            const SizedBox(height: 8),
            Text(
              '新建草稿先保存，再从列表进入编辑后上传实景视频并生成',
              key: const Key('liveVideoNewModeHint'),
              style: TextStyle(fontSize: 12, color: Colors.grey.shade600),
            ),
          ],
          const SizedBox(height: 10),
          if (busy)
            _buildVideoBusyHint()
          else ...[
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Expanded(
                  child: TextField(
                    key: const Key('liveVideoPathField'),
                    controller: _videoPathController,
                    enabled: canOperate,
                    decoration: const InputDecoration(
                      labelText: '实景视频本机路径',
                      hintText: r'D:\videos\scene.mp4',
                      border: OutlineInputBorder(),
                      isDense: true,
                    ),
                  ),
                ),
                const SizedBox(width: 8),
                FilledButton.tonal(
                  key: const Key('liveVideoUploadButton'),
                  onPressed: canUpload ? _uploadVideo : null,
                  child: const Text('上传实景视频'),
                ),
              ],
            ),
            const SizedBox(height: 8),
            Row(
              children: [
                Icon(
                  hasSource
                      ? Icons.check_circle_outline
                      : Icons.info_outline,
                  size: 16,
                  color:
                      hasSource ? Colors.green.shade600 : Colors.grey.shade500,
                ),
                const SizedBox(width: 6),
                Expanded(
                  child: Text(
                    sourceLabel,
                    key: const Key('liveVideoSourceText'),
                    style: TextStyle(
                      fontSize: 12,
                      color:
                          hasSource ? Colors.green.shade700 : Colors.grey.shade600,
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
                child: const Text('生成直播视频'),
              ),
            ),
            if (_isEdit && !canOperate)
              const Padding(
                padding: EdgeInsets.only(top: 8),
                child: Text(
                  '仅草稿状态可操作（合成中 / 就绪等不可重复生成）',
                  style: TextStyle(fontSize: 12, color: Colors.grey),
                ),
              ),
          ],
        ],
      ),
    );
  }

  /// 上传 / 合成进行中的进度提示。
  Widget _buildVideoBusyHint() {
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
            _videoUploading ? '正在上传实景视频…' : '正在合成直播视频…',
            key: const Key('liveVideoBusyText'),
            style: TextStyle(fontSize: 13, color: Colors.grey.shade700),
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
        color: Colors.amber.withValues(alpha: 0.12),
        borderRadius: BorderRadius.circular(8),
      ),
      child: const Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(Icons.gpp_good_outlined, size: 16, color: Colors.orange),
          SizedBox(width: 8),
          Expanded(
            child: Text(
              '合规说明：直播画面将强制叠加「AI 智能直播」角标，'
              '由服务端统一控制（aiBadgeShown 恒为 true），无法关闭。',
              style: TextStyle(fontSize: 12, color: Colors.orange),
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
                  '选择音色（仅「可用」音色可选）',
                  style: TextStyle(fontSize: 16, fontWeight: FontWeight.bold),
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
                      onTap: () => Navigator.of(sheetContext).pop(''),
                    ),
                    for (final voice in state.voices)
                      _buildVoiceSheetItem(sheetContext, voice),
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
      _voiceId = result.isEmpty ? null : result;
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
        '${style.label} · 时长 ${(voice.sampleDurationSeconds / 60).floor()} 分',
        style: TextStyle(fontSize: 12, color: Colors.grey.shade600),
      ),
      trailing: enabled && voice.id == _voiceId
          ? const Icon(Icons.check, color: Colors.green)
          : null,
      onTap: enabled
          ? () => Navigator.of(sheetContext).pop(voice.id)
          : null,
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
        style: TextStyle(fontSize: 12, color: Colors.grey.shade600),
      ),
      trailing: enabled && script.id == _scriptId
          ? const Icon(Icons.check, color: Colors.green)
          : null,
      onTap: enabled
          ? () => Navigator.of(sheetContext).pop(script.id)
          : null,
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
      return (label: '克隆中', color: Colors.grey);
    case 'processing':
      return (label: '处理中', color: Colors.blue);
    case 'ready':
      return (label: '可用', color: Colors.green.shade700);
    case 'failed':
      return (label: '失败', color: Colors.red);
    default:
      return (label: status, color: Colors.grey);
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
