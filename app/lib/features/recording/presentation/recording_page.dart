import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import 'package:starvoice_app/core/network/api_exception.dart';
import 'package:starvoice_app/features/recording/application/recorder_controller.dart';
import 'package:starvoice_app/features/recording/data/reading_passages.dart';
import 'package:starvoice_app/providers.dart';

/// 录音页（路由 /recording）：10 段念稿跟读采集。
/// 桌面版 Windows 可真实录音（使用电脑麦克风，record 插件原生支持，无需额外配置）。
class RecordingPage extends ConsumerStatefulWidget {
  const RecordingPage({super.key});

  @override
  ConsumerState<RecordingPage> createState() => _RecordingPageState();
}

class _RecordingPageState extends ConsumerState<RecordingPage> {
  /// 克隆命名输入框控制器：页面级持有，页面销毁时统一释放。
  final TextEditingController _cloneNameController = TextEditingController();

  @override
  void initState() {
    super.initState();
    // 首帧后恢复本地进度，避免 build 阶段触发异步持久化读取
    WidgetsBinding.instance.addPostFrameCallback((_) {
      ref.read(recorderControllerProvider.notifier).init();
    });
  }

  @override
  void dispose() {
    _cloneNameController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final controller = ref.read(recorderControllerProvider.notifier);
    final state = ref.watch(recorderControllerProvider);

    return PopScope(
      canPop: false,
      // 页面销毁（返回）时若正在录音，先自动停止并保存当前段进度
      onPopInvokedWithResult: (bool didPop, Object? result) async {
        if (didPop) {
          return;
        }
        if (ref.read(recorderControllerProvider).phase != RecorderPhase.idle) {
          await controller.saveProgressAndStop();
        }
        if (context.mounted) {
          Navigator.of(context).pop();
        }
      },
      child: Scaffold(
        key: const Key('recordingPage'),
        appBar: AppBar(title: const Text('声音克隆录音')),
        body: state.restoring
            ? const Center(
                child: CircularProgressIndicator(key: Key('recordingLoading')),
              )
            : SafeArea(
                child: SingleChildScrollView(
                  padding: const EdgeInsets.fromLTRB(16, 8, 16, 16),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      _buildProgressHeader(state),
                      const SizedBox(height: 12),
                      _SegmentChips(
                        segments: state.segments,
                        currentIndex: state.currentIndex,
                        enabled:
                            state.phase == RecorderPhase.idle &&
                            state.currentIndex < recordingSegmentCount,
                        onTap: (index) {
                          if (index != state.currentIndex) {
                            ref
                                .read(recorderControllerProvider.notifier)
                                .selectSegment(index);
                          }
                        },
                      ),
                      const SizedBox(height: 16),
                      if (state.currentIndex < recordingSegmentCount)
                        _buildPassageCard(state)
                      else
                        _buildAllDonePanel(state),
                      const SizedBox(height: 16),
                      _buildStatusArea(state),
                      if (state.errorMessage != null) ...[
                        const SizedBox(height: 8),
                        _ErrorHint(
                          message: state.errorMessage!,
                          onDismiss: controller.clearError,
                        ),
                      ],
                      const SizedBox(height: 12),
                      _buildControlRow(state, controller),
                      const SizedBox(height: 8),
                      _buildRecentSegmentBanner(state, controller),
                      const SizedBox(height: 16),
                      _buildBottomPanel(state, controller),
                    ],
                  ),
                ),
              ),
      ),
    );
  }

  /// 顶部：横向进度（第 x/10 段）+ 已完成计数。
  Widget _buildProgressHeader(RecordingState state) {
    final current = state.currentIndex;
    final label = current < recordingSegmentCount
        ? '第 ${current + 1}/10 段'
        : '已完成全部 10 段';
    return Row(
      children: [
        Text(
          label,
          key: const Key('recordingProgressText'),
          style: const TextStyle(fontSize: 16, fontWeight: FontWeight.bold),
        ),
        const Spacer(),
        Text(
          '已完成 ${state.completedCount}/10',
          style: TextStyle(fontSize: 13, color: Colors.grey.shade600),
        ),
      ],
    );
  }

  /// 当前段念稿全文（大字号方便照读）。
  Widget _buildPassageCard(RecordingState state) {
    final index = state.currentIndex;
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: Colors.deepPurple.withValues(alpha: 0.06),
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: Colors.deepPurple.withValues(alpha: 0.25)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            '第 ${index + 1} 段念稿 · 请用自然语速跟读',
            style: TextStyle(
              fontSize: 13,
              color: Colors.deepPurple.shade700,
              fontWeight: FontWeight.w600,
            ),
          ),
          const SizedBox(height: 10),
          Text(
            readingPassages[index],
            key: const Key('passageText'),
            style: const TextStyle(fontSize: 20, height: 1.7),
          ),
        ],
      ),
    );
  }

  Widget _buildAllDonePanel(RecordingState state) {
    return Container(
      key: const Key('recordingAllDonePanel'),
      padding: const EdgeInsets.all(20),
      decoration: BoxDecoration(
        color: Colors.green.withValues(alpha: 0.08),
        borderRadius: BorderRadius.circular(12),
      ),
      child: Column(
        children: [
          const Icon(Icons.task_alt, color: Colors.green, size: 40),
          const SizedBox(height: 8),
          const Text(
            '10 段已全部录完',
            style: TextStyle(fontSize: 16, fontWeight: FontWeight.bold),
          ),
          const SizedBox(height: 4),
          Text(
            '累计 ${formatRecordingDuration(state.totalSeconds)}，'
            '达到 3 分钟即可开始克隆',
            style: TextStyle(fontSize: 13, color: Colors.grey.shade600),
          ),
        ],
      ),
    );
  }

  /// 状态区：录音中/暂停显示计时与实时波形；idle 显示提示。
  Widget _buildStatusArea(RecordingState state) {
    if (state.phase == RecorderPhase.recording ||
        state.phase == RecorderPhase.paused) {
      return Column(
        children: [
          Row(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              Text(
                formatRecordingDuration(state.elapsedSeconds),
                key: const Key('segmentTimerText'),
                style: const TextStyle(
                  fontSize: 40,
                  fontWeight: FontWeight.bold,
                  fontFeatures: [FontFeature.tabularFigures()],
                ),
              ),
              if (state.phase == RecorderPhase.paused) ...[
                const SizedBox(width: 8),
                Container(
                  padding: const EdgeInsets.symmetric(
                    horizontal: 8,
                    vertical: 2,
                  ),
                  decoration: BoxDecoration(
                    color: Colors.orange.shade100,
                    borderRadius: BorderRadius.circular(4),
                  ),
                  child: const Text(
                    '已暂停',
                    style: TextStyle(fontSize: 12, color: Colors.orange),
                  ),
                ),
              ],
            ],
          ),
          const SizedBox(height: 8),
          SizedBox(
            height: 72,
            width: double.infinity,
            child: CustomPaint(
              key: const Key('waveformCanvas'),
              painter: WaveformPainter(
                samples: state.waveform,
                color: Theme.of(context).colorScheme.primary,
              ),
            ),
          ),
          const SizedBox(height: 6),
          Text(
            state.phase == RecorderPhase.recording
                ? '正在录音，请大声清晰地朗读念稿'
                : '已暂停，可继续录音或完成本段',
            style: TextStyle(fontSize: 12, color: Colors.grey.shade600),
          ),
        ],
      );
    }

    if (state.currentSegmentRecorded &&
        state.currentIndex < recordingSegmentCount) {
      return Text(
        '本段已录制 ${formatRecordingDuration(state.segments[state.currentIndex]!.durationSeconds)}，'
        '重新开始将覆盖旧文件',
        key: const Key('recordedSegmentHint'),
        textAlign: TextAlign.center,
        style: TextStyle(fontSize: 13, color: Colors.grey.shade700),
      );
    }
    return Text(
      '准备好后点击「录音」，跟随上方文案朗读即可',
      key: const Key('idleRecordHint'),
      textAlign: TextAlign.center,
      style: TextStyle(fontSize: 13, color: Colors.grey.shade600),
    );
  }

  /// 控制区三按钮：录音/暂停/继续、重录本段、完成本段。
  Widget _buildControlRow(RecordingState state, RecorderController controller) {
    final allDone = state.currentIndex >= recordingSegmentCount;
    final recording = state.phase == RecorderPhase.recording;
    final paused = state.phase == RecorderPhase.paused;

    final toggleLabel = allDone
        ? '开始录音'
        : recording
        ? '暂停'
        : paused
        ? '继续录音'
        : state.currentSegmentRecorded
        ? '重录本段'
        : '开始录音';

    return Row(
      children: [
        Expanded(
          flex: 2,
          child: FilledButton(
            key: const Key('recordButton'),
            onPressed: allDone
                ? null
                : () {
                    if (recording) {
                      controller.pauseCurrentSegment();
                    } else if (paused) {
                      controller.resumeCurrentSegment();
                    } else {
                      controller.startCurrentSegment();
                    }
                  },
            style: FilledButton.styleFrom(
              minimumSize: const Size.fromHeight(48),
            ),
            child: Text(toggleLabel),
          ),
        ),
        const SizedBox(width: 8),
        Expanded(
          child: OutlinedButton(
            key: const Key('redoSegmentButton'),
            onPressed:
                state.phase == RecorderPhase.idle &&
                    state.currentSegmentRecorded &&
                    !allDone
                ? () => controller.recordSegment(state.currentIndex)
                : null,
            style: OutlinedButton.styleFrom(
              minimumSize: const Size.fromHeight(48),
            ),
            child: const Text('重录'),
          ),
        ),
        const SizedBox(width: 8),
        Expanded(
          child: OutlinedButton(
            key: const Key('finishSegmentButton'),
            onPressed: recording || paused
                ? controller.finishCurrentSegment
                : null,
            style: OutlinedButton.styleFrom(
              minimumSize: const Size.fromHeight(48),
            ),
            child: const Text('完成本段'),
          ),
        ),
      ],
    );
  }

  /// 最近完成段的提示条：显示时长并提供「重录本段」。
  Widget _buildRecentSegmentBanner(
    RecordingState state,
    RecorderController controller,
  ) {
    final index = state.lastCompletedIndex;
    if (index < 0 ||
        index >= state.segments.length ||
        state.phase != RecorderPhase.idle ||
        index == state.currentIndex) {
      return const SizedBox.shrink();
    }
    final segment = state.segments[index];
    if (segment == null) {
      return const SizedBox.shrink();
    }
    return Container(
      key: const Key('recentSegmentBanner'),
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
      decoration: BoxDecoration(
        color: Colors.grey.shade100,
        borderRadius: BorderRadius.circular(8),
      ),
      child: Row(
        children: [
          Icon(
            Icons.check_circle_outline,
            size: 18,
            color: Colors.green.shade600,
          ),
          const SizedBox(width: 6),
          Expanded(
            child: Text(
              '第 ${index + 1} 段已录制 '
              '${formatRecordingDuration(segment.durationSeconds)}',
              style: const TextStyle(fontSize: 13),
            ),
          ),
          TextButton(
            key: const Key('redoRecentButton'),
            onPressed: () => controller.recordSegment(index),
            child: const Text('重录本段'),
          ),
        ],
      ),
    );
  }

  /// 底部：总时长大字 + 开始克隆按钮。
  Widget _buildBottomPanel(
    RecordingState state,
    RecorderController controller,
  ) {
    final canSubmit =
        state.completedCount == recordingSegmentCount &&
        state.totalSeconds >= minimumTotalSeconds;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(
          '总时长 ${formatRecordingDuration(state.totalSeconds)}',
          key: const Key('totalDurationText'),
          textAlign: TextAlign.center,
          style: const TextStyle(fontSize: 28, fontWeight: FontWeight.bold),
        ),
        if (!canSubmit) ...[
          const SizedBox(height: 4),
          Text(
            '录满 10 段且总时长 ≥ 3 分钟（当前 ${state.completedCount}/10 段）方可开始克隆',
            textAlign: TextAlign.center,
            style: TextStyle(fontSize: 12, color: Colors.grey.shade600),
          ),
        ],
        const SizedBox(height: 12),
        FilledButton(
          key: const Key('submitCloneButton'),
          onPressed: canSubmit ? _startCloneFlow : null,
          style: FilledButton.styleFrom(minimumSize: const Size.fromHeight(52)),
          child: const Text('开始克隆'),
        ),
      ],
    );
  }

  /// 提交克隆：弹出命名对话框 → 调 createVoice 创建 pending 音色 → 进入音色库。
  Future<void> _startCloneFlow() async {
    final state = ref.read(recorderControllerProvider);
    final name = await _askCloneName();
    if (name == null || !mounted) {
      return;
    }
    try {
      await ref
          .read(apiClientProvider)
          .createVoice(name: name, sampleDurationSeconds: state.totalSeconds);
      if (mounted) {
        // 克隆任务已创建（pending），跳转音色库页查看进度
        context.go('/voices');
      }
    } on ApiException catch (error) {
      _handleCloneError(error);
    }
  }

  /// 命名对话框：默认名「我的声音」，空输入回退默认名。
  Future<String?> _askCloneName() async {
    _cloneNameController.text = '我的声音';
    final name = await showDialog<String>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        key: const Key('cloneNameDialog'),
        title: const Text('给克隆的音色命名'),
        content: TextField(
          key: const Key('cloneNameField'),
          controller: _cloneNameController,
          maxLength: 50,
          decoration: const InputDecoration(hintText: '我的声音'),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(),
            child: const Text('取消'),
          ),
          FilledButton(
            key: const Key('cloneNameConfirmButton'),
            onPressed: () {
              final trimmed = _cloneNameController.text.trim();
              Navigator.of(dialogContext)
                  .pop(trimmed.isEmpty ? '我的声音' : trimmed);
            },
            child: const Text('开始克隆'),
          ),
        ],
      ),
    );
    return name;
  }

  /// 克隆提交失败提示：403 未签协议引导去签署；400 时长不足给出口径；其余透传后端提示。
  void _handleCloneError(ApiException error) {
    if (!mounted) {
      return;
    }
    final messenger = ScaffoldMessenger.of(context);
    if (error.code == 'AGREEMENT_REQUIRED') {
      messenger
        ..clearSnackBars()
        ..showSnackBar(
          const SnackBar(
            content: Text('克隆声音前需先签署《声音授权协议》，请先完成授权'),
          ),
        );
      context.push('/voice-agreement');
      return;
    }
    if (error.code == 'DURATION_TOO_SHORT') {
      messenger
        ..clearSnackBars()
        ..showSnackBar(
          const SnackBar(content: Text('录音时长不足 3 分钟，无法开始克隆')),
        );
      return;
    }
    messenger
      ..clearSnackBars()
      ..showSnackBar(SnackBar(content: Text(error.message)));
  }
}

/// 错误提示条。
class _ErrorHint extends StatelessWidget {
  const _ErrorHint({required this.message, required this.onDismiss});

  final String message;
  final VoidCallback onDismiss;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
      decoration: BoxDecoration(
        color: Theme.of(context).colorScheme.errorContainer,
        borderRadius: BorderRadius.circular(8),
      ),
      child: Row(
        children: [
          Expanded(
            child: Text(
              message,
              key: const Key('recordingErrorText'),
              style: TextStyle(
                fontSize: 13,
                color: Theme.of(context).colorScheme.onErrorContainer,
              ),
            ),
          ),
          TextButton(onPressed: onDismiss, child: const Text('知道了')),
        ],
      ),
    );
  }
}

/// 顶部横向分段进度条：共 10 个小格，可点选历史段查看/重录。
class _SegmentChips extends StatelessWidget {
  const _SegmentChips({
    required this.segments,
    required this.currentIndex,
    required this.enabled,
    required this.onTap,
  });

  final List<SegmentRecord?> segments;
  final int currentIndex;
  final bool enabled;
  final ValueChanged<int> onTap;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Row(
      key: const Key('segmentChips'),
      children: [
        for (var i = 0; i < segments.length; i++)
          Expanded(
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 1.5),
              child: InkWell(
                key: Key('segmentChip_$i'),
                borderRadius: BorderRadius.circular(4),
                onTap: enabled ? () => onTap(i) : null,
                child: Container(
                  height: 28,
                  alignment: Alignment.center,
                  decoration: BoxDecoration(
                    color: segments[i] != null
                        ? scheme.primaryContainer
                        : scheme.surfaceContainerHighest,
                    borderRadius: BorderRadius.circular(4),
                    border: i == currentIndex
                        ? Border.all(color: scheme.primary, width: 2)
                        : null,
                  ),
                  child: Text(
                    '${i + 1}',
                    style: TextStyle(
                      fontSize: 12,
                      fontWeight: i == currentIndex ? FontWeight.bold : null,
                      color: segments[i] != null
                          ? scheme.onPrimaryContainer
                          : Colors.grey.shade700,
                    ),
                  ),
                ),
              ),
            ),
          ),
      ],
    );
  }
}

/// 柱状波形画笔：把最近 N 个振幅采样画成居中竖条。
class WaveformPainter extends CustomPainter {
  const WaveformPainter({required this.samples, required this.color});

  final List<double> samples;
  final Color color;

  @override
  void paint(Canvas canvas, Size size) {
    if (samples.isEmpty || size.width <= 0 || size.height <= 0) {
      return;
    }
    final paint = Paint()
      ..color = color
      ..strokeCap = StrokeCap.round
      ..strokeWidth = 4;
    final step = size.width / samples.length;
    final midY = size.height / 2;
    for (var i = 0; i < samples.length; i++) {
      final value = samples[i].clamp(0.05, 1.0);
      final barHeight = (size.height - 8) * value;
      final x = step * i + step / 2;
      canvas.drawLine(
        Offset(x, midY - barHeight / 2),
        Offset(x, midY + barHeight / 2),
        paint,
      );
    }
  }

  @override
  bool shouldRepaint(covariant WaveformPainter oldDelegate) {
    return oldDelegate.samples != samples || oldDelegate.color != color;
  }
}
