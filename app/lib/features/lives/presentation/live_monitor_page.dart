/// 现场直播工作台：/lives/:id/monitor（现场线 G6 前端）。
/// 画面真人出镜，后台由「AI 语音主播」实时朗读弹幕、介绍产品并回复提问；
/// 本页展示直播状态 + 已播时长（每秒刷新，hh:mm:ss）+ AI 播报状态 +
/// 测试弹幕注入（模拟观众提问，触发 G3→G4→G5 真实语音链路）+ 弹幕日志。
/// 进入页面启动轮询（monitor 每 3s、danmaku 每 3s），退出停止。
/// 「AI 智能直播」角标恒为 true，本页强制展示角标提示、无关闭入口。
/// 一键开播入口收口在本页：就绪（ready）场次从列表页进入本工作台后，
/// 点击「开始直播」开播并进入直播中监控，列表页不再单独提供开播按钮。
/// 就绪（ready）态额外展示「开播前出声自检」引导卡，提示直播画面与
/// 出声链路（电脑线虚拟声卡 / 手机线音频转接线）需先就位。
library;

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import 'package:starvoice_app/core/models/live.dart';
import 'package:starvoice_app/core/network/api_exception.dart';
import 'package:starvoice_app/providers.dart';

/// 现场直播工作台：真人出镜 + 后台 AI 语音主播的直播间控制台，
/// 展示直播状态 / AI 播报状态 / 弹幕日志，支持一键开始 / 结束直播
/// （开始入口收口在本页）与测试弹幕注入。
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

  /// 开始直播进行中（防重复点击）
  bool _starting = false;

  /// 已播时长本地时钟：monitor 轮询间隔内也要每秒递增，故用本地秒数兜底展示。
  int _localSeconds = 0;
  Timer? _ticker;

  /// 测试弹幕输入框（直播中可用，模拟观众提问触发 AI 语音回复）
  final TextEditingController _testController = TextEditingController();

  /// 测试弹幕发送中（防重复点击）
  bool _sendingDanmaku = false;

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
    _testController.dispose();
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
      final monitor = await ref
          .read(apiClientProvider)
          .getLiveMonitor(widget.liveId);
      if (!mounted) {
        return;
      }
      setState(() {
        _monitor = monitor;
        _localSeconds = monitor.durationSeconds;
        _loading = false;
        _error = null;
      });
      // 直播进入终态（ended/failed，本页外触发结束）：停止轮询并返回，
      // 避免残留定时器；就绪 / 直播中等非终态保持轮询，支撑工作台内
      // 「就绪 → 开始直播 → 直播中」的状态流转与外部状态变化感知。
      if (monitor.status == LiveStatus.ended ||
          monitor.status == LiveStatus.failed) {
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
      final danmaku = await ref
          .read(apiClientProvider)
          .getLiveDanmaku(widget.liveId);
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

  /// 一键开始直播（G6 收口）：ready → live，成功后立即刷新监控并对齐弹幕
  /// 日志；「开始直播」入口只保留在本工作台，列表页不再提供开播按钮。
  Future<void> _startLive() async {
    final monitor = _monitor;
    if (_starting || monitor == null || monitor.status != LiveStatus.ready) {
      return;
    }
    setState(() {
      _starting = true;
    });
    try {
      await ref.read(apiClientProvider).startLive(widget.liveId);
      if (!mounted) {
        return;
      }
      setState(() {
        _starting = false;
      });
      _showSnack('直播已开始，AI 语音主播已上线');
      // 立即对齐状态与弹幕，不等下一次轮询
      await _loadMonitor();
      await _loadDanmaku();
    } on ApiException catch (error) {
      if (!mounted) {
        return;
      }
      setState(() {
        _starting = false;
      });
      _showSnack('开播失败：${error.message}');
      // 兜底对齐：失败时状态可能已变化（例如他端已开播），刷新一次
      _loadMonitor();
    }
  }

  /// 发送测试弹幕：写入弹幕网关（G3）→ 实时互动引擎（G4）生成回复 →
  /// 本机语音出口播报（G5）。仅直播中可发；成功后清空输入并立即对齐日志。
  Future<void> _sendTestDanmaku() async {
    final content = _testController.text.trim();
    if (content.isEmpty || _sendingDanmaku) {
      return;
    }
    final monitor = _monitor;
    if (monitor == null || monitor.status != LiveStatus.live) {
      return;
    }
    setState(() {
      _sendingDanmaku = true;
    });
    try {
      await ref
          .read(apiClientProvider)
          .postDanmaku(widget.liveId, content: content);
      if (!mounted) {
        return;
      }
      _testController.clear();
      setState(() {
        _sendingDanmaku = false;
      });
      _showSnack('测试弹幕已发送，AI 语音主播开始回复');
      // 立即与后端对齐（弹幕日志 + 计数），不等下一次轮询
      _loadDanmaku();
      _loadMonitor();
    } on ApiException catch (error) {
      if (!mounted) {
        return;
      }
      setState(() {
        _sendingDanmaku = false;
      });
      _showSnack('发送失败：${error.message}');
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      key: const Key('liveMonitorPage'),
      appBar: AppBar(title: const Text('现场直播工作台')),
      body: _buildBody(),
      bottomNavigationBar: _buildBottomBar(),
    );
  }

  /// 底部主操作区：就绪（ready）显示「开始直播」，直播中（live）显示红色
  /// 「结束直播」；其余状态 / 加载中 / 加载失败不展示动作，避免误导按钮。
  Widget? _buildBottomBar() {
    final monitor = _monitor;
    if (_loading || monitor == null) {
      return null;
    }
    if (monitor.status == LiveStatus.ready) {
      return SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: SizedBox(
            width: double.infinity,
            child: FilledButton(
              key: const Key('liveMonitorStartButton'),
              onPressed: _starting ? null : _startLive,
              style: FilledButton.styleFrom(
                minimumSize: const Size.fromHeight(48),
              ),
              child: _starting ? const Text('正在开播…') : const Text('开始直播'),
            ),
          ),
        ),
      );
    }
    if (monitor.status == LiveStatus.live) {
      return SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: SizedBox(
            width: double.infinity,
            child: FilledButton(
              key: const Key('liveEndButton'),
              onPressed: _ending ? null : _endLive,
              style: FilledButton.styleFrom(
                backgroundColor: Colors.red.shade600,
                minimumSize: const Size.fromHeight(48),
              ),
              child: const Text('结束直播'),
            ),
          ),
        ),
      );
    }
    // idle / processing / ended / failed：无可用主操作，不展示底部按钮
    return null;
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
          if (monitor.status == LiveStatus.ready) ...[
            const SizedBox(height: 12),
            _buildPreflightCard(),
          ],
          const SizedBox(height: 12),
          _buildAiHostCard(monitor),
          const SizedBox(height: 12),
          _buildTestDanmakuSection(monitor),
          const SizedBox(height: 12),
          _buildComplianceBadge(monitor),
          const SizedBox(height: 16),
          _buildDanmakuSection(),
        ],
      ),
    );
  }

  /// 开播前出声自检卡：就绪（ready）态提示直播画面与出声链路准备，
  /// 覆盖电脑线（虚拟声卡 → 直播伴侣）与手机线（音频转接线接入开播手机）
  /// 两种出声方式；开播后自动消失，不打扰直播中监控。
  Widget _buildPreflightCard() {
    return Card(
      key: const Key('liveMonitorPreflight'),
      margin: EdgeInsets.zero,
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                const Icon(
                  Icons.fact_check_outlined,
                  size: 18,
                  color: Colors.blueGrey,
                ),
                const SizedBox(width: 8),
                Text(
                  '开播前自检',
                  style: TextStyle(
                    fontSize: 14,
                    fontWeight: FontWeight.w600,
                    color: Colors.blueGrey.shade700,
                  ),
                ),
              ],
            ),
            const SizedBox(height: 12),
            _buildPreflightItem('直播间画面已开播（直播伴侣 / 手机开播），真人出镜正常'),
            const SizedBox(height: 8),
            _buildPreflightItem(
              '出声链路就位：电脑线 = 系统默认播放指向虚拟声卡、直播伴侣麦克风选 '
              'CABLE Output；手机线 = 出声设备经音频转接线连到开播手机',
            ),
            const SizedBox(height: 8),
            _buildPreflightItem('开播后在本页发一条测试弹幕，确认直播间能听到 AI 语音回复'),
          ],
        ),
      ),
    );
  }

  /// 自检卡单行条目：左侧对勾图标 + 说明文字。
  Widget _buildPreflightItem(String text) {
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Icon(
          Icons.check_circle_outline,
          size: 16,
          color: Colors.green.shade600,
        ),
        const SizedBox(width: 8),
        Expanded(
          child: Text(
            text,
            style: TextStyle(
              fontSize: 13,
              color: Colors.grey.shade700,
              height: 1.4,
            ),
          ),
        ),
      ],
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
                const Icon(
                  Icons.fiber_manual_record,
                  size: 10,
                  color: Colors.red,
                ),
                const SizedBox(width: 4),
                Text(
                  _phaseLabel(monitor.status),
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

  /// 状态卡右侧短描述：直播中 / 已结束 / 就绪待开播等等待态用「待开播」。
  String _phaseLabel(LiveStatus status) {
    switch (status) {
      case LiveStatus.live:
        return '直播中';
      case LiveStatus.ended:
      case LiveStatus.failed:
        return '已结束';
      case LiveStatus.ready:
        return '待开播';
      case LiveStatus.processing:
        return '准备中';
      case LiveStatus.idle:
        return '草稿';
    }
  }

  /// AI 语音主播运行卡：真人出镜画面，AI 负责后台语音播报。
  Widget _buildAiHostCard(LiveMonitor monitor) {
    final live = monitor.status == LiveStatus.live;
    final ready = monitor.status == LiveStatus.ready;
    final finished =
        monitor.status == LiveStatus.ended ||
        monitor.status == LiveStatus.failed;
    // 主播状态三档：播报中（直播中）/ 待开播（就绪）/ 已停止（终态）；
    // idle / processing 归为待机（尚未到可开播阶段）。
    final String stateText;
    final String note;
    final Color stateColor;
    if (live) {
      stateText = '播报中';
      note = '真人出镜现场，AI 语音主播在后台实时朗读弹幕、介绍产品并回复提问。';
      stateColor = Colors.teal.shade700;
    } else if (ready) {
      stateText = '待开播';
      note = '配置已就绪，点击下方「开始直播」后 AI 语音主播将上线播报。';
      stateColor = Colors.orange.shade700;
    } else if (finished) {
      stateText = '已停止';
      note = '直播已结束，AI 语音播报已停止。';
      stateColor = Colors.grey;
    } else {
      stateText = '待机';
      note = '直播尚未开播，AI 语音主播暂未上线。';
      stateColor = Colors.grey;
    }
    return Card(
      key: const Key('liveMonitorAiHostCard'),
      margin: EdgeInsets.zero,
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Container(
              padding: const EdgeInsets.all(10),
              decoration: BoxDecoration(
                color: Colors.orange.shade50,
                borderRadius: BorderRadius.circular(10),
              ),
              child: Icon(
                Icons.record_voice_over,
                color: Colors.orange.shade700,
                size: 22,
              ),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      const Expanded(
                        child: Text(
                          'AI 语音主播',
                          style: TextStyle(
                            fontSize: 15,
                            fontWeight: FontWeight.w600,
                          ),
                        ),
                      ),
                      Container(
                        padding: const EdgeInsets.symmetric(
                          horizontal: 8,
                          vertical: 3,
                        ),
                        decoration: BoxDecoration(
                          color: stateColor.withValues(alpha: 0.12),
                          borderRadius: BorderRadius.circular(999),
                        ),
                        child: Text(
                          stateText,
                          key: const Key('liveMonitorAiHostState'),
                          style: TextStyle(
                            fontSize: 12,
                            color: stateColor,
                            fontWeight: FontWeight.w600,
                          ),
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 6),
                  Text(
                    note,
                    key: const Key('liveMonitorAiHostNote'),
                    style: TextStyle(
                      fontSize: 13,
                      color: Colors.grey.shade600,
                      height: 1.4,
                    ),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  /// 测试弹幕注入区：模拟一条观众提问，跑通「弹幕 → AI 回复 → 语音播报」
  /// 全链路联调；仅直播中可用（服务端非 live 返回 409）。
  Widget _buildTestDanmakuSection(LiveMonitor monitor) {
    final live = monitor.status == LiveStatus.live;
    final canSend =
        live && !_sendingDanmaku && _testController.text.trim().isNotEmpty;
    return Container(
      key: const Key('liveMonitorTestSection'),
      width: double.infinity,
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: Colors.blueGrey.withValues(alpha: 0.05),
        borderRadius: BorderRadius.circular(8),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(
                Icons.science_outlined,
                size: 16,
                color: Colors.blueGrey.shade600,
              ),
              const SizedBox(width: 6),
              const Text(
                '发送测试弹幕',
                style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600),
              ),
            ],
          ),
          const SizedBox(height: 4),
          Text(
            _testDanmakuHint(monitor.status),
            key: const Key('liveMonitorTestHint'),
            style: TextStyle(fontSize: 12, color: Colors.grey.shade600),
          ),
          const SizedBox(height: 8),
          Row(
            crossAxisAlignment: CrossAxisAlignment.center,
            children: [
              Expanded(
                child: TextField(
                  key: const Key('liveMonitorTestInput'),
                  controller: _testController,
                  enabled: live && !_sendingDanmaku,
                  maxLength: 200,
                  textInputAction: TextInputAction.send,
                  onChanged: (_) => setState(() {}),
                  onSubmitted: canSend ? (_) => _sendTestDanmaku() : null,
                  decoration: InputDecoration(
                    hintText: '如：今天双人套餐多少钱？',
                    counterText: '',
                    isDense: true,
                    contentPadding: const EdgeInsets.symmetric(
                      horizontal: 12,
                      vertical: 10,
                    ),
                    border: OutlineInputBorder(
                      borderRadius: BorderRadius.circular(8),
                    ),
                  ),
                ),
              ),
              const SizedBox(width: 8),
              FilledButton.tonal(
                key: const Key('liveMonitorTestSend'),
                onPressed: canSend ? _sendTestDanmaku : null,
                child: _sendingDanmaku
                    ? const SizedBox(
                        width: 16,
                        height: 16,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      )
                    : const Text('发送'),
              ),
            ],
          ),
        ],
      ),
    );
  }

  /// 测试弹幕区说明文案：直播中说明联调用途，终态提示已结束，其余提示先开播。
  String _testDanmakuHint(LiveStatus status) {
    if (status == LiveStatus.live) {
      return '模拟一条观众提问（如问价格），AI 会立即生成回复并开口播报，用于联调与演示。';
    }
    if (status == LiveStatus.ended || status == LiveStatus.failed) {
      return '直播已结束，无法再发送测试弹幕。';
    }
    return '尚未开播，无法发送测试弹幕；点击「开始直播」进入直播后即可联调。';
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
                Icon(
                  Icons.chat_bubble_outline,
                  size: 40,
                  color: Colors.grey.shade400,
                ),
                const SizedBox(height: 8),
                Text('暂无弹幕', style: TextStyle(color: Colors.grey.shade500)),
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
