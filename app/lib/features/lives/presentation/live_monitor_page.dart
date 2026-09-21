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

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:starvoice_app/core/models/danmaku_source.dart';
import 'package:starvoice_app/core/models/live.dart';
import 'package:starvoice_app/core/models/loop_script.dart';
import 'package:starvoice_app/core/network/api_exception.dart';
import 'package:starvoice_app/core/theme/app_colors.dart';
import 'package:starvoice_app/core/theme/app_theme.dart';
import 'package:starvoice_app/features/assistant_speaker/application/assistant_speaker_controller.dart';
import 'package:starvoice_app/features/assistant_speaker/presentation/keep_alive_guide_dialog.dart';
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

  /// 「助播机出声」常开偏好键：直播进入时按该记忆自动恢复出声。
  static const _speakerAlwaysOnKey = 'assistant_speaker_always_on';

  /// 后台保活引导是否已展示过：仅首次启用出声时弹一次，不重复打扰。
  static const _keepAliveGuidedKey = 'assistant_keep_alive_guided';

  Timer? _monitorTimer;
  Timer? _danmakuTimer;

  /// ★场次已不存在（被删 / 换账号）：**终态**。置真后停止轮询并只显示出口。
  ///
  /// 为什么要单独一个状态：原先「场次曾加载成功、之后被删」时，每轮轮询都
  /// 静默失败（错误分支只在 `_monitor == null` 时才置 error）、轮询永不停止、
  /// 页面永久停在旧数据上 —— 实测 10 分钟 283 次请求 / 215 次 404，
  /// 每个按钮都提示「开播配置不存在」，「结束直播」也失败，用户只能杀掉 App。
  bool _liveGone = false;

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

  /// 助播机出声控制器实例缓存：dispose 阶段 ref 已失效，需用本实例收口出声。
  AssistantSpeakerController? _speakerNotifier;

  /// 助播机出声是否常开：来自本地偏好的内存镜像，避免直播中轮询反复读盘。
  bool _speakerAlwaysOn = false;

  /// 本地常开偏好是否已读取：仅首个直播态读取一次并缓存。
  bool _speakerPrefLoaded = false;

  /// 测试弹幕输入框（直播中可用，模拟观众提问触发 AI 语音回复）
  final TextEditingController _testController = TextEditingController();

  /// 测试弹幕发送中（防重复点击）
  bool _sendingDanmaku = false;

  /// 直播中热更循环台词进行中（防重复点击）
  bool _updatingLoop = false;

  /// 直播中热更话术（弹幕回复知识）进行中（防重复点击）
  bool _updatingScript = false;

  /// 弹幕采集源状态（R2 · D4.1）：贴一段分享链接就能让服务端以观众身份连入
  /// 本直播间监听真实弹幕 —— 落库后自动走既有的「AI 回复 → 出声」链路。
  /// 拉取失败时保持上一次快照：它是旁路信息，不该打断工作台主流程。
  DanmakuSourceStatus? _danmakuSource;

  /// 采集源链接输入框（贴抖音分享文本 / 链接）
  final TextEditingController _sourceController = TextEditingController();

  /// 起采集进行中（防重复点击）
  bool _bindingSource = false;

  /// 停采集进行中（防重复点击）
  bool _stoppingSource = false;

  @override
  void initState() {
    super.initState();
    // 首帧后再发起请求与启动轮询，避免 build 阶段做网络调用
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _loadMonitor();
      _loadDanmaku();
      _loadDanmakuSource();
      _monitorTimer = Timer.periodic(_monitorInterval, (_) {
        _loadMonitor();
        // R7：采集状态也纳入轮询。此前只在进入页面 / 手动刷新 / 绑定成功三处拉取，
        // 导致真机上绑定成功后卡片一直停在「连接中…」，必须退出重进才更新（实测踩到）。
        _loadDanmakuSource();
      });
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
    _sourceController.dispose();
    final speaker = _speakerNotifier;
    if (speaker != null) {
      // 出声收口延后到当前卸载帧完成后再停用：元素已随页面卸载，同步
      // notify 会触发已 defunct 元素的 markNeedsBuild 断言。
      scheduleMicrotask(speaker.stop);
    }
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
      // 非直播中一律停用助播出声：直播结束 / 外部变更时自动收口
      if (monitor.status != LiveStatus.live) {
        ref.read(assistantSpeakerControllerProvider.notifier).stop();
      }
      // 直播中按「常开」记忆自动恢复助播出声（用户手动关闭则不拉起）
      if (monitor.status == LiveStatus.live) {
        _syncSpeakerAutoStart();
      }
    } on ApiException catch (error) {
      if (!mounted) {
        return;
      }
      // ★场次已不存在 = **终态**：停轮询、给出口。绝不能像普通轮询失败那样静默重试。
      if (error.code == 'LIVE_NOT_FOUND' || error.statusCode == 404) {
        _stopPolling();
        ref.read(assistantSpeakerControllerProvider.notifier).stop();
        setState(() {
          _loading = false;
          _liveGone = true;
          _error = '这场直播已不存在（可能已被删除）';
        });
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

  /// 直播中按用户「常开」偏好自动恢复助播出声：仅首个直播态读取一次本地
  /// 偏好并缓存；开关由用户手动切换时同步写回偏好，本方法不覆盖用户选择。
  Future<void> _syncSpeakerAutoStart() async {
    if (ref.read(assistantSpeakerControllerProvider).enabled) {
      return;
    }
    if (!_speakerPrefLoaded) {
      final prefs = await SharedPreferences.getInstance();
      if (!mounted) {
        return;
      }
      _speakerPrefLoaded = true;
      _speakerAlwaysOn = prefs.getBool(_speakerAlwaysOnKey) ?? false;
    }
    if (_speakerAlwaysOn) {
      final notifier = ref.read(assistantSpeakerControllerProvider.notifier);
      if (!ref.read(assistantSpeakerControllerProvider).enabled) {
        notifier.start(liveId: widget.liveId);
      }
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

  /// 结束结算弹层：展示本场按分钟计费的结算摘要（不足 1 分钟 / 无结算摘要时
  /// 提示未扣费），用户点「知道了」后返回列表页。
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
      final summary = await ref.read(apiClientProvider).endLive(widget.liveId);
      if (!mounted) {
        return;
      }
      _stopPolling();
      await _showEndSummary(summary);
      if (!mounted) {
        return;
      }
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
  @override
  Widget build(BuildContext context) {
    // 现场工作台恒为深色：直播中长时间注视的操作面板，固定 workbench 主题。
    return Theme(
      data: AppTheme.workbench(),
      child: Scaffold(
        key: const Key('liveMonitorPage'),
        appBar: AppBar(title: const Text('现场直播工作台')),
        body: _buildBody(),
        bottomNavigationBar: _buildBottomBar(),
      ),
    );
  }

  /// 底部主操作区：就绪（ready）显示「开始直播」，直播中（live）显示红色
  /// 「结束直播」；其余状态 / 加载中 / 加载失败不展示动作，避免误导按钮。
  Widget? _buildBottomBar() {
    final monitor = _monitor;
    // 场次已不存在时不再渲染任何动作按钮 —— 它们点了也只会报「开播配置不存在」，
    // 「结束直播」同样会失败，留着只会让人以为还有救。
    if (_loading || monitor == null || _liveGone) {
      return null;
    }
    if (monitor.status == LiveStatus.ready) {
      return SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(16, 8, 16, 16),
          child: SizedBox(
            width: double.infinity,
            child: FilledButton(
              key: const Key('liveMonitorStartButton'),
              onPressed: _starting ? null : _startLive,
              style: FilledButton.styleFrom(
                minimumSize: const Size.fromHeight(52),
                shape: RoundedRectangleBorder(
                  borderRadius: BorderRadius.circular(14),
                ),
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
          padding: const EdgeInsets.fromLTRB(16, 8, 16, 16),
          child: SizedBox(
            width: double.infinity,
            child: FilledButton(
              key: const Key('liveEndButton'),
              onPressed: _ending ? null : _endLive,
              style: FilledButton.styleFrom(
                backgroundColor: AppColors.danger,
                minimumSize: const Size.fromHeight(52),
                shape: RoundedRectangleBorder(
                  borderRadius: BorderRadius.circular(14),
                ),
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
    // ★场次已不存在：只给一句明确说明和一个出口。
    // 不轮询、不放任何操作按钮 —— 它们此刻全是死路（这正是用户被卡住的那次现场）。
    if (_liveGone) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Icon(Icons.link_off, size: 40, color: AppColors.nightTextDim),
              const SizedBox(height: 14),
              Text(
                _error ?? '这场直播已不存在',
                key: const Key('liveMonitorGoneText'),
                textAlign: TextAlign.center,
                style: const TextStyle(
                  color: AppColors.nightText,
                  fontSize: 14,
                  height: 1.6,
                ),
              ),
              const SizedBox(height: 8),
              const Text(
                '它可能已在别处被删除，或当前账号已变更。',
                textAlign: TextAlign.center,
                style: TextStyle(color: AppColors.nightTextDim, fontSize: 12),
              ),
              const SizedBox(height: 18),
              FilledButton(
                key: const Key('liveMonitorGoneBack'),
                onPressed: () => context.pop(),
                child: const Text('返回列表'),
              ),
            ],
          ),
        ),
      );
    }
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
        await _loadDanmakuSource();
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
          if (monitor.status == LiveStatus.live) ...[
            const SizedBox(height: 12),
            _buildAssistantSpeakerCard(),
          ],
          const SizedBox(height: 12),
          _buildDanmakuSourceCard(monitor),
          const SizedBox(height: 12),
          _buildTestDanmakuSection(monitor),
          const SizedBox(height: 12),
          _buildComplianceBadge(monitor),
          const SizedBox(height: 16),
          _buildInteractionStatsSection(monitor),
          const SizedBox(height: 16),
          _buildRepliesSection(monitor),
          const SizedBox(height: 16),
          _buildDanmakuSection(),
        ],
      ),
    );
  }

  /// 助播机出声端开关卡（P1 手机线）：直播中可把本机当出声端，
  /// 轮询远程出声队列并把 AI 语音经音频转接线送入开播手机。
  Widget _buildAssistantSpeakerCard() {
    final speaker = ref.watch(assistantSpeakerControllerProvider);
    // R53：掉线告警要用监控快照里的心跳（页面持有的那份）
    final monitor = _monitor;
    _speakerNotifier ??= ref.read(assistantSpeakerControllerProvider.notifier);
    final enabled = speaker.enabled;
    final accent = enabled ? AppColors.live : AppColors.nightTextFaint;
    return Container(
      key: const Key('liveMonitorSpeakerCard'),
      padding: const EdgeInsets.fromLTRB(16, 14, 16, 12),
      decoration: BoxDecoration(
        color: AppColors.nightCard,
        borderRadius: BorderRadius.circular(18),
        border: Border.all(color: AppColors.nightStroke),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Container(
                width: 40,
                height: 40,
                decoration: BoxDecoration(
                  color: enabled
                      ? AppColors.live.withValues(alpha: 0.16)
                      : AppColors.nightCardHi,
                  borderRadius: BorderRadius.circular(12),
                ),
                child: Icon(
                  Icons.speaker_phone_outlined,
                  size: 20,
                  color: accent,
                ),
              ),
              const SizedBox(width: 12),
              const Expanded(
                child: Text(
                  '助播机出声（手机线）',
                  style: TextStyle(
                    fontSize: 15,
                    fontWeight: FontWeight.w600,
                    color: AppColors.nightText,
                  ),
                ),
              ),
              Container(
                padding: const EdgeInsets.symmetric(
                  horizontal: 10,
                  vertical: 4,
                ),
                decoration: BoxDecoration(
                  color: accent.withValues(alpha: 0.16),
                  borderRadius: BorderRadius.circular(999),
                ),
                child: Text(
                  _speakerStatusLabel(speaker),
                  key: const Key('liveMonitorSpeakerState'),
                  style: TextStyle(
                    fontSize: 12,
                    color: accent,
                    fontWeight: FontWeight.w700,
                  ),
                ),
              ),
            ],
          ),
          const SizedBox(height: 10),
          const Text(
            '启用后本机轮询播报队列并出声，经音频转接线送入开播手机；'
            '需服务端 LIVE_SPEAKER_OUTPUT=phone。开启后记忆为常开，'
            '下次进入直播将自动启用；首次开启请按引导放行后台，'
            '避免切后台 / 锁屏时被系统冻结而中断出声。',
            style: TextStyle(
              fontSize: 12,
              color: AppColors.nightTextDim,
              height: 1.45,
            ),
          ),
          if (enabled && speaker.status == AssistantSpeakerStatus.error) ...[
            const SizedBox(height: 6),
            Text(
              speaker.lastError ?? '连接异常',
              style: const TextStyle(fontSize: 12, color: AppColors.danger),
            ),
          ],
          // ★R53：助播机掉线告警 —— 「AI 在说，但声音送不出去」。
          // 2026-09-18 实测：助播机被系统冻结后不再拉音频，服务端早有 warn 日志
          // （loopCaster「疑似助播机未轮询」），但**商家看不到**，AI 独自讲了 15 分钟。
          // 判据用「距上次拉取多少秒」，而不是「有没有拉过」—— 后者抓不到「拉了又停」。
          // 只在**本机确实开着出声**且**场次在播**时提示，避免商家主动关掉时误报。
          if (enabled &&
              monitor != null &&
              monitor.status == LiveStatus.live &&
              (monitor.speakerSecondsSincePull ?? 0) >= 30) ...[
            const SizedBox(height: 10),
            Container(
              key: const Key('liveMonitorSpeakerStaleWarn'),
              padding: const EdgeInsets.all(10),
              decoration: BoxDecoration(
                color: AppColors.danger.withValues(alpha: 0.16),
                borderRadius: BorderRadius.circular(10),
              ),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Icon(Icons.error_outline, size: 15, color: AppColors.danger),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      '这台手机已经 ${monitor.speakerSecondsSincePull ?? 0} 秒没来取音频了 —— '
                      'AI 还在说，但声音送不出去。请确认本机没被杀后台 / 锁屏冻结，'
                      '并在系统设置里允许自启动。',
                      style: const TextStyle(
                        fontSize: 11,
                        height: 1.5,
                        color: AppColors.nightText,
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ],
          const SizedBox(height: 4),
          Row(
            children: [
              const Icon(
                Icons.history,
                size: 14,
                color: AppColors.nightTextFaint,
              ),
              const SizedBox(width: 6),
              Text(
                '累计播报 ${speaker.playedCount} 条',
                style: const TextStyle(
                  fontSize: 12,
                  color: AppColors.nightTextFaint,
                ),
              ),
              const Spacer(),
              Switch(
                key: const Key('liveMonitorSpeakerSwitch'),
                value: enabled,
                activeThumbColor: AppColors.live,
                activeTrackColor: AppColors.live.withValues(alpha: 0.35),
                onChanged: (value) async {
                  // 常开记忆写回本地，再启停出声端
                  final prefs = await SharedPreferences.getInstance();
                  await prefs.setBool(_speakerAlwaysOnKey, value);
                  _speakerAlwaysOn = value;
                  _speakerPrefLoaded = true;
                  final notifier = ref.read(
                    assistantSpeakerControllerProvider.notifier,
                  );
                  if (value) {
                    notifier.start(liveId: widget.liveId);
                    // 首次启用出声时引导一次后台保活；不阻断开播
                    await _maybeShowKeepAliveGuide();
                  } else {
                    notifier.stop();
                  }
                },
              ),
            ],
          ),
        ],
      ),
    );
  }

  /// 首次启用助播出声时弹一次后台保活引导：极简系统风弹窗告知「锁屏可能
  /// 导致出声中断」，并给一键去系统设置放行的入口。
  /// 仅 Android 有效（电池优化设置是 Android 概念）；仅引导一次、不阻断。
  Future<void> _maybeShowKeepAliveGuide() async {
    if (!mounted || defaultTargetPlatform != TargetPlatform.android) {
      return;
    }
    try {
      final prefs = await SharedPreferences.getInstance();
      if (!mounted || (prefs.getBool(_keepAliveGuidedKey) ?? false)) {
        return;
      }
      await prefs.setBool(_keepAliveGuidedKey, true);
      final bridge = ref.read(keepAliveBridgeProvider);
      final exempt = await bridge.isIgnoringBatteryOptimizations();
      if (!mounted) {
        return;
      }
      await showKeepAliveGuideDialog(
        context,
        batteryExempt: exempt,
        onOpenSettings: bridge.openBatteryOptimizationSettings,
      );
    } catch (_) {
      // 引导只是锦上添花：原生桥不可用 / 读写偏好失败时静默跳过，不阻断开播
    }
  }

  /// 出声端状态文案：未启用 / 监听中 / 播报中 / 连接异常。
  String _speakerStatusLabel(AssistantSpeakerState speaker) {
    switch (speaker.status) {
      case AssistantSpeakerStatus.idle:
        return '未启用';
      case AssistantSpeakerStatus.waiting:
        return speaker.enabled ? '监听中' : '未启用';
      case AssistantSpeakerStatus.playing:
        return '播报中';
      case AssistantSpeakerStatus.error:
        return '连接异常';
    }
  }

  /// 开播前出声自检卡：就绪（ready）态提示直播画面与出声链路准备，
  /// 覆盖电脑线（虚拟声卡 → 直播伴侣）与手机线（音频转接线接入开播手机）
  /// 两种出声方式；开播后自动消失，不打扰直播中监控。
  Widget _buildPreflightCard() {
    return Container(
      key: const Key('liveMonitorPreflight'),
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: AppColors.nightCard,
        borderRadius: BorderRadius.circular(18),
        border: Border.all(color: AppColors.nightStroke),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Container(
                width: 36,
                height: 36,
                decoration: BoxDecoration(
                  color: AppColors.primarySoft,
                  borderRadius: BorderRadius.circular(11),
                ),
                child: const Icon(
                  Icons.fact_check_outlined,
                  size: 18,
                  color: AppColors.primary,
                ),
              ),
              const SizedBox(width: 10),
              const Expanded(
                child: Text(
                  '开播前自检',
                  style: TextStyle(
                    fontSize: 15,
                    fontWeight: FontWeight.w600,
                    color: AppColors.nightText,
                  ),
                ),
              ),
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                decoration: BoxDecoration(
                  color: AppColors.warningSoft,
                  borderRadius: BorderRadius.circular(999),
                ),
                child: const Text(
                  '待确认',
                  style: TextStyle(
                    fontSize: 11,
                    color: AppColors.warning,
                    fontWeight: FontWeight.w700,
                  ),
                ),
              ),
            ],
          ),
          const SizedBox(height: 14),
          _buildPreflightItem('直播间画面已开播（直播伴侣 / 手机开播），真人出镜正常'),
          const SizedBox(height: 10),
          _buildPreflightItem(
            '出声链路就位：电脑线 = 系统默认播放指向虚拟声卡、直播伴侣麦克风选 '
            'CABLE Output；手机线 = 出声设备经音频转接线连到开播手机',
          ),
          const SizedBox(height: 10),
          _buildPreflightItem('开播后在本页发一条测试弹幕，确认直播间能听到 AI 语音回复'),
        ],
      ),
    );
  }

  /// 自检卡单行条目：左侧对勾图标 + 说明文字。
  Widget _buildPreflightItem(String text) {
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Container(
          margin: const EdgeInsets.only(top: 1),
          width: 18,
          height: 18,
          decoration: BoxDecoration(
            color: AppColors.live.withValues(alpha: 0.16),
            shape: BoxShape.circle,
          ),
          child: const Icon(Icons.check, size: 12, color: AppColors.live),
        ),
        const SizedBox(width: 10),
        Expanded(
          child: Text(
            text,
            style: const TextStyle(
              fontSize: 13,
              color: AppColors.nightTextDim,
              height: 1.45,
            ),
          ),
        ),
      ],
    );
  }

  /// 顶部状态卡片：状态徽章 + 已播时长。
  Widget _buildStatusCard(LiveMonitor monitor, int durationSeconds) {
    final color = _statusColor(monitor.status);
    final live = monitor.status == LiveStatus.live;
    final label = _durationLabel(durationSeconds);
    return Container(
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(20),
        gradient: const LinearGradient(
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
          colors: [AppColors.nightCardHi, AppColors.nightCard],
        ),
        border: Border.all(color: AppColors.nightStroke),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(18, 18, 18, 16),
            child: Row(
              children: [
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Container(
                        padding: const EdgeInsets.symmetric(
                          horizontal: 10,
                          vertical: 5,
                        ),
                        decoration: BoxDecoration(
                          color: color.withValues(alpha: 0.16),
                          borderRadius: BorderRadius.circular(999),
                          border: Border.all(
                            color: color.withValues(alpha: 0.45),
                          ),
                        ),
                        child: Text(
                          monitor.status.label,
                          key: const Key('liveMonitorStatus'),
                          style: TextStyle(
                            fontSize: 13,
                            color: color,
                            fontWeight: FontWeight.w700,
                          ),
                        ),
                      ),
                      const SizedBox(height: 12),
                      Row(
                        children: [
                          Container(
                            width: 8,
                            height: 8,
                            decoration: BoxDecoration(
                              shape: BoxShape.circle,
                              color: live ? AppColors.live : color,
                            ),
                          ),
                          const SizedBox(width: 6),
                          Text(
                            _phaseLabel(monitor.status),
                            style: const TextStyle(
                              fontSize: 13,
                              color: AppColors.nightTextDim,
                            ),
                          ),
                        ],
                      ),
                    ],
                  ),
                ),
                Column(
                  crossAxisAlignment: CrossAxisAlignment.end,
                  children: [
                    const Text(
                      '已播时长',
                      style: TextStyle(
                        fontSize: 12,
                        color: AppColors.nightTextFaint,
                      ),
                    ),
                    const SizedBox(height: 6),
                    Text(
                      label,
                      key: const Key('liveMonitorDuration'),
                      style: const TextStyle(
                        fontSize: 36,
                        fontWeight: FontWeight.w700,
                        color: AppColors.nightText,
                        letterSpacing: 1.2,
                        fontFeatures: [FontFeature.tabularFigures()],
                      ),
                    ),
                  ],
                ),
              ],
            ),
          ),
          Container(
            width: double.infinity,
            padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 12),
            decoration: const BoxDecoration(
              color: AppColors.primarySoft,
              border: Border(top: BorderSide(color: AppColors.nightStroke)),
            ),
            child: Row(
              children: [
                const Icon(
                  Icons.forum_outlined,
                  size: 16,
                  color: AppColors.primary,
                ),
                const SizedBox(width: 8),
                Text(
                  '弹幕 ${monitor.danmakuCount} 条',
                  key: const Key('liveMonitorDanmakuCount'),
                  style: const TextStyle(
                    fontSize: 13,
                    color: AppColors.nightTextDim,
                    fontWeight: FontWeight.w600,
                  ),
                ),
                const Spacer(),
                if (live)
                  Row(
                    children: const [
                      Icon(
                        Icons.fiber_manual_record,
                        size: 8,
                        color: AppColors.live,
                      ),
                      SizedBox(width: 4),
                      Text(
                        'AI 实时播报中',
                        style: TextStyle(
                          fontSize: 11,
                          color: AppColors.nightTextFaint,
                        ),
                      ),
                    ],
                  ),
              ],
            ),
          ),
        ],
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
      if (monitor.loopRunning) {
        // M5：循环台本播出中 —— 状态胶囊带出当前条 / 轮
        stateText =
            '循环播报中 · 第 ${monitor.loopCurrentSeq} 条 / 第 ${monitor.loopRound} 轮';
        note = '真人出镜现场，AI 语音主播正在按台本循环介绍产品，并可在空档回复弹幕。';
      } else if (monitor.loopMissing) {
        // M5：未绑定循环台本 —— 开播也只回弹幕，需要提示绑定
        stateText = '播报中';
        note = '未绑定循环台本（仅弹幕回复）：AI 只在收到弹幕时回复；绑定台本并开播后才会自动循环口播介绍产品。';
      } else {
        stateText = '播报中';
        note = '真人出镜现场，AI 语音主播在后台实时朗读弹幕、介绍产品并回复提问。';
      }
      stateColor = AppColors.live;
    } else if (ready) {
      stateText = '待开播';
      note = '配置已就绪，点击下方「开始直播」后 AI 语音主播将上线播报。';
      stateColor = AppColors.primary;
    } else if (finished) {
      stateText = '已停止';
      note = '直播已结束，AI 语音播报已停止。';
      stateColor = AppColors.nightTextFaint;
    } else {
      stateText = '待机';
      note = '直播尚未开播，AI 语音主播暂未上线。';
      stateColor = AppColors.info;
    }
    return Container(
      key: const Key('liveMonitorAiHostCard'),
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: AppColors.nightCard,
        borderRadius: BorderRadius.circular(18),
        border: Border.all(color: AppColors.nightStroke),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Container(
            width: 44,
            height: 44,
            decoration: BoxDecoration(
              color: stateColor.withValues(alpha: 0.16),
              borderRadius: BorderRadius.circular(14),
            ),
            child: Icon(Icons.record_voice_over, color: stateColor, size: 22),
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
                          color: AppColors.nightText,
                        ),
                      ),
                    ),
                    Container(
                      constraints: const BoxConstraints(maxWidth: 220),
                      padding: const EdgeInsets.symmetric(
                        horizontal: 10,
                        vertical: 4,
                      ),
                      decoration: BoxDecoration(
                        color: stateColor.withValues(alpha: 0.16),
                        borderRadius: BorderRadius.circular(999),
                      ),
                      child: Text(
                        stateText,
                        key: const Key('liveMonitorAiHostState'),
                        style: TextStyle(
                          fontSize: 12,
                          color: stateColor,
                          fontWeight: FontWeight.w700,
                        ),
                        maxLines: 2,
                        textAlign: TextAlign.right,
                        overflow: TextOverflow.ellipsis,
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 6),
                Text(
                  note,
                  key: const Key('liveMonitorAiHostNote'),
                  style: const TextStyle(
                    fontSize: 13,
                    color: AppColors.nightTextDim,
                    height: 1.45,
                  ),
                ),
                // 热更入口：仅直播中可用（服务端非 live 返回 409）。
                // 「更新话术」= 换弹幕回复知识，新弹幕立即生效；
                // 「更新循环台词」= 换轮播台本，下一轮开头重读生效、不打断当前句。
                if (live) ...[
                  const SizedBox(height: 10),
                  Wrap(
                    spacing: 8,
                    runSpacing: 8,
                    children: [
                      OutlinedButton.icon(
                        key: const Key('liveMonitorUpdateScriptButton'),
                        onPressed: _updatingScript ? null : _updateScript,
                        icon: const Icon(Icons.description_outlined, size: 18),
                        label: Text(_updatingScript ? '更新中…' : '更新话术'),
                        style: _hotSwapButtonStyle(),
                      ),
                      OutlinedButton.icon(
                        key: const Key('liveMonitorUpdateLoopButton'),
                        onPressed: _updatingLoop ? null : _updateLoopScript,
                        icon: const Icon(Icons.playlist_play, size: 18),
                        label: Text(_updatingLoop ? '更新中…' : '更新循环台词'),
                        style: _hotSwapButtonStyle(),
                      ),
                    ],
                  ),
                ],
              ],
            ),
          ),
        ],
      ),
    );
  }

  /// 热更按钮统一样式：工作台内两个入口视觉一致
  ButtonStyle _hotSwapButtonStyle() => OutlinedButton.styleFrom(
        foregroundColor: AppColors.nightText,
        side: const BorderSide(color: AppColors.nightStroke),
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
        minimumSize: const Size(0, 34),
        tapTargetSize: MaterialTapTargetSize.shrinkWrap,
      );

  /// 直播中热更话术（弹幕回复知识）：选一条我的「可开播」话术后调
  /// /api/lives/:id/script 换绑；弹幕回复上下文按条实时读取，新弹幕立即生效。
  Future<void> _updateScript() async {
    if (_updatingScript) {
      return;
    }
    setState(() => _updatingScript = true);
    try {
      final scripts = await ref.read(apiClientProvider).listScripts();
      if (!mounted) {
        return;
      }
      final ready = scripts.where((script) => script.isReady).toList();
      if (ready.isEmpty) {
        _showSnack('暂无可开播的话术，请先生成并通过敏感词扫描');
        return;
      }
      final picked = await showModalBottomSheet<String>(
        context: context,
        isScrollControlled: true,
        builder: (sheetContext) {
          return SafeArea(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                const Padding(
                  padding: EdgeInsets.fromLTRB(16, 16, 16, 0),
                  child: Align(
                    alignment: Alignment.centerLeft,
                    child: Text(
                      '更新话术（仅「可开播」话术可选）',
                      style: TextStyle(fontSize: 16, fontWeight: FontWeight.bold),
                    ),
                  ),
                ),
                Flexible(
                  child: ListView(
                    shrinkWrap: true,
                    children: [
                      for (final script in ready)
                        ListTile(
                          key: Key('liveMonitorScriptOption_${script.id}'),
                          title: Text(
                            script.displayTitle,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                          ),
                          subtitle: const Text(
                            '新弹幕将用该话术回复',
                            style: TextStyle(fontSize: 12),
                          ),
                          onTap: () =>
                              Navigator.of(sheetContext).pop(script.id),
                        ),
                    ],
                  ),
                ),
              ],
            ),
          );
        },
      );
      if (!mounted || picked == null) {
        return;
      }
      await ref
          .read(apiClientProvider)
          .bindLiveScript(widget.liveId, scriptId: picked);
      if (!mounted) {
        return;
      }
      _showSnack('话术已更新，新弹幕将用新话术回复');
      await _loadMonitor();
    } on ApiException catch (error) {
      if (mounted) {
        _showSnack('更新话术失败：${error.message}');
      }
    } finally {
      if (mounted) {
        setState(() => _updatingScript = false);
      }
    }
  }

  /// 直播中热更循环台词（轮播台本）：选一本我的台本后调
  /// /api/lives/:id/loop-script 换绑，引擎下一轮开头重读，不打断当前句。
  Future<void> _updateLoopScript() async {
    final picked = await context.push<LoopScript>('/loop-scripts?select=1');
    if (!mounted || picked == null) {
      return;
    }
    setState(() => _updatingLoop = true);
    try {
      await ref
          .read(apiClientProvider)
          .bindLiveLoopScript(widget.liveId, loopScriptId: picked.id);
      if (!mounted) {
        return;
      }
      _showSnack('循环台词已更新，将在下一轮生效');
      await _loadMonitor();
    } on ApiException catch (error) {
      if (mounted) {
        _showSnack('更新话术失败：${error.message}');
      }
    } finally {
      if (mounted) {
        setState(() => _updatingLoop = false);
      }
    }
  }


  /// 拉取本场采集源状态（只读）。失败静默：采集状态是旁路信息，
  /// 拉不到就维持上一次快照，不打断工作台。
  Future<void> _loadDanmakuSource() async {
    try {
      final status = await ref
          .read(apiClientProvider)
          .fetchDanmakuSource(widget.liveId);
      if (mounted) {
        setState(() => _danmakuSource = status);
      }
    } on ApiException {
      // 旁路信息：静默保持旧快照
    }
  }

  /// 起采集：把分享文本交给服务端（短链展开在服务端完成），以观众身份连入监听。
  /// 仅直播中可用；服务端未配签名 Key 时返回 503 SOURCE_DISABLED。
  Future<void> _bindDanmakuSource() async {
    final text = _sourceController.text.trim();
    if (text.isEmpty) {
      return;
    }
    setState(() => _bindingSource = true);
    try {
      final binding = await ref
          .read(apiClientProvider)
          .bindDanmakuSource(widget.liveId, shareText: text);
      if (!mounted) {
        return;
      }
      _sourceController.clear();
      _showSnack('正在监听 ${binding.platformLabel} 直播间 ${binding.roomRef}');
      await _loadDanmakuSource();
    } on ApiException catch (error) {
      if (mounted) {
        _showSnack('起采集失败：${error.message}');
      }
    } finally {
      if (mounted) {
        setState(() => _bindingSource = false);
      }
    }
  }

  /// 停采集并解绑（幂等）。
  Future<void> _stopDanmakuSource() async {
    setState(() => _stoppingSource = true);
    try {
      await ref.read(apiClientProvider).stopDanmakuSource(widget.liveId);
      if (!mounted) {
        return;
      }
      _showSnack('已停止采集');
      await _loadDanmakuSource();
    } on ApiException catch (error) {
      if (mounted) {
        _showSnack('停止采集失败：${error.message}');
      }
    } finally {
      if (mounted) {
        setState(() => _stoppingSource = false);
      }
    }
  }

  /// 采集状态文案：把「通道是否启用 / 有没有绑定 / 会话什么状态」讲成一句人话。
  String _sourceHintText(LiveMonitor monitor) {
    final source = _danmakuSource;
    if (source != null && !source.enabled) {
      return '该服务端未配置签名 Key，采集通道未启用';
    }
    final binding = source?.binding;
    if (binding == null) {
      return monitor.status == LiveStatus.live
          ? '贴一段直播分享链接，服务端会以观众身份连入监听真实弹幕'
          : '开播后即可开始采集';
    }
    final state = source?.watch?.label ?? '未在监听';
    final err = source?.watch?.lastError;
    // R49：把「可以换」写出来 —— 之前这段只说在监听哪个房间，
    // 商家想换直播间时会以为必须先停止。
    return '${binding.platformLabel} · 房间 ${binding.roomRef} · $state'
        '${err == null || err.isEmpty ? '' : '（$err）'}'
        '　换直播间：贴新链接点「换链接」即可';
  }

  /// 弹幕采集卡（R2 · D4.1）：现场工作台里「真实弹幕」的入口。
  /// 与下方「发送测试弹幕」并列 —— 一个喂真数据，一个手工联调。
  Widget _buildDanmakuSourceCard(LiveMonitor monitor) {
    final source = _danmakuSource;
    final enabled = source?.enabled ?? true;
    final binding = source?.binding;
    final watch = source?.watch;
    final live = monitor.status == LiveStatus.live;
    final canBind =
        enabled && live && !_bindingSource && _sourceController.text.trim().isNotEmpty;
    return Container(
      key: const Key('liveMonitorSourceCard'),
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: AppColors.nightCard,
        borderRadius: BorderRadius.circular(18),
        border: Border.all(color: AppColors.nightStroke),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Container(
                width: 36,
                height: 36,
                decoration: BoxDecoration(
                  color: AppColors.live.withValues(alpha: 0.16),
                  borderRadius: BorderRadius.circular(11),
                ),
                child: const Icon(
                  Icons.podcasts_outlined,
                  size: 18,
                  color: AppColors.live,
                ),
              ),
              const SizedBox(width: 10),
              const Expanded(
                child: Text(
                  '弹幕采集',
                  style: TextStyle(
                    fontSize: 15,
                    fontWeight: FontWeight.w600,
                    color: AppColors.nightText,
                  ),
                ),
              ),
              if (binding != null)
                TextButton(
                  key: const Key('liveMonitorSourceStop'),
                  onPressed: _stoppingSource ? null : _stopDanmakuSource,
                  child: Text(_stoppingSource ? '停止中…' : '停止'),
                ),
            ],
          ),
          const SizedBox(height: 4),
          Text(
            _sourceHintText(monitor),
            key: const Key('liveMonitorSourceState'),
            style: const TextStyle(
              fontSize: 12,
              color: AppColors.nightTextDim,
              height: 1.4,
            ),
          ),
          // ★R51：连着但长时间零事件 —— 最危险的一种「看着正常」。
          // 2026-09-18 商家中途下播重开、抖音给了新房间号，我们的采集仍连着旧房间：
          // connected、lastError 为空、台本照跑，**一切看着都对**，实际零事件，
          // AI 独自讲了 15 分钟才被人发现。这里必须主动说话。
          if (watch != null && watch.looksIdle) ...[
            const SizedBox(height: 10),
            Container(
              key: const Key('liveMonitorSourceIdleWarn'),
              padding: const EdgeInsets.all(10),
              decoration: BoxDecoration(
                color: AppColors.warning.withValues(alpha: 0.14),
                borderRadius: BorderRadius.circular(10),
              ),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Icon(
                    Icons.warning_amber_rounded,
                    size: 15,
                    color: AppColors.warning,
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      '已连接，但 ${(watch.idleSeconds() ?? 0) ~/ 60} 分钟没收到任何弹幕。'
                      '若你中途重开过抖音直播，房间号会变 —— 请粘贴新链接后点「换链接」。',
                      style: const TextStyle(
                        fontSize: 11,
                        height: 1.5,
                        color: AppColors.nightText,
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ],
          // ★R49：绑定了也**照样显示输入行** —— 原先 `binding == null` 才渲染，
          // 于是想换直播间只能「先停止、再粘新的」，既绕又容易停在半路。
          // 现在贴着新链接点一次即可换（服务端会先断旧会话再连新的）。
          if (enabled && live) ...[
            const SizedBox(height: 12),
            Row(
              crossAxisAlignment: CrossAxisAlignment.center,
              children: [
                Expanded(
                  child: TextField(
                    key: const Key('liveMonitorSourceInput'),
                    controller: _sourceController,
                    enabled: live && !_bindingSource,
                    textInputAction: TextInputAction.done,
                    onChanged: (_) => setState(() {}),
                    onSubmitted: canBind ? (_) => _bindDanmakuSource() : null,
                    style: const TextStyle(color: AppColors.nightText),
                    decoration: InputDecoration(
                      hintText: binding == null
                          ? '粘贴抖音分享链接 / 文本'
                          : '粘贴新链接可换直播间（自动重连）',
                      isDense: true,
                      border: OutlineInputBorder(
                        borderRadius: BorderRadius.circular(12),
                      ),
                    ),
                  ),
                ),
                const SizedBox(width: 10),
                SizedBox(
                  height: 48,
                  child: FilledButton(
                    key: const Key('liveMonitorSourceBind'),
                    onPressed: canBind ? _bindDanmakuSource : null,
                    style: FilledButton.styleFrom(
                      padding: const EdgeInsets.symmetric(horizontal: 20),
                      shape: RoundedRectangleBorder(
                        borderRadius: BorderRadius.circular(12),
                      ),
                    ),
                    child: _bindingSource
                        ? const SizedBox(
                            width: 16,
                            height: 16,
                            child: CircularProgressIndicator(strokeWidth: 2),
                          )
                        // R49：已绑定时按钮语义是「换链接」而不是「开始采集」
                        : Text(binding == null ? '开始采集' : '换链接'),
                  ),
                ),
              ],
            ),
          ],
        ],
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
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: AppColors.nightCard,
        borderRadius: BorderRadius.circular(18),
        border: Border.all(color: AppColors.nightStroke),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Container(
                width: 36,
                height: 36,
                decoration: BoxDecoration(
                  color: AppColors.info.withValues(alpha: 0.16),
                  borderRadius: BorderRadius.circular(11),
                ),
                child: const Icon(
                  Icons.science_outlined,
                  size: 18,
                  color: AppColors.info,
                ),
              ),
              const SizedBox(width: 10),
              const Expanded(
                child: Text(
                  '发送测试弹幕',
                  style: TextStyle(
                    fontSize: 15,
                    fontWeight: FontWeight.w600,
                    color: AppColors.nightText,
                  ),
                ),
              ),
            ],
          ),
          const SizedBox(height: 4),
          Text(
            _testDanmakuHint(monitor.status),
            key: const Key('liveMonitorTestHint'),
            style: const TextStyle(
              fontSize: 12,
              color: AppColors.nightTextDim,
              height: 1.4,
            ),
          ),
          const SizedBox(height: 12),
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
                  style: const TextStyle(color: AppColors.nightText),
                  decoration: InputDecoration(
                    hintText: '如：今天双人套餐多少钱？',
                    counterText: '',
                    isDense: true,
                    border: OutlineInputBorder(
                      borderRadius: BorderRadius.circular(12),
                    ),
                  ),
                ),
              ),
              const SizedBox(width: 10),
              SizedBox(
                height: 48,
                child: FilledButton(
                  key: const Key('liveMonitorTestSend'),
                  onPressed: canSend ? _sendTestDanmaku : null,
                  style: FilledButton.styleFrom(
                    padding: const EdgeInsets.symmetric(horizontal: 20),
                    shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(12),
                    ),
                  ),
                  child: _sendingDanmaku
                      ? const SizedBox(
                          width: 16,
                          height: 16,
                          child: CircularProgressIndicator(strokeWidth: 2),
                        )
                      : const Text('发送'),
                ),
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
    final ok = monitor.aiBadgeShown;
    final color = ok ? AppColors.warning : AppColors.danger;
    final background = ok
        ? AppColors.warningSoft
        : AppColors.danger.withValues(alpha: 0.14);
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
      decoration: BoxDecoration(
        color: background,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: color.withValues(alpha: 0.35)),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(
            ok ? Icons.verified_outlined : Icons.warning_amber_rounded,
            size: 18,
            color: color,
          ),
          const SizedBox(width: 10),
          Expanded(
            child: Text(
              monitor.aiBadgeShown
                  ? '合规提示：直播画面已强制叠加「AI 智能直播」角标，无法关闭。'
                  : '合规提示：直播画面未检测到 AI 角标。',
              key: const Key('liveMonitorBadgeNote'),
              style: TextStyle(fontSize: 12.5, color: color, height: 1.4),
            ),
          ),
        ],
      ),
    );
  }

  /// 弹幕日志区：只读滚动展示；空态显示「暂无弹幕」。
  /// R24：AI 回复区 —— 让商家看得见「AI 到底回了什么」。
  /// 服务端是内存台账（开播清空、结束保留、重启即丢），这里只做展示。
  /// R45：互动概况 —— 让商家看见「收到多少 / 有效多少 / 回了多少 / 因为频次漏了多少」。
  ///
  /// 这是**唯一**能让商家判断「回复频次是不是设得太紧」的地方：
  /// 没有它，商家只会觉得「今天 AI 怎么不搭理人」，却不知道是自己的设置挡的。
  Widget _buildInteractionStatsSection(LiveMonitor monitor) {
    final stats = monitor.interactionStats;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            const Text(
              '互动概况',
              style: TextStyle(
                fontSize: 15,
                fontWeight: FontWeight.w700,
                color: AppColors.nightText,
              ),
            ),
            const SizedBox(width: 8),
            Text(
              '收到 ${stats.received} 条',
              style: const TextStyle(fontSize: 11, color: AppColors.nightTextFaint),
            ),
          ],
        ),
        const SizedBox(height: 10),
        Container(
          key: const Key('liveMonitorStatsCard'),
          width: double.infinity,
          padding: const EdgeInsets.all(14),
          decoration: BoxDecoration(
            color: AppColors.nightCard,
            borderRadius: BorderRadius.circular(16),
            border: Border.all(color: AppColors.nightStroke),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                mainAxisAlignment: MainAxisAlignment.spaceAround,
                children: [
                  _statCell('有效提问', stats.valid, AppColors.nightText),
                  _statCell('已回复', stats.replied, AppColors.live),
                  _statCell(
                    '因频次漏掉',
                    stats.throttled,
                    stats.throttled > 0 ? AppColors.warning : AppColors.nightTextDim,
                  ),
                ],
              ),
              const Divider(height: 20, color: AppColors.nightStroke),
              Text(
                '挡掉无效弹幕 ${stats.filtered} 条（灌水 ${stats.spam} · 闲聊 ${stats.smalltalk} · 问候 ${stats.greeting}）',
                style: const TextStyle(fontSize: 11, color: AppColors.nightTextFaint),
              ),
              if (monitor.pendingReplies > 0) ...[
                const SizedBox(height: 4),
                Text(
                  '排队中 ${monitor.pendingReplies} 条（台本每句之间放一条）',
                  key: const Key('liveMonitorStatsPending'),
                  style: const TextStyle(fontSize: 11, color: AppColors.nightTextFaint),
                ),
              ],
              // 可执行的那一句：把数字翻译成「你该做什么」
              if (stats.throttledHeavy) ...[
                const SizedBox(height: 10),
                Container(
                  key: const Key('liveMonitorStatsHint'),
                  padding: const EdgeInsets.all(10),
                  decoration: BoxDecoration(
                    color: AppColors.warning.withValues(alpha: 0.14),
                    borderRadius: BorderRadius.circular(10),
                  ),
                  child: Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      const Icon(Icons.info_outline, size: 15, color: AppColors.warning),
                      const SizedBox(width: 8),
                      Expanded(
                        child: Text(
                          '有 ${stats.throttled} 条有效提问因为频次被挡下，比回出去的还多 —— 可以去「我的 → 智能回复与话术」把回复频次放宽。',
                          style: const TextStyle(
                            fontSize: 11,
                            height: 1.5,
                            color: AppColors.nightText,
                          ),
                        ),
                      ),
                    ],
                  ),
                ),
              ],
            ],
          ),
        ),
      ],
    );
  }

  Widget _statCell(String label, int value, Color color) {
    return Column(
      children: [
        Text(
          '$value',
          style: TextStyle(fontSize: 22, fontWeight: FontWeight.w700, color: color),
        ),
        const SizedBox(height: 2),
        Text(label, style: const TextStyle(fontSize: 11, color: AppColors.nightTextFaint)),
      ],
    );
  }

  Widget _buildRepliesSection(LiveMonitor monitor) {
    final replies = monitor.recentReplies;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            const Text(
              'AI 回复',
              style: TextStyle(
                fontSize: 15,
                fontWeight: FontWeight.w700,
                color: AppColors.nightText,
              ),
            ),
            const SizedBox(width: 8),
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
              decoration: BoxDecoration(
                color: AppColors.nightCardHi,
                borderRadius: BorderRadius.circular(999),
              ),
              child: Text(
                '共 ${replies.length} 条',
                key: const Key('liveMonitorReplyCount'),
                style: const TextStyle(
                  fontSize: 11,
                  color: AppColors.nightTextFaint,
                ),
              ),
            ),
          ],
        ),
        const SizedBox(height: 10),
        if (replies.isEmpty)
          Container(
            key: const Key('liveMonitorRepliesEmpty'),
            width: double.infinity,
            padding: const EdgeInsets.symmetric(vertical: 28),
            decoration: BoxDecoration(
              color: AppColors.nightCard,
              borderRadius: BorderRadius.circular(16),
              border: Border.all(color: AppColors.nightStroke),
            ),
            child: Column(
              children: [
                const Icon(
                  Icons.record_voice_over_outlined,
                  size: 34,
                  color: AppColors.nightTextFaint,
                ),
                const SizedBox(height: 8),
                const Text(
                  '还没有回复',
                  style: TextStyle(color: AppColors.nightTextDim),
                ),
                const SizedBox(height: 4),
                const Text(
                  '观众提问后，AI 的回话会出现在这里',
                  style: TextStyle(fontSize: 11, color: AppColors.nightTextFaint),
                ),
              ],
            ),
          )
        else
          for (final item in replies) _buildReplyItem(item),
      ],
    );
  }

  Widget _buildReplyItem(LiveReply item) {
    final nickname = (item.senderNickname ?? '').trim();
    return Container(
      key: Key('liveMonitorReply_${item.createdAt}'),
      width: double.infinity,
      margin: const EdgeInsets.only(bottom: 8),
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: AppColors.nightCard,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: AppColors.nightStroke),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              const Icon(Icons.smart_toy_outlined, size: 14, color: AppColors.primary),
              const SizedBox(width: 6),
              if (nickname.isNotEmpty)
                Text(
                  '回给 $nickname',
                  style: const TextStyle(fontSize: 11, color: AppColors.nightTextFaint),
                ),
              const Spacer(),
              // 兜底话术要能一眼看出来：那句不是 AI 想的，是命中敏感词后的安全替身
              if (item.isFallback)
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
                  decoration: BoxDecoration(
                    color: AppColors.warning.withValues(alpha: 0.18),
                    borderRadius: BorderRadius.circular(6),
                  ),
                  child: const Text(
                    '兜底话术',
                    style: TextStyle(fontSize: 10, color: AppColors.warning),
                  ),
                ),
              // R32：固定回复标出来 —— 商家能看出「这条没花 AI 的钱」
              if (item.isFaq)
                Container(
                  key: const Key('liveMonitorReplyFaqBadge'),
                  padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
                  decoration: BoxDecoration(
                    color: AppColors.live.withValues(alpha: 0.18),
                    borderRadius: BorderRadius.circular(6),
                  ),
                  child: const Text(
                    '固定回复',
                    style: TextStyle(fontSize: 10, color: AppColors.live),
                  ),
                ),
            ],
          ),
          const SizedBox(height: 6),
          Text(
            item.text,
            style: const TextStyle(
              fontSize: 13,
              height: 1.5,
              color: AppColors.nightText,
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildDanmakuSection() {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            const Text(
              '弹幕日志',
              style: TextStyle(
                fontSize: 15,
                fontWeight: FontWeight.w700,
                color: AppColors.nightText,
              ),
            ),
            const SizedBox(width: 8),
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
              decoration: BoxDecoration(
                color: AppColors.nightCardHi,
                borderRadius: BorderRadius.circular(999),
              ),
              child: Text(
                '共 ${_danmaku.length} 条',
                style: const TextStyle(
                  fontSize: 11,
                  color: AppColors.nightTextFaint,
                ),
              ),
            ),
          ],
        ),
        const SizedBox(height: 10),
        if (_danmaku.isEmpty)
          Container(
            key: const Key('liveMonitorDanmakuEmpty'),
            width: double.infinity,
            padding: const EdgeInsets.symmetric(vertical: 28),
            decoration: BoxDecoration(
              color: AppColors.nightCard,
              borderRadius: BorderRadius.circular(16),
              border: Border.all(color: AppColors.nightStroke),
            ),
            child: Column(
              children: [
                const Icon(
                  Icons.chat_bubble_outline,
                  size: 34,
                  color: AppColors.nightTextFaint,
                ),
                const SizedBox(height: 8),
                Text('暂无弹幕', style: TextStyle(color: AppColors.nightTextDim)),
              ],
            ),
          )
        else
          for (final item in _danmaku) _buildDanmakuItem(item),
      ],
    );
  }

  Widget _buildDanmakuItem(LiveDanmaku item) {
    return Container(
      margin: const EdgeInsets.only(bottom: 8),
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: AppColors.nightCard,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: AppColors.nightStroke),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          CircleAvatar(
            radius: 16,
            backgroundColor: AppColors.primarySoft,
            child: Text(
              _nicknameInitial(item.senderNickname),
              style: const TextStyle(
                fontSize: 12,
                color: AppColors.primary,
                fontWeight: FontWeight.w700,
              ),
            ),
          ),
          const SizedBox(width: 10),
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
                        style: const TextStyle(
                          fontSize: 12,
                          color: AppColors.nightTextDim,
                          fontWeight: FontWeight.w600,
                        ),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                      ),
                    ),
                    const SizedBox(width: 8),
                    Text(
                      _sentAtLabel(item.sentAt),
                      style: const TextStyle(
                        fontSize: 11,
                        color: AppColors.nightTextFaint,
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 3),
                Text(
                  item.content,
                  key: Key('liveDanmakuContent_${item.id}'),
                  style: const TextStyle(
                    fontSize: 14,
                    color: AppColors.nightText,
                    height: 1.35,
                  ),
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
      return AppColors.live;
    case LiveStatus.ended:
      return AppColors.nightTextFaint;
    case LiveStatus.idle:
      return AppColors.info;
    case LiveStatus.processing:
      return AppColors.warning;
    case LiveStatus.ready:
      return AppColors.primary;
    case LiveStatus.failed:
      return AppColors.danger;
  }
}
