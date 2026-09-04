import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'package:starvoice_app/core/models/script.dart';
import 'package:starvoice_app/core/network/api_client.dart';
import 'package:starvoice_app/core/network/api_exception.dart';

/// 话术库 UI 状态。
class ScriptState {
  const ScriptState({
    this.scripts = const <Script>[],
    this.loading = false,
    this.generating = false,
    this.error,
  });

  final List<Script> scripts;

  /// 列表加载中（首次进入话术页）
  final bool loading;

  /// DeepSeek 话术生成中（真实调用需数秒）
  final bool generating;

  /// 列表加载失败的中文提示（加载成功后清空）
  final String? error;

  ScriptState copyWith({
    List<Script>? scripts,
    bool? loading,
    bool? generating,
    String? error,
    bool clearError = false,
  }) {
    return ScriptState(
      scripts: scripts ?? this.scripts,
      loading: loading ?? this.loading,
      generating: generating ?? this.generating,
      error: clearError ? null : error ?? this.error,
    );
  }
}

/// 话术控制器：负责「我的话术」列表加载与 DeepSeek 话术生成。
class ScriptController extends StateNotifier<ScriptState> {
  ScriptController(this._apiClient) : super(const ScriptState());

  final ApiClient _apiClient;

  /// 拉取我的话术列表；失败时把中文提示写入 state。
  Future<void> load() async {
    state = state.copyWith(loading: true, clearError: true);
    try {
      final scripts = await _apiClient.listScripts();
      if (!mounted) {
        return;
      }
      state = ScriptState(scripts: scripts, loading: false);
    } on ApiException catch (error) {
      if (!mounted) {
        return;
      }
      state = state.copyWith(loading: false, error: error.message);
    }
  }

  /// 生成话术：成功后把新话术插入列表头部并返回；失败向调用方抛出 [ApiException]。
  Future<Script> generate({
    required String industry,
    String? title,
    required Map<String, String> product,
  }) async {
    state = state.copyWith(generating: true);
    try {
      final script = await _apiClient.generateScript(
        industry: industry,
        title: title,
        product: product,
      );
      if (!mounted) {
        return script;
      }
      state = state.copyWith(
        generating: false,
        scripts: <Script>[script, ...state.scripts],
      );
      return script;
    } on ApiException {
      if (mounted) {
        state = state.copyWith(generating: false);
      }
      rethrow;
    }
  }
}