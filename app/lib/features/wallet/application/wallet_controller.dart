import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'package:starvoice_app/core/models/app_config.dart';
import 'package:starvoice_app/core/models/wallet.dart';
import 'package:starvoice_app/core/network/api_client.dart';
import 'package:starvoice_app/core/network/api_exception.dart';

/// 收银台（商家端钱包）UI 状态。
class WalletState {
  const WalletState({
    this.loading = false,
    this.error,
    this.overview,
    this.config,
    this.actionBusy = false,
    this.actionError,
  });

  /// 首次加载中（已有内容时后台刷新不置位，避免整页闪烁）。
  final bool loading;

  /// 加载失败的中文提示（加载成功后清空）。
  final String? error;

  /// 钱包总览：余额 / 当月免费剩余 / 流水 / 最近充值单。
  final WalletOverview? overview;

  /// 服务端开关下发：充值入口显隐 / 档位 / 公告。
  final PublicAppConfig? config;

  /// 扫码下单 / 轮询 / 卡密核销动作进行中（充值区按钮禁用）。
  final bool actionBusy;

  /// 充值动作失败的中文提示（成功后清空）。
  final String? actionError;

  /// 充值入口是否展示：配置未下发前不展示充值区。
  bool get showCharge => config?.showCharge ?? false;
}

/// 收银台控制器：加载钱包总览与服务端开关，提供扫码 / 轮询 / 卡密核销动作。
/// 动作成功后刷新总览（新余额 / 流水 / 订单即时可见）。
class WalletController extends StateNotifier<WalletState> {
  WalletController(this._apiClient) : super(const WalletState());

  final ApiClient _apiClient;

  /// 拉取钱包总览 + 服务端开关；任一失败进入错误态供页面重试。
  Future<void> load() async {
    // 保留已有内容再刷新：首次进入展示转圈，刷新/动作后不整页闪烁。
    state = WalletState(
      overview: state.overview,
      config: state.config,
      loading: true,
    );
    try {
      final overview = await _apiClient.fetchWalletOverview();
      final config = await _apiClient.fetchAppConfig();
      if (!mounted) {
        return;
      }
      state = WalletState(overview: overview, config: config);
    } on ApiException catch (error) {
      if (!mounted) {
        return;
      }
      state = WalletState(
        overview: state.overview,
        config: state.config,
        error: error.message,
      );
    }
  }

  /// 生成扫码单；成功返回结果（供页面弹收款码），失败写 actionError 返回 null。
  Future<RechargeScanResult?> startScan(int hours) async {
    state = WalletState(
      overview: state.overview,
      config: state.config,
      actionBusy: true,
    );
    try {
      final result = await _apiClient.createRechargeOrderScan(hours: hours);
      if (!mounted) {
        return null;
      }
      state = WalletState(overview: state.overview, config: state.config);
      return result;
    } on ApiException catch (error) {
      if (!mounted) {
        return null;
      }
      state = WalletState(
        overview: state.overview,
        config: state.config,
        actionError: error.message,
      );
      return null;
    }
  }

  /// 轮询扫码单确认状态；成功返回结果（供页面判断 paid 后刷新）。
  Future<RechargePollResult?> pollRecharge(String orderId) async {
    state = WalletState(
      overview: state.overview,
      config: state.config,
      actionBusy: true,
    );
    try {
      final result = await _apiClient.pollRecharge(orderId: orderId);
      if (!mounted) {
        return null;
      }
      state = WalletState(overview: state.overview, config: state.config);
      return result;
    } on ApiException catch (error) {
      if (!mounted) {
        return null;
      }
      state = WalletState(
        overview: state.overview,
        config: state.config,
        actionError: error.message,
      );
      return null;
    }
  }

  /// 卡密核销入账；成功后刷新总览并返回结果。
  Future<RedeemCardResult?> redeemCard(String code) async {
    state = WalletState(
      overview: state.overview,
      config: state.config,
      actionBusy: true,
    );
    try {
      final result = await _apiClient.redeemCard(code: code);
      if (!mounted) {
        return null;
      }
      await load();
      return result;
    } on ApiException catch (error) {
      if (!mounted) {
        return null;
      }
      state = WalletState(
        overview: state.overview,
        config: state.config,
        actionError: error.message,
      );
      return null;
    }
  }
}
