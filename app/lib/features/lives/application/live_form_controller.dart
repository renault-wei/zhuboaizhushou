import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'package:starvoice_app/core/models/coupon.dart';
import 'package:starvoice_app/core/models/live.dart';
import 'package:starvoice_app/core/models/script.dart';
import 'package:starvoice_app/core/models/voice.dart';
import 'package:starvoice_app/core/network/api_client.dart';
import 'package:starvoice_app/core/network/api_exception.dart';

/// 开播配置表单页 UI 状态（新建与编辑共用）。
/// 除可选项下拉数据（音色/话术/团购券）外，编辑模式还缓存初始 Live 用于预填。
class LiveFormState {
  const LiveFormState({
    this.initial,
    this.voices = const <Voice>[],
    this.scripts = const <Script>[],
    this.coupons = const <Coupon>[],
    this.loading = false,
    this.loadError,
    this.saving = false,
  });

  /// 编辑模式下的初始配置（新建模式为 null）
  final Live? initial;

  /// 可选音色（仅 status=ready 的可选，其余禁用展示）
  final List<Voice> voices;

  /// 可选话术（仅 status=ready 的可选，blocked/draft 禁用展示）
  final List<Script> scripts;

  /// 团购券（选择后展示券名；未绑定抖音拉不到时券名降级为券 id）
  final List<Coupon> coupons;

  /// 引用数据 / 初始配置加载中
  final bool loading;

  /// 加载失败的中文提示（含编辑模式 404）
  final String? loadError;

  /// 保存中（防止重复提交）
  final bool saving;

  LiveFormState copyWith({
    Live? initial,
    List<Voice>? voices,
    List<Script>? scripts,
    List<Coupon>? coupons,
    bool? loading,
    String? loadError,
    bool clearError = false,
    bool? saving,
  }) {
    return LiveFormState(
      initial: initial ?? this.initial,
      voices: voices ?? this.voices,
      scripts: scripts ?? this.scripts,
      coupons: coupons ?? this.coupons,
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
  LiveFormController(this._apiClient, this.liveId) : super(const LiveFormState());

  final ApiClient _apiClient;

  /// provider family 参数：空串表示新建，非空为编辑的 live id
  final String liveId;

  bool get isEditMode => liveId.isNotEmpty;

  /// 拉取表单数据：音色 / 话术 / 团购券；编辑模式额外拉取初始配置用于预填。
  Future<void> load() async {
    state = const LiveFormState(loading: true);
    try {
      final voices = await _apiClient.listVoices();
      final scripts = await _apiClient.listScripts();
      // 团购券需先绑定抖音；未绑定等失败不阻塞表单，券名降级为券 id
      final coupons = await _loadCouponsBestEffort();
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
        scripts: scripts,
        coupons: coupons,
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
    String? voiceId,
    String? scriptId,
    String? loopScriptId,
    String? couponId,
  }) async {
    state = state.copyWith(saving: true, clearError: true);
    try {
      if (isEditMode) {
        return await _apiClient.updateLive(
          id: liveId,
          title: title,
          voiceId: voiceId,
          scriptId: scriptId,
          loopScriptId: loopScriptId,
          couponId: couponId,
        );
      }
      return await _apiClient.createLive(
        title: title,
        voiceId: voiceId,
        scriptId: scriptId,
        loopScriptId: loopScriptId,
        couponId: couponId,
      );
    } on ApiException {
      if (mounted) {
        state = state.copyWith(saving: false);
      }
      rethrow;
    }
  }

  /// 团购券列表尽力而为：失败返回空列表。
  Future<List<Coupon>> _loadCouponsBestEffort() async {
    try {
      return await _apiClient.fetchCoupons();
    } on ApiException {
      return <Coupon>[];
    }
  }
}
