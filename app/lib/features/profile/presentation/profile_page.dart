import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

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

/// 手机号脱敏：保留前 3 位与后 4 位，中间 4 位用 * 隐藏。
String maskPhone(String phone) {
  if (phone.length != 11) {
    return phone;
  }
  return '${phone.substring(0, 3)}****${phone.substring(7)}';
}

/// 「我的」页：账号信息、收银台/充值、声音授权协议入口与退出登录。
/// 底部导航第三个 Tab（/me）。
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
          const SizedBox(height: 16),
          const _AgreementMenuTile(),
          const SizedBox(height: 12),
          const _WalletMenuTile(),
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
            '星辰语音 · AI 智能直播助手',
            textAlign: TextAlign.center,
            style: TextStyle(fontSize: 12, color: context.tokenTextHint),
          ),
        ],
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

/// 「收银台 / 充值」菜单项：进入钱包页查看余额与充值。
class _WalletMenuTile extends StatelessWidget {
  const _WalletMenuTile();

  @override
  Widget build(BuildContext context) {
    return Card(
      key: const Key('profileWalletEntry'),
      margin: EdgeInsets.zero,
      child: ListTile(
        key: const Key('profileWalletOpenButton'),
        onTap: () => context.push('/wallet'),
        leading: const Icon(Icons.account_balance_wallet_rounded, size: 22),
        title: const Text('收银台 / 充值'),
        subtitle: Text(
          '预充直播时长、兑换卡密，查看余额与消费流水',
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
