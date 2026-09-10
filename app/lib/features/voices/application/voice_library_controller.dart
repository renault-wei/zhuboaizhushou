import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'package:starvoice_app/core/models/voice.dart';
import 'package:starvoice_app/core/models/volc_preset.dart';
import 'package:starvoice_app/core/network/api_client.dart';
import 'package:starvoice_app/core/network/api_exception.dart';
import 'package:starvoice_app/core/storage/voice_cache_store.dart';

/// 音色库 UI 状态。
class VoiceLibraryState {
  const VoiceLibraryState({
    this.voices = const <Voice>[],
    this.catalog = const VolcPresetCatalog.empty(),
    this.loading = false,
    this.catalogLoading = false,
    this.catalogFromCache = false,
    this.savingDefault = false,
    this.error,
    this.catalogError,
  });

  final List<Voice> voices;

  /// 火山预设目录（音色库「预设音色」区与默认音色标记的数据源）
  final VolcPresetCatalog catalog;
  final bool loading;

  /// 预设目录是否正在从服务端拉取
  final bool catalogLoading;

  /// 预设目录是否来自本地缓存（服务端拉取失败时的回落，UI 需如实提示）
  final bool catalogFromCache;

  /// 是否正在提交默认音色
  final bool savingDefault;

  /// 最近一次操作失败的中文提示（拉取/删除失败等），成功操作后清空。
  final String? error;

  /// 预设目录拉取失败的中文提示（有缓存回落时仍展示，提示数据可能不是最新）
  final String? catalogError;

  /// 是否存在仍在克隆中（pending/processing）的音色。
  bool get hasActiveVoices => voices.any((voice) => voice.isCloning);

  VoiceLibraryState copyWith({
    List<Voice>? voices,
    VolcPresetCatalog? catalog,
    bool? loading,
    bool? catalogLoading,
    bool? catalogFromCache,
    bool? savingDefault,
    String? error,
    String? catalogError,
    bool clearError = false,
    bool clearCatalogError = false,
  }) {
    return VoiceLibraryState(
      voices: voices ?? this.voices,
      catalog: catalog ?? this.catalog,
      loading: loading ?? this.loading,
      catalogLoading: catalogLoading ?? this.catalogLoading,
      catalogFromCache: catalogFromCache ?? this.catalogFromCache,
      savingDefault: savingDefault ?? this.savingDefault,
      error: clearError ? null : error ?? this.error,
      catalogError: clearCatalogError ? null : catalogError ?? this.catalogError,
    );
  }
}

/// 音色库控制器：拉取克隆音色列表与预设目录、克隆状态轮询（pending → ready）、
/// 删除克隆音色、设置商家默认音色。
class VoiceLibraryController extends StateNotifier<VoiceLibraryState> {
  VoiceLibraryController(this._apiClient, {VoiceCacheStore? cacheStore})
    : _cache = cacheStore,
      super(const VoiceLibraryState());

  final ApiClient _apiClient;

  /// 本地缓存（服务端为准，仅作失败回落）；测试可不注入
  final VoiceCacheStore? _cache;

  /// 轮询间隔：与服务端 mock 状态推进节奏（3 秒一档）保持一致。
  static const Duration pollInterval = Duration(seconds: 3);

  /// 单次进入页面最多轮询次数，超过即停止，避免无限请求。
  static const int maxPollRounds = 30;

  Timer? _pollTimer;
  int _pollRounds = 0;

  /// 拉取我的音色列表；成功后若仍有克隆中音色则自动启动轮询。
  Future<void> load() async {
    stopPolling();
    state = state.copyWith(loading: true, clearError: true);
    try {
      final voices = await _apiClient.listVoices();
      if (!mounted) {
        return;
      }
      // 只更新音色列表，保留已拉取的预设目录（load 与 loadCatalog 并发，
      // 重建 state 会把目录清空，导致下拉刷新后「预设音色」变空）。
      state = state.copyWith(voices: voices, loading: false, clearError: true);
      startPolling();
    } on ApiException catch (error) {
      if (!mounted) {
        return;
      }
      state = state.copyWith(loading: false, error: error.message);
    }
  }

  /// 拉取火山预设目录（含生效默认音色与商家自己设过的默认音色）。
  /// 服务端成功即覆盖本地缓存；失败则回落本地缓存并保留错误提示（UI 如实标注）。
  Future<void> loadCatalog() async {
    state = state.copyWith(catalogLoading: true, clearCatalogError: true);
    try {
      final catalog = await _apiClient.fetchVolcPresetCatalog();
      if (!mounted) {
        return;
      }
      state = state.copyWith(
        catalog: catalog,
        catalogLoading: false,
        catalogFromCache: false,
        clearCatalogError: true,
      );
      await _cache?.saveCatalog(catalog);
      await _cache?.saveDefaultPresetId(catalog.defaultPresetId);
    } on ApiException catch (error) {
      final cached = await _cache?.readCatalog();
      final cachedDefault = await _cache?.readDefaultPresetId();
      if (!mounted) {
        return;
      }
      if (cached != null) {
        state = state.copyWith(
          catalog: cached.copyWith(
            defaultPresetId: cachedDefault ?? cached.defaultPresetId,
          ),
          catalogLoading: false,
          catalogFromCache: true,
          catalogError: error.message,
        );
        return;
      }
      state = state.copyWith(
        catalogLoading: false,
        catalogError: error.message,
      );
    }
  }

  /// 设置商家默认音色（服务端为准）：先本地乐观更新，失败回滚并抛给页面提示。
  /// 只影响新建开播配置的预填，不改动已有场次的音色。
  Future<void> setDefaultPreset(String presetId) async {
    if (state.savingDefault || presetId.isEmpty) {
      return;
    }
    final previous = state.catalog;
    state = state.copyWith(
      catalog: previous.copyWith(
        defaultPresetId: presetId,
        userDefaultPresetId: presetId,
      ),
      savingDefault: true,
      clearError: true,
    );
    try {
      // 服务端返回生效值（正常等于刚提交的 id），以服务端口径为准回填
      final effective = await _apiClient.setDefaultVoice(presetId: presetId);
      if (!mounted) {
        return;
      }
      state = state.copyWith(
        catalog: state.catalog.copyWith(
          defaultPresetId: effective.isEmpty ? presetId : effective,
        ),
        savingDefault: false,
        clearError: true,
      );
      await _cache?.saveCatalog(state.catalog);
      await _cache?.saveDefaultPresetId(state.catalog.defaultPresetId);
    } on ApiException catch (error) {
      if (!mounted) {
        return;
      }
      state = state.copyWith(
        catalog: previous,
        savingDefault: false,
        error: error.message,
      );
      rethrow;
    }
  }

  /// 启动定时轮询：仅当列表中存在克隆中音色时生效。
  void startPolling() {
    stopPolling();
    if (!state.hasActiveVoices) {
      return;
    }
    _pollRounds = 0;
    _pollTimer = Timer.periodic(pollInterval, (_) => pollStatus());
  }

  /// 停止轮询（页面销毁或全部音色到达终态时调用）。
  void stopPolling() {
    _pollTimer?.cancel();
    _pollTimer = null;
  }

  /// 单轮轮询：把每个克隆中音色拉到最新状态。
  /// 全部到达终态（ready/failed）或超过最大轮询次数后自动停止。
  Future<void> pollStatus() async {
    final activeIds = state.voices
        .where((voice) => voice.isCloning)
        .map((voice) => voice.id)
        .toList(growable: false);
    if (activeIds.isEmpty) {
      stopPolling();
      return;
    }
    _pollRounds += 1;
    for (final id in activeIds) {
      try {
        final updated = await _apiClient.getVoice(id);
        if (!mounted) {
          return;
        }
        _upsert(updated);
      } on ApiException {
        // 单条刷新失败不中断整轮轮询，避免网络抖动打断状态流转
      }
    }
    if (mounted && (!state.hasActiveVoices || _pollRounds >= maxPollRounds)) {
      stopPolling();
    }
  }

  /// 删除音色：成功后从列表移除；失败把中文提示写入 state 并向上抛出。
  Future<void> deleteVoice(String id) async {
    try {
      await _apiClient.deleteVoice(id);
      if (!mounted) {
        return;
      }
      state = state.copyWith(
        voices: state.voices.where((voice) => voice.id != id).toList(),
        clearError: true,
      );
    } on ApiException catch (error) {
      if (!mounted) {
        return;
      }
      state = state.copyWith(error: error.message);
      rethrow;
    }
  }

  /// 用最新单查结果替换列表里的同名音色。
  void _upsert(Voice updated) {
    final voices = state.voices.map((voice) {
      return voice.id == updated.id ? updated : voice;
    }).toList();
    state = state.copyWith(voices: voices);
  }

  @override
  void dispose() {
    stopPolling();
    super.dispose();
  }
}
