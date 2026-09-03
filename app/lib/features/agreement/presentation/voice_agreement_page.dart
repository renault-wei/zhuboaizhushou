import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import 'package:starvoice_app/core/models/voice_agreement.dart';
import 'package:starvoice_app/core/network/api_exception.dart';
import 'package:starvoice_app/providers.dart';

/// 声音授权协议签署页（路由 /voice-agreement）。
///
/// 流程：滚动阅读协议全文 → 底部固定勾选框「我已阅读并同意《声音授权协议》」
/// → 点「签署」（未勾选禁用）→ 成功后返回首页，由首页重新拉取签署状态刷新卡片。
class VoiceAgreementPage extends ConsumerStatefulWidget {
  const VoiceAgreementPage({super.key});

  @override
  ConsumerState<VoiceAgreementPage> createState() => _VoiceAgreementPageState();
}

class _VoiceAgreementPageState extends ConsumerState<VoiceAgreementPage> {
  bool _loading = true;
  String? _error;
  VoiceAgreement? _agreement;
  bool _agreed = false;
  bool _signing = false;

  @override
  void initState() {
    super.initState();
    // 首帧后再拉取，避免 build 阶段发起网络请求
    WidgetsBinding.instance.addPostFrameCallback((_) => _loadAgreement());
  }

  Future<void> _loadAgreement() async {
    if (mounted) {
      setState(() {
        _loading = true;
        _error = null;
      });
    }
    try {
      final agreement = await ref.read(apiClientProvider).fetchVoiceAgreement();
      if (!mounted) {
        return;
      }
      setState(() {
        _agreement = agreement;
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

  Future<void> _handleSign() async {
    final agreement = _agreement;
    if (agreement == null || _signing) {
      return;
    }
    setState(() {
      _signing = true;
    });
    try {
      await ref.read(apiClientProvider).signVoiceAgreement(version: agreement.version);
      if (!mounted) {
        return;
      }
      // 签署成功返回首页，由首页刷新卡片展示「已签署」
      context.pop(true);
    } on ApiException catch (error) {
      if (!mounted) {
        return;
      }
      ScaffoldMessenger.of(context)
        ..clearSnackBars()
        ..showSnackBar(SnackBar(content: Text(error.message)));
    } finally {
      if (mounted) {
        setState(() {
          _signing = false;
        });
      }
    }
  }

  Widget _buildBody() {
    if (_loading) {
      return const Center(child: CircularProgressIndicator());
    }
    if (_error != null) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              Text(
                '协议加载失败：$_error',
                key: const Key('voiceAgreementLoadError'),
                textAlign: TextAlign.center,
                style: TextStyle(color: Theme.of(context).colorScheme.error),
              ),
              const SizedBox(height: 16),
              OutlinedButton(
                key: const Key('voiceAgreementRetryButton'),
                onPressed: _loadAgreement,
                child: const Text('重试'),
              ),
            ],
          ),
        ),
      );
    }

    final agreement = _agreement;
    if (agreement == null) {
      return const SizedBox.shrink();
    }
    return SingleChildScrollView(
      key: const Key('voiceAgreementScrollView'),
      padding: const EdgeInsets.fromLTRB(20, 16, 20, 24),
      child: Text(
        agreement.content,
        key: const Key('voiceAgreementContent'),
        style: const TextStyle(fontSize: 15, height: 1.7),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final canSign = _agreed && !_loading && _error == null && _agreement != null;

    return Scaffold(
      appBar: AppBar(title: const Text('声音授权协议')),
      body: SafeArea(child: _buildBody()),
      // 底部固定：勾选框 + 签署按钮（未勾选时签署禁用）
      bottomNavigationBar: SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(16, 4, 16, 12),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Row(
                children: [
                  Checkbox(
                    key: const Key('voiceAgreementCheckbox'),
                    value: _agreed,
                    onChanged: (value) {
                      setState(() {
                        _agreed = value ?? false;
                      });
                    },
                  ),
                  const Expanded(
                    child: Text(
                      '我已阅读并同意《声音授权协议》',
                      style: TextStyle(fontSize: 14),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 8),
              SizedBox(
                width: double.infinity,
                height: 48,
                child: FilledButton(
                  key: const Key('voiceAgreementSignButton'),
                  onPressed: canSign && !_signing ? _handleSign : null,
                  child: _signing
                      ? const SizedBox(
                          width: 20,
                          height: 20,
                          child: CircularProgressIndicator(strokeWidth: 2),
                        )
                      : const Text('签署', style: TextStyle(fontSize: 16)),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
