import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import 'package:starvoice_app/core/models/douyin_bind_status.dart';
import 'package:starvoice_app/core/models/voice_agreement.dart';
import 'package:starvoice_app/core/network/api_exception.dart';
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
                style: Theme.of(context)
                    .textTheme
                    .headlineSmall
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
              const SizedBox(height: 32),
              const _DouyinAccountCard(),
              const SizedBox(height: 16),
              const _VoiceAgreementCard(),
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
          OutlinedButton(
            onPressed: _refresh,
            child: const Text('重试'),
          ),
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
            style: FilledButton.styleFrom(minimumSize: const Size.fromHeight(44)),
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
                style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w500),
                overflow: TextOverflow.ellipsis,
              ),
              const SizedBox(height: 2),
              Text(
                '抖音账号已绑定',
                style: TextStyle(fontSize: 12, color: Colors.grey.shade600),
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
                  style: TextStyle(fontSize: 12, color: Colors.grey.shade600),
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
      color: Colors.grey.shade300,
      alignment: Alignment.center,
      child: const Icon(Icons.person, color: Colors.black45),
    );
  }
}

/// 声音授权卡片：负责拉取签署状态；
/// 未签署显示「去签署」警示样式，已签署展示版本与签署时间。
class _VoiceAgreementCard extends ConsumerStatefulWidget {
  const _VoiceAgreementCard();

  @override
  ConsumerState<_VoiceAgreementCard> createState() => _VoiceAgreementCardState();
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
      final status = await ref.read(apiClientProvider).fetchVoiceAgreementStatus();
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
          OutlinedButton(
            onPressed: _refresh,
            child: const Text('重试'),
          ),
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
                Icon(Icons.warning_amber_rounded, size: 20, color: scheme.onErrorContainer),
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
              style: FilledButton.styleFrom(minimumSize: const Size.fromHeight(40)),
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
          style: TextStyle(fontSize: 12, color: Colors.grey.shade600),
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
                  style: TextStyle(fontSize: 12, color: Colors.grey.shade600),
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
