import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import 'package:starvoice_app/core/config/app_meta.dart';
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

/// 分钟 → 中文时长：120 → 2 小时、90 → 1 小时 30 分。
String formatMinutesZh(int minutes) {
  final hours = minutes ~/ 60;
  final rest = minutes % 60;
  if (hours == 0) {
    return '$rest 分钟';
  }
  if (rest == 0) {
    return '$hours 小时';
  }
  return '$hours 小时 $rest 分';
}

/// 手机号脱敏：保留前 3 位与后 4 位，中间 4 位用 * 隐藏。
String maskPhone(String phone) {
  if (phone.length != 11) {
    return phone;
  }
  return '${phone.substring(0, 3)}****${phone.substring(7)}';
}

/// 「我的」页（底部导航第三个 Tab /me）：账号信息 → 直播时长余额 →
/// 账号与协议 / 帮助与支持两组入口 → 退出登录。
class ProfilePage extends ConsumerWidget {
  const ProfilePage({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final authState = ref.watch(authControllerProvider);
    final user = authState.user;
    final maskedPhone = maskPhone(user?.phone ?? '');
    final userId = user?.id ?? '--';

    return Scaffold(
      key: const Key('profilePage'),
      appBar: AppBar(title: const Text('我的')),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: <Widget>[
          _AccountCard(maskedPhone: maskedPhone, userId: userId),
          const SizedBox(height: 12),
          const _WalletSummaryCard(),
          const SizedBox(height: 20),
          const _GroupHeader('账号与协议'),
          const SizedBox(height: 8),
          const _AgreementMenuTile(),
          const SizedBox(height: 12),
          const _NavMenuTile(
            entryKey: Key('profilePrivacyEntry'),
            openButtonKey: Key('profilePrivacyOpenButton'),
            icon: Icons.privacy_tip_outlined,
            title: '隐私政策',
            route: '/profile/privacy',
          ),
          const SizedBox(height: 12),
          const _NavMenuTile(
            entryKey: Key('profileTermsEntry'),
            openButtonKey: Key('profileTermsOpenButton'),
            icon: Icons.assignment_outlined,
            title: '用户服务协议',
            route: '/profile/terms',
          ),
          const SizedBox(height: 20),
          const _GroupHeader('帮助与支持'),
          const SizedBox(height: 8),
          const _NavMenuTile(
            entryKey: Key('profileAiInfoEntry'),
            openButtonKey: Key('profileAiInfoOpenButton'),
            icon: Icons.smart_toy_outlined,
            title: 'AI 语音直播说明',
            route: '/profile/ai-info',
          ),
          const SizedBox(height: 12),
          const _NavMenuTile(
            entryKey: Key('profileSupportEntry'),
            openButtonKey: Key('profileSupportOpenButton'),
            icon: Icons.support_agent_rounded,
            title: '官方客服',
            route: '/profile/support',
          ),
          const SizedBox(height: 12),
          _NavMenuTile(
            entryKey: const Key('profileAboutEntry'),
            openButtonKey: const Key('profileAboutOpenButton'),
            icon: Icons.info_outline_rounded,
            title: '关于星辰语音',
            subtitle: 'v${AppMeta.version}',
            route: '/profile/about',
          ),
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
          const SizedBox(height: 16),
          Text(
            '${AppMeta.appName} · ${AppMeta.slogan}',
            textAlign: TextAlign.center,
            style: TextStyle(fontSize: 12, color: context.tokenTextHint),
          ),
          const SizedBox(height: 4),
          Text(
            'v${AppMeta.version}',
            key: const Key('profileFooterVersion'),
            textAlign: TextAlign.center,
            style: TextStyle(fontSize: 11, color: context.tokenTextHint),
          ),
        ],
      ),
    );
  }
}

/// 组标题：账号与协议 / 帮助与支持的分组锚点。
class _GroupHeader extends StatelessWidget {
  const _GroupHeader(this.title);

  final String title;

  @override
  Widget build(BuildContext context) {
    return Text(
      title,
      style: TextStyle(
        fontSize: 13,
        fontWeight: FontWeight.w600,
        color: context.tokenTextHint,
      ),
    );
  }
}

/// 普通跳转菜单项：指向「我的」相关子页面（隐私 / 协议 / 客服等）。
class _NavMenuTile extends StatelessWidget {
  const _NavMenuTile({
    required this.entryKey,
    required this.openButtonKey,
    required this.icon,
    required this.title,
    required this.route,
    this.subtitle,
  });

  final Key entryKey;
  final Key openButtonKey;
  final IconData icon;
  final String title;
  final String route;
  final String? subtitle;

  @override
  Widget build(BuildContext context) {
    return Card(
      key: entryKey,
      margin: EdgeInsets.zero,
      child: ListTile(
        key: openButtonKey,
        onTap: () => context.push(route),
        leading: Icon(icon, size: 22),
        title: Text(title),
        subtitle: subtitle == null
            ? null
            : Text(
                subtitle!,
                style: TextStyle(fontSize: 12, color: context.tokenTextBody),
              ),
        trailing: Icon(
          Icons.chevron_right,
          size: 20,
          color: context.tokenTextHint,
        ),
      ),
    );
  }
}

/// 账号信息卡：展示脱敏手机号与用户 ID。
class _AccountCard extends StatelessWidget {
  const _AccountCard({required this.maskedPhone, required this.userId});

  final String maskedPhone;
  final String userId;

  @override
  Widget build(BuildContext context) {
    return Container(
      key: const Key('profileAccountCard'),
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        gradient: const LinearGradient(
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
          colors: <Color>[AppColors.primary, AppColors.primaryDark],
        ),
        borderRadius: BorderRadius.circular(16),
      ),
      child: Row(
        children: <Widget>[
          const CircleAvatar(
            radius: 24,
            backgroundColor: Colors.white24,
            child: Icon(Icons.person_rounded, color: Colors.white, size: 28),
          ),
          const SizedBox(width: 14),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Text(
                  maskedPhone,
                  key: const Key('profilePhone'),
                  style: const TextStyle(
                    color: Colors.white,
                    fontSize: 18,
                    fontWeight: FontWeight.bold,
                  ),
                ),
                const SizedBox(height: 4),
                Text(
                  '用户 ID：$userId',
                  key: const Key('profileUserId'),
                  style: TextStyle(
                    color: Colors.white.withValues(alpha: 0.85),
                    fontSize: 13,
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

/// 「声音授权协议」菜单项：展示签署状态，未签署点击去协议页签署，
/// 签署成功 pop 返回后刷新本页状态。
class _AgreementMenuTile extends ConsumerStatefulWidget {
  const _AgreementMenuTile();

  @override
  ConsumerState<_AgreementMenuTile> createState() => _AgreementMenuTileState();
}

class _AgreementMenuTileState extends ConsumerState<_AgreementMenuTile> {
  bool _loading = true;
  bool _busy = false;
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

  Future<void> _goAgreement() async {
    if (_busy) {
      return;
    }
    setState(() => _busy = true);
    try {
      // 协议页签署成功后 pop，回到本页刷新签署状态
      await context.push('/voice-agreement');
      if (mounted) {
        await _refresh();
      }
    } finally {
      if (mounted) {
        setState(() => _busy = false);
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final status = _status;
    final signed = status?.signed ?? false;
    final version = status?.version ?? '';
    final signedAt = status?.signedAt;

    String subtitle;
    if (_loading && status == null) {
      subtitle = '正在同步签署状态…';
    } else if (_error != null) {
      subtitle = '状态获取失败：$_error';
    } else if (signed) {
      subtitle = version.isNotEmpty ? '已签署 v$version' : '已签署当前版本';
      if (signedAt != null) {
        subtitle += ' · ${_formatDateTime(DateTime.parse(signedAt).toLocal())}';
      }
    } else {
      subtitle = '克隆声音前需先签署授权协议，请尽快完成';
    }

    return Card(
      key: const Key('profileAgreementEntry'),
      margin: EdgeInsets.zero,
      child: ListTile(
        key: const Key('profileAgreementEntryOpenButton'),
        enabled: !_busy,
        onTap: _goAgreement,
        leading: const Icon(Icons.record_voice_over_rounded, size: 22),
        title: const Text('声音授权协议'),
        subtitle: Text(
          subtitle,
          key: const Key('profileAgreementSubtitle'),
          maxLines: 2,
          overflow: TextOverflow.ellipsis,
          style: TextStyle(fontSize: 12, color: context.tokenTextBody),
        ),
        trailing: signed
            ? Text(
                '已签署',
                key: const Key('profileAgreementStatusLabel'),
                style: const TextStyle(color: AppColors.live, fontSize: 13),
              )
            : Text(
                _error == null ? '未签署' : '同步失败',
                key: const Key('profileAgreementStatusLabel'),
                style: TextStyle(
                  color: _error == null
                      ? AppColors.warning
                      : context.tokenTextHint,
                  fontSize: 13,
                ),
              ),
      ),
    );
  }
}

/// 直播时长余额摘要卡：预充余额 + 当月免费剩余（来自收银台总览），
/// 点击进收银台，返回后自动刷新；不承担充值动作本身（充值区在收银台页）。
class _WalletSummaryCard extends ConsumerStatefulWidget {
  const _WalletSummaryCard();

  @override
  ConsumerState<_WalletSummaryCard> createState() => _WalletSummaryCardState();
}

class _WalletSummaryCardState extends ConsumerState<_WalletSummaryCard> {
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    // 首帧后再拉取，避免 build 阶段发起网络请求
    WidgetsBinding.instance.addPostFrameCallback((_) {
      ref.read(walletControllerProvider.notifier).load();
    });
  }

  Future<void> _openWallet() async {
    if (_busy) {
      return;
    }
    setState(() => _busy = true);
    try {
      // 收银台内充值 / 核销后 pop 返回，回到本页刷新余额摘要
      await context.push('/wallet');
      if (mounted) {
        await ref.read(walletControllerProvider.notifier).load();
      }
    } finally {
      if (mounted) {
        setState(() => _busy = false);
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final state = ref.watch(walletControllerProvider);
    final overview = state.overview;
    final showCharge = state.config?.showCharge ?? false;

    Widget content;
    if (overview == null && state.loading) {
      content = _buildPlaceholder(
        context,
        icon: Icons.hourglass_top_rounded,
        text: '正在同步时长余额…',
        action: null,
      );
    } else if (overview == null && state.error != null) {
      content = _buildPlaceholder(
        context,
        icon: Icons.sync_problem_rounded,
        text: '时长余额同步失败',
        action: TextButton(
          onPressed: () => ref.read(walletControllerProvider.notifier).load(),
          child: const Text('重试'),
        ),
      );
    } else {
      final remaining = overview?.monthlyLive.remainingMinutes ?? 0;
      final quotaExhausted = remaining <= 0;
      content = Row(
        children: <Widget>[
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                const Text('直播时长余额', style: TextStyle(fontSize: 13)),
                const SizedBox(height: 6),
                Text(
                  formatMinutesZh(overview?.balanceMinutes ?? 0),
                  key: const Key('profileBalanceValue'),
                  style: TextStyle(
                    fontSize: 24,
                    fontWeight: FontWeight.bold,
                    color: context.tokenTextStrong,
                  ),
                ),
                const SizedBox(height: 4),
                Text(
                  quotaExhausted
                      ? '本月免费时长已用完'
                      : '本月免费剩余 ${formatMinutesZh(remaining)}',
                  key: const Key('profileMonthlyRemaining'),
                  style: TextStyle(
                    fontSize: 12,
                    color: quotaExhausted
                        ? AppColors.warning
                        : context.tokenTextBody,
                  ),
                ),
              ],
            ),
          ),
          if (showCharge)
            Column(
              children: <Widget>[
                Container(
                  padding: const EdgeInsets.symmetric(
                    horizontal: 12,
                    vertical: 6,
                  ),
                  decoration: BoxDecoration(
                    color: AppColors.primary,
                    borderRadius: BorderRadius.circular(18),
                  ),
                  child: const Text(
                    '去充值',
                    style: TextStyle(color: Colors.white, fontSize: 13),
                  ),
                ),
                const SizedBox(height: 10),
                Icon(
                  Icons.chevron_right,
                  size: 20,
                  color: context.tokenTextHint,
                ),
              ],
            )
          else
            Icon(Icons.chevron_right, size: 20, color: context.tokenTextHint),
        ],
      );
    }

    return Card(
      key: const Key('profileWalletEntry'),
      margin: EdgeInsets.zero,
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        key: const Key('profileWalletOpenButton'),
        onTap: _busy || overview == null && state.loading ? null : _openWallet,
        child: Padding(padding: const EdgeInsets.all(16), child: content),
      ),
    );
  }

  Widget _buildPlaceholder(
    BuildContext context, {
    required IconData icon,
    required String text,
    required Widget? action,
  }) {
    return Row(
      children: <Widget>[
        Icon(icon, size: 22, color: context.tokenTextHint),
        const SizedBox(width: 10),
        Expanded(
          child: Text(
            text,
            style: TextStyle(fontSize: 13, color: context.tokenTextBody),
          ),
        ),
        ?action,
      ],
    );
  }
}
