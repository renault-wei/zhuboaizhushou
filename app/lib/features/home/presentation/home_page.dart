import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'package:starvoice_app/providers.dart';

/// 登录后首页：展示脱敏手机号、用户 ID 与登录时间，支持退出登录。
class HomePage extends ConsumerWidget {
  const HomePage({super.key});

  /// 手机号脱敏：保留前 3 位与后 4 位，中间 4 位用 * 隐藏。
  String _maskPhone(String phone) {
    if (phone.length != 11) {
      return phone;
    }
    return '${phone.substring(0, 3)}****${phone.substring(7)}';
  }

  String _twoDigits(int value) => value.toString().padLeft(2, '0');

  String _formatDateTime(DateTime time) {
    return '${time.year}-${_twoDigits(time.month)}-${_twoDigits(time.day)} '
        '${_twoDigits(time.hour)}:${_twoDigits(time.minute)}:${_twoDigits(time.second)}';
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
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 24),
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
              Text('登录时间：$loginTimeText',
                  style: const TextStyle(fontSize: 16)),
              const SizedBox(height: 48),
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
