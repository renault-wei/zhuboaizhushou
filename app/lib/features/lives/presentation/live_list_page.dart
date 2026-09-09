import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import 'package:starvoice_app/core/models/live.dart';
import 'package:starvoice_app/core/network/api_exception.dart';
import 'package:starvoice_app/core/theme/app_colors.dart';
import 'package:starvoice_app/core/theme/theme_tokens.dart';
import 'package:starvoice_app/features/lives/application/live_list_controller.dart';
import 'package:starvoice_app/providers.dart';

/// 开播配置列表页（路由 /lives）：分段展示草稿 / 就绪·合成中·进行中 / 已结束。
/// 草稿（idle）可编辑与删除；processing / ready / live 受删除保护
/// （服务端 409，UI 同步禁用删除）；ready / live 统一经「进入监控」跳转
/// 现场直播工作台（G6 收口），一键开播与结束都收在工作台内完成。
class LiveListPage extends ConsumerStatefulWidget {
  const LiveListPage({super.key});

  @override
  ConsumerState<LiveListPage> createState() => _LiveListPageState();
}

class _LiveListPageState extends ConsumerState<LiveListPage> {
  @override
  void initState() {
    super.initState();
    // 首帧后再拉取列表，避免 build 阶段发起网络请求
    WidgetsBinding.instance.addPostFrameCallback((_) {
      ref.read(liveListControllerProvider.notifier).load();
    });
  }

  Future<void> _reload() async {
    await ref.read(liveListControllerProvider.notifier).load();
  }

  void _showSnack(String message) {
    if (!mounted) {
      return;
    }
    ScaffoldMessenger.of(context)
      ..clearSnackBars()
      ..showSnackBar(SnackBar(content: Text(message)));
  }

  /// 新建草稿：进入 /lives/new，返回后刷新列表。
  Future<void> _goNew() async {
    await context.push('/lives/new');
    if (mounted) {
      await _reload();
    }
  }

  /// 编辑草稿：进入 /lives/:id，返回后刷新列表（标题 / 绑定可能已变化）。
  Future<void> _goEdit(Live live) async {
    await context.push('/lives/${live.id}');
    if (mounted) {
      await _reload();
    }
  }

  /// 查看占位：processing / ended / failed 暂无详情页，仅提示后续版本接入。
  void _viewPlaceholder() {
    _showSnack('该状态的详情与推流能力将在后续版本接入');
  }

  /// 进入监控页：ready / live 状态跳 /lives/:id/monitor（工作台内开播 /
  /// 结束），返回后刷新列表。
  Future<void> _goMonitor(Live live) async {
    await context.push('/lives/${live.id}/monitor');
    if (mounted) {
      await _reload();
    }
  }

  /// 结束结算弹层：展示本场按分钟计费的结算摘要（不足 1 分钟 / 无结算摘要时
  /// 提示未扣费），用户点「知道了」后刷新列表。
  Future<void> _showEndSummary(LiveEndSummary summary) {
    final lines = <String>[
      '直播已结束，AI 语音主播已下线。',
      '',
      summary.billing?.summaryText ?? '本场未产生时长扣费',
    ];
    return showDialog<void>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        key: const Key('liveEndSummaryDialog'),
        title: const Text('本场结算'),
        content: Text(
          lines.join('\n'),
          style: const TextStyle(fontSize: 14, height: 1.5),
        ),
        actions: [
          FilledButton(
            key: const Key('liveEndSummaryConfirmButton'),
            onPressed: () => Navigator.of(dialogContext).pop(),
            child: const Text('知道了'),
          ),
        ],
      ),
    );
  }

  /// 结束直播：live → ended，二次确认后调用，成功后刷新列表。
  Future<void> _endLive(Live live) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        key: const Key('liveEndDialog'),
        title: const Text('结束直播'),
        content: const Text('结束后直播将转为已结束，确定结束？'),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(false),
            child: const Text('取消'),
          ),
          FilledButton(
            key: const Key('liveEndConfirmButton'),
            onPressed: () => Navigator.of(dialogContext).pop(true),
            child: const Text('结束直播'),
          ),
        ],
      ),
    );
    if (confirmed != true || !mounted) {
      return;
    }
    try {
      final summary = await ref.read(apiClientProvider).endLive(live.id);
      if (!mounted) {
        return;
      }
      await _showEndSummary(summary);
      if (!mounted) {
        return;
      }
      _showSnack('直播已结束');
      await _reload();
    } on ApiException catch (error) {
      if (mounted) {
        _showSnack('结束失败：${error.message}');
      }
    }
  }

  Future<void> _confirmDelete(Live live) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        key: const Key('liveDeleteDialog'),
        title: const Text('删除开播配置'),
        content: const Text('删除后配置不可恢复，确定删除？'),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(false),
            child: const Text('取消'),
          ),
          FilledButton(
            key: const Key('liveDeleteConfirmButton'),
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
      await ref.read(liveListControllerProvider.notifier).delete(live.id);
      if (mounted) {
        _showSnack('已删除开播配置');
      }
    } on ApiException catch (error) {
      if (mounted) {
        _showSnack('删除失败：${error.message}');
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final state = ref.watch(liveListControllerProvider);
    return Scaffold(
      key: const Key('liveListPage'),
      appBar: AppBar(
        title: const Text('开播配置'),
        actions: [
          IconButton(
            key: const Key('liveRefreshButton'),
            onPressed: state.loading ? null : _reload,
            icon: const Icon(Icons.refresh),
            tooltip: '刷新',
          ),
          IconButton(
            key: const Key('liveAddButton'),
            onPressed: state.loading ? null : _goNew,
            icon: const Icon(Icons.add),
            tooltip: '新建开播配置',
          ),
        ],
      ),
      body: _buildBody(state),
    );
  }

  Widget _buildBody(LiveListState state) {
    if (state.loading && state.lives.isEmpty) {
      return const Center(
        child: CircularProgressIndicator(key: Key('liveListLoading')),
      );
    }
    if (state.error != null && state.lives.isEmpty) {
      return _buildErrorState(state.error!);
    }
    if (state.lives.isEmpty) {
      return _buildEmptyState();
    }
    final drafts = state.lives
        .where((live) => live.status == LiveStatus.idle)
        .toList();
    final active = state.lives
        .where(
          (live) =>
              live.status == LiveStatus.processing ||
              live.status == LiveStatus.ready ||
              live.status == LiveStatus.live,
        )
        .toList();
    final finished = state.lives.where((live) => live.isFinished).toList();
    return RefreshIndicator(
      onRefresh: _reload,
      child: ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        padding: const EdgeInsets.all(16),
        children: [
          if (drafts.isNotEmpty) _buildSection('草稿', drafts, state),
          if (active.isNotEmpty) _buildSection('就绪 / 合成中 / 直播中', active, state),
          if (finished.isNotEmpty) _buildSection('已结束', finished, state),
        ],
      ),
    );
  }

  Widget _buildSection(String title, List<Live> items, LiveListState state) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Padding(
          padding: const EdgeInsets.only(left: 4, top: 4, bottom: 8),
          child: Text(
            '$title（${items.length}）',
            style: const TextStyle(fontSize: 14, fontWeight: FontWeight.bold),
          ),
        ),
        for (final live in items)
          Padding(
            padding: const EdgeInsets.only(bottom: 12),
            child: _LiveCard(
              live: live,
              voiceNames: state.voiceNames,
              presetNames: state.presetNames,
              scriptTitles: state.scriptTitles,
              couponNames: state.couponNames,
              onEdit: live.isEditable ? () => _goEdit(live) : null,
              onView: _viewPlaceholder,
              onMonitor: live.isReady || live.isLive
                  ? () => _goMonitor(live)
                  : null,
              onEnd: live.isLive ? () => _endLive(live) : null,
              onDelete: live.isDeleteProtected
                  ? null
                  : () => _confirmDelete(live),
            ),
          ),
      ],
    );
  }

  Widget _buildErrorState(String message) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(
              '开播配置加载失败：$message',
              key: const Key('liveListErrorText'),
              textAlign: TextAlign.center,
            ),
            const SizedBox(height: 12),
            OutlinedButton(
              key: const Key('liveListRetryButton'),
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
                          Icons.live_tv,
                          size: 56,
                          color: context.tokenTextHint,
                        ),
                        const SizedBox(height: 16),
                        const Text(
                          '还没有开播配置，点击 + 创建第一个草稿',
                          key: Key('liveListEmptyText'),
                          textAlign: TextAlign.center,
                        ),
                        const SizedBox(height: 20),
                        FilledButton.tonal(
                          key: const Key('liveListCreateButton'),
                          onPressed: _goNew,
                          child: const Text('去创建'),
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

/// 状态徽章配色：idle 蓝 / processing 靛 / ready 绿 / live 橙 / ended 灰 / failed 红。
Color _statusColor(BuildContext context, LiveStatus status) {
  switch (status) {
    case LiveStatus.idle:
      return AppColors.info;
    case LiveStatus.processing:
      return AppColors.warning;
    case LiveStatus.ready:
      return AppColors.primary;
    case LiveStatus.live:
      return AppColors.live;
    case LiveStatus.ended:
      return context.tokenTextHint;
    case LiveStatus.failed:
      return AppColors.danger;
  }
}

/// 单条开播配置卡片：标题 + 状态徽章 + 绑定摘要 + 操作按钮。
/// 操作按钮随状态切换：idle 编辑；ready / live 进入监控（开播 / 结束
/// 收口在工作台内）；processing / ended / failed 查看占位。
/// 删除保护：processing / ready / live 的删除按钮禁用（服务端同样 409 拦截）。
class _LiveCard extends StatelessWidget {
  const _LiveCard({
    required this.live,
    required this.voiceNames,
    required this.presetNames,
    required this.scriptTitles,
    required this.couponNames,
    required this.onEdit,
    required this.onView,
    required this.onMonitor,
    required this.onEnd,
    required this.onDelete,
  });

  final Live live;
  final Map<String, String> voiceNames;
  final Map<String, String> presetNames;
  final Map<String, String> scriptTitles;
  final Map<String, String> couponNames;
  final VoidCallback? onEdit;
  final VoidCallback? onView;
  final VoidCallback? onMonitor;
  final VoidCallback? onEnd;
  final VoidCallback? onDelete;

  /// 卡片摘要：优先展示引用资源名称，缺失时降级为原始 id。
  String get _summary {
    final parts = <String>[
      if (live.voiceId != null)
        '音色：${voiceNames[live.voiceId] ?? live.voiceId}',
      if (live.volcPresetId != null)
        '音色：${presetNames[live.volcPresetId] ?? live.volcPresetId}（火山预设）',
      if (live.scriptId != null)
        '话术：${scriptTitles[live.scriptId] ?? live.scriptId}',
      if (live.couponId != null)
        '券：${couponNames[live.couponId] ?? live.couponId}',
    ];
    if (parts.isEmpty) {
      return '尚未绑定音色 / 话术 / 团购券';
    }
    return parts.join(' · ');
  }

  @override
  Widget build(BuildContext context) {
    final color = _statusColor(context, live.status);
    return Card(
      key: Key('liveCard_${live.id}'),
      margin: EdgeInsets.zero,
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Expanded(
                  child: Text(
                    live.title,
                    style: const TextStyle(
                      fontSize: 16,
                      fontWeight: FontWeight.bold,
                    ),
                    maxLines: 1,
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
                    color: color.withValues(alpha: 0.12),
                    borderRadius: BorderRadius.circular(999),
                  ),
                  child: Text(
                    live.statusLabel,
                    key: Key('liveStatus_${live.id}'),
                    style: TextStyle(
                      fontSize: 12,
                      color: color,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 6),
            Text(
              _summary,
              style: TextStyle(fontSize: 12, color: context.tokenTextBody),
            ),
            const SizedBox(height: 6),
            Row(
              children: [
                if (live.status == LiveStatus.idle)
                  TextButton(
                    key: Key('liveEdit_${live.id}'),
                    onPressed: onEdit,
                    child: Text(live.hasVoiceSource ? '编辑' : '去完善'),
                  )
                else if (live.status == LiveStatus.ready ||
                    live.status == LiveStatus.live)
                  TextButton(
                    key: Key('liveMonitor_${live.id}'),
                    onPressed: onMonitor,
                    child: const Text('进入监控'),
                  )
                else
                  TextButton(
                    key: Key('liveView_${live.id}'),
                    onPressed: onView,
                    child: const Text('查看'),
                  ),
                const Spacer(),
                if (live.status == LiveStatus.live)
                  TextButton(
                    key: Key('liveEndAction_${live.id}'),
                    onPressed: onEnd,
                    style: TextButton.styleFrom(
                      foregroundColor: AppColors.danger,
                    ),
                    child: const Text('结束'),
                  ),
                IconButton(
                  key: Key('liveDelete_${live.id}'),
                  onPressed: onDelete,
                  icon: Icon(
                    Icons.delete_outline,
                    color: onDelete == null
                        ? context.tokenTextHint
                        : context.tokenTextBody,
                  ),
                  tooltip: live.isDeleteProtected ? '合成中、已就绪或直播中，不可删除' : '删除',
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}
