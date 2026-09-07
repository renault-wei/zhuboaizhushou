import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'package:starvoice_app/core/models/script.dart';
import 'package:starvoice_app/core/network/api_exception.dart';
import 'package:starvoice_app/core/theme/app_colors.dart';
import 'package:starvoice_app/core/theme/theme_tokens.dart';
import 'package:starvoice_app/providers.dart';

/// 话术编辑保存页（路由 /scripts/:id/edit）：
/// 多行编辑 content（可选标题），保存后服务端会重新做敏感词扫描，
/// 命中拦截词时展示红色警示条，话术标注不可开播。
class ScriptEditPage extends ConsumerStatefulWidget {
  const ScriptEditPage({super.key, required this.scriptId});

  final String scriptId;

  @override
  ConsumerState<ScriptEditPage> createState() => _ScriptEditPageState();
}

class _ScriptEditPageState extends ConsumerState<ScriptEditPage> {
  bool _loading = true;
  bool _saving = false;
  String? _loadError;
  Script? _script;
  late final TextEditingController _titleController;
  late final TextEditingController _contentController;

  @override
  void initState() {
    super.initState();
    _titleController = TextEditingController();
    _contentController = TextEditingController();
    // 首帧后再拉取话术详情，避免在 build 阶段发起网络请求
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _load();
    });
  }

  @override
  void dispose() {
    _titleController.dispose();
    _contentController.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _loadError = null;
    });
    try {
      final script = await ref
          .read(apiClientProvider)
          .getScript(widget.scriptId);
      if (!mounted) {
        return;
      }
      setState(() {
        _script = script;
        _loading = false;
        _titleController.text = script.title ?? '';
        _contentController.text = script.content;
      });
    } on ApiException catch (error) {
      if (!mounted) {
        return;
      }
      setState(() {
        _loadError = error.message;
        _loading = false;
      });
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

  /// 保存：content 必填；成功后用服务端返回的最新扫描结果刷新页面展示。
  Future<void> _save() async {
    final content = _contentController.text.trim();
    if (content.isEmpty) {
      _showSnack('话术内容不能为空');
      return;
    }
    final title = _titleController.text.trim();
    setState(() {
      _saving = true;
    });
    try {
      final updated = await ref
          .read(apiClientProvider)
          .updateScript(
            widget.scriptId,
            content: content,
            title: title.isEmpty ? null : title,
          );
      if (!mounted) {
        return;
      }
      setState(() {
        _script = updated;
        _saving = false;
        _titleController.text = updated.title ?? '';
        _contentController.text = updated.content;
      });
      _showSnack('已保存，并完成敏感词重新扫描');
    } on ApiException catch (error) {
      if (!mounted) {
        return;
      }
      setState(() {
        _saving = false;
      });
      _showSnack('保存失败：${error.message}');
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      key: const Key('scriptEditPage'),
      appBar: AppBar(title: const Text('编辑话术')),
      body: _buildBody(),
    );
  }

  Widget _buildBody() {
    if (_loading) {
      return const Center(
        child: CircularProgressIndicator(key: Key('scriptEditLoading')),
      );
    }
    if (_loadError != null || _script == null) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: <Widget>[
              Text('话术加载失败：${_loadError ?? '话术不存在'}'),
              const SizedBox(height: 12),
              OutlinedButton(
                key: const Key('scriptEditRetryButton'),
                onPressed: _load,
                child: const Text('重试'),
              ),
            ],
          ),
        ),
      );
    }
    final script = _script!;
    return ListView(
      padding: const EdgeInsets.all(16),
      children: <Widget>[
        TextField(
          key: const Key('scriptEditTitleField'),
          controller: _titleController,
          maxLength: 100,
          decoration: const InputDecoration(
            labelText: '标题（选填）',
            border: OutlineInputBorder(),
          ),
        ),
        const SizedBox(height: 8),
        TextField(
          key: const Key('scriptEditContentField'),
          controller: _contentController,
          minLines: 10,
          maxLines: null,
          decoration: const InputDecoration(
            labelText: '话术内容',
            alignLabelWithHint: true,
            border: OutlineInputBorder(),
          ),
        ),
        const SizedBox(height: 4),
        Text(
          '保存后将重新进行敏感词扫描，命中拦截词会被标记为不可开播',
          style: TextStyle(fontSize: 12, color: context.tokenTextBody),
        ),
        const SizedBox(height: 16),
        FilledButton(
          key: const Key('scriptSaveButton'),
          onPressed: _saving ? null : _save,
          style: FilledButton.styleFrom(minimumSize: const Size.fromHeight(48)),
          child: _saving
              ? const SizedBox(
                  width: 20,
                  height: 20,
                  child: CircularProgressIndicator(strokeWidth: 2),
                )
              : const Text('保存并重新扫描'),
        ),
        const SizedBox(height: 16),
        if (script.isBlocked)
          _buildBlockedBanner(script.sensitiveMatchedWords)
        else
          Row(
            children: <Widget>[
              Icon(Icons.check_circle_outline, size: 16, color: AppColors.live),
              const SizedBox(width: 6),
              Text(
                '扫描通过，当前话术可开播',
                key: const Key('scriptEditReadyHint'),
                style: TextStyle(fontSize: 13, color: AppColors.live),
              ),
            ],
          ),
      ],
    );
  }

  Widget _buildBlockedBanner(List<String> matchedWords) {
    final words = matchedWords.isEmpty
        ? '命中拦截级敏感词，话术不可开播'
        : '命中敏感词：${matchedWords.join('、')}，话术不可开播';
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
      decoration: BoxDecoration(
        color: AppColors.danger.withValues(alpha: 0.08),
        borderRadius: BorderRadius.circular(8),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          const Icon(
            Icons.warning_amber_rounded,
            size: 16,
            color: AppColors.danger,
          ),
          const SizedBox(width: 6),
          Expanded(
            child: Text(
              words,
              key: const Key('scriptEditBlockedBanner'),
              style: TextStyle(fontSize: 13, color: AppColors.danger),
            ),
          ),
        ],
      ),
    );
  }
}
