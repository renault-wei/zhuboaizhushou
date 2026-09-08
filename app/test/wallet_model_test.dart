import 'package:flutter_test/flutter_test.dart';

import 'package:starvoice_app/core/models/app_config.dart';
import 'package:starvoice_app/core/models/wallet.dart';

void main() {
  group('WalletOverview', () {
    test('fromJson 解析余额/免费剩余/流水/充值单', () {
      final overview = WalletOverview.fromJson(<String, dynamic>{
        'balanceMinutes': 120,
        'monthlyLive': {
          'quotaMinutes': 600,
          'usedMinutes': 240,
          'remainingMinutes': 360,
        },
        'transactions': <Map<String, dynamic>>[
          {
            'id': 'tx-1',
            'deltaMinutes': -5,
            'balanceAfterMinutes': 115,
            'sourceKind': 'live_deduct',
            'sourceId': null,
            'remark': '直播在线扣减',
            'createdAt': '2026-09-08T10:00:00.000Z',
          },
        ],
        'rechargeOrders': <Map<String, dynamic>>[
          {
            'id': 'order-1',
            'orderNo': 'rn-abc123',
            'channel': 'alipay_scan',
            'hours': 1,
            'minutes': 60,
            'amountCents': 990,
            'status': 'pending',
            'paidAt': null,
            'createdAt': '2026-09-08T09:00:00.000Z',
          },
        ],
      });

      expect(overview.balanceMinutes, 120);
      expect(overview.monthlyLive.quotaMinutes, 600);
      expect(overview.monthlyLive.remainingMinutes, 360);
      expect(overview.monthlyLive.exhausted, isFalse);
      expect(overview.transactions, hasLength(1));
      expect(overview.transactions.first.sourceLabel, '直播扣减');
      expect(overview.transactions.first.isCredit, isFalse);
      expect(overview.rechargeOrders, hasLength(1));
      expect(overview.rechargeOrders.first.statusLabel, '待确认');
      expect(overview.rechargeOrders.first.paid, isFalse);
    });

    test('缺失字段容错为空值', () {
      final overview = WalletOverview.fromJson(<String, dynamic>{});

      expect(overview.balanceMinutes, 0);
      expect(overview.monthlyLive.quotaMinutes, 0);
      expect(overview.transactions, isEmpty);
      expect(overview.rechargeOrders, isEmpty);
    });
  });

  group('流水与订单标签', () {
    test('入账来源标签映射', () {
      String labelOf(String kind) =>
          AmountLedgerTxn.fromJson(<String, dynamic>{'sourceKind': kind})
              .sourceLabel;
      expect(labelOf('recharge_order'), '扫码充值');
      expect(labelOf('card_redeem'), '卡密核销');
      expect(labelOf('admin_adjust'), '运营调整');
      expect(labelOf('unknown_kind'), 'unknown_kind');
    });

    test('订单已到账状态', () {
      final order = RechargeOrder.fromJson(<String, dynamic>{
        'status': 'paid',
        'paidAt': '2026-09-08T10:00:00.000Z',
      });
      expect(order.paid, isTrue);
      expect(order.statusLabel, '已到账');
    });
  });

  group('充值动作结果', () {
    test('扫码下单结果解析（mock 通道）', () {
      final result = RechargeScanResult.fromJson(<String, dynamic>{
        'order': <String, dynamic>{
          'id': 'order-1',
          'orderNo': 'rn-mock-1',
          'kind': 'recharge',
          'channel': 'alipay_scan',
          'hours': 10,
          'minutes': 600,
          'amountCents': 8990,
          'status': 'pending',
          'createdAt': '2026-09-08T09:00:00.000Z',
        },
        'qrcodeUrl': 'mock://alipay-scan/rn-mock-1',
        'mockChannel': true,
        'message': '扫码单已创建',
      });

      expect(result.order.orderNo, 'rn-mock-1');
      expect(result.order.hours, 10);
      expect(result.qrcodeUrl, 'mock://alipay-scan/rn-mock-1');
      expect(result.mockChannel, isTrue);
      expect(result.order.paid, isFalse);
    });

    test('轮询与卡密核销结果解析', () {
      final poll = RechargePollResult.fromJson(<String, dynamic>{
        'orderId': 'order-1',
        'orderNo': 'rn-mock-1',
        'status': 'paid',
        'paidAt': '2026-09-08T10:00:00.000Z',
        'amountCents': 8990,
        'hours': 10,
        'balanceMinutes': 720,
      });
      expect(poll.paid, isTrue);
      expect(poll.balanceMinutes, 720);

      final redeem = RedeemCardResult.fromJson(<String, dynamic>{
        'status': 'redeemed',
        'batchId': 'batch-1',
        'orderId': 'order-2',
        'orderNo': 'cd-mock-1',
        'creditedMinutes': 600,
        'balanceMinutes': 1320,
      });
      expect(redeem.creditedMinutes, 600);
      expect(redeem.balanceMinutes, 1320);
    });
  });

  group('PublicAppConfig', () {
    test('解析档位/显隐/公告', () {
      final config = PublicAppConfig.fromJson(<String, dynamic>{
        'showCharge': true,
        'pricePacks': <Map<String, dynamic>>[
          {'hours': 1, 'amountCents': 990},
          {'hours': 10, 'amountCents': 8990},
        ],
        'notice': '系统维护公告',
        'quotaPriority': ['balance', 'quota'],
      });

      expect(config.showCharge, isTrue);
      expect(config.pricePacks, hasLength(2));
      expect(config.pricePacks.first.hours, 1);
      expect(config.pricePacks.first.yuan, 9.9);
      expect(config.hasNotice, isTrue);
    });

    test('缺省与非法字段容错', () {
      final config = PublicAppConfig.fromJson(<String, dynamic>{});
      expect(config.showCharge, isFalse);
      expect(config.pricePacks, isEmpty);
      expect(config.hasNotice, isFalse);
    });
  });
}
