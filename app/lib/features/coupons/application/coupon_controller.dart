import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'package:starvoice_app/core/models/coupon.dart';
import 'package:starvoice_app/core/network/api_client.dart';
import 'package:starvoice_app/core/network/api_exception.dart';

/// 团购券列表 UI 状态。
class CouponState {
  const CouponState({
    this.coupons = const <Coupon>[],
    this.loading = false,
    this.error,
    this.errorCode,
  });

  final List<Coupon> coupons;

  /// 列表加载中（首次进入券列表页）
  final bool loading;

  /// 加载失败的中文提示（加载成功后清空）
  final String? error;

  /// 加载失败的机器可读错误码（用于区分「未绑定抖音号」等特殊场景）
  final String? errorCode;

  /// 是否因未绑定抖音号而无法拉券。
  bool get notBound => errorCode == 'DOUYIN_NOT_BOUND';

  CouponState copyWith({
    List<Coupon>? coupons,
    bool? loading,
    String? error,
    String? errorCode,
    bool clearError = false,
  }) {
    return CouponState(
      coupons: coupons ?? this.coupons,
      loading: loading ?? this.loading,
      error: clearError ? null : error ?? this.error,
      errorCode: clearError ? null : errorCode ?? this.errorCode,
    );
  }
}

/// 团购券控制器：负责「团购券列表」的加载。
class CouponController extends StateNotifier<CouponState> {
  CouponController(this._apiClient) : super(const CouponState());

  final ApiClient _apiClient;

  /// 拉取当前抖音账号的团购券列表；失败时把中文提示与错误码写入 state。
  Future<void> load() async {
    state = state.copyWith(loading: true, clearError: true);
    try {
      final coupons = await _apiClient.fetchCoupons();
      if (!mounted) {
        return;
      }
      state = CouponState(coupons: coupons, loading: false);
    } on ApiException catch (error) {
      if (!mounted) {
        return;
      }
      state = state.copyWith(
        loading: false,
        error: error.message,
        errorCode: error.code,
      );
    }
  }
}
