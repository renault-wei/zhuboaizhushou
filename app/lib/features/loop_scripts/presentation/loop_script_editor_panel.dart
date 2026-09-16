/// 循环台本编辑器（新建/编辑/生成草稿预览共用）：标题 + 有序条目编辑。
/// 每条台词支持：多行文本、播后间隔秒（0-60，空 = 用全局默认 0 秒）、
/// 上移 / 下移 / 删除 / 添加一句。保存前只做本地必填校验，命中敏感词由
/// 服务端拦截（SENSITIVE_BLOCKED），页面透出命中词提示。
library;

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'package:starvoice_app/core/models/loop_script.dart';
import 'package:starvoice_app/core/network/api_exception.dart';
import 'package:starvoice_app/core/theme/app_colors.dart';
import 'package:starvoice_app/core/theme/theme_tokens.dart';
import 'package:starvoice_app/providers.dart';

const Map<String, String> _loopKindLabels = <String, String>{
  'opening': '开场',
  'product': '产品介绍',
  'coupon': '券讲解',
  'warmup': '暖场',
  'closing': '收尾',
  'custom': '自定义',
};

String _loopKindLabel(String? kind) {
  if (kind == null || kind.isEmpty) {
    return '';
  }
  return _loopKindLabels[kind] ?? kind;
}

/// 编辑器内部的可变条目：uid 保证增删改排序时控件状态稳定。
class _EditableLoopItem {
  _EditableLoopItem({
    required this.uid,
    this.id = '',
    this.kind,
    required this.text,
    this.gapAfterSeconds,
    this.ttsSegmentCount,
  });

  factory _EditableLoopItem.fromModel(int uid, LoopScriptItem item) {
    return _EditableLoopItem(
      uid: uid,
      id: item.id,
      kind: item.kind,
      text: item.text,
      gapAfterSeconds: item.gapAfterSeconds,
      ttsSegmentCount: item.ttsSegmentCount,
    );
  }

  final int uid;
  final String id;
  final String? kind;
  String text;
  int? gapAfterSeconds;

  /// 服务端回带的合成分段份数（R19）；草稿/本地新增条目为 null，由编辑器实时预览
  int? ttsSegmentCount;
}

/// 单条台词编辑行：文本多行输入 + 间隔秒输入 + 上移/下移/删除。
class _LoopItemRow extends ConsumerStatefulWidget {
  const _LoopItemRow({
    required this.item,
    required this.index,
    required this.total,
    required this.onChanged,
    required this.onMoveUp,
    required this.onMoveDown,
    required this.onDelete,
  });

  final _EditableLoopItem item;
  final int index;
  final int total;
  final ValueChanged<String> onChanged;
  final VoidCallback onMoveUp;
  final VoidCallback onMoveDown;
  final VoidCallback onDelete;

  @override
  ConsumerState<_LoopItemRow> createState() => _LoopItemRowState();
}

class _LoopItemRowState extends ConsumerState<_LoopItemRow> {
  late final TextEditingController _textController;
  late final TextEditingController _gapController;
  Timer? _previewDebounce;

  /// 实时预览到的分段份数（服务端口径）；null = 尚未取到
  int? _liveSegmentCount;

  @override
  void initState() {
    super.initState();
    _textController = TextEditingController(text: widget.item.text);
    _gapController = TextEditingController(
      text: widget.item.gapAfterSeconds?.toString() ?? '',
    );
    // 服务端已在详情里回带份数就直接用；草稿/新增条目没有，才去问一次
    if (widget.item.ttsSegmentCount == null) {
      _schedulePreview(immediate: true);
    }
  }

  @override
  void dispose() {
    _previewDebounce?.cancel();
    _textController.dispose();
    _gapController.dispose();
    super.dispose();
  }

  /// 防抖预览分段份数：打字时不打断输入，停手 400ms 才问服务端一次。
  /// 份数一律以服务端为准（复用合成链路的分段实现），客户端不另写一份。
  void _schedulePreview({bool immediate = false}) {
    _previewDebounce?.cancel();
    if (widget.item.text.trim().isEmpty) {
      if (_liveSegmentCount != null) {
        setState(() => _liveSegmentCount = null);
      }
      return;
    }
    _previewDebounce = Timer(
      immediate ? Duration.zero : const Duration(milliseconds: 400),
      () async {
        try {
          final preview = await ref
              .read(apiClientProvider)
              .previewTtsSegments(widget.item.text.trim());
          if (!mounted) {
            return;
          }
          setState(() => _liveSegmentCount = preview.segmentCount);
        } on ApiException {
          // 份数只是提示：预览失败不该打断编辑
        }
      },
    );
  }

  /// 展示用份数：实时预览优先，其次服务端回带的
  int? get _segmentCount => _liveSegmentCount ?? widget.item.ttsSegmentCount;

  @override
  Widget build(BuildContext context) {
    final kindLabel = _loopKindLabel(widget.item.kind);
    final textTheme = Theme.of(context).textTheme;
    return Container(
      key: ValueKey<int>(widget.item.uid),
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: context.tokenSurfaceFill,
        border: Border.all(color: context.tokenDivider),
        borderRadius: BorderRadius.circular(8),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Row(
            children: <Widget>[
              Container(
                width: 22,
                height: 22,
                alignment: Alignment.center,
                decoration: BoxDecoration(
                  color: Theme.of(context).colorScheme.primary,
                  shape: BoxShape.circle,
                ),
                child: Text(
                  '${widget.index + 1}',
                  style: TextStyle(
                    color: Theme.of(context).colorScheme.onPrimary,
                    fontSize: 12,
                    fontWeight: FontWeight.bold,
                  ),
                ),
              ),
              if (kindLabel.isNotEmpty) ...<Widget>[
                const SizedBox(width: 8),
                Container(
                  padding: const EdgeInsets.symmetric(
                    horizontal: 8,
                    vertical: 2,
                  ),
                  decoration: BoxDecoration(
                    color: AppColors.primarySoft,
                    borderRadius: BorderRadius.circular(10),
                  ),
                  child: Text(
                    kindLabel,
                    style: TextStyle(fontSize: 11, color: AppColors.primary),
                  ),
                ),
              ],
              const Spacer(),
              IconButton(
                key: Key('loopItemUp_${widget.item.uid}'),
                visualDensity: VisualDensity.compact,
                icon: const Icon(Icons.keyboard_arrow_up),
                tooltip: '上移',
                onPressed: widget.index == 0 ? null : widget.onMoveUp,
              ),
              IconButton(
                key: Key('loopItemDown_${widget.item.uid}'),
                visualDensity: VisualDensity.compact,
                icon: const Icon(Icons.keyboard_arrow_down),
                tooltip: '下移',
                onPressed: widget.index == widget.total - 1
                    ? null
                    : widget.onMoveDown,
              ),
              IconButton(
                key: Key('loopItemDelete_${widget.item.uid}'),
                visualDensity: VisualDensity.compact,
                icon: const Icon(Icons.delete_outline),
                tooltip: '删除',
                onPressed: widget.onDelete,
              ),
            ],
          ),
          TextField(
            key: Key('loopItemText_${widget.item.uid}'),
            controller: _textController,
            minLines: 1,
            maxLines: 3,
            // 与服务端的宽松安全上限一致（2026-09-17 由 200 放开到 2000）：
            // 业务上不限制话术字数，这里只是拦异常输入
            maxLength: 2000,
            decoration: const InputDecoration(
              hintText: '输入一句口播台词',
              border: OutlineInputBorder(),
              isDense: true,
            ),
            onChanged: (value) {
              widget.item.text = value;
              widget.onChanged(value);
              _schedulePreview();
            },
          ),
          const SizedBox(height: 4),
          Row(
            children: <Widget>[
              Icon(
                Icons.timer_outlined,
                size: 16,
                color: context.tokenTextHint,
              ),
              const SizedBox(width: 6),
              SizedBox(
                width: 88,
                child: TextField(
                  key: Key('loopItemGap_${widget.item.uid}'),
                  controller: _gapController,
                  keyboardType: TextInputType.number,
                  decoration: const InputDecoration(
                    labelText: '间隔秒',
                    hintText: '空=默认2',
                    border: OutlineInputBorder(),
                    isDense: true,
                  ),
                  onChanged: (value) {
                    final parsed = int.tryParse(value.trim());
                    if (parsed != null && parsed >= 0 && parsed <= 60) {
                      widget.item.gapAfterSeconds = parsed;
                    } else {
                      widget.item.gapAfterSeconds = null;
                    }
                  },
                ),
              ),
              const SizedBox(width: 6),
              Text(
                '0-60，播完停顿',
                style: TextStyle(fontSize: 11, color: context.tokenTextHint),
              ),
            ],
          ),
          const SizedBox(height: 6),
          Text(
            _segmentCount == null
                ? '台词 ${widget.item.text.trim().length} 字'
                : '台词 ${widget.item.text.trim().length} 字 · 合成 $_segmentCount 段',
            key: const Key('loopItemSegmentHint'),
            style: textTheme.bodySmall?.copyWith(color: context.tokenTextHint),
          ),
        ],
      ),
    );
  }
}

/// 编辑器面板：标题 + 条目编辑 + 保存（供新建 / 编辑 / 生成草稿预览页复用）。
class LoopScriptEditorPanel extends StatefulWidget {
  const LoopScriptEditorPanel({
    super.key,
    required this.initialTitle,
    this.initialItems = const <LoopScriptItem>[],
    this.generationNote,
    required this.onSave,
    this.saveButtonKey,
  });

  /// 标题初值（编辑 = 原标题；新建默认空串）
  final String initialTitle;

  /// 条目初值（编辑/复制 = 原条目；生成草稿 = 草稿条目；空台本 = 空）
  final List<LoopScriptItem> initialItems;

  /// 生成时的一次性说明（仅生成成功后展示一次，不落库）
  final String? generationNote;

  /// 保存回调：由宿主决定走新建（create）还是整体替换（update）
  final Future<void> Function(String title, List<LoopScriptItem> items) onSave;

  /// 底部保存按钮的 key（页面级便于测试定位）
  final Key? saveButtonKey;

  @override
  State<LoopScriptEditorPanel> createState() => _LoopScriptEditorPanelState();
}

class _LoopScriptEditorPanelState extends State<LoopScriptEditorPanel> {
  late final TextEditingController _titleController;
  late List<_EditableLoopItem> _items;
  int _nextUid = 0;
  bool _saving = false;

  @override
  void initState() {
    super.initState();
    _titleController = TextEditingController(text: widget.initialTitle);
    _items = <_EditableLoopItem>[
      for (final item in widget.initialItems)
        _EditableLoopItem.fromModel(_nextUid++, item),
    ];
  }

  @override
  void dispose() {
    _titleController.dispose();
    super.dispose();
  }

  void _showSnack(String message) {
    if (!mounted) {
      return;
    }
    ScaffoldMessenger.of(context)
      ..clearSnackBars()
      ..showSnackBar(SnackBar(content: Text(message)));
  }

  void _addItem() {
    setState(() {
      _items.add(_EditableLoopItem(uid: _nextUid++, text: ''));
    });
  }

  void _moveItem(int from, int to) {
    if (to < 0 || to >= _items.length) {
      return;
    }
    setState(() {
      final item = _items.removeAt(from);
      _items.insert(to, item);
    });
  }

  void _deleteItem(int index) {
    setState(() {
      _items.removeAt(index);
    });
  }

  /// 保存前本地校验；命中敏感词等由 onSave 抛 [ApiException]，这里透出提示。
  Future<void> _save() async {
    final title = _titleController.text.trim();
    if (title.isEmpty || title.length > 100) {
      _showSnack('台本标题不能为空且不超过 100 字');
      return;
    }
    if (_items.isEmpty) {
      _showSnack('请至少添加一句台词');
      return;
    }
    for (var index = 0; index < _items.length; index++) {
      if (_items[index].text.trim().isEmpty) {
        _showSnack('第 ${index + 1} 句台词不能为空');
        return;
      }
      // 与服务端一致：2000 是宽松安全上限（拦异常），不是业务字数限制
      if (_items[index].text.trim().length > 2000) {
        _showSnack('第 ${index + 1} 句台词超过安全上限（2000 字）');
        return;
      }
    }
    setState(() {
      _saving = true;
    });
    final payloadItems = <LoopScriptItem>[
      for (final item in _items)
        LoopScriptItem(
          id: item.id,
          kind: item.kind,
          text: item.text.trim(),
          gapAfterSeconds: item.gapAfterSeconds,
        ),
    ];
    try {
      await widget.onSave(title, payloadItems);
    } on ApiException catch (error) {
      final hitWords = error.matchedWords;
      final extra = hitWords.isEmpty ? '' : '（命中：${hitWords.join('、')}）';
      if (mounted) {
        _showSnack('保存失败：${error.message}$extra');
      }
    } finally {
      if (mounted) {
        setState(() {
          _saving = false;
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    return ListView(
      padding: const EdgeInsets.all(16),
      children: <Widget>[
        TextField(
          key: const Key('loopScriptTitleField'),
          controller: _titleController,
          maxLength: 100,
          decoration: const InputDecoration(
            labelText: '台本标题（1-100 字）',
            hintText: '例如：午市火锅循环口播',
            border: OutlineInputBorder(),
          ),
        ),
        if (widget.generationNote != null &&
            widget.generationNote!.isNotEmpty) ...<Widget>[
          const SizedBox(height: 4),
          Container(
            width: double.infinity,
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
            decoration: BoxDecoration(
              color: AppColors.warningSoft,
              borderRadius: BorderRadius.circular(8),
            ),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                const Icon(
                  Icons.auto_fix_high_outlined,
                  size: 16,
                  color: AppColors.warning,
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(
                    widget.generationNote!,
                    key: const Key('loopScriptGenerationNote'),
                    style: TextStyle(fontSize: 12, color: AppColors.warning),
                  ),
                ),
              ],
            ),
          ),
        ],
        const SizedBox(height: 16),
        Row(
          children: <Widget>[
            Expanded(
              child: Text(
                '台本条目（${_items.length}）',
                style: Theme.of(context).textTheme.titleSmall
                    ?.copyWith(fontWeight: FontWeight.bold),
              ),
            ),
          ],
        ),
        const SizedBox(height: 8),
        for (var index = 0; index < _items.length; index++)
          Padding(
            padding: const EdgeInsets.only(bottom: 10),
            child: _LoopItemRow(
              item: _items[index],
              index: index,
              total: _items.length,
              onChanged: (_) {},
              onMoveUp: () => _moveItem(index, index - 1),
              onMoveDown: () => _moveItem(index, index + 1),
              onDelete: () => _deleteItem(index),
            ),
          ),
        if (_items.isEmpty)
          Padding(
            padding: EdgeInsets.symmetric(vertical: 20),
            child: Center(
              child: Text(
                '还没有台词，点击下方「添加一句」开始编写',
                style: TextStyle(color: context.tokenTextHint),
              ),
            ),
          ),
        OutlinedButton.icon(
          key: const Key('loopItemAddButton'),
          onPressed: _saving ? null : _addItem,
          icon: const Icon(Icons.add),
          label: const Text('添加一句'),
        ),
        const SizedBox(height: 10),
        Text(
          '循环节奏：整本按顺序循环播放，每条播完后停顿其「间隔秒」（空则默认 0 秒，连读不停）。',
          style: TextStyle(fontSize: 12, color: context.tokenTextBody),
        ),
        const SizedBox(height: 16),
        FilledButton(
          key: widget.saveButtonKey ?? const Key('loopScriptSaveButton'),
          onPressed: _saving ? null : _save,
          style: FilledButton.styleFrom(minimumSize: const Size.fromHeight(48)),
          child: _saving
              ? const SizedBox(
                  width: 20,
                  height: 20,
                  child: CircularProgressIndicator(strokeWidth: 2),
                )
              : const Text('保存台本'),
        ),
        const SizedBox(height: 24),
      ],
    );
  }
}
