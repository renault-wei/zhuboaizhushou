import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'package:starvoice_app/core/models/live.dart';
import 'package:starvoice_app/core/models/script.dart';
import 'package:starvoice_app/core/models/voice.dart';
import 'package:starvoice_app/core/models/volc_preset.dart';
import 'package:starvoice_app/core/network/api_client.dart';
import 'package:starvoice_app/core/network/api_exception.dart';

/// 开播配置列表页 UI 状态。
/// Live 只携带外键 id，卡片摘要要展示音色名/话术标题，
/// 因此额外维护 id → 名称映射（引用资源删除后映射缺失，页面降级展示 id）。
class LiveListState {
  const LiveListState({
    this.lives = const <Live>[],
    this.voiceNames = const <String, String>{},
    this.presetNames = const <String, String>{},
    this.scriptTitles = const <String, String>{},
    this.loading = false,
    this.error,
  });

  /// 我的开播配置（服务端按 updatedAt desc 返回）
  final List<Live> lives;

  /// 音色 id → 名称
  final Map<String, String> voiceNames;

  /// 火山预设音色 id → 名称
  final Map<String, String> presetNames;

  /// 话术 id → 展示标题（未命名话术退化为「未命名话术」）
  final Map<String, String> scriptTitles;

  /// 列表加载中（首次进入 / 下拉刷新）
  final bool loading;

  /// 最近一次加载失败的中文提示，成功后清空
  final String? error;

  bool get hasLives => lives.isNotEmpty;

  LiveListState copyWith({
    List<Live>? lives,
    Map<String, String>? voiceNames,
    Map<String, String>? presetNames,
    Map<String, String>? scriptTitles,
    bool? loading,
    String? error,
    bool clearError = false,
  }) {
    return LiveListState(
      lives: lives ?? this.lives,
      voiceNames: voiceNames ?? this.voiceNames,
      presetNames: presetNames ?? this.presetNames,
      scriptTitles: scriptTitles ?? this.scriptTitles,
      loading: loading ?? this.loading,
      error: clearError ? null : error ?? this.error,
    );
  }
}

/// 开播配置列表控制器：拉取列表 + 引用资源名称映射、删除草稿。
class LiveListController extends StateNotifier<LiveListState> {
  LiveListController(this._apiClient) : super(const LiveListState());

  final ApiClient _apiClient;

  /// 拉取我的开播配置与引用资源；主列表失败才报错，引用资源失败仅降级名称展示。
  Future<void> load() async {
    state = state.copyWith(loading: true, clearError: true);
    try {
      final lives = await _apiClient.listLives();
      final voices = await _loadVoicesBestEffort();
      final presets = await _loadPresetsBestEffort();
      final scripts = await _loadScriptsBestEffort();
      if (!mounted) {
        return;
      }
      state = LiveListState(
        lives: lives,
        voiceNames: <String, String>{
          for (final voice in voices) voice.id: voice.name,
        },
        presetNames: <String, String>{
          for (final preset in presets) preset.id: preset.name,
        },
        scriptTitles: <String, String>{
          for (final script in scripts) script.id: script.displayTitle,
        },
        loading: false,
      );
    } on ApiException catch (error) {
      if (!mounted) {
        return;
      }
      state = state.copyWith(loading: false, error: error.message);
    }
  }

  /// 删除开播配置：成功就地移除；失败（如 409 直播中不可删）抛给页面弹提示。
  Future<void> delete(String id) async {
    try {
      await _apiClient.deleteLive(id);
      if (!mounted) {
        return;
      }
      state = state.copyWith(
        lives: state.lives.where((live) => live.id != id).toList(),
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

  /// 音色列表尽力而为：失败不影响主列表展示。
  Future<List<Voice>> _loadVoicesBestEffort() async {
    try {
      return await _apiClient.listVoices();
    } on ApiException {
      return <Voice>[];
    }
  }

  /// 火山预设音色列表尽力而为：失败不影响主列表展示。
  Future<List<VolcPresetVoice>> _loadPresetsBestEffort() async {
    try {
      return await _apiClient.listVolcPresetVoices();
    } on ApiException {
      return <VolcPresetVoice>[];
    }
  }

  /// 话术列表尽力而为：失败不影响主列表展示。
  Future<List<Script>> _loadScriptsBestEffort() async {
    try {
      return await _apiClient.listScripts();
    } on ApiException {
      return <Script>[];
    }
  }

}
