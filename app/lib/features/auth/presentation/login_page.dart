import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'package:starvoice_app/core/network/api_exception.dart';
import 'package:starvoice_app/providers.dart';

/// 手机号验证码登录页。
class LoginPage extends ConsumerStatefulWidget {
  const LoginPage({super.key});

  @override
  ConsumerState<LoginPage> createState() => _LoginPageState();
}

class _LoginPageState extends ConsumerState<LoginPage> {
  // 中国大陆手机号：1 开头、11 位数字（与服务端校验规则一致）
  static final RegExp _phonePattern = RegExp(r'^1[3-9]\d{9}$');
  static final RegExp _codePattern = RegExp(r'^\d{6}$');

  final TextEditingController _phoneController = TextEditingController();
  final TextEditingController _codeController = TextEditingController();
  Timer? _resendTimer;
  int _resendSeconds = 0;
  bool _sending = false;
  bool _loggingIn = false;

  /// dev 模式下后端返回明文验证码已自动填入
  bool _devCodeFilled = false;
  String? _errorText;

  @override
  void dispose() {
    _resendTimer?.cancel();
    _phoneController.dispose();
    _codeController.dispose();
    super.dispose();
  }

  /// 获取验证码成功后启动重发倒计时（禁用按钮）。
  void _startResendCountdown(int seconds) {
    _resendTimer?.cancel();
    setState(() {
      _resendSeconds = seconds;
    });
    _resendTimer = Timer.periodic(const Duration(seconds: 1), (timer) {
      if (!mounted) {
        timer.cancel();
        return;
      }
      setState(() {
        _resendSeconds -= 1;
        if (_resendSeconds <= 0) {
          _resendSeconds = 0;
          timer.cancel();
        }
      });
    });
  }

  Future<void> _handleSendCode() async {
    final phone = _phoneController.text.trim();
    if (!_phonePattern.hasMatch(phone)) {
      setState(() {
        _errorText = '请输入正确的 11 位手机号';
      });
      return;
    }

    FocusScope.of(context).unfocus();
    setState(() {
      _sending = true;
      _errorText = null;
    });
    try {
      final result =
          await ref.read(authControllerProvider.notifier).sendCode(phone);
      if (!mounted) {
        return;
      }
      _startResendCountdown(
        result.resendAfterSeconds > 0 ? result.resendAfterSeconds : 60,
      );
      final code = result.code;
      if (code != null && code.isNotEmpty) {
        // 联调便利：dev 模式响应直接携带验证码，自动填入输入框
        _codeController.text = code;
        setState(() {
          _devCodeFilled = true;
        });
      }
    } on ApiException catch (error) {
      if (!mounted) {
        return;
      }
      setState(() {
        _errorText = error.message;
      });
      // 命中限频（429）：按服务端建议秒数继续倒计时
      if (error.code == 'SEND_TOO_FREQUENT' &&
          error.retryAfterSeconds != null &&
          error.retryAfterSeconds! > _resendSeconds) {
        _startResendCountdown(error.retryAfterSeconds!);
      }
    } finally {
      if (mounted) {
        setState(() {
          _sending = false;
        });
      }
    }
  }

  Future<void> _handleLogin() async {
    final phone = _phoneController.text.trim();
    final code = _codeController.text.trim();
    if (!_phonePattern.hasMatch(phone)) {
      setState(() {
        _errorText = '请输入正确的 11 位手机号';
      });
      return;
    }
    if (!_codePattern.hasMatch(code)) {
      setState(() {
        _errorText = '请输入 6 位数字验证码';
      });
      return;
    }

    FocusScope.of(context).unfocus();
    setState(() {
      _loggingIn = true;
      _errorText = null;
    });
    try {
      await ref
          .read(authControllerProvider.notifier)
          .loginWithCode(phone: phone, code: code);
      // 登录成功后由路由守卫自动跳转首页
    } on ApiException catch (error) {
      if (!mounted) {
        return;
      }
      setState(() {
        _errorText = error.message;
      });
    } finally {
      if (mounted) {
        setState(() {
          _loggingIn = false;
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final canSend = !_sending && _resendSeconds <= 0;
    final sendLabel =
        _resendSeconds > 0 ? '重新获取(${_resendSeconds}s)' : '获取验证码';

    return Scaffold(
      appBar: AppBar(title: const Text('登录')),
      body: SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 32),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text(
                '星辰语音',
                textAlign: TextAlign.center,
                style: Theme.of(context)
                    .textTheme
                    .headlineSmall
                    ?.copyWith(fontWeight: FontWeight.bold),
              ),
              const SizedBox(height: 36),
              TextField(
                key: const Key('phoneField'),
                controller: _phoneController,
                keyboardType: TextInputType.phone,
                maxLength: 11,
                inputFormatters: [FilteringTextInputFormatter.digitsOnly],
                decoration: const InputDecoration(
                  labelText: '手机号',
                  hintText: '请输入 11 位手机号',
                  counterText: '',
                  prefixIcon: Icon(Icons.phone_android),
                  border: OutlineInputBorder(),
                ),
              ),
              const SizedBox(height: 16),
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Expanded(
                    child: TextField(
                      key: const Key('codeField'),
                      controller: _codeController,
                      keyboardType: TextInputType.number,
                      maxLength: 6,
                      inputFormatters: [FilteringTextInputFormatter.digitsOnly],
                      decoration: const InputDecoration(
                        labelText: '验证码',
                        hintText: '6 位验证码',
                        counterText: '',
                        prefixIcon: Icon(Icons.shield_outlined),
                        border: OutlineInputBorder(),
                      ),
                    ),
                  ),
                  const SizedBox(width: 12),
                  SizedBox(
                    height: 56,
                    child: OutlinedButton(
                      key: const Key('sendCodeButton'),
                      onPressed: canSend ? _handleSendCode : null,
                      child: Text(sendLabel),
                    ),
                  ),
                ],
              ),
              if (_devCodeFilled)
                Padding(
                  padding: const EdgeInsets.only(top: 8),
                  child: Text(
                    '开发模式：验证码已自动填入',
                    key: const Key('devCodeHint'),
                    style: TextStyle(
                      fontSize: 12,
                      color: Colors.grey.shade600,
                    ),
                  ),
                ),
              if (_errorText != null)
                Padding(
                  padding: const EdgeInsets.only(top: 8),
                  child: Text(
                    _errorText!,
                    key: const Key('loginError'),
                    style: TextStyle(color: Theme.of(context).colorScheme.error),
                  ),
                ),
              const SizedBox(height: 24),
              FilledButton(
                key: const Key('loginButton'),
                onPressed: _loggingIn ? null : _handleLogin,
                style: FilledButton.styleFrom(
                  minimumSize: const Size.fromHeight(48),
                ),
                child: _loggingIn
                    ? const SizedBox(
                        width: 20,
                        height: 20,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      )
                    : const Text('登录', style: TextStyle(fontSize: 16)),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
