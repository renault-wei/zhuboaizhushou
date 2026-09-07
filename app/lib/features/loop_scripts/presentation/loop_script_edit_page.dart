/// 循环台本编辑页（/loop-scripts/:id/edit）：加载台本详情后用统一编辑器
/// 整体替换标题与条目（seq = 顺序号）；引用它的场次待下次开播生效，不做热更新。
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import 'package:starvoice_app/core/models/loop_script.dart';
import 'package:starvoice_app/core/network/api_exception.dart';
import 'package:starvoice_app/features/loop_scripts/presentation/loop_script_editor_panel.dart';
import 'package:starvoice_app/providers.dart';

/// 循环台本编辑页。
class LoopScriptEditPage extends ConsumerStatefulWidget {
  const LoopScriptEditPage({super.key, required this.loopScriptId});

  final String loopScriptId;

  @override
  ConsumerState<LoopScriptEditPage> createState() =>
      _LoopScriptEditPageState();
}

class _LoopScriptEditPageState extends ConsumerState<LoopScriptEditPage> {
  bool _loading = true;
  String? _error;
  LoopScript? _script;

  @override
  void initState() {
    super.initState();
    // 首帧后再拉取详情，避免在 build 阶段发起网络请求
    WidgetsBinding.instance.addPostFrameCallback((_) => _load());
  }

  Future<void> _load() async {
    if (mounted) {
      setState(() {
        _loading = true;
        _error = null;
      });
    }
    try {
      final script = await ref
          .read(apiClientProvider)
          .getLoopScript(widget.loopScriptId);
      if (!mounted) {
        return;
      }
      setState(() {
        _script = script;
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

  Future<void> _save(String title, List<LoopScriptItem> items) async {
    await ref.read(apiClientProvider).updateLoopScript(
      widget.loopScriptId,
      title: title,
      items: <Map<String, dynamic>>[
        for (final item in items) item.toPayload(),
      ],
    );
    if (mounted) {
      ScaffoldMessenger.of(context)
        ..clearSnackBars()
        ..showSnackBar(const SnackBar(content: Text('台本已保存')));
      context.pop();
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      key: const Key('loopScriptEditPage'),
      appBar: AppBar(title: const Text('编辑循环台本')),
      body: _buildBody(),
    );
  }

  Widget _buildBody() {
    if (_loading) {
      return const Center(
        child: CircularProgressIndicator(key: Key('loopScriptEditLoading')),
      );
    }
    if (_error != null) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: <Widget>[
              Text(
                '台本加载失败：$_error',
                textAlign: TextAlign.center,
              ),
              const SizedBox(height: 12),
              OutlinedButton(
                key: const Key('loopScriptEditRetryButton'),
                onPressed: _load,
                child: const Text('重试'),
              ),
            ],
          ),
        ),
      );
    }
    final script = _script;
    if (script == null) {
      return const SizedBox.shrink();
    }
    return LoopScriptEditorPanel(
      initialTitle: script.title,
      initialItems: script.items,
      saveButtonKey: const Key('loopScriptEditSaveButton'),
      onSave: _save,
    );
  }
}
