import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'package:starvoice_app/core/models/live.dart';
import 'package:starvoice_app/core/models/script.dart';
import 'package:starvoice_app/core/models/voice.dart';
import 'package:starvoice_app/core/models/volc_preset.dart';
import 'package:starvoice_app/core/network/api_client.dart';
import 'package:starvoice_app/core/network/api_exception.dart';
import 'package:starvoice_app/core/storage/voice_cache_store.dart';

/// 开播配置表单页 UI 状态（新建与编辑共用）。
/// 除可选项下拉数据（音色/话术）外，编辑模式还缓存初始 Live 用于预填。
class LiveFormState {
  const LiveFormState({
    this.initial,
    this.voices = const <Voice>[],
    this.presets = const <VolcPresetVoice>[],
    this.presetGroups = const <VolcPresetGroup>[],
    this.defaultPresetId = '',
    this.scripts = const <Script>[],
    this.loading = false,
    this.loadError,
    this.saving = false,
  });

  /// 编辑模式下的初始配置（新建模式为 null）
  final Live? initial;

  /// 可选音色（仅 status=ready 的可选，其余禁用展示）
  final List<Voice> voices;

  /// 火山预设音色目录（只读内置，全部可选中）
  final List<VolcPresetVoice> presets;

  /// 预设音色的分组元数据（服务端下发顺序，客户端据此分组展示）
  final List<VolcPresetGroup> presetGroups;

  /// 新建场次的默认音色 id（服务端下发；空串 = 未提供）
  final String defaultPresetId;

  /// 可选话术（仅 status=ready 的可选，blocked/draft 禁用展示）
  final List<Script> scripts;

  /// 引用数据 / 初始配置加载中
  final bool loading;

  /// 加载失败的中文提示（含编辑模式 404）
  final String? loadError;

  /// 保存中（防止重复提交）
  final bool saving;

  LiveFormState copyWith({
    Live? initial,
    List<Voice>? voices,
    List<VolcPresetVoice>? presets,
    List<VolcPresetGroup>? presetGroups,
    String? defaultPresetId,
    List<Script>? scripts,
    bool? loading,
    String? loadError,
    bool clearError = false,
    bool? saving,
  }) {
    return LiveFormState(
      initial: initial ?? this.initial,
      voices: voices ?? this.voices,
      presets: presets ?? this.presets,
      presetGroups: presetGroups ?? this.presetGroups,
      defaultPresetId: defaultPresetId ?? this.defaultPresetId,
      scripts: scripts ?? this.scripts,
      loading: loading ?? this.loading,
      loadError: clearError ? null : loadError ?? this.loadError,
      saving: saving ?? this.saving,
    );
  }
}

/// 开播配置表单控制器：按 liveId 维度隔离（空串 = 新建，非空 = 编辑）。
/// 负责拉取下拉数据与初始配置、统一走 createLive / updateLive 提交。
/// 合规说明：status / aiBadgeShown 无提交入口，角标由服务端写死 true，客户端不可篡改。
class LiveFormController extends StateNotifier<LiveFormState> {
  LiveFormController(this._apiClient, this.liveId, {VoiceCacheStore? cacheStore})
    : _cache = cacheStore,
      super(const LiveFormState());

  final ApiClient _apiClient;

  /// 音色本地缓存（服务端为准，仅作失败回落）；测试可不注入
  final VoiceCacheStore? _cache;

  /// provider family 参数：空串表示新建，非空为编辑的 live id
  final String liveId;

  bool get isEditMode => liveId.isNotEmpty;

  /// 拉取表单数据：音色 / 话术；编辑模式额外拉取初始配置用于预填。
  Future<void> load() async {
    state = const LiveFormState(loading: true);
    try {
      final voices = await _apiClient.listVoices();
      final scripts = await _apiClient.listScripts();
      // 火山预设音色目录（含分组与默认音色）尽力而为：失败不阻塞表单，音色区只剩克隆组
      final catalog = await _loadPresetsBestEffort();
      Live? initial;
      if (isEditMode) {
        initial = await _apiClient.getLive(liveId);
      }
      if (!mounted) {
        return;
      }
      state = LiveFormState(
        initial: initial,
        voices: voices,
        presets: catalog.presets,
        presetGroups: catalog.groups,
        defaultPresetId: catalog.defaultPresetId,
        scripts: scripts,
        loading: false,
      );
    } on ApiException catch (error) {
      if (!mounted) {
        return;
      }
      state = LiveFormState(loading: false, loadError: error.message);
    }
  }

  /// 保存草稿：新建走 createLive，编辑走 updateLive；失败向上抛给页面弹提示。
  Future<Live> save({
    required String title,
    String? volcPresetId,
    int? speechRate,
    String? voiceId,
    String? scriptId,
    String? loopScriptId,
  }) async {
    state = state.copyWith(saving: true, clearError: true);
    try {
      if (isEditMode) {
        return await _apiClient.updateLive(
          id: liveId,
          title: title,
          volcPresetId: volcPresetId,
          speechRate: speechRate,
          voiceId: voiceId,
          scriptId: scriptId,
          loopScriptId: loopScriptId,
        );
      }
      return await _apiClient.createLive(
        title: title,
        volcPresetId: volcPresetId,
        speechRate: speechRate,
        voiceId: voiceId,
        scriptId: scriptId,
        loopScriptId: loopScriptId,
      );
    } on ApiException {
      if (mounted) {
        state = state.copyWith(saving: false);
      }
      rethrow;
    }
  }

  /// 火山预设音色目录尽力而为：服务端成功即覆盖本地缓存；
  /// 失败回落本地缓存快照 + 上次记住的默认音色，弱网下仍能预填默认音色；
  /// 连缓存都没有时返回空目录（音色选择区只显示克隆音色组）。
  Future<VolcPresetCatalog> _loadPresetsBestEffort() async {
    try {
      final catalog = await _apiClient.fetchVolcPresetCatalog();
      await _cache?.saveCatalog(catalog);
      await _cache?.saveDefaultPresetId(catalog.defaultPresetId);
      return catalog;
    } on ApiException {
      final cached = await _cache?.readCatalog();
      if (cached == null) {
        return const VolcPresetCatalog.empty();
      }
      final cachedDefault = await _cache?.readDefaultPresetId();
      return cached.copyWith(
        defaultPresetId: cachedDefault ?? cached.defaultPresetId,
      );
    }
  }
}
