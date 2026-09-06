/// 直播中监控页：/lives/:id/monitor。
/// 展示实时状态 + 已播时长（每秒刷新，hh:mm:ss）+ 弹幕日志（只读滚动）。
/// 进入页面启动轮询（monitor 每 3s、danmaku 每 3s），退出停止。
/// 「AI 智能直播」角标恒为 true，本页强制展示角标提示、无关闭入口。
library;

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import 'package:starvoice_app/core/models/live.dart';
import 'package:starvoice_app/core/network/api_exception.dart';
import 'package:starvoice_app/providers.dart';

/// 直播监控页：只读展示直播中状态 / 已播时长 / 弹幕，支持一键结束直播。
class LiveMonitorPage extends ConsumerStatefulWidget {
  const LiveMonitorPage({super.key, required this.liveId});

  final String liveId;

  @override
  ConsumerState<LiveMonitorPage> createState() => _LiveMonitorPageState();
}

class _LiveMonitorPageState extends ConsumerState<LiveMonitorPage> {
  /// monitor 快照轮询间隔
  static const _monitorInterval = Duration(seconds: 3);

  /// 弹幕日志轮询间隔
  static const _danmakuInterval = Duration(seconds: 3);

  Timer? _monitorTimer;
  Timer? _danmakuTimer;

  LiveMonitor? _monitor;
  List<LiveDanmaku> _danmaku = const <LiveDanmaku>[];

  /// 首次加载中（monitor 未就绪）
  bool _loading = true;

  /// 首次加载失败的中文提示（含 404）
  String? _error;

  /// 结束直播进行中（防重复点击）
  bool _ending = false;

  /// 已播时长本地时钟：monitor 轮询间隔内也要每秒递增，故用本地秒数兜底展示。
  int _localSeconds = 0;
  Timer? _ticker;

  @override
  void initState() {
    super.initState();
    // 首帧后再发起请求与启动轮询，避免 build 阶段做网络调用
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _loadMonitor();
      _loadDanmaku();
      _monitorTimer = Timer.periodic(_monitorInterval, (_) => _loadMonitor());
      _danmakuTimer = Timer.periodic(_danmakuInterval, (_) => _loadDanmaku());
      // 已播时长每秒递增：monitor 未刷新时也能平滑走动
      _ticker = Timer.periodic(const Duration(seconds: 1), (_) {
        if (mounted && _monitor?.status == LiveStatus.live) {
          setState(() {
            _localSeconds += 1;
          });
        }
      });
    });
  }

  @override
  void dispose() {
    _monitorTimer?.cancel();
    _danmakuTimer?.cancel();
    _ticker?.cancel();
    super.dispose();
  }

  void _showSnack(String message) {
    if (!mounted) {
      return;
    }
    ScaffoldMessenger.of(context)
      ..clearSnackBars()
      ..showSnackBar(SnackBar(content: Text(message)));
  }

  /// 拉取监控快照：失败仅在首次（尚无数据）时置 error，轮询中失败静默保留旧值。
  Future<void> _loadMonitor() async {
    try {
      final monitor = await ref.read(apiClientProvider).getLiveMonitor(widget.liveId);
      if (!mounted) {
        return;
      }
      setState(() {
        _monitor = monitor;
        _localSeconds = monitor.durationSeconds;
        _loading = false;
        _error = null;
      });
      // 直播已结束（本页外触发）：停止轮询并返回，避免残留定时器
      if (monitor.status != LiveStatus.live) {
        _stopPolling();
      }
    } on ApiException catch (error) {
      if (!mounted) {
        return;
      }
      setState(() {
        _loading = false;
        if (_monitor == null) {
          _error = error.message;
        }
      });
    }
  }

  /// 拉取弹幕日志：失败静默保留旧列表，不打断观看体验。
  Future<void> _loadDanmaku() async {
    try {
      final danmaku = await ref.read(apiClientProvider).getLiveDanmaku(widget.liveId);
      if (!mounted) {
        return;
      }
      setState(() {
        _danmaku = danmaku;
      });
    } on ApiException {
      // 弹幕加载失败不阻塞页面，静默保留旧数据
    }
  }

  void _stopPolling() {
    _monitorTimer?.cancel();
    _danmakuTimer?.cancel();
    _ticker?.cancel();
  }

  /// 结束直播：二次确认后调用 endLive，成功 pop 返回列表页。
  Future<void> _endLive() async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        key: const Key('liveEndDialog'),
        title: const Text('结束直播'),
        content: const Text('结束后直播将停止推流并转为已结束，确定结束？'),
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
    setState(() {
      _ending = true;
    });
    try {
      await ref.read(apiClientProvider).endLive(widget.liveId);
      if (!mounted) {
        return;
      }
      _stopPolling();
      context.pop();
    } on ApiException catch (error) {
      if (mounted) {
        setState(() {
          _ending = false;
        });
        _showSnack('结束失败：${error.message}');
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      key: const Key('liveMonitorPage'),
      appBar: AppBar(title: const Text('直播监控')),
      body: _buildBody(),
      bottomNavigationBar: _ending
          ? null
          : SafeArea(
              child: Padding(
                padding: const EdgeInsets.all(16),
                child: SizedBox(
                  width: double.infinity,
                  child: FilledButton(
                    key: const Key('liveEndButton'),
                    onPressed: _endLive,
                    style: FilledButton.styleFrom(
                      backgroundColor: Colors.red.shade600,
                      minimumSize: const Size.fromHeight(48),
                    ),
                    child: const Text('结束直播'),
                  ),
                ),
              ),
            ),
    );
  }

  Widget _buildBody() {
    if (_loading) {
      return const Center(
        child: CircularProgressIndicator(key: Key('liveMonitorLoading')),
      );
    }
    if (_error != null && _monitor == null) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(
                '监控加载失败：$_error',
                key: const Key('liveMonitorErrorText'),
                textAlign: TextAlign.center,
              ),
              const SizedBox(height: 12),
              OutlinedButton(
                key: const Key('liveMonitorRetryButton'),
                onPressed: () {
                  setState(() {
                    _loading = true;
                    _error = null;
                  });
                  _loadMonitor();
                  _loadDanmaku();
                },
                child: const Text('重试'),
              ),
            ],
          ),
        ),
      );
    }
    final monitor = _monitor;
    if (monitor == null) {
      return const Center(child: Text('暂无直播数据'));
    }
    final durationSeconds = monitor.status == LiveStatus.live
        ? (_localSeconds > monitor.durationSeconds
            ? _localSeconds
            : monitor.durationSeconds)
        : monitor.durationSeconds;
    return RefreshIndicator(
      onRefresh: () async {
        await _loadMonitor();
        await _loadDanmaku();
      },
      child: ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        padding: const EdgeInsets.all(16),
        children: [
          _buildStatusCard(monitor, durationSeconds),
          const SizedBox(height: 16),
          _buildComplianceBadge(monitor),
          const SizedBox(height: 16),
          _buildDanmakuSection(),
        ],
      ),
    );
  }

  /// 顶部状态卡片：状态徽章 + 已播时长。
  Widget _buildStatusCard(LiveMonitor monitor, int durationSeconds) {
    final color = _statusColor(monitor.status);
    final label = _durationLabel(durationSeconds);
    return Card(
      margin: EdgeInsets.zero,
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Container(
                  padding: const EdgeInsets.symmetric(
                    horizontal: 10,
                    vertical: 4,
                  ),
                  decoration: BoxDecoration(
                    color: color.withValues(alpha: 0.12),
                    borderRadius: BorderRadius.circular(999),
                  ),
                  child: Text(
                    monitor.status.label,
                    key: const Key('liveMonitorStatus'),
                    style: TextStyle(
                      fontSize: 13,
                      color: color,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                ),
                const SizedBox(width: 10),
                const Icon(Icons.fiber_manual_record,
                    size: 10, color: Colors.red),
                const SizedBox(width: 4),
                Text(
                  monitor.status == LiveStatus.live ? '直播中' : '已结束',
                  style: TextStyle(fontSize: 13, color: Colors.grey.shade700),
                ),
              ],
            ),
            const SizedBox(height: 16),
            Text(
              '已播时长',
              style: TextStyle(fontSize: 12, color: Colors.grey.shade600),
            ),
            const SizedBox(height: 4),
            Text(
              label,
              key: const Key('liveMonitorDuration'),
              style: const TextStyle(
                fontSize: 32,
                fontWeight: FontWeight.bold,
                fontFeatures: [FontFeature.tabularFigures()],
              ),
            ),
            const SizedBox(height: 8),
            Text(
              '弹幕 ${monitor.danmakuCount} 条',
              key: const Key('liveMonitorDanmakuCount'),
              style: TextStyle(fontSize: 13, color: Colors.grey.shade700),
            ),
          ],
        ),
      ),
    );
  }

  /// 合规角标提示：恒 true、无关闭入口。
  Widget _buildComplianceBadge(LiveMonitor monitor) {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
      decoration: BoxDecoration(
        color: Colors.amber.withValues(alpha: 0.12),
        borderRadius: BorderRadius.circular(8),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Icon(Icons.gpp_good_outlined, size: 16, color: Colors.orange),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              monitor.aiBadgeShown
                  ? '合规提示：直播画面已强制叠加「AI 智能直播」角标，无法关闭。'
                  : '合规提示：直播画面未检测到 AI 角标。',
              key: const Key('liveMonitorBadgeNote'),
              style: const TextStyle(fontSize: 12, color: Colors.orange),
            ),
          ),
        ],
      ),
    );
  }

  /// 弹幕日志区：只读滚动展示；空态显示「暂无弹幕」。
  Widget _buildDanmakuSection() {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          '弹幕日志',
          style: const TextStyle(fontSize: 14, fontWeight: FontWeight.bold),
        ),
        const SizedBox(height: 8),
        if (_danmaku.isEmpty)
          Container(
            key: const Key('liveMonitorDanmakuEmpty'),
            width: double.infinity,
            padding: const EdgeInsets.symmetric(vertical: 32),
            child: Column(
              children: [
                Icon(Icons.chat_bubble_outline,
                    size: 40, color: Colors.grey.shade400),
                const SizedBox(height: 8),
                Text(
                  '暂无弹幕',
                  style: TextStyle(color: Colors.grey.shade500),
                ),
              ],
            ),
          )
        else
          for (final item in _danmaku) _buildDanmakuItem(item),
      ],
    );
  }

  Widget _buildDanmakuItem(LiveDanmaku item) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          CircleAvatar(
            radius: 14,
            backgroundColor: Colors.orange.shade100,
            child: Text(
              _nicknameInitial(item.senderNickname),
              style: TextStyle(fontSize: 12, color: Colors.orange.shade800),
            ),
          ),
          const SizedBox(width: 8),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    Expanded(
                      child: Text(
                        item.senderNickname ?? '匿名观众',
                        key: Key('liveDanmakuNickname_${item.id}'),
                        style: TextStyle(
                          fontSize: 12,
                          color: Colors.grey.shade600,
                          fontWeight: FontWeight.w600,
                        ),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                      ),
                    ),
                    Text(
                      _sentAtLabel(item.sentAt),
                      style: TextStyle(
                        fontSize: 11,
                        color: Colors.grey.shade400,
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 2),
                Text(
                  item.content,
                  key: Key('liveDanmakuContent_${item.id}'),
                  style: const TextStyle(fontSize: 14),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  /// 昵称首字符：空昵称回退「观」。
  String _nicknameInitial(String? nickname) {
    final name = nickname?.trim() ?? '';
    if (name.isEmpty) {
      return '观';
    }
    return name.characters.first;
  }

  /// 弹幕时间 → 本地 HH:mm:ss。
  String _sentAtLabel(String sentAt) {
    final parsed = DateTime.tryParse(sentAt);
    if (parsed == null) {
      return '';
    }
    final local = parsed.toLocal();
    String two(int value) => value.toString().padLeft(2, '0');
    return '${two(local.hour)}:${two(local.minute)}:${two(local.second)}';
  }

  /// 秒数 → hh:mm:ss（超过 24h 时小时数继续累加）。
  String _durationLabel(int total) {
    final value = total < 0 ? 0 : total;
    final hours = value ~/ 3600;
    final minutes = (value % 3600) ~/ 60;
    final seconds = value % 60;
    String two(int n) => n.toString().padLeft(2, '0');
    return '${two(hours)}:${two(minutes)}:${two(seconds)}';
  }
}

/// 状态徽章配色：live 橙 / ended 灰 / 其它用中性灰蓝。
Color _statusColor(LiveStatus status) {
  switch (status) {
    case LiveStatus.live:
      return Colors.orange.shade800;
    case LiveStatus.ended:
      return Colors.grey;
    case LiveStatus.idle:
      return Colors.blue.shade700;
    case LiveStatus.processing:
      return Colors.indigo;
    case LiveStatus.ready:
      return Colors.green.shade700;
    case LiveStatus.failed:
      return Colors.red;
  }
}
