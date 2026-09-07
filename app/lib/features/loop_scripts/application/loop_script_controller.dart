import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'package:starvoice_app/core/models/loop_script.dart';
import 'package:starvoice_app/core/network/api_client.dart';
import 'package:starvoice_app/core/network/api_exception.dart';

/// 循环台本库 UI 状态。
class LoopScriptState {
  const LoopScriptState({
    this.scripts = const <LoopScript>[],
    this.loading = false,
    this.deletingId,
    this.error,
  });

  /// 我的循环台本列表（服务端 updatedAt 倒序，含条数摘要）
  final List<LoopScript> scripts;

  /// 列表加载中（首次进入台本库页）
  final bool loading;

  /// 正在删除的台本 id（用于禁用对应行操作，防止重复提交）
  final String? deletingId;

  /// 列表加载失败的中文提示（加载成功后清空）
  final String? error;

  LoopScriptState copyWith({
    List<LoopScript>? scripts,
    bool? loading,
    String? deletingId,
    bool clearDeleting = false,
    String? error,
    bool clearError = false,
  }) {
    return LoopScriptState(
      scripts: scripts ?? this.scripts,
      loading: loading ?? this.loading,
      deletingId: clearDeleting ? null : deletingId ?? this.deletingId,
      error: clearError ? null : error ?? this.error,
    );
  }
}

/// 循环台本库控制器：负责「我的循环台本」列表加载与删除（删除前服务端自动解绑引用场次）。
class LoopScriptController extends StateNotifier<LoopScriptState> {
  LoopScriptController(this._apiClient) : super(const LoopScriptState());

  final ApiClient _apiClient;

  /// 拉取我的循环台本列表；失败时把中文提示写入 state。
  Future<void> load() async {
    state = state.copyWith(loading: true, clearError: true);
    try {
      final scripts = await _apiClient.listLoopScripts();
      if (!mounted) {
        return;
      }
      state = LoopScriptState(scripts: scripts, loading: false);
    } on ApiException catch (error) {
      if (!mounted) {
        return;
      }
      state = state.copyWith(loading: false, error: error.message);
    }
  }

  /// 删除循环台本：成功后从列表移除；失败抛出 [ApiException] 由页面提示。
  Future<void> delete(String id) async {
    state = state.copyWith(deletingId: id);
    try {
      await _apiClient.deleteLoopScript(id);
      if (!mounted) {
        return;
      }
      state = state.copyWith(
        scripts: state.scripts.where((item) => item.id != id).toList(),
        clearDeleting: true,
      );
    } on ApiException {
      if (mounted) {
        state = state.copyWith(clearDeleting: true);
      }
      rethrow;
    }
  }
}
