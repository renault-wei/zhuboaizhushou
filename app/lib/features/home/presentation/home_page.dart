import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import 'package:starvoice_app/core/models/douyin_bind_status.dart';
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

/// 登录后首页：展示脱敏手机号、用户 ID、登录时间与抖音账号绑定卡片。
class HomePage extends ConsumerWidget {
  const HomePage({super.key});

  /// 手机号脱敏：保留前 3 位与后 4 位，中间 4 位用 * 隐藏。
  String _maskPhone(String phone) {
    if (phone.length != 11) {
      return phone;
    }
    return '${phone.substring(0, 3)}****${phone.substring(7)}';
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final authState = ref.watch(authControllerProvider);
    final user = authState.user;
    final maskedPhone = _maskPhone(user?.phone ?? '');
    final userId = user?.id ?? '--';
    final loginTimeText = _formatDateTime(authState.loginAt ?? DateTime.now());

    return Scaffold(
      appBar: AppBar(title: const Text('首页')),
      body: Center(
        child: SingleChildScrollView(
          padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 16),
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text(
                '欢迎使用星辰语音',
                textAlign: TextAlign.center,
                style: Theme.of(context).textTheme.headlineSmall
                    ?.copyWith(fontWeight: FontWeight.bold),
              ),
              const SizedBox(height: 40),
              Text(
                '手机号：$maskedPhone',
                key: const Key('homePhone'),
                style: const TextStyle(fontSize: 16),
              ),
              const SizedBox(height: 12),
              Text('用户ID：$userId', style: const TextStyle(fontSize: 16)),
              const SizedBox(height: 12),
              Text('登录时间：$loginTimeText', style: const TextStyle(fontSize: 16)),
              const SizedBox(height: 24),
              const _LiveStartHeroCard(),
              const SizedBox(height: 16),
              const _DouyinAccountCard(),
              const SizedBox(height: 16),
              const _VoiceAgreementCard(),
              const SizedBox(height: 16),
              const _CloneVoiceCard(),
              const SizedBox(height: 16),
              const _VoiceLibraryCard(),
              const SizedBox(height: 16),
              const _ScriptLibraryCard(),
              const SizedBox(height: 16),
              const _LoopScriptLibraryCard(),
              const SizedBox(height: 16),
              const _CouponEntryCard(),
              const SizedBox(height: 16),
              const _WalletEntryCard(),
              const SizedBox(height: 24),
              OutlinedButton(
                key: const Key('logoutButton'),
                onPressed: () {
                  ref.read(authControllerProvider.notifier).logout();
                },
                style: OutlinedButton.styleFrom(
                  minimumSize: const Size.fromHeight(48),
                ),
                child: const Text('退出登录'),
              ),
            ],
          ),
        ),
      ),
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
      await context.push(lives.isEmpty ? '/lives/new' : '/lives');
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

/// 抖音账号卡片：负责拉取绑定状态，支持去绑定 / 解绑后刷新。
class _DouyinAccountCard extends ConsumerStatefulWidget {
  const _DouyinAccountCard();

  @override
  ConsumerState<_DouyinAccountCard> createState() => _DouyinAccountCardState();
}

class _DouyinAccountCardState extends ConsumerState<_DouyinAccountCard> {
  bool _loading = true;
  bool _unbinding = false;
  String? _error;
  DouyinBindStatus? _status;

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
      final status = await ref.read(apiClientProvider).fetchDouyinBindStatus();
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

  Future<void> _goBind() async {
    // 绑定页成功后 pop，回到首页刷新卡片状态
    await context.push('/douyin-bind');
    await _refresh();
  }

  void _showSnack(String message) {
    if (!mounted) {
      return;
    }
    ScaffoldMessenger.of(context)
      ..clearSnackBars()
      ..showSnackBar(SnackBar(content: Text(message)));
  }

  Future<void> _confirmUnbind() async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('解绑抖音号'),
        content: const Text('解绑后如需直播拉券需重新授权绑定，确定解绑吗？'),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(context).pop(false),
            child: const Text('取消'),
          ),
          TextButton(
            key: const Key('douyinUnbindConfirmButton'),
            onPressed: () => Navigator.of(context).pop(true),
            child: const Text('确定解绑'),
          ),
        ],
      ),
    );
    if (confirmed != true || !mounted) {
      return;
    }

    setState(() {
      _unbinding = true;
    });
    try {
      await ref.read(apiClientProvider).unbindDouyin();
      _showSnack('已解绑抖音号');
      await _refresh();
    } on ApiException catch (error) {
      _showSnack(error.message);
    } finally {
      if (mounted) {
        setState(() {
          _unbinding = false;
        });
      }
    }
  }

  Widget _buildContent() {
    if (_loading) {
      return const Padding(
        padding: EdgeInsets.symmetric(vertical: 8),
        child: Text('正在同步抖音绑定状态…'),
      );
    }
    if (_error != null) {
      return Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            '抖音账号状态获取失败：$_error',
            style: TextStyle(color: Theme.of(context).colorScheme.error),
          ),
          const SizedBox(height: 8),
          OutlinedButton(onPressed: _refresh, child: const Text('重试')),
        ],
      );
    }

    final status = _status;
    if (status == null || !status.bound) {
      return Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          const Text('绑定抖音号后可拉取团购券，为实景直播挂载商品。'),
          const SizedBox(height: 12),
          FilledButton.tonal(
            key: const Key('douyinBindButton'),
            onPressed: _goBind,
            style: FilledButton.styleFrom(
              minimumSize: const Size.fromHeight(44),
            ),
            child: const Text('去绑定'),
          ),
        ],
      );
    }

    final avatarUrl = status.avatarUrl;
    return Row(
      children: [
        ClipOval(
          child: SizedBox(
            width: 44,
            height: 44,
            child: avatarUrl != null && avatarUrl.isNotEmpty
                ? Image.network(
                    avatarUrl,
                    fit: BoxFit.cover,
                    errorBuilder: (context, error, stackTrace) =>
                        const _AvatarFallback(),
                  )
                : const _AvatarFallback(),
          ),
        ),
        const SizedBox(width: 12),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                status.nickname ?? '已绑定抖音号',
                key: const Key('douyinNickname'),
                style: const TextStyle(
                  fontSize: 16,
                  fontWeight: FontWeight.w500,
                ),
                overflow: TextOverflow.ellipsis,
              ),
              const SizedBox(height: 2),
              Text(
                '抖音账号已绑定',
                style: TextStyle(fontSize: 12, color: context.tokenTextBody),
              ),
            ],
          ),
        ),
        OutlinedButton(
          key: const Key('douyinUnbindButton'),
          onPressed: _unbinding ? null : _confirmUnbind,
          child: _unbinding
              ? const SizedBox(
                  width: 16,
                  height: 16,
                  child: CircularProgressIndicator(strokeWidth: 2),
                )
              : const Text('解绑'),
        ),
      ],
    );
  }

  @override
  Widget build(BuildContext context) {
    return Card(
      key: const Key('douyinCard'),
      margin: EdgeInsets.zero,
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                const Icon(Icons.smart_display, size: 20),
                const SizedBox(width: 8),
                const Text(
                  '抖音账号',
                  style: TextStyle(fontSize: 16, fontWeight: FontWeight.bold),
                ),
                const Spacer(),
                Text(
                  _status?.bound == true ? '已绑定' : '未绑定',
                  style: TextStyle(
                    fontSize: 12,
                    color: _status?.bound == true
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

/// 头像加载失败 / 无头像时的兜底图标。
class _AvatarFallback extends StatelessWidget {
  const _AvatarFallback();

  @override
  Widget build(BuildContext context) {
    return Container(
      color: context.tokenSurfaceFill,
      alignment: Alignment.center,
      child: Icon(Icons.person, color: context.tokenTextHint),
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

/// 「我的音色」入口卡片：位于「克隆我的声音」卡片下方。
/// 展示音色数量（拉取列表长度），点击进入音色库页 /voices。
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
      if (!mounted) {
        return;
      }
      setState(() {
        _count = voices.length;
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
    final hint = _error ?? (_loading ? '正在同步音色…' : '已有 $_count 个音色，可查看克隆进度或删除');
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
                  '我的音色',
                  style: TextStyle(fontSize: 16, fontWeight: FontWeight.bold),
                ),
                const Spacer(),
                Text(
                  _loading && _error == null ? '同步中' : '$_count 个',
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

/// 「话术生成」入口卡片：位于「我的音色」卡片下方。
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

/// 「团购券」入口卡片：位于「话术生成」卡片下方。
/// 点击进入团购券列表页 /coupons，供后续开播配置选择「直播挂载商品」。
class _CouponEntryCard extends StatelessWidget {
  const _CouponEntryCard();

  @override
  Widget build(BuildContext context) {
    return Card(
      key: const Key('couponEntryCard'),
      margin: EdgeInsets.zero,
      child: InkWell(
        key: const Key('couponEntryOpenButton'),
        borderRadius: BorderRadius.circular(12),
        onTap: () => context.push('/coupons'),
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: <Widget>[
              Row(
                children: <Widget>[
                  const Icon(Icons.confirmation_number_outlined, size: 20),
                  const SizedBox(width: 8),
                  const Text(
                    '团购券',
                    style: TextStyle(fontSize: 16, fontWeight: FontWeight.bold),
                  ),
                  const Spacer(),
                  Icon(
                    Icons.chevron_right,
                    size: 20,
                    color: context.tokenTextHint,
                  ),
                ],
              ),
              const SizedBox(height: 10),
              Text(
                '拉取抖音团购券，为实景直播挂载商品',
                style: TextStyle(fontSize: 13, color: context.tokenTextBody),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// 「收银台 / 充值」入口卡片：预充直播时长、兑换卡密、查看余额与流水。
/// 点击进入收银台页 /wallet（充值入口显隐由服务端开关控制）。
class _WalletEntryCard extends StatelessWidget {
  const _WalletEntryCard();

  @override
  Widget build(BuildContext context) {
    return Card(
      key: const Key('walletEntryCard'),
      margin: EdgeInsets.zero,
      child: InkWell(
        key: const Key('walletEntryOpenButton'),
        borderRadius: BorderRadius.circular(12),
        onTap: () => context.push('/wallet'),
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: <Widget>[
              Row(
                children: <Widget>[
                  const Icon(Icons.account_balance_wallet_outlined, size: 20),
                  const SizedBox(width: 8),
                  const Text(
                    '收银台 / 充值',
                    style: TextStyle(fontSize: 16, fontWeight: FontWeight.bold),
                  ),
                  const Spacer(),
                  Icon(
                    Icons.chevron_right,
                    size: 20,
                    color: context.tokenTextHint,
                  ),
                ],
              ),
              const SizedBox(height: 10),
              Text(
                '预充直播时长、兑换卡密，查看余额与消费流水',
                style: TextStyle(fontSize: 13, color: context.tokenTextBody),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
