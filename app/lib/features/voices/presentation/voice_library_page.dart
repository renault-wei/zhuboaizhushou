import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import 'package:starvoice_app/core/config/api_config.dart';
import 'package:starvoice_app/core/models/voice.dart';
import 'package:starvoice_app/core/models/volc_preset.dart';
import 'package:starvoice_app/core/network/api_exception.dart';
import 'package:starvoice_app/core/theme/app_colors.dart';
import 'package:starvoice_app/core/theme/theme_tokens.dart';
import 'package:starvoice_app/features/recording/application/recorder_controller.dart';
import 'package:starvoice_app/features/voices/application/voice_library_controller.dart';
import 'package:starvoice_app/features/voices/presentation/widgets/preset_voice_list.dart';
import 'package:starvoice_app/providers.dart';

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

/// 音色库页（路由 /voices）：列表模式，分「我的声音」与「预设音色」两区。
///
/// - 我的声音：商家自己的克隆音色（进度轮询 / 试听 / 删除）；本批不支持设为默认，
///   声音复刻接入后再开放（按钮置灰并说明原因）。
/// - 预设音色：火山内置音色按服务端分组折叠展示，可试听、可设为默认音色；
///   默认音色**以服务端为准**，新建开播配置时自动带入，同时写一份本地缓存供弱网回落。
class VoiceLibraryPage extends ConsumerStatefulWidget {
  const VoiceLibraryPage({super.key});

  @override
  ConsumerState<VoiceLibraryPage> createState() => _VoiceLibraryPageState();
}

class _VoiceLibraryPageState extends ConsumerState<VoiceLibraryPage> {
  /// 正在试听的克隆音色 id（null = 空闲）：试听期间禁用其他试听按钮防重复合成。
  String? _previewingVoiceId;

  /// 正在试听的预设音色 id（null = 空闲）
  String? _previewingPresetId;

  /// 正在提交的默认音色 id（null = 空闲）：提交期间禁止改选，避免连点重复请求
  String? _settingDefaultId;

  @override
  void initState() {
    super.initState();
    // 首帧后再发起网络请求，避免 build 阶段副作用；load 内部会自动启动轮询
    WidgetsBinding.instance.addPostFrameCallback((_) => _reload());
  }

  /// 同时刷新克隆音色列表与预设目录（两个接口互不阻塞，谁先到谁先展示）。
  Future<void> _reload() async {
    final controller = ref.read(voiceLibraryControllerProvider.notifier);
    await Future.wait(<Future<void>>[controller.load(), controller.loadCatalog()]);
  }

  void _showSnack(String message) {
    if (!mounted) {
      return;
    }
    ScaffoldMessenger.of(context)
      ..clearSnackBars()
      ..showSnackBar(SnackBar(content: Text(message)));
  }

  /// 试听克隆音色（档 A）：调服务端真实合成接口取 wav 字节，再用本机播放器播出。
  /// 克隆音色尚未接入真实复刻，服务端会回落演示预设音色并回告知头，这里如实提示。
  Future<void> _previewVoice(Voice voice) async {
    if (_previewingVoiceId != null || _previewingPresetId != null) {
      return;
    }
    setState(() => _previewingVoiceId = voice.id);
    try {
      final preview = await ref
          .read(apiClientProvider)
          .previewVoice(voiceId: voice.id);
      if (!mounted) {
        return;
      }
      if (preview.demoFallback) {
        _showSnack('克隆音色真实复刻待接入，当前用演示音色试听');
      }
      await ref.read(speechOutPlayerProvider).play(preview.bytes);
    } on ApiException catch (error) {
      _showSnack('试听失败：${error.message}');
    } finally {
      if (mounted) {
        setState(() => _previewingVoiceId = null);
      }
    }
  }

  /// 试听预设音色（方案 A）：优先直连服务端预生成的静态试听音频（秒开、不再走合成）；
  /// 该音色还没预生成（或静态文件取不到）时，回落真合成接口兜底（服务端同一句只真合成一次）。
  Future<void> _previewPreset(VolcPresetVoice preset) async {
    if (_previewingPresetId != null || _previewingVoiceId != null) {
      return;
    }
    setState(() => _previewingPresetId = preset.id);
    try {
      final previewUrl = preset.previewUrl;
      var staticPlayed = false;
      if (previewUrl != null && previewUrl.isNotEmpty) {
        try {
          await ref
              .read(speechOutPlayerProvider)
              .playUrl('${ApiConfig.baseUrl}$previewUrl');
          staticPlayed = true;
        } catch (_) {
          // 静态试听取不到（文件缺失 / 网络抖动）：回落真合成，不让试听变砖
          staticPlayed = false;
        }
      }
      if (staticPlayed) {
        return;
      }
      final preview = await ref
          .read(apiClientProvider)
          .previewVoice(presetId: preset.id);
      if (!mounted) {
        return;
      }
      await ref.read(speechOutPlayerProvider).play(preview.bytes);
    } on ApiException catch (error) {
      _showSnack('试听失败：${error.message}');
    } finally {
      if (mounted) {
        setState(() => _previewingPresetId = null);
      }
    }
  }

  /// 设为默认音色（服务端为准）：成功后新建开播配置会自动带入该音色。
  Future<void> _setDefaultPreset(VolcPresetVoice preset) async {
    if (_settingDefaultId != null) {
      return;
    }
    setState(() => _settingDefaultId = preset.id);
    try {
      await ref
          .read(voiceLibraryControllerProvider.notifier)
          .setDefaultPreset(preset.id);
      _showSnack('已把「${preset.name}」设为默认音色，新建开播会自动带入');
    } on ApiException catch (error) {
      _showSnack('设置失败：${error.message}');
    } finally {
      if (mounted) {
        setState(() => _settingDefaultId = null);
      }
    }
  }

  Future<void> _confirmDelete(Voice voice) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        key: const Key('voiceDeleteDialog'),
        title: const Text('删除音色'),
        content: const Text('删除后音色将不可恢复，确定删除？'),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(false),
            child: const Text('取消'),
          ),
          FilledButton(
            key: const Key('voiceDeleteConfirmButton'),
            onPressed: () => Navigator.of(dialogContext).pop(true),
            child: const Text('删除'),
          ),
        ],
      ),
    );
    if (confirmed != true || !mounted) {
      return;
    }
    try {
      await ref
          .read(voiceLibraryControllerProvider.notifier)
          .deleteVoice(voice.id);
    } on ApiException catch (error) {
      if (mounted) {
        _showSnack('删除失败：${error.message}');
      }
    }
  }

  void _goRecording() {
    context.push('/recording');
  }

  /// 克隆音色设为默认：本批未开放，置灰按钮点击给出明确原因，不做静默。
  void _explainCloneDefault() {
    _showSnack('克隆音色设为默认待声音复刻接入后开放，当前可先把预设音色设为默认');
  }

  @override
  Widget build(BuildContext context) {
    final state = ref.watch(voiceLibraryControllerProvider);
    return Scaffold(
      key: const Key('voiceLibraryPage'),
      appBar: AppBar(
        title: const Text('音色库'),
        actions: [
          IconButton(
            key: const Key('voiceLibraryRefreshButton'),
            onPressed: state.loading || state.catalogLoading ? null : _reload,
            icon: const Icon(Icons.refresh),
            tooltip: '刷新',
          ),
        ],
      ),
      body: RefreshIndicator(
        onRefresh: _reload,
        child: ListView(
          physics: const AlwaysScrollableScrollPhysics(),
          padding: const EdgeInsets.all(16),
          children: [
            _buildDefaultCard(context, state),
            _buildCloneSection(context, state),
            const SizedBox(height: 20),
            PresetVoiceSection(
              catalog: state.catalog,
              catalogLoading: state.catalogLoading,
              catalogFromCache: state.catalogFromCache,
              catalogError: state.catalogError,
              previewingId: _previewingPresetId,
              savingDefault: state.savingDefault || _settingDefaultId != null,
              onPreview: _previewPreset,
              onSetDefault: _setDefaultPreset,
              onRetry: () =>
                  ref.read(voiceLibraryControllerProvider.notifier).loadCatalog(),
            ),
            const SizedBox(height: 24),
          ],
        ),
      ),
    );
  }

  /// 顶部「默认音色」卡：展示当前生效的默认音色（服务端生效值），可试听。
  Widget _buildDefaultCard(BuildContext context, VoiceLibraryState state) {
    final catalog = state.catalog;
    final preset = _findPreset(catalog, catalog.defaultPresetId);
    if (preset == null) {
      return const SizedBox.shrink();
    }
    final isUserSet = catalog.userDefaultPresetId != null;
    return Padding(
      padding: const EdgeInsets.only(bottom: 20),
      child: Card(
        key: const Key('voiceLibraryDefaultCard'),
        margin: EdgeInsets.zero,
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Row(
                children: [
                  const Icon(Icons.auto_awesome_outlined, size: 20),
                  const SizedBox(width: 8),
                  const Text(
                    '默认音色',
                    style: TextStyle(fontSize: 16, fontWeight: FontWeight.bold),
                  ),
                  const Spacer(),
                  Text(
                    '新建开播自动带入',
                    style: TextStyle(fontSize: 12, color: context.tokenTextHint),
                  ),
                ],
              ),
              const SizedBox(height: 10),
              Row(
                children: [
                  Expanded(
                    child: Text(
                      preset.name,
                      key: const Key('voiceLibraryDefaultName'),
                      style: const TextStyle(
                        fontSize: 18,
                        fontWeight: FontWeight.w700,
                      ),
                    ),
                  ),
                  TextButton(
                    key: const Key('voiceLibraryDefaultListen'),
                    onPressed: () => _previewPreset(preset),
                    child: const Text('试听'),
                  ),
                ],
              ),
              const SizedBox(height: 4),
              Text(
                isUserSet
                    ? '已切换为你设置的默认音色，可在下方「预设音色」里随时更换'
                    : '当前为系统默认音色，可在下方「预设音色」里改成你常用的声音',
                style: TextStyle(fontSize: 12, color: context.tokenTextBody),
              ),
            ],
          ),
        ),
      ),
    );
  }

  /// 「我的声音」区：克隆音色列表（进度 / 试听 / 删除）+ 去录制入口。
  Widget _buildCloneSection(BuildContext context, VoiceLibraryState state) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Row(
          children: [
            const Icon(Icons.mic_none_outlined, size: 20),
            const SizedBox(width: 8),
            const Text(
              '我的声音',
              style: TextStyle(fontSize: 16, fontWeight: FontWeight.bold),
            ),
            const Spacer(),
            TextButton(
              key: const Key('voiceLibraryGoRecordButton'),
              onPressed: _goRecording,
              child: const Text('去录制'),
            ),
          ],
        ),
        const SizedBox(height: 4),
        ..._buildCloneBody(context, state),
      ],
    );
  }

  List<Widget> _buildCloneBody(BuildContext context, VoiceLibraryState state) {
    if (state.loading && state.voices.isEmpty) {
      return const <Widget>[
        Padding(
          padding: EdgeInsets.symmetric(vertical: 20),
          child: Center(
            child: CircularProgressIndicator(key: Key('voiceLibraryLoading')),
          ),
        ),
      ];
    }
    if (state.error != null && state.voices.isEmpty) {
      return <Widget>[
        Padding(
          padding: const EdgeInsets.symmetric(vertical: 16),
          child: Column(
            children: [
              Text(
                '音色列表加载失败：${state.error}',
                key: const Key('voiceLibraryErrorText'),
                textAlign: TextAlign.center,
              ),
              const SizedBox(height: 12),
              OutlinedButton(
                key: const Key('voiceLibraryRetryButton'),
                onPressed: _reload,
                child: const Text('重试'),
              ),
            ],
          ),
        ),
      ];
    }
    if (state.voices.isEmpty) {
      return <Widget>[
        Container(
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 18),
          decoration: BoxDecoration(
            color: context.tokenSurfaceFill,
            borderRadius: BorderRadius.circular(12),
          ),
          child: Column(
            children: [
              Icon(
                Icons.record_voice_over_outlined,
                size: 40,
                color: context.tokenTextHint,
              ),
              const SizedBox(height: 10),
              const Text(
                '还没有克隆音色，去录制你的第一段声音吧',
                key: Key('voiceLibraryEmptyText'),
                textAlign: TextAlign.center,
              ),
              const SizedBox(height: 6),
              Text(
                '不想录也能开播：直接用下面的预设音色',
                style: TextStyle(fontSize: 12, color: context.tokenTextHint),
              ),
            ],
          ),
        ),
      ];
    }
    final cards = <Widget>[];
    for (final voice in state.voices) {
      cards.add(
        Padding(
          padding: const EdgeInsets.only(top: 12),
          child: _VoiceCard(
            voice: voice,
            previewing: _previewingVoiceId == voice.id,
            onListen: voice.isReady && _previewingVoiceId == null
                ? () => _previewVoice(voice)
                : null,
            onSetDefault: _explainCloneDefault,
            onDelete: () => _confirmDelete(voice),
          ),
        ),
      );
    }
    return cards;
  }

  static VolcPresetVoice? _findPreset(VolcPresetCatalog catalog, String id) {
    if (id.isEmpty) {
      return null;
    }
    for (final preset in catalog.presets) {
      if (preset.id == id) {
        return preset;
      }
    }
    return null;
  }
}

/// 单个克隆音色卡片：名称、状态徽章、时长、创建时间；
/// ready 可「试听」，全部可「删除」；「设为默认」本批置灰（声音复刻接入后开放）。
class _VoiceCard extends StatelessWidget {
  const _VoiceCard({
    required this.voice,
    required this.previewing,
    required this.onListen,
    required this.onSetDefault,
    required this.onDelete,
  });

  final Voice voice;

  /// 该音色正在试听（按钮位置显示加载态）
  final bool previewing;
  final VoidCallback? onListen;

  /// 点击置灰的「设为默认」：给出未开放原因
  final VoidCallback onSetDefault;
  final VoidCallback onDelete;

  ({String label, Color color}) _statusStyle() {
    switch (voice.status) {
      case 'pending':
        return (label: '克隆中', color: AppColors.warning);
      case 'processing':
        return (label: '处理中', color: AppColors.info);
      case 'ready':
        return (label: '可用', color: AppColors.live);
      case 'failed':
        return (label: '失败', color: AppColors.danger);
      default:
        return (label: voice.status, color: AppColors.warning);
    }
  }

  @override
  Widget build(BuildContext context) {
    final style = _statusStyle();
    return Card(
      key: Key('voiceCard_${voice.id}'),
      margin: EdgeInsets.zero,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(16, 12, 8, 12),
        child: Row(
          children: [
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      Flexible(
                        child: Text(
                          voice.name,
                          style: const TextStyle(
                            fontSize: 16,
                            fontWeight: FontWeight.bold,
                          ),
                          overflow: TextOverflow.ellipsis,
                        ),
                      ),
                      const SizedBox(width: 8),
                      Container(
                        padding: const EdgeInsets.symmetric(
                          horizontal: 8,
                          vertical: 2,
                        ),
                        decoration: BoxDecoration(
                          color: style.color.withValues(alpha: 0.12),
                          borderRadius: BorderRadius.circular(999),
                        ),
                        child: Text(
                          style.label,
                          key: Key('voiceStatus_${voice.id}'),
                          style: TextStyle(
                            fontSize: 12,
                            color: style.color,
                            fontWeight: FontWeight.w600,
                          ),
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 6),
                  Text(
                    <String>[
                      '时长 ${formatRecordingDuration(voice.sampleDurationSeconds)}',
                      '创建于 ${_formatCreatedAt(voice.createdAt)}',
                      // 档 A 口径：声音复刻未接入，可试听但走演示音色
                      if (voice.isReady) '复刻待接入（试听为演示音色）',
                    ].join(' · '),
                    style: TextStyle(fontSize: 12, color: context.tokenTextBody),
                  ),
                ],
              ),
            ),
            if (previewing) ...[
              const Padding(
                padding: EdgeInsets.symmetric(horizontal: 12),
                child: SizedBox(
                  width: 18,
                  height: 18,
                  child: CircularProgressIndicator(
                    key: Key('voiceListenLoading'),
                    strokeWidth: 2,
                  ),
                ),
              ),
            ] else if (onListen != null) ...[
              TextButton(
                key: Key('voiceListen_${voice.id}'),
                onPressed: onListen,
                child: const Text('试听'),
              ),
            ],
            TextButton(
              key: Key('voiceSetDefault_${voice.id}'),
              onPressed: onSetDefault,
              child: Text(
                '设为默认',
                style: TextStyle(color: context.tokenTextHint),
              ),
            ),
            IconButton(
              key: Key('voiceDelete_${voice.id}'),
              onPressed: onDelete,
              icon: Icon(Icons.delete_outline, color: context.tokenTextBody),
              tooltip: '删除',
            ),
          ],
        ),
      ),
    );
  }
}
