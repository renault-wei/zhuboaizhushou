/// 独立弹幕监控页（R16b）：贴一段直播分享链接，直接看这个直播间的弹幕流水。
///
/// **不绑场次、不落库** —— 这是它与工作台里「弹幕采集卡」的根本区别：
///   * 采集卡：必须先开一场直播，事件落 live_danmaku 并触发 AI 回复 → 出声（生产链路）；
///   * 本页：随时可用，事件只在服务端内存里缓冲 200 条，**纯看**。
///
/// 用途：验证某直播间能不能采、弹幕长什么样；排障时一眼分清「房间真没人」与「链路坏了」。
library;

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'package:starvoice_app/core/models/danmaku_watch.dart';
import 'package:starvoice_app/core/network/api_exception.dart';
import 'package:starvoice_app/core/theme/app_colors.dart';
import 'package:starvoice_app/providers.dart';

class DanmakuWatchPage extends ConsumerStatefulWidget {
  const DanmakuWatchPage({super.key});

  @override
  ConsumerState<DanmakuWatchPage> createState() => _DanmakuWatchPageState();
}

class _DanmakuWatchPageState extends ConsumerState<DanmakuWatchPage> {
  /// 轮询间隔：够快能看到"在动"，又不至于把服务端问爆
  static const Duration _pollInterval = Duration(seconds: 2);

  final TextEditingController _linkController = TextEditingController();
  Timer? _pollTimer;

  DanmakuWatch? _watch;
  List<DanmakuWatchEvent> _events = const <DanmakuWatchEvent>[];
  int _lastSeq = 0;
  bool _starting = false;
  bool _stopping = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    // 首帧后再请求，避免 build 阶段做网络调用
    WidgetsBinding.instance.addPostFrameCallback((_) => _restoreExisting());
  }

  @override
  void dispose() {
    _pollTimer?.cancel();
    _linkController.dispose();
    super.dispose();
  }

  /// 进页面先看有没有已在跑的监控（服务端是内存态，上次可能没停掉）
  Future<void> _restoreExisting() async {
    try {
      final watches = await ref.read(apiClientProvider).listDanmakuWatches();
      if (!mounted || watches.isEmpty) {
        return;
      }
      setState(() => _watch = watches.first);
      await _loadEvents();
      _startPolling();
    } on ApiException {
      // 旁路工具：拉不到就当没有，不在进入时报错
    }
  }

  void _startPolling() {
    _pollTimer?.cancel();
    _pollTimer = Timer.periodic(_pollInterval, (_) => _loadEvents());
  }

  /// 增量拉取：只取 seq 更大的，避免每轮把整个缓冲重传
  Future<void> _loadEvents() async {
    final watch = _watch;
    if (watch == null) {
      return;
    }
    try {
      final page = await ref
          .read(apiClientProvider)
          .fetchDanmakuWatchEvents(watch.watchId, since: _lastSeq);
      if (!mounted) {
        return;
      }
      if (page.events.isEmpty) {
        return;
      }
      setState(() {
        _events = <DanmakuWatchEvent>[...page.events.reversed, ..._events];
        _lastSeq = page.lastSeq;
        _error = null;
      });
    } on ApiException catch (error) {
      if (!mounted) {
        return;
      }
      // 监控可能已被别处停掉：停轮询并回到未开始态
      if (error.statusCode == 404) {
        _pollTimer?.cancel();
        setState(() {
          _watch = null;
          _error = '监控已失效，请重新开始';
        });
        return;
      }
      setState(() => _error = error.message);
    }
  }

  Future<void> _start() async {
    final text = _linkController.text.trim();
    if (text.isEmpty) {
      return;
    }
    setState(() {
      _starting = true;
      _error = null;
    });
    try {
      final watch = await ref
          .read(apiClientProvider)
          .startDanmakuWatch(shareText: text);
      if (!mounted) {
        return;
      }
      setState(() {
        _watch = watch;
        _events = const <DanmakuWatchEvent>[];
        _lastSeq = 0;
      });
      _linkController.clear();
      _startPolling();
    } on ApiException catch (error) {
      if (mounted) {
        setState(() => _error = error.message);
      }
    } finally {
      if (mounted) {
        setState(() => _starting = false);
      }
    }
  }

  Future<void> _stop() async {
    final watch = _watch;
    if (watch == null) {
      return;
    }
    setState(() => _stopping = true);
    try {
      await ref.read(apiClientProvider).stopDanmakuWatch(watch.watchId);
      if (!mounted) {
        return;
      }
      _pollTimer?.cancel();
      setState(() {
        _watch = null;
        _events = const <DanmakuWatchEvent>[];
        _lastSeq = 0;
      });
    } on ApiException catch (error) {
      if (mounted) {
        setState(() => _error = error.message);
      }
    } finally {
      if (mounted) {
        setState(() => _stopping = false);
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Scaffold(
      key: const Key('danmakuWatchPage'),
      appBar: AppBar(title: const Text('弹幕监控')),
      body: ListView(
        padding: const EdgeInsets.fromLTRB(16, 12, 16, 32),
        children: <Widget>[
          _buildIntroCard(theme),
          const SizedBox(height: 16),
          if (_watch == null) _buildStartCard(theme) else _buildRunningCard(theme),
          if (_error != null) ...<Widget>[
            const SizedBox(height: 12),
            Text(
              _error!,
              key: const Key('danmakuWatchError'),
              style: TextStyle(color: AppColors.danger, fontSize: 13),
            ),
          ],
          const SizedBox(height: 20),
          Row(
            children: <Widget>[
              Text(
                '弹幕流水',
                style: theme.textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w600),
              ),
              const SizedBox(width: 8),
              Text(
                '共 ${_events.length} 条',
                key: const Key('danmakuWatchCount'),
                style: theme.textTheme.bodySmall?.copyWith(color: AppColors.textSecondary),
              ),
            ],
          ),
          const SizedBox(height: 10),
          if (_events.isEmpty)
            _buildEmpty(theme)
          else
            Column(
              key: const Key('danmakuWatchEvents'),
              children: <Widget>[
                for (final item in _events) _buildEventTile(theme, item),
              ],
            ),
        ],
      ),
    );
  }

  Widget _buildIntroCard(ThemeData theme) {
    return Card(
      margin: EdgeInsets.zero,
      color: AppColors.info.withValues(alpha: 0.08),
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            const Icon(Icons.info_outline_rounded, size: 18, color: AppColors.info),
            const SizedBox(width: 10),
            Expanded(
              child: Text(
                '这是「只看」的监控：不绑定直播场次、不写数据库、也不触发 AI 回复。'
                '贴一段分享链接就能看这个直播间有没有人说话。',
                style: theme.textTheme.bodySmall?.copyWith(height: 1.5),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildStartCard(ThemeData theme) {
    final canStart = !_starting && _linkController.text.trim().isNotEmpty;
    return Card(
      key: const Key('danmakuWatchStartCard'),
      margin: EdgeInsets.zero,
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: <Widget>[
            Text(
              '粘贴直播分享链接',
              style: theme.textTheme.bodyMedium?.copyWith(fontWeight: FontWeight.w600),
            ),
            const SizedBox(height: 8),
            TextField(
              key: const Key('danmakuWatchInput'),
              controller: _linkController,
              enabled: !_starting,
              maxLines: 2,
              minLines: 1,
              onChanged: (_) => setState(() {}),
              decoration: const InputDecoration(
                hintText: '如：7.32 复制打开抖音… https://v.douyin.com/xxxx/',
                border: OutlineInputBorder(),
                isDense: true,
              ),
            ),
            const SizedBox(height: 12),
            FilledButton(
              key: const Key('danmakuWatchStart'),
              onPressed: canStart ? _start : null,
              child: _starting
                  ? const SizedBox(
                      width: 16,
                      height: 16,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : const Text('开始监控'),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildRunningCard(ThemeData theme) {
    final watch = _watch!;
    return Card(
      key: const Key('danmakuWatchRunningCard'),
      margin: EdgeInsets.zero,
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Row(
          children: <Widget>[
            const Icon(Icons.podcasts_outlined, size: 20, color: AppColors.live),
            const SizedBox(width: 10),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  Text(
                    '监控中 · ${watch.platformLabel}',
                    style: theme.textTheme.bodyMedium?.copyWith(fontWeight: FontWeight.w600),
                  ),
                  const SizedBox(height: 2),
                  Text(
                    '房间 ${watch.roomRef}',
                    key: const Key('danmakuWatchState'),
                    style: theme.textTheme.bodySmall?.copyWith(
                      color: AppColors.textSecondary,
                    ),
                  ),
                ],
              ),
            ),
            TextButton(
              key: const Key('danmakuWatchStop'),
              onPressed: _stopping ? null : _stop,
              child: Text(_stopping ? '停止中…' : '停止'),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildEmpty(ThemeData theme) {
    return Card(
      key: const Key('danmakuWatchEmpty'),
      margin: EdgeInsets.zero,
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 28, horizontal: 16),
        child: Column(
          children: <Widget>[
            Icon(Icons.chat_bubble_outline_rounded, size: 30, color: AppColors.textHint),
            const SizedBox(height: 10),
            Text(
              _watch == null ? '还没有开始监控' : '暂时没有弹幕',
              style: theme.textTheme.bodyMedium,
            ),
            const SizedBox(height: 4),
            Text(
              _watch == null
                  ? '贴一段分享链接就能看这个直播间的弹幕'
                  : '该直播间可能没有其他观众在说话 —— 能看到「进场」就说明链路是通的',
              style: theme.textTheme.bodySmall?.copyWith(
                color: AppColors.textSecondary,
                height: 1.5,
              ),
              textAlign: TextAlign.center,
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildEventTile(ThemeData theme, DanmakuWatchEvent item) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 6),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
            decoration: BoxDecoration(
              color: AppColors.surfaceMuted,
              borderRadius: BorderRadius.circular(6),
            ),
            child: Text(
              item.typeLabel,
              style: theme.textTheme.labelSmall?.copyWith(color: AppColors.textSecondary),
            ),
          ),
          const SizedBox(width: 8),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                if ((item.senderNickname ?? '').trim().isNotEmpty)
                  Text(
                    item.senderNickname!,
                    style: theme.textTheme.bodySmall?.copyWith(
                      color: AppColors.textSecondary,
                    ),
                  ),
                Text(item.displayText, style: theme.textTheme.bodyMedium),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
