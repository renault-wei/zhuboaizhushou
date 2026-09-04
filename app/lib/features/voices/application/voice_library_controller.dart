import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'package:starvoice_app/core/models/voice.dart';
import 'package:starvoice_app/core/network/api_client.dart';
import 'package:starvoice_app/core/network/api_exception.dart';

/// 音色库 UI 状态。
class VoiceLibraryState {
  const VoiceLibraryState({
    this.voices = const <Voice>[],
    this.loading = false,
    this.error,
  });

  final List<Voice> voices;
  final bool loading;

  /// 最近一次操作失败的中文提示（拉取/删除失败等），成功操作后清空。
  final String? error;

  /// 是否存在仍在克隆中（pending/processing）的音色。
  bool get hasActiveVoices => voices.any((voice) => voice.isCloning);

  VoiceLibraryState copyWith({
    List<Voice>? voices,
    bool? loading,
    String? error,
    bool clearError = false,
  }) {
    return VoiceLibraryState(
      voices: voices ?? this.voices,
      loading: loading ?? this.loading,
      error: clearError ? null : error ?? this.error,
    );
  }
}

/// 音色库控制器：拉取列表、克隆状态轮询（pending → ready）、删除音色。
class VoiceLibraryController extends StateNotifier<VoiceLibraryState> {
  VoiceLibraryController(this._apiClient) : super(const VoiceLibraryState());

  final ApiClient _apiClient;

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
      state = VoiceLibraryState(voices: voices, loading: false);
      startPolling();
    } on ApiException catch (error) {
      if (!mounted) {
        return;
      }
      state = state.copyWith(loading: false, error: error.message);
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
