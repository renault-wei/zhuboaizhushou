import 'package:flutter/material.dart';

import 'package:starvoice_app/core/models/volc_preset.dart';
import 'package:starvoice_app/core/theme/app_colors.dart';
import 'package:starvoice_app/core/theme/theme_tokens.dart';

/// 音色性别展示文案：服务端下发 female / male，未知值不展示。
String presetGenderLabel(String gender) {
  switch (gender) {
    case 'female':
      return '女声';
    case 'male':
      return '男声';
    default:
      return '';
  }
}

/// 「预设音色」列表区：按服务端分组顺序展示全部火山预设音色（44 条量级），
/// 每行可试听、可设为商家默认音色；分组默认折叠，避免长列表铺满整屏。
///
/// 数据来源与默认音色口径：服务端为准（[catalog] 为服务端或本地缓存快照），
/// [catalogFromCache]=true 时如实标注「展示的是本机缓存」。
class PresetVoiceSection extends StatelessWidget {
  const PresetVoiceSection({
    super.key,
    required this.catalog,
    required this.catalogLoading,
    required this.catalogFromCache,
    required this.catalogError,
    required this.previewingId,
    required this.savingDefault,
    required this.onPreview,
    required this.onSetDefault,
    required this.onRetry,
  });

  final VolcPresetCatalog catalog;

  /// 正在从服务端拉取目录
  final bool catalogLoading;

  /// 目录来自本机缓存（服务端拉取失败回落）
  final bool catalogFromCache;
  final String? catalogError;

  /// 正在试听的预设音色 id（null = 空闲）
  final String? previewingId;

  /// 默认音色是否正在提交（提交期间禁止改选，避免连点）
  final bool savingDefault;

  final void Function(VolcPresetVoice preset) onPreview;
  final void Function(VolcPresetVoice preset) onSetDefault;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    final groups = catalog.groupedPresets;
    return Column(
      key: const Key('presetVoiceSection'),
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        _buildHeader(context),
        if (catalogFromCache && catalogError != null) ...[
          const SizedBox(height: 8),
          _buildBanner(context, '预设音色暂时取不到（$catalogError），以下为本机缓存的音色'),
        ],
        const SizedBox(height: 10),
        if (catalogLoading && groups.isEmpty)
          const Padding(
            padding: EdgeInsets.symmetric(vertical: 12),
            child: Center(
              child: SizedBox(
                width: 20,
                height: 20,
                child: CircularProgressIndicator(
                  key: Key('presetCatalogLoading'),
                  strokeWidth: 2,
                ),
              ),
            ),
          )
        else if (groups.isEmpty)
          _buildErrorState(context)
        else
          for (final group in groups)
            _PresetGroupTile(
              group: group,
              defaultPresetId: catalog.userDefaultPresetId,
              previewingId: previewingId,
              savingDefault: savingDefault,
              onPreview: onPreview,
              onSetDefault: onSetDefault,
            ),
      ],
    );
  }

  Widget _buildHeader(BuildContext context) {
    return Row(
      children: [
        const Icon(Icons.library_music_outlined, size: 20),
        const SizedBox(width: 8),
        const Text(
          '预设音色',
          style: TextStyle(fontSize: 16, fontWeight: FontWeight.bold),
        ),
        const Spacer(),
        Text(
          catalog.presets.isEmpty ? '—' : '${catalog.presets.length} 个',
          key: const Key('presetVoiceCountLabel'),
          style: TextStyle(fontSize: 12, color: context.tokenTextBody),
        ),
      ],
    );
  }

  Widget _buildBanner(BuildContext context, String message) {
    return Container(
      key: const Key('presetCatalogCacheBanner'),
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
      decoration: BoxDecoration(
        color: AppColors.warning.withValues(alpha: 0.12),
        borderRadius: BorderRadius.circular(8),
      ),
      child: Text(
        message,
        style: const TextStyle(fontSize: 12, color: AppColors.warning),
      ),
    );
  }

  Widget _buildErrorState(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 16),
      decoration: BoxDecoration(
        color: context.tokenSurfaceFill,
        borderRadius: BorderRadius.circular(12),
      ),
      child: Column(
        children: [
          Text(
            catalogError == null ? '预设音色为空' : '预设音色加载失败：$catalogError',
            key: const Key('presetCatalogErrorText'),
            textAlign: TextAlign.center,
            style: TextStyle(fontSize: 13, color: context.tokenTextBody),
          ),
          const SizedBox(height: 10),
          OutlinedButton(
            key: const Key('presetCatalogRetryButton'),
            onPressed: catalogLoading ? null : onRetry,
            child: const Text('重试'),
          ),
        ],
      ),
    );
  }
}

/// 单个预设分组：可折叠标题（分组名 + 条数 + 展收箭头）+ 组内音色行。
class _PresetGroupTile extends StatefulWidget {
  const _PresetGroupTile({
    required this.group,
    required this.defaultPresetId,
    required this.previewingId,
    required this.savingDefault,
    required this.onPreview,
    required this.onSetDefault,
  });

  final PresetVoiceGroup group;
  final String? defaultPresetId;
  final String? previewingId;
  final bool savingDefault;
  final void Function(VolcPresetVoice preset) onPreview;
  final void Function(VolcPresetVoice preset) onSetDefault;

  @override
  State<_PresetGroupTile> createState() => _PresetGroupTileState();
}

class _PresetGroupTileState extends State<_PresetGroupTile> {
  /// 分组默认折叠：44 条音色一次铺开会让页面过长，按需展开更清爽
  bool _expanded = false;

  @override
  Widget build(BuildContext context) {
    final voices = widget.group.voices;
    return Card(
      key: Key('presetGroup_${widget.group.id}'),
      margin: const EdgeInsets.only(bottom: 10),
      clipBehavior: Clip.antiAlias,
      child: Column(
        children: [
          InkWell(
            key: Key('presetGroupHeader_${widget.group.id}'),
            onTap: () => setState(() => _expanded = !_expanded),
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
              child: Row(
                children: [
                  Expanded(
                    child: Text(
                      widget.group.label,
                      style: const TextStyle(
                        fontSize: 15,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                  ),
                  Text(
                    '${voices.length} 个',
                    style: TextStyle(fontSize: 12, color: context.tokenTextHint),
                  ),
                  const SizedBox(width: 6),
                  AnimatedRotation(
                    turns: _expanded ? 0.5 : 0,
                    duration: const Duration(milliseconds: 160),
                    child: Icon(
                      Icons.expand_more,
                      size: 20,
                      color: context.tokenTextHint,
                    ),
                  ),
                ],
              ),
            ),
          ),
          if (_expanded) ...<Widget>[
            Divider(height: 1, color: context.tokenDivider),
            for (final preset in voices)
              _PresetVoiceRow(
                preset: preset,
                isDefault: preset.id == widget.defaultPresetId,
                previewing: preset.id == widget.previewingId,
                busy: widget.savingDefault,
                onPreview: () => widget.onPreview(preset),
                onSetDefault: () => widget.onSetDefault(preset),
              ),
          ],
        ],
      ),
    );
  }
}

/// 单条预设音色行：名称 + 性别/推荐标记 + 试听 + 设为默认（单选）。
class _PresetVoiceRow extends StatelessWidget {
  const _PresetVoiceRow({
    required this.preset,
    required this.isDefault,
    required this.previewing,
    required this.busy,
    required this.onPreview,
    required this.onSetDefault,
  });

  final VolcPresetVoice preset;
  final bool isDefault;
  final bool previewing;

  /// 有其他默认音色正在提交：禁止重复提交
  final bool busy;
  final VoidCallback onPreview;
  final VoidCallback onSetDefault;

  @override
  Widget build(BuildContext context) {
    final gender = presetGenderLabel(preset.gender);
    return Padding(
      key: Key('presetVoiceRow_${preset.id}'),
      padding: const EdgeInsets.fromLTRB(16, 8, 8, 8),
      child: Row(
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    Flexible(
                      child: Text(
                        preset.name,
                        style: const TextStyle(
                          fontSize: 15,
                          fontWeight: FontWeight.w600,
                        ),
                        overflow: TextOverflow.ellipsis,
                      ),
                    ),
                    if (gender.isNotEmpty) ...[
                      const SizedBox(width: 6),
                      _Chip(label: gender, color: AppColors.info),
                    ],
                    if (preset.recommended) ...[
                      const SizedBox(width: 6),
                      const _Chip(label: '推荐', color: AppColors.live),
                    ],
                    if (isDefault) ...[
                      const SizedBox(width: 6),
                      _Chip(
                        label: '默认',
                        color: AppColors.primary,
                        key: Key('presetDefaultMark_${preset.id}'),
                      ),
                    ],
                  ],
                ),
              ],
            ),
          ),
          if (previewing)
            const Padding(
              padding: EdgeInsets.symmetric(horizontal: 12),
              child: SizedBox(
                width: 18,
                height: 18,
                child: CircularProgressIndicator(
                  key: Key('presetListenLoading'),
                  strokeWidth: 2,
                ),
              ),
            )
          else
            TextButton(
              key: Key('presetListen_${preset.id}'),
              onPressed: onPreview,
              child: const Text('试听'),
            ),
          TextButton(
            key: Key('presetSetDefault_${preset.id}'),
            onPressed: (isDefault || busy) ? null : onSetDefault,
            child: Text(isDefault ? '已设为默认' : '设为默认'),
          ),
        ],
      ),
    );
  }
}

/// 小圆角标记块（性别 / 推荐 / 默认）
class _Chip extends StatelessWidget {
  const _Chip({super.key, required this.label, required this.color});

  final String label;
  final Color color;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.12),
        borderRadius: BorderRadius.circular(999),
      ),
      child: Text(
        label,
        style: TextStyle(
          fontSize: 11,
          color: color,
          fontWeight: FontWeight.w600,
        ),
      ),
    );
  }
}
