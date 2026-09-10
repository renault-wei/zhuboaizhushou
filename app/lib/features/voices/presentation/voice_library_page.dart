import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import 'package:starvoice_app/core/models/voice.dart';
import 'package:starvoice_app/core/network/api_exception.dart';
import 'package:starvoice_app/core/theme/app_colors.dart';
import 'package:starvoice_app/core/theme/theme_tokens.dart';
import 'package:starvoice_app/features/recording/application/recorder_controller.dart';
import 'package:starvoice_app/features/voices/application/voice_library_controller.dart';
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

/// 音色库页（路由 /voices）：我的音色列表 + 克隆进度轮询 + 试听占位 + 删除。
class VoiceLibraryPage extends ConsumerStatefulWidget {
  const VoiceLibraryPage({super.key});

  @override
  ConsumerState<VoiceLibraryPage> createState() => _VoiceLibraryPageState();
}

class _VoiceLibraryPageState extends ConsumerState<VoiceLibraryPage> {
  /// 正在试听的音色 id（null = 空闲）：试听期间禁用其他试听按钮防重复合成。
  String? _previewingVoiceId;

  @override
  void initState() {
    super.initState();
    // 首帧后再拉取列表，避免 build 阶段发起网络请求；load 内部会自动启动轮询
    WidgetsBinding.instance.addPostFrameCallback((_) {
      ref.read(voiceLibraryControllerProvider.notifier).load();
    });
  }

  Future<void> _reload() async {
    await ref.read(voiceLibraryControllerProvider.notifier).load();
  }

  void _showSnack(String message) {
    if (!mounted) {
      return;
    }
    ScaffoldMessenger.of(context)
      ..clearSnackBars()
      ..showSnackBar(SnackBar(content: Text(message)));
  }

  /// 试听（档 A）：调服务端真实合成接口取 wav 字节，再用本机播放器播出。
  /// 克隆音色尚未接入真实复刻，服务端会回落演示预设音色并回告知头，这里如实提示。
  Future<void> _preview(Voice voice) async {
    if (_previewingVoiceId != null) {
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

  @override
  Widget build(BuildContext context) {
    final state = ref.watch(voiceLibraryControllerProvider);
    return Scaffold(
      key: const Key('voiceLibraryPage'),
      appBar: AppBar(
        title: const Text('我的音色'),
        actions: [
          IconButton(
            key: const Key('voiceLibraryRefreshButton'),
            onPressed: state.loading ? null : _reload,
            icon: const Icon(Icons.refresh),
            tooltip: '刷新',
          ),
        ],
      ),
      body: _buildBody(state),
    );
  }

  Widget _buildBody(VoiceLibraryState state) {
    if (state.loading && state.voices.isEmpty) {
      return const Center(
        child: CircularProgressIndicator(key: Key('voiceLibraryLoading')),
      );
    }
    if (state.error != null && state.voices.isEmpty) {
      return _buildErrorState();
    }
    if (state.voices.isEmpty) {
      return _buildEmptyState();
    }
    return RefreshIndicator(
      onRefresh: _reload,
      child: ListView.separated(
        physics: const AlwaysScrollableScrollPhysics(),
        padding: const EdgeInsets.all(16),
        itemCount: state.voices.length,
        separatorBuilder: (context, index) => const SizedBox(height: 12),
        itemBuilder: (context, index) {
          final voice = state.voices[index];
          return _VoiceCard(
            voice: voice,
            previewing: _previewingVoiceId == voice.id,
            onListen: voice.isReady && _previewingVoiceId == null
                ? () => _preview(voice)
                : null,
            onDelete: () => _confirmDelete(voice),
          );
        },
      ),
    );
  }

  Widget _buildErrorState() {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(
              '音色列表加载失败：${ref.read(voiceLibraryControllerProvider).error}',
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
    );
  }

  Widget _buildEmptyState() {
    return LayoutBuilder(
      builder: (context, constraints) {
        return RefreshIndicator(
          onRefresh: _reload,
          child: ListView(
            physics: const AlwaysScrollableScrollPhysics(),
            children: [
              ConstrainedBox(
                constraints: BoxConstraints(minHeight: constraints.maxHeight),
                child: Center(
                  child: Padding(
                    padding: const EdgeInsets.all(32),
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Icon(
                          Icons.record_voice_over_outlined,
                          size: 56,
                          color: context.tokenTextHint,
                        ),
                        const SizedBox(height: 16),
                        const Text(
                          '还没有音色，去录制你的第一段声音吧',
                          key: Key('voiceLibraryEmptyText'),
                          textAlign: TextAlign.center,
                        ),
                        const SizedBox(height: 20),
                        FilledButton.tonal(
                          key: const Key('voiceLibraryGoRecordButton'),
                          onPressed: _goRecording,
                          child: const Text('去录制'),
                        ),
                      ],
                    ),
                  ),
                ),
              ),
            ],
          ),
        );
      },
    );
  }
}

/// 单个音色卡片：名称、状态徽章、时长、创建时间，ready 提供「试听」，全部提供「删除」。
class _VoiceCard extends StatelessWidget {
  const _VoiceCard({
    required this.voice,
    required this.previewing,
    required this.onListen,
    required this.onDelete,
  });

  final Voice voice;

  /// 该音色正在试听（按钮位置显示加载态）
  final bool previewing;
  final VoidCallback? onListen;
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
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
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
                    style: TextStyle(
                      fontSize: 12,
                      color: context.tokenTextBody,
                    ),
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
