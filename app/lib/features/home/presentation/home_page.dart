import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import 'package:starvoice_app/core/models/live.dart';
import 'package:starvoice_app/core/models/voice_agreement.dart';
import 'package:starvoice_app/core/network/api_exception.dart';
import 'package:starvoice_app/core/theme/app_colors.dart';
import 'package:starvoice_app/core/theme/theme_tokens.dart';
import 'package:starvoice_app/providers.dart';

String _twoDigits(int value) => value.toString().padLeft(2, '0');

String _formatDateTime(DateTime time) {
  return '${time.year}-${_twoDigits(time.month)}-${_twoDigits(time.day)} '
      '${_twoDigits(time.hour)}:${_twoDigits(time.minute)}:${_twoDigits(time.second)}';
}

/// 登录后首页（三 Tab · 首页）：顶部品牌头 + 「AI 直播」「声音克隆」「话术」
/// 三个能力区。账号信息、收银台与退出登录收敛到「我的」Tab；抖音绑定入口
/// 由券列表页承接，首页不再展示。
class HomePage extends StatelessWidget {
  const HomePage({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.fromLTRB(16, 12, 16, 32),
          children: const <Widget>[
            _HomeBrandHeader(),
            SizedBox(height: 20),
            _SectionHeader(
              icon: Icons.campaign_rounded,
              title: 'AI 直播',
              subtitle: '场次状态一目了然，就绪后一键进入直播工作台',
            ),
            SizedBox(height: 10),
            _LiveStartHeroCard(),
            SizedBox(height: 24),
            _SectionHeader(
              icon: Icons.record_voice_over_rounded,
              title: '声音克隆',
              subtitle: '完成声音授权后，录制专属音色或选用预设音色',
            ),
            SizedBox(height: 10),
            _VoiceAgreementCard(),
            SizedBox(height: 12),
            _CloneVoiceCard(),
            SizedBox(height: 12),
            _VoiceLibraryCard(),
            SizedBox(height: 24),
            _SectionHeader(
              icon: Icons.notes_rounded,
              title: '话术',
              subtitle: 'AI 生成带货话术与循环台本，开播后不冷场',
            ),
            SizedBox(height: 10),
            _ScriptLibraryCard(),
            SizedBox(height: 12),
            _LoopScriptLibraryCard(),
          ],
        ),
      ),
    );
  }
}

/// 首页顶部品牌头：星橙渐变圆角图标 + 产品名与一句话定位。
class _HomeBrandHeader extends StatelessWidget {
  const _HomeBrandHeader();

  @override
  Widget build(BuildContext context) {
    return Row(
      children: <Widget>[
        Container(
          width: 44,
          height: 44,
          alignment: Alignment.center,
          decoration: BoxDecoration(
            gradient: const LinearGradient(
              begin: Alignment.topLeft,
              end: Alignment.bottomRight,
              colors: <Color>[AppColors.primary, AppColors.primaryDark],
            ),
            borderRadius: BorderRadius.circular(14),
          ),
          child: const Icon(
            Icons.auto_awesome_rounded,
            color: Colors.white,
            size: 22,
          ),
        ),
        const SizedBox(width: 12),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Text(
                '星辰语音',
                style: Theme.of(context).textTheme.titleLarge
                    ?.copyWith(fontWeight: FontWeight.bold),
              ),
              const SizedBox(height: 2),
              Text(
                'AI 智能直播助手，让 AI 帮你说',
                style: TextStyle(fontSize: 12, color: context.tokenTextBody),
              ),
            ],
          ),
        ),
      ],
    );
  }
}

/// 能力区标题：小号星橙图标块 + 标题与一行副文案，作为首页分区锚点。
class _SectionHeader extends StatelessWidget {
  const _SectionHeader({
    required this.icon,
    required this.title,
    required this.subtitle,
  });

  final IconData icon;
  final String title;
  final String subtitle;

  @override
  Widget build(BuildContext context) {
    return Row(
      crossAxisAlignment: CrossAxisAlignment.center,
      children: <Widget>[
        Container(
          width: 34,
          height: 34,
          alignment: Alignment.center,
          decoration: BoxDecoration(
            color: AppColors.primarySoft,
            borderRadius: BorderRadius.circular(10),
          ),
          child: Icon(icon, size: 19, color: AppColors.primaryDark),
        ),
        const SizedBox(width: 10),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Text(
                title,
                style: const TextStyle(
                  fontSize: 17,
                  fontWeight: FontWeight.bold,
                ),
              ),
              const SizedBox(height: 2),
              Text(
                subtitle,
                style: TextStyle(fontSize: 12, color: context.tokenTextHint),
              ),
            ],
          ),
        ),
      ],
    );
  }
}

/// 「AI 语音开播」主入口卡片：首页顶部主行动入口，状态化展示当前场次
/// （直播中 / 已就绪 / 草稿待完善 / 空态），点击直达对应工作台或列表页；
/// 从页面返回后自动刷新，保证与列表页状态一致。
class _LiveStartHeroCard extends ConsumerStatefulWidget {
  const _LiveStartHeroCard();

  @override
  ConsumerState<_LiveStartHeroCard> createState() => _LiveStartHeroCardState();
}

class _LiveStartHeroCardState extends ConsumerState<_LiveStartHeroCard> {
  List<Live>? _lives;
  bool _loading = true;
  bool _opening = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    // 首帧后再拉取，避免 build 阶段发起网络请求
    WidgetsBinding.instance.addPostFrameCallback((_) => _refresh());
  }

  Future<void> _refresh() async {
    if (mounted) {
      setState(() {
        _loading = true;
        _error = null;
      });
    }
    try {
      final lives = await ref.read(apiClientProvider).listLives();
      if (!mounted) {
        return;
      }
      setState(() {
        _lives = lives;
        _loading = false;
      });
    } on ApiException catch (error) {
      if (!mounted) {
        return;
      }
      setState(() {
        _loading = false;
        _error = error.message;
      });
    }
  }

  /// 直播中的场次（多条时取首条，其余在列表页统一管理）。
  Live? get _liveNow {
    final lives = _lives;
    if (lives == null) {
      return null;
    }
    for (final live in lives) {
      if (live.isLive) {
        return live;
      }
    }
    return null;
  }

  /// 已就绪待开播的场次（无直播中时取首条就绪）。
  Live? get _readyNow {
    final lives = _lives;
    if (lives == null) {
      return null;
    }
    for (final live in lives) {
      if (live.isReady) {
        return live;
      }
    }
    return null;
  }

  /// 草稿（idle）数量：用于「去完善」引导文案。
  int get _draftCount {
    final lives = _lives;
    if (lives == null) {
      return 0;
    }
    return lives.where((live) => live.status == LiveStatus.idle).length;
  }

  /// 点击主入口：直播中 / 就绪场次直达工作台；空态去新建，否则进列表管理。
  Future<void> _handleTap() async {
    if (_opening || _loading) {
      return;
    }
    if (_error != null) {
      // 同步失败：整卡点击等同重试
      await _refresh();
      return;
    }
    final target = _liveNow ?? _readyNow;
    if (target != null) {
      setState(() => _opening = true);
      try {
        await context.push('/lives/${target.id}/monitor');
      } finally {
        if (mounted) {
          setState(() => _opening = false);
        }
      }
      if (mounted) {
        await _refresh();
      }
      return;
    }
    final lives = _lives ?? const <Live>[];
    setState(() => _opening = true);
    try {
      if (lives.isEmpty) {
        // 无场次：直接进全屏「新建开播配置」，返回后回到首页
        await context.push('/lives/new');
      } else {
        // 有草稿 / 多场次：/lives 已是直播 Tab 分支路由，用 go 切换过去
        context.go('/lives');
      }
    } finally {
      if (mounted) {
        setState(() => _opening = false);
      }
    }
    if (mounted) {
      await _refresh();
    }
  }

  @override
  Widget build(BuildContext context) {
    final bool blocked = _loading || _opening;
    final String hint;
    final String action;
    final IconData actionIcon;
    if (_loading) {
      hint = '正在同步开播状态…';
      action = '请稍候';
      actionIcon = Icons.hourglass_top_rounded;
    } else if (_error != null) {
      hint = '开播状态同步失败：$_error';
      action = '重试';
      actionIcon = Icons.refresh_rounded;
    } else {
      final liveNow = _liveNow;
      if (liveNow != null) {
        hint = '正在直播：${liveNow.title}';
        action = '进入直播';
        actionIcon = Icons.radio_button_checked_rounded;
      } else {
        final readyNow = _readyNow;
        if (readyNow != null) {
          hint = '已就绪，可一键开播：${readyNow.title}';
          action = '开始直播';
          actionIcon = Icons.play_arrow_rounded;
        } else {
          final lives = _lives ?? const <Live>[];
          if (lives.isEmpty) {
            hint = '还没有直播场次，创建第一场就能用 AI 语音开播';
            action = '创建场次';
            actionIcon = Icons.add_rounded;
          } else {
            final draftCount = _draftCount;
            if (draftCount > 0) {
              hint = '有 $draftCount 个草稿待完善，补齐音色/话术即可开播';
              action = '去完善';
              actionIcon = Icons.edit_rounded;
            } else {
              hint = '直播场次都在这里统一管理';
              action = '管理场次';
              actionIcon = Icons.tune_rounded;
            }
          }
        }
      }
    }

    return Card(
      key: const Key('liveStartHeroCard'),
      margin: EdgeInsets.zero,
      clipBehavior: Clip.antiAlias,
      child: Ink(
        decoration: const BoxDecoration(
          gradient: LinearGradient(
            begin: Alignment.topLeft,
            end: Alignment.bottomRight,
            colors: <Color>[AppColors.primary, AppColors.primaryDark],
          ),
        ),
        child: InkWell(
          key: const Key('liveStartHeroOpenButton'),
          onTap: blocked ? null : _handleTap,
          child: Padding(
            padding: const EdgeInsets.all(16),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: <Widget>[
                Row(
                  children: <Widget>[
                    const Icon(
                      Icons.campaign_rounded,
                      size: 22,
                      color: Colors.white,
                    ),
                    const SizedBox(width: 8),
                    const Expanded(
                      child: Text(
                        'AI 语音开播',
                        style: TextStyle(
                          color: Colors.white,
                          fontSize: 18,
                          fontWeight: FontWeight.bold,
                        ),
                      ),
                    ),
                    Icon(
                      Icons.chevron_right,
                      size: 20,
                      color: Colors.white.withValues(alpha: 0.9),
                    ),
                  ],
                ),
                const SizedBox(height: 10),
                Text(
                  hint,
                  key: const Key('liveStartHeroHint'),
                  style: const TextStyle(
                    color: Colors.white,
                    fontSize: 13,
                    height: 1.4,
                  ),
                ),
                const SizedBox(height: 14),
                SizedBox(
                  height: 42,
                  child: FilledButton.icon(
                    key: const Key('liveStartActionButton'),
                    onPressed: blocked ? null : _handleTap,
                    style: FilledButton.styleFrom(
                      backgroundColor: Colors.white,
                      foregroundColor: AppColors.primaryDark,
                      disabledBackgroundColor: Colors.white.withValues(
                        alpha: 0.85,
                      ),
                      disabledForegroundColor: AppColors.primaryDark,
                      shape: RoundedRectangleBorder(
                        borderRadius: BorderRadius.circular(21),
                      ),
                    ),
                    icon: _opening
                        ? const SizedBox(
                            width: 16,
                            height: 16,
                            child: CircularProgressIndicator(
                              strokeWidth: 2,
                              color: AppColors.primaryDark,
                            ),
                          )
                        : Icon(actionIcon, size: 18),
                    label: Text(
                      _opening ? '进入中…' : action,
                      style: const TextStyle(fontWeight: FontWeight.bold),
                    ),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// 声音授权卡片：负责拉取签署状态；
/// 未签署显示「去签署」警示样式，已签署展示版本与签署时间。
class _VoiceAgreementCard extends ConsumerStatefulWidget {
  const _VoiceAgreementCard();

  @override
  ConsumerState<_VoiceAgreementCard> createState() =>
      _VoiceAgreementCardState();
}

class _VoiceAgreementCardState extends ConsumerState<_VoiceAgreementCard> {
  bool _loading = true;
  String? _error;
  AgreementStatus? _status;

  @override
  void initState() {
    super.initState();
    // 首帧后再拉取，避免 build 阶段发起网络请求
    WidgetsBinding.instance.addPostFrameCallback((_) => _refresh());
  }

  Future<void> _refresh() async {
    if (mounted) {
      setState(() {
        _loading = true;
        _error = null;
      });
    }
    try {
      final status = await ref
          .read(apiClientProvider)
          .fetchVoiceAgreementStatus();
      if (!mounted) {
        return;
      }
      setState(() {
        _status = status;
        _loading = false;
      });
    } on ApiException catch (error) {
      if (!mounted) {
        return;
      }
      setState(() {
        _error = error.message;
        _loading = false;
      });
    }
  }

  Future<void> _goSign() async {
    // 协议页签署成功后 pop，回到首页刷新签署状态
    await context.push('/voice-agreement');
    await _refresh();
  }

  Widget _buildContent() {
    if (_loading) {
      return const Padding(
        padding: EdgeInsets.symmetric(vertical: 8),
        child: Text('正在同步协议签署状态…'),
      );
    }
    if (_error != null) {
      return Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            '声音授权状态获取失败：$_error',
            style: TextStyle(color: Theme.of(context).colorScheme.error),
          ),
          const SizedBox(height: 8),
          OutlinedButton(onPressed: _refresh, child: const Text('重试')),
        ],
      );
    }

    final status = _status;
    if (status == null || !status.signed) {
      // 未签署：警示样式，突出「克隆声音前必须完成」的合规提示
      final scheme = Theme.of(context).colorScheme;
      return Container(
        padding: const EdgeInsets.all(12),
        decoration: BoxDecoration(
          color: scheme.errorContainer,
          borderRadius: BorderRadius.circular(8),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(
              children: [
                Icon(
                  Icons.warning_amber_rounded,
                  size: 20,
                  color: scheme.onErrorContainer,
                ),
                const SizedBox(width: 8),
                Text(
                  '尚未签署声音授权协议',
                  style: TextStyle(
                    fontSize: 14,
                    fontWeight: FontWeight.bold,
                    color: scheme.onErrorContainer,
                  ),
                ),
              ],
            ),
            const SizedBox(height: 6),
            Text(
              '克隆声音前必须完成《声音授权协议》签署，否则无法使用声音克隆与 AI 直播。',
              key: const Key('voiceAgreementWarningHint'),
              style: TextStyle(
                fontSize: 13,
                height: 1.5,
                color: scheme.onErrorContainer,
              ),
            ),
            const SizedBox(height: 12),
            FilledButton(
              key: const Key('goVoiceAgreementButton'),
              onPressed: _goSign,
              style: FilledButton.styleFrom(
                minimumSize: const Size.fromHeight(40),
              ),
              child: const Text('去签署'),
            ),
          ],
        ),
      );
    }

    final version = status.version ?? '';
    final signedAt = status.signedAt;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          version.isNotEmpty ? '已签署 v$version' : '已签署',
          key: const Key('voiceAgreementSignedText'),
          style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w500),
        ),
        const SizedBox(height: 4),
        Text(
          signedAt != null
              ? '签署时间：${_formatDateTime(DateTime.parse(signedAt).toLocal())}'
              : '已签署当前版本协议',
          style: TextStyle(fontSize: 12, color: context.tokenTextBody),
        ),
      ],
    );
  }

  @override
  Widget build(BuildContext context) {
    return Card(
      key: const Key('voiceAgreementCard'),
      margin: EdgeInsets.zero,
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                const Icon(Icons.record_voice_over, size: 20),
                const SizedBox(width: 8),
                const Text(
                  '声音授权',
                  style: TextStyle(fontSize: 16, fontWeight: FontWeight.bold),
                ),
                const Spacer(),
                Text(
                  _status?.signed == true ? '已签署' : '未签署',
                  key: const Key('voiceAgreementStatusLabel'),
                  style: TextStyle(
                    fontSize: 12,
                    color: _status?.signed == true
                        ? AppColors.live
                        : context.tokenTextHint,
                  ),
                ),
              ],
            ),
            const SizedBox(height: 12),
            _buildContent(),
          ],
        ),
      ),
    );
  }
}

/// 「克隆我的声音」卡片：位于声音授权卡片下方。
/// 未签署协议 → 跳协议页并提示「请先完成声音授权」；已签署 → 进入录音页 /recording。
class _CloneVoiceCard extends ConsumerStatefulWidget {
  const _CloneVoiceCard();

  @override
  ConsumerState<_CloneVoiceCard> createState() => _CloneVoiceCardState();
}

class _CloneVoiceCardState extends ConsumerState<_CloneVoiceCard> {
  bool _loading = true;
  bool _busy = false;
  bool _signed = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    // 首帧后再拉取签署状态，避免在 build 阶段发起网络请求
    WidgetsBinding.instance.addPostFrameCallback((_) => _refresh());
  }

  Future<void> _refresh() async {
    if (mounted) {
      setState(() {
        _loading = true;
        _error = null;
      });
    }
    try {
      final status = await ref
          .read(apiClientProvider)
          .fetchVoiceAgreementStatus();
      if (!mounted) {
        return;
      }
      setState(() {
        _signed = status.signed;
        _loading = false;
      });
    } on ApiException catch (error) {
      if (!mounted) {
        return;
      }
      setState(() {
        _error = error.message;
        _loading = false;
      });
    }
  }

  /// 点击入口：以最新签署状态决定去向，避免本地缓存过期。
  Future<void> _handleTap() async {
    if (_loading || _busy) {
      return;
    }
    setState(() {
      _busy = true;
    });
    try {
      final status = await ref
          .read(apiClientProvider)
          .fetchVoiceAgreementStatus();
      if (!mounted) {
        return;
      }
      if (status.signed) {
        await context.push('/recording');
      } else {
        _showSnack('请先完成声音授权');
        await context.push('/voice-agreement');
      }
      if (!mounted) {
        return;
      }
      // 协议页/录音页返回后刷新状态
      await _refresh();
    } on ApiException catch (error) {
      _showSnack(error.message);
    } finally {
      if (mounted) {
        setState(() {
          _busy = false;
        });
      }
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

  @override
  Widget build(BuildContext context) {
    final hint = _error ?? (_signed ? '已签署授权，可开始采集声音样本' : '完成声音授权后即可开始录音克隆');
    return Card(
      key: const Key('cloneVoiceCard'),
      margin: EdgeInsets.zero,
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(
              children: [
                const Icon(Icons.mic, size: 20),
                const SizedBox(width: 8),
                const Text(
                  '克隆我的声音',
                  style: TextStyle(fontSize: 16, fontWeight: FontWeight.bold),
                ),
                const Spacer(),
                Text(
                  _signed ? '已授权' : '未授权',
                  key: const Key('cloneVoiceStatusLabel'),
                  style: TextStyle(
                    fontSize: 12,
                    color: _signed ? AppColors.live : context.tokenTextHint,
                  ),
                ),
              ],
            ),
            const SizedBox(height: 10),
            Text(
              hint,
              key: const Key('cloneVoiceHint'),
              style: TextStyle(fontSize: 13, color: context.tokenTextBody),
            ),
            const SizedBox(height: 12),
            FilledButton.tonal(
              key: const Key('cloneVoiceStartButton'),
              onPressed: _loading || _busy ? null : _handleTap,
              style: FilledButton.styleFrom(
                minimumSize: const Size.fromHeight(44),
              ),
              child: _busy
                  ? const SizedBox(
                      width: 18,
                      height: 18,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : Text(_signed ? '开始录音' : '去完成声音授权'),
            ),
          ],
        ),
      ),
    );
  }
}

/// 「音色库」入口卡片：位于「克隆我的声音」卡片下方。
/// 展示克隆音色数量与预设音色数量，点击进入音色库页 /voices（列表模式）。
class _VoiceLibraryCard extends ConsumerStatefulWidget {
  const _VoiceLibraryCard();

  @override
  ConsumerState<_VoiceLibraryCard> createState() => _VoiceLibraryCardState();
}

class _VoiceLibraryCardState extends ConsumerState<_VoiceLibraryCard> {
  bool _loading = true;
  bool _busy = false;
  String? _error;
  int _count = 0;

  /// 预设音色条数（服务端目录；拿不到时按 0 展示，不影响入口可用）
  int _presetCount = 0;

  @override
  void initState() {
    super.initState();
    // 首帧后再拉取音色数量，避免在 build 阶段发起网络请求
    WidgetsBinding.instance.addPostFrameCallback((_) => _refresh());
  }

  Future<void> _refresh() async {
    if (mounted) {
      setState(() {
        _loading = true;
        _error = null;
      });
    }
    try {
      final voices = await ref.read(apiClientProvider).listVoices();
      var presetCount = 0;
      try {
        final catalog = await ref
            .read(apiClientProvider)
            .fetchVolcPresetCatalog();
        presetCount = catalog.presets.length;
      } on ApiException {
        // 预设目录为只读内置目录，拉取失败不阻塞入口：退化成只显示克隆音色数
      }
      if (!mounted) {
        return;
      }
      setState(() {
        _count = voices.length;
        _presetCount = presetCount;
        _loading = false;
      });
    } on ApiException catch (error) {
      if (!mounted) {
        return;
      }
      setState(() {
        _error = error.message;
        _loading = false;
      });
    }
  }

  /// 点击入口：进入音色库页，返回后刷新数量（可能已新增/删除音色）。
  Future<void> _handleTap() async {
    if (_loading || _busy) {
      return;
    }
    setState(() {
      _busy = true;
    });
    await context.push('/voices');
    if (!mounted) {
      return;
    }
    setState(() {
      _busy = false;
    });
    await _refresh();
  }

  @override
  Widget build(BuildContext context) {
    final hint = _error ??
        (_loading
            ? '正在同步音色…'
            : '已有 $_count 个克隆音色，另有 $_presetCount 个预设音色可选');
    return Card(
      key: const Key('voiceLibraryCard'),
      margin: EdgeInsets.zero,
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(
              children: [
                const Icon(Icons.record_voice_over_outlined, size: 20),
                const SizedBox(width: 8),
                const Text(
                  '音色库',
                  style: TextStyle(fontSize: 16, fontWeight: FontWeight.bold),
                ),
                const Spacer(),
                Text(
                  _loading && _error == null
                      ? '同步中'
                      : '$_count 个声音 · $_presetCount 个预设',
                  key: const Key('voiceLibraryCountLabel'),
                  style: TextStyle(
                    fontSize: 12,
                    color: _error != null
                        ? Theme.of(context).colorScheme.error
                        : context.tokenTextBody,
                  ),
                ),
              ],
            ),
            const SizedBox(height: 10),
            Text(
              hint,
              key: const Key('voiceLibraryHint'),
              style: TextStyle(fontSize: 13, color: context.tokenTextBody),
            ),
            const SizedBox(height: 12),
            FilledButton.tonal(
              key: const Key('voiceLibraryOpenButton'),
              onPressed: _loading || _busy ? null : _handleTap,
              style: FilledButton.styleFrom(
                minimumSize: const Size.fromHeight(44),
              ),
              child: const Text('进入音色库'),
            ),
          ],
        ),
      ),
    );
  }
}

/// 「话术生成」入口卡片：位于「音色库」卡片下方。
/// 展示已有话术数量，点击进入话术生成页 /scripts。
class _ScriptLibraryCard extends ConsumerStatefulWidget {
  const _ScriptLibraryCard();

  @override
  ConsumerState<_ScriptLibraryCard> createState() => _ScriptLibraryCardState();
}

class _ScriptLibraryCardState extends ConsumerState<_ScriptLibraryCard> {
  bool _loading = true;
  bool _busy = false;
  String? _error;
  int _count = 0;

  @override
  void initState() {
    super.initState();
    // 首帧后再拉取话术数量，避免在 build 阶段发起网络请求
    WidgetsBinding.instance.addPostFrameCallback((_) => _refresh());
  }

  Future<void> _refresh() async {
    if (mounted) {
      setState(() {
        _loading = true;
        _error = null;
      });
    }
    try {
      final scripts = await ref.read(apiClientProvider).listScripts();
      if (!mounted) {
        return;
      }
      setState(() {
        _count = scripts.length;
        _loading = false;
      });
    } on ApiException catch (error) {
      if (!mounted) {
        return;
      }
      setState(() {
        _error = error.message;
        _loading = false;
      });
    }
  }

  /// 点击入口：进入话术生成页，返回后刷新数量（可能已新增/编辑话术）。
  Future<void> _handleTap() async {
    if (_loading || _busy) {
      return;
    }
    setState(() {
      _busy = true;
    });
    await context.push('/scripts');
    if (!mounted) {
      return;
    }
    setState(() {
      _busy = false;
    });
    await _refresh();
  }

  @override
  Widget build(BuildContext context) {
    final hint =
        _error ?? (_loading ? '正在同步话术…' : '已有 $_count 条话术，可生成 AI 直播话术');
    return Card(
      key: const Key('scriptEntryCard'),
      margin: EdgeInsets.zero,
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: <Widget>[
            Row(
              children: <Widget>[
                const Icon(Icons.notes_rounded, size: 20),
                const SizedBox(width: 8),
                const Text(
                  '话术生成',
                  style: TextStyle(fontSize: 16, fontWeight: FontWeight.bold),
                ),
                const Spacer(),
                Text(
                  _loading && _error == null ? '同步中' : '$_count 条',
                  key: const Key('scriptEntryCountLabel'),
                  style: TextStyle(
                    fontSize: 12,
                    color: _error != null
                        ? Theme.of(context).colorScheme.error
                        : context.tokenTextBody,
                  ),
                ),
              ],
            ),
            const SizedBox(height: 10),
            Text(
              hint,
              key: const Key('scriptEntryHint'),
              style: TextStyle(fontSize: 13, color: context.tokenTextBody),
            ),
            const SizedBox(height: 12),
            FilledButton.tonal(
              key: const Key('scriptEntryOpenButton'),
              onPressed: _loading || _busy ? null : _handleTap,
              style: FilledButton.styleFrom(
                minimumSize: const Size.fromHeight(44),
              ),
              child: const Text('去生成话术'),
            ),
          ],
        ),
      ),
    );
  }
}

/// 「循环台本」入口卡片：位于「话术生成」卡片下方。
/// 展示已有循环台本数量，点击进入台本库 /loop-scripts（开播前绑定循环口播）。
class _LoopScriptLibraryCard extends ConsumerStatefulWidget {
  const _LoopScriptLibraryCard();

  @override
  ConsumerState<_LoopScriptLibraryCard> createState() =>
      _LoopScriptLibraryCardState();
}

class _LoopScriptLibraryCardState
    extends ConsumerState<_LoopScriptLibraryCard> {
  bool _loading = true;
  bool _busy = false;
  String? _error;
  int _count = 0;

  @override
  void initState() {
    super.initState();
    // 首帧后再拉取台本数量，避免在 build 阶段发起网络请求
    WidgetsBinding.instance.addPostFrameCallback((_) => _refresh());
  }

  Future<void> _refresh() async {
    if (mounted) {
      setState(() {
        _loading = true;
        _error = null;
      });
    }
    try {
      final scripts = await ref.read(apiClientProvider).listLoopScripts();
      if (!mounted) {
        return;
      }
      setState(() {
        _count = scripts.length;
        _loading = false;
      });
    } on ApiException catch (error) {
      if (!mounted) {
        return;
      }
      setState(() {
        _error = error.message;
        _loading = false;
      });
    }
  }

  /// 点击入口：进入台本库页，返回后刷新数量（可能已新建/编辑台本）。
  Future<void> _handleTap() async {
    if (_loading || _busy) {
      return;
    }
    setState(() {
      _busy = true;
    });
    await context.push('/loop-scripts');
    if (!mounted) {
      return;
    }
    setState(() {
      _busy = false;
    });
    await _refresh();
  }

  @override
  Widget build(BuildContext context) {
    final hint =
        _error ?? (_loading ? '正在同步循环台本…' : '已有 $_count 本循环台本，绑定后开播自动循环口播');
    return Card(
      key: const Key('loopScriptEntryCard'),
      margin: EdgeInsets.zero,
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: <Widget>[
            Row(
              children: <Widget>[
                const Icon(Icons.playlist_play_rounded, size: 20),
                const SizedBox(width: 8),
                const Text(
                  '循环台本',
                  style: TextStyle(fontSize: 16, fontWeight: FontWeight.bold),
                ),
                const Spacer(),
                Text(
                  _loading && _error == null ? '同步中' : '$_count 本',
                  key: const Key('loopScriptEntryCountLabel'),
                  style: TextStyle(
                    fontSize: 12,
                    color: _error != null
                        ? Theme.of(context).colorScheme.error
                        : context.tokenTextBody,
                  ),
                ),
              ],
            ),
            const SizedBox(height: 10),
            Text(
              hint,
              key: const Key('loopScriptEntryHint'),
              style: TextStyle(fontSize: 13, color: context.tokenTextBody),
            ),
            const SizedBox(height: 12),
            FilledButton.tonal(
              key: const Key('loopScriptEntryOpenButton'),
              onPressed: _loading || _busy ? null : _handleTap,
              style: FilledButton.styleFrom(
                minimumSize: const Size.fromHeight(44),
              ),
              child: const Text('去管理台本'),
            ),
          ],
        ),
      ),
    );
  }
}
