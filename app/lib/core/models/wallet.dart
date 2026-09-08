// 商家端收银台（钱包）数据模型：字段与服务端 /api/wallet 与
// /api/recharge/*、/api/cards/redeem 返回保持一致（snake 库列名已收敛为 camel）。

/// 当月免费直播剩余：月度 quota 账本（分钟）。
class MonthlyLiveQuota {
  const MonthlyLiveQuota({
    required this.quotaMinutes,
    required this.usedMinutes,
    required this.remainingMinutes,
  });

  factory MonthlyLiveQuota.fromJson(Map<String, dynamic> json) {
    return MonthlyLiveQuota(
      quotaMinutes: (json['quotaMinutes'] as num?)?.toInt() ?? 0,
      usedMinutes: (json['usedMinutes'] as num?)?.toInt() ?? 0,
      remainingMinutes: (json['remainingMinutes'] as num?)?.toInt() ?? 0,
    );
  }

  final int quotaMinutes;
  final int usedMinutes;
  final int remainingMinutes;

  /// 当月免费分钟是否已用完。
  bool get exhausted => remainingMinutes <= 0;
}

/// 时长余额流水（hour_balance_ledger）行。
class AmountLedgerTxn {
  const AmountLedgerTxn({
    required this.id,
    required this.deltaMinutes,
    required this.balanceAfterMinutes,
    required this.sourceKind,
    this.sourceId,
    this.remark,
    required this.createdAt,
  });

  factory AmountLedgerTxn.fromJson(Map<String, dynamic> json) {
    return AmountLedgerTxn(
      id: json['id']?.toString() ?? '',
      deltaMinutes: (json['deltaMinutes'] as num?)?.toInt() ?? 0,
      balanceAfterMinutes: (json['balanceAfterMinutes'] as num?)?.toInt() ?? 0,
      sourceKind: json['sourceKind']?.toString() ?? '',
      sourceId: json['sourceId']?.toString(),
      remark: json['remark']?.toString(),
      createdAt: json['createdAt']?.toString() ?? '',
    );
  }

  final String id;

  /// 变动分钟：正数为入账，负数为扣减。
  final int deltaMinutes;

  /// 变动后的余额（分钟）。
  final int balanceAfterMinutes;

  /// 入账来源，如 recharge_order / card_redeem / live_deduct / admin_adjust。
  final String sourceKind;
  final String? sourceId;
  final String? remark;
  final String createdAt;

  bool get isCredit => deltaMinutes > 0;

  /// 流水中文标签（未知来源原样透出，便于尽早暴露前后端不同步）。
  String get sourceLabel {
    switch (sourceKind) {
      case 'recharge_order':
        return '扫码充值';
      case 'card_redeem':
        return '卡密核销';
      case 'live_deduct':
        return '直播扣减';
      case 'admin_adjust':
        return '运营调整';
      default:
        return sourceKind;
    }
  }
}

/// 充值订单摘要（orders.kind = recharge）。
class RechargeOrder {
  const RechargeOrder({
    required this.id,
    required this.orderNo,
    required this.channel,
    this.hours,
    this.minutes,
    required this.amountCents,
    required this.status,
    this.paidAt,
    required this.createdAt,
  });

  factory RechargeOrder.fromJson(Map<String, dynamic> json) {
    return RechargeOrder(
      id: json['id']?.toString() ?? '',
      orderNo: json['orderNo']?.toString() ?? '',
      channel: json['channel']?.toString() ?? '',
      hours: (json['hours'] as num?)?.toInt(),
      minutes: (json['minutes'] as num?)?.toInt(),
      amountCents: (json['amountCents'] as num?)?.toInt() ?? 0,
      status: json['status']?.toString() ?? '',
      paidAt: json['paidAt']?.toString(),
      createdAt: json['createdAt']?.toString() ?? '',
    );
  }

  final String id;
  final String orderNo;

  /// 充值渠道：alipay_scan（扫码）/ card（卡密核销）。
  final String channel;
  final int? hours;
  final int? minutes;
  final int amountCents;

  /// pending / paid（扫码 mock 通道人工确权前为 pending）。
  final String status;
  final String? paidAt;
  final String createdAt;

  bool get paid => status == 'paid';

  /// 订单状态中文标签（未知状态原样透出）。
  String get statusLabel {
    switch (status) {
      case 'paid':
        return '已到账';
      case 'pending':
        return '待确认';
      default:
        return status;
    }
  }
}

/// 钱包总览：一次取齐收银台首页所需（余额 + 当月免费剩余 + 流水 + 最近充值单）。
class WalletOverview {
  const WalletOverview({
    required this.balanceMinutes,
    required this.monthlyLive,
    required this.transactions,
    required this.rechargeOrders,
  });

  factory WalletOverview.fromJson(Map<String, dynamic> json) {
    final monthlyJson = json['monthlyLive'];
    final txRaw = json['transactions'];
    final ordersRaw = json['rechargeOrders'];
    return WalletOverview(
      balanceMinutes: (json['balanceMinutes'] as num?)?.toInt() ?? 0,
      monthlyLive: MonthlyLiveQuota.fromJson(
        monthlyJson is Map
            ? Map<String, dynamic>.from(monthlyJson)
            : <String, dynamic>{},
      ),
      transactions: _parseList(txRaw, AmountLedgerTxn.fromJson),
      rechargeOrders: _parseList(ordersRaw, RechargeOrder.fromJson),
    );
  }

  static List<T> _parseList<T>(
    Object? raw,
    T Function(Map<String, dynamic>) fromJson,
  ) {
    if (raw is! List) {
      return <T>[];
    }
    return raw
        .whereType<Map>()
        .map((item) => fromJson(Map<String, dynamic>.from(item)))
        .toList();
  }

  /// 预充时长余额（分钟，跨月不清零）。
  final int balanceMinutes;
  final MonthlyLiveQuota monthlyLive;
  final List<AmountLedgerTxn> transactions;
  final List<RechargeOrder> rechargeOrders;
}

/// POST /api/recharge/scan 返回：扫码单（mock 通道返回占位收款码）。
class RechargeScanResult {
  const RechargeScanResult({
    required this.order,
    required this.qrcodeUrl,
    required this.mockChannel,
    required this.message,
  });

  factory RechargeScanResult.fromJson(Map<String, dynamic> json) {
    final orderJson = json['order'];
    return RechargeScanResult(
      order: RechargeOrder.fromJson(
        orderJson is Map
            ? Map<String, dynamic>.from(orderJson)
            : <String, dynamic>{},
      ),
      qrcodeUrl: json['qrcodeUrl']?.toString() ?? '',
      mockChannel: json['mockChannel'] == true,
      message: json['message']?.toString() ?? '',
    );
  }

  final RechargeOrder order;

  /// mock 通道为 mock:// 占位；M8 凭证接入后为真实支付宝收款码地址。
  final String qrcodeUrl;
  final bool mockChannel;
  final String message;
}

/// POST /api/recharge/poll 返回：扫码单轮询确认结果。
class RechargePollResult {
  const RechargePollResult({
    required this.orderId,
    required this.orderNo,
    required this.status,
    this.paidAt,
    required this.amountCents,
    this.hours,
    this.balanceMinutes,
  });

  factory RechargePollResult.fromJson(Map<String, dynamic> json) {
    return RechargePollResult(
      orderId: json['orderId']?.toString() ?? '',
      orderNo: json['orderNo']?.toString() ?? '',
      status: json['status']?.toString() ?? '',
      paidAt: json['paidAt']?.toString(),
      amountCents: (json['amountCents'] as num?)?.toInt() ?? 0,
      hours: (json['hours'] as num?)?.toInt(),
      balanceMinutes: (json['balanceMinutes'] as num?)?.toInt(),
    );
  }

  final String orderId;
  final String orderNo;
  final String status;
  final String? paidAt;
  final int amountCents;
  final int? hours;

  /// paid 后服务端附带的最新时长余额。
  final int? balanceMinutes;

  bool get paid => status == 'paid';
}

/// POST /api/cards/redeem 返回：卡密核销入账结果。
class RedeemCardResult {
  const RedeemCardResult({
    required this.status,
    this.batchId,
    required this.orderId,
    required this.orderNo,
    required this.creditedMinutes,
    required this.balanceMinutes,
  });

  factory RedeemCardResult.fromJson(Map<String, dynamic> json) {
    return RedeemCardResult(
      status: json['status']?.toString() ?? '',
      batchId: json['batchId']?.toString(),
      orderId: json['orderId']?.toString() ?? '',
      orderNo: json['orderNo']?.toString() ?? '',
      creditedMinutes: (json['creditedMinutes'] as num?)?.toInt() ?? 0,
      balanceMinutes: (json['balanceMinutes'] as num?)?.toInt() ?? 0,
    );
  }

  final String status;
  final String? batchId;
  final String orderId;
  final String orderNo;
  final int creditedMinutes;
  final int balanceMinutes;
}
