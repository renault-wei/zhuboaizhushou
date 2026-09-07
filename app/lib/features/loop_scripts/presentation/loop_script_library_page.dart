/// 循环台本库页（/loop-scripts）：我的循环台本列表 + 新建入口。
/// 行内操作：编辑 / 复制为草稿 / 删除（删除会解除引用该台本的开播配置，
/// 进行中的直播场次不受影响，由服务端在删除时解绑并保留内存快照）。
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import 'package:starvoice_app/core/models/loop_script.dart';
import 'package:starvoice_app/core/network/api_exception.dart';
import 'package:starvoice_app/core/theme/theme_tokens.dart';
import 'package:starvoice_app/features/loop_scripts/application/loop_script_controller.dart';
import 'package:starvoice_app/providers.dart';

String _twoDigits(int value) => value.toString().padLeft(2, '0');

/// 展示用更新时间：ISO 字符串 → yyyy-MM-dd HH:mm（本地时区）。
String _formatUpdatedAt(String iso) {
  final time = DateTime.tryParse(iso);
  if (time == null) {
    return '';
  }
  final local = time.toLocal();
  return '${local.year}-${_twoDigits(local.month)}-${_twoDigits(local.day)} '
      '${_twoDigits(local.hour)}:${_twoDigits(local.minute)}';
}

/// 循环台本库页。
class LoopScriptLibraryPage extends ConsumerStatefulWidget {
  const LoopScriptLibraryPage({super.key, this.selectable = false});

  /// 点选绑定模式（select=1）：行点击即 pop 返回整本台本，供开播配置表单绑定；
  /// 非选择模式保留行内 编辑/复制/删除 操作菜单。
  final bool selectable;

  @override
  ConsumerState<LoopScriptLibraryPage> createState() =>
      _LoopScriptLibraryPageState();
}

class _LoopScriptLibraryPageState extends ConsumerState<LoopScriptLibraryPage> {
  @override
  void initState() {
    super.initState();
    // 首帧后再拉取列表，避免在 build 阶段发起网络请求
    WidgetsBinding.instance.addPostFrameCallback((_) {
      ref.read(loopScriptControllerProvider.notifier).load();
    });
  }

  Future<void> _reload() async {
    await ref.read(loopScriptControllerProvider.notifier).load();
  }

  void _showSnack(String message) {
    if (!mounted) {
      return;
    }
    ScaffoldMessenger.of(context)
      ..clearSnackBars()
      ..showSnackBar(SnackBar(content: Text(message)));
  }

  /// 新建台本（含空台本手填 / 从话术一键生成两种入口）。
  Future<void> _openNew() async {
    await context.push('/loop-scripts/new');
    if (!mounted) {
      return;
    }
    await _reload();
  }

  Future<void> _openEdit(LoopScript script) async {
    await context.push('/loop-scripts/${script.id}/edit');
    if (!mounted) {
      return;
    }
    await _reload();
  }

  /// 复制为草稿：把现有台本内容带入「新建」编辑列表，保存后生成新台本。
  Future<void> _openCopyDraft(LoopScript script) async {
    await context.push('/loop-scripts/new?copy=${script.id}');
    if (!mounted) {
      return;
    }
    await _reload();
  }

  /// 删除二次确认：文案说明引用会解绑、进行中场次不受影响。
  Future<void> _confirmDelete(LoopScript script) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('删除循环台本'),
        content: const Text(
          '删除后引用该台本的开播配置会自动解除绑定，'
          '进行中的直播不受影响。确定删除吗？',
        ),
        actions: <Widget>[
          TextButton(
            onPressed: () => Navigator.of(context).pop(false),
            child: const Text('取消'),
          ),
          TextButton(
            key: const Key('loopScriptDeleteConfirmButton'),
            onPressed: () => Navigator.of(context).pop(true),
            child: const Text('确定删除'),
          ),
        ],
      ),
    );
    if (confirmed != true || !mounted) {
      return;
    }
    try {
      await ref.read(loopScriptControllerProvider.notifier).delete(script.id);
      if (mounted) {
        _showSnack('已删除循环台本');
      }
    } on ApiException catch (error) {
      if (mounted) {
        _showSnack('删除失败：${error.message}');
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final state = ref.watch(loopScriptControllerProvider);
    return Scaffold(
      key: const Key('loopScriptLibraryPage'),
      appBar: AppBar(
        title: const Text('循环台本'),
        actions: <Widget>[
          IconButton(
            key: const Key('loopScriptRefreshButton'),
            onPressed: state.loading ? null : _reload,
            icon: const Icon(Icons.refresh),
            tooltip: '刷新',
          ),
        ],
      ),
      body: _buildBody(state),
    );
  }

  Widget _buildBody(LoopScriptState state) {
    if (state.loading && state.scripts.isEmpty) {
      return const Center(
        child: CircularProgressIndicator(key: Key('loopScriptListLoading')),
      );
    }
    return ListView(
      padding: const EdgeInsets.all(16),
      children: <Widget>[
        Row(
          children: <Widget>[
            Expanded(
              child: Text(
                '我的循环台本（${state.scripts.length}）',
                style: Theme.of(context).textTheme.titleMedium
                    ?.copyWith(fontWeight: FontWeight.bold),
              ),
            ),
            FilledButton(
              key: const Key('loopScriptCreateButton'),
              onPressed: state.deletingId != null ? null : _openNew,
              child: const Text('新建台本'),
            ),
          ],
        ),
        const SizedBox(height: 8),
        if (widget.selectable)
          Padding(
            padding: const EdgeInsets.only(bottom: 8),
            child: Text(
              '点选一条循环台本绑定到本场开播；没有合适的台本可先「新建台本」',
              key: const Key('loopScriptSelectHint'),
              style: TextStyle(fontSize: 12, color: context.tokenTextHint),
            ),
          ),
        if (state.error != null && state.scripts.isEmpty)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 24),
            child: Column(
              children: <Widget>[
                Text('台本列表加载失败：${state.error}'),
                const SizedBox(height: 12),
                OutlinedButton(
                  key: const Key('loopScriptListRetryButton'),
                  onPressed: _reload,
                  child: const Text('重试'),
                ),
              ],
            ),
          )
        else if (state.scripts.isEmpty && !state.loading)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 40),
            child: Center(
              child: Text(
                '还没有循环台本，点击「新建台本」创建一条循环口播台本',
                key: const Key('loopScriptEmptyText'),
                textAlign: TextAlign.center,
                style: TextStyle(color: context.tokenTextHint),
              ),
            ),
          )
        else
          ..._buildScriptCards(state),
      ],
    );
  }

  List<Widget> _buildScriptCards(LoopScriptState state) {
    return <Widget>[
      for (final script in state.scripts)
        Card(
          key: Key('loopScriptCard_${script.id}'),
          margin: const EdgeInsets.symmetric(vertical: 6),
          child: ListTile(
            onTap: widget.selectable
                ? () => Navigator.of(context).pop(script)
                : null,
            contentPadding: const EdgeInsets.only(left: 16, right: 4),
            leading: const Icon(Icons.playlist_play_rounded),
            title: Text(
              script.hasEmptyTitle ? '（未命名台本）' : script.title,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
            ),
            subtitle: Text(
              '${script.itemCount} 条 · 更新于 ${_formatUpdatedAt(script.updatedAt)}',
              style: TextStyle(fontSize: 12, color: context.tokenTextBody),
            ),
            trailing: widget.selectable
                ? const Icon(Icons.check_circle_outline)
                : PopupMenuButton<String>(
                    key: Key('loopScriptMenu_${script.id}'),
                    enabled: state.deletingId == null,
                    onSelected: (action) {
                      if (action == 'edit') {
                        _openEdit(script);
                      } else if (action == 'copy') {
                        _openCopyDraft(script);
                      } else if (action == 'delete') {
                        _confirmDelete(script);
                      }
                    },
                    itemBuilder: (context) => <PopupMenuEntry<String>>[
                      const PopupMenuItem<String>(
                        value: 'edit',
                        child: Text('编辑'),
                      ),
                      const PopupMenuItem<String>(
                        value: 'copy',
                        child: Text('复制为草稿'),
                      ),
                      const PopupMenuItem<String>(
                        value: 'delete',
                        child: Text('删除'),
                      ),
                    ],
                  ),
          ),
        ),
    ];
  }
}
