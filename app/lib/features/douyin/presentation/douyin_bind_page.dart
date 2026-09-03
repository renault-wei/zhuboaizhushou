import 'dart:math';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import 'package:starvoice_app/core/network/api_exception.dart';
import 'package:starvoice_app/providers.dart';

/// 抖音账号绑定页。
///
/// 真实场景由抖音 OAuth 授权回调带回 code；MVP 阶段点「模拟抖音授权」
/// 用 dev 模式自动生成的 mock- 前缀授权码走 mock 绑定链路。
class DouyinBindPage extends ConsumerStatefulWidget {
  const DouyinBindPage({super.key});

  @override
  ConsumerState<DouyinBindPage> createState() => _DouyinBindPageState();
}

class _DouyinBindPageState extends ConsumerState<DouyinBindPage> {
  final TextEditingController _codeController = TextEditingController();
  bool _binding = false;
  String? _errorText;

  @override
  void initState() {
    super.initState();
    if (kDebugMode) {
      // dev/测试模式自动生成 mock 授权码并在页面展示，方便一键走通绑定链路
      _codeController.text = _generateMockCode();
    }
  }

  @override
  void dispose() {
    _codeController.dispose();
    super.dispose();
  }

  /// 生成 mock 授权码：mock- 前缀 + 时间戳 + 随机串（服务端只认 mock- 前缀）
  String _generateMockCode() {
    final random = Random();
    final nonce = random.nextInt(0x7fffffff).toRadixString(16);
    return 'mock-${DateTime.now().millisecondsSinceEpoch}-$nonce';
  }

  Future<void> _handleMockAuthorize() async {
    var code = _codeController.text.trim();
    if (code.isEmpty && kDebugMode) {
      // 兜底：dev 模式下即便误清空输入框也能再生成
      code = _generateMockCode();
      _codeController.text = code;
    }
    if (code.isEmpty) {
      setState(() {
        _errorText = '请输入抖音授权 code，或点击右上角重新模拟授权';
      });
      return;
    }

    FocusScope.of(context).unfocus();
    setState(() {
      _binding = true;
      _errorText = null;
    });
    try {
      await ref.read(apiClientProvider).bindDouyin(code);
      if (!mounted) {
        return;
      }
      // 绑定成功返回首页，由首页重新拉取绑定状态刷新卡片
      context.pop(true);
    } on ApiException catch (error) {
      if (!mounted) {
        return;
      }
      // 错误透传服务端中文 message（如 ALREADY_BOUND / OPENID_CONFLICT / CODE_INVALID）
      setState(() {
        _errorText = error.message;
      });
    } finally {
      if (mounted) {
        setState(() {
          _binding = false;
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('绑定抖音账号')),
      body: SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 32),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const Icon(Icons.smart_display, size: 56, color: Colors.black54),
              const SizedBox(height: 16),
              Text(
                '绑定抖音账号',
                textAlign: TextAlign.center,
                style: Theme.of(context)
                    .textTheme
                    .headlineSmall
                    ?.copyWith(fontWeight: FontWeight.bold),
              ),
              const SizedBox(height: 12),
              const Text(
                '绑定后可用于拉取抖音团购券并开启实景直播。'
                '当前为开发联调阶段，点击下方按钮模拟抖音授权。',
                textAlign: TextAlign.center,
                style: TextStyle(height: 1.5),
              ),
              const SizedBox(height: 32),
              TextField(
                key: const Key('douyinCodeField'),
                controller: _codeController,
                maxLines: 1,
                decoration: const InputDecoration(
                  labelText: '授权码',
                  hintText: '请输入抖音授权 code',
                  prefixIcon: Icon(Icons.key),
                  border: OutlineInputBorder(),
                ),
              ),
              if (kDebugMode)
                Padding(
                  padding: const EdgeInsets.only(top: 8),
                  child: Text(
                    '开发模式：已自动填入模拟授权码',
                    key: const Key('douyinDevCodeHint'),
                    style: TextStyle(fontSize: 12, color: Colors.grey.shade600),
                  ),
                ),
              if (_errorText != null)
                Padding(
                  padding: const EdgeInsets.only(top: 8),
                  child: Text(
                    _errorText!,
                    key: const Key('douyinBindError'),
                    style: TextStyle(color: Theme.of(context).colorScheme.error),
                  ),
                ),
              const SizedBox(height: 24),
              FilledButton(
                key: const Key('mockAuthorizeButton'),
                onPressed: _binding ? null : _handleMockAuthorize,
                style: FilledButton.styleFrom(minimumSize: const Size.fromHeight(48)),
                child: _binding
                    ? const SizedBox(
                        width: 20,
                        height: 20,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      )
                    : const Text('模拟抖音授权', style: TextStyle(fontSize: 16)),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
