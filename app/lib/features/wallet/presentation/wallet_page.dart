import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'package:starvoice_app/core/models/app_config.dart';
import 'package:starvoice_app/core/models/wallet.dart';
import 'package:starvoice_app/core/theme/app_colors.dart';
import 'package:starvoice_app/core/theme/theme_tokens.dart';
import 'package:starvoice_app/features/wallet/application/wallet_controller.dart';
import 'package:starvoice_app/providers.dart';

String _twoDigits(int value) => value.toString().padLeft(2, '0');

/// ISO 时间 → 本地「MM-dd HH:mm」；解析失败原样透出。
String _formatTime(String iso) {
  final time = DateTime.tryParse(iso)?.toLocal();
  if (time == null) {
    return iso;
  }
  return '${_twoDigits(time.month)}-${_twoDigits(time.day)} '
      '${_twoDigits(time.hour)}:${_twoDigits(time.minute)}';
}

/// 分钟金额 → 元展示，去多余尾零：990 → ¥9.9、1000 → ¥10。
String _yuanText(int cents) {
  final yuan = cents / 100;
  if (yuan == yuan.roundToDouble()) {
    return '¥${yuan.toStringAsFixed(0)}';
  }
  final fixed = yuan.toStringAsFixed(2);
  return '¥${fixed.replaceFirst(RegExp(r'0+$'), '').replaceFirst(RegExp(r'\.$'), '')}';
}

/// 分钟 → 中文时长：120 → 2 小时、90 → 1 小时 30 分。
String _minutesText(int minutes) {
  final hours = minutes ~/ 60;
  final rest = minutes % 60;
  if (hours == 0) {
    return '$rest 分钟';
  }
  if (rest == 0) {
    return '$hours 小时';
  }
  return '$hours 小时 $rest 分';
}

/// 收银台（路由 /wallet）：预充时长余额 + 当月免费直播剩余 + 服务端开关下发
/// 的扫码充值档位 + 卡密兑换 + 充值订单 / 最近流水。
class WalletPage extends ConsumerStatefulWidget {
  const WalletPage({super.key});

  @override
  ConsumerState<WalletPage> createState() => _WalletPageState();
}

class _WalletPageState extends ConsumerState<WalletPage> {
  final TextEditingController _cardCodeController = TextEditingController();
  bool _noticeShown = false;

  @override
  void initState() {
    super.initState();
    // 首帧后再拉取，避免 build 阶段发起网络请求
    WidgetsBinding.instance.addPostFrameCallback((_) {
      ref.read(walletControllerProvider.notifier).load();
    });
  }

  @override
  void dispose() {
    _cardCodeController.dispose();
    super.dispose();
  }

  WalletController get _wallet => ref.read(walletControllerProvider.notifier);

  Future<void> _reload() async {
    await _wallet.load();
  }

  /// 服务端公告：配置带公告时只弹一次。
  void _maybeShowNotice(WalletState state) {
    final notice = state.config?.notice ?? '';
    if (_noticeShown || notice.trim().isEmpty || state.overview == null) {
      return;
    }
    _noticeShown = true;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) {
        return;
      }
      showDialog<void>(
        context: context,
        builder: (dialogContext) => AlertDialog(
          key: const Key('walletNoticeDialog'),
          title: const Text('平台公告'),
          content: Text(notice),
          actions: <Widget>[
            TextButton(
              onPressed: () => Navigator.of(dialogContext).pop(),
              child: const Text('知道了'),
            ),
          ],
        ),
      );
    });
  }

  @override
  Widget build(BuildContext context) {
    final state = ref.watch(walletControllerProvider);
    _maybeShowNotice(state);
    return Scaffold(
      key: const Key('walletPage'),
      appBar: AppBar(
        title: const Text('收银台'),
        actions: <Widget>[
          IconButton(
            key: const Key('walletRefreshButton'),
            tooltip: '刷新',
            onPressed: state.loading ? null : _reload,
            icon: const Icon(Icons.refresh),
          ),
        ],
      ),
      body: _buildBody(state),
    );
  }

  Widget _buildBody(WalletState state) {
    final overview = state.overview;
    if (overview == null) {
      if (state.loading) {
        return const Center(
          child: CircularProgressIndicator(key: Key('walletLoading')),
        );
      }
      return _buildErrorState(state.error ?? '暂无数据，请重试');
    }
    final config = state.config;
    return RefreshIndicator(
      onRefresh: _reload,
      child: ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        padding: const EdgeInsets.all(16),
        children: <Widget>[
          if (state.error != null) ...<Widget>[
            _InlineErrorCard(message: state.error!, onRetry: _reload),
            const SizedBox(height: 12),
          ],
          _BalanceCard(overview: overview),
          if (config?.showCharge ?? false) ...<Widget>[
            const SizedBox(height: 12),
            _ChargeCard(
              packs: config?.pricePacks ?? const <PricePack>[],
              busy: state.actionBusy,
              onStart: _startScan,
            ),
          ],
          const SizedBox(height: 12),
          _RedeemCard(
            controller: _cardCodeController,
            busy: state.actionBusy,
            onRedeem: _redeemCard,
          ),
          const SizedBox(height: 16),
          ..._buildOrdersSection(overview.rechargeOrders),
          const SizedBox(height: 16),
          ..._buildTransactionsSection(overview.transactions),
        ],
      ),
    );
  }

  Widget _buildErrorState(String message) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            Text(
              '收银台加载失败：$message',
              key: const Key('walletErrorText'),
              textAlign: TextAlign.center,
              style: const TextStyle(fontSize: 15),
            ),
            const SizedBox(height: 16),
            FilledButton.tonal(
              key: const Key('walletRetryButton'),
              onPressed: _reload,
              child: const Text('重试'),
            ),
          ],
        ),
      ),
    );
  }

  List<Widget> _buildOrdersSection(List<RechargeOrder> orders) {
    return <Widget>[
      const Padding(
        padding: EdgeInsets.only(bottom: 8),
        child: Text(
          '充值订单',
          key: Key('walletOrdersTitle'),
          style: TextStyle(fontSize: 15, fontWeight: FontWeight.bold),
        ),
      ),
      if (orders.isEmpty)
        Text(
          '暂无充值订单，可扫码充值或兑换卡密',
          key: const Key('walletOrdersEmpty'),
          style: TextStyle(fontSize: 13, color: context.tokenTextHint),
        )
      else
        for (final order in orders) ...<Widget>[
          _OrderTile(order: order),
          const SizedBox(height: 8),
        ],
    ];
  }

  List<Widget> _buildTransactionsSection(List<AmountLedgerTxn> txns) {
    return <Widget>[
      const Padding(
        padding: EdgeInsets.only(bottom: 8),
        child: Text(
          '最近流水',
          key: Key('walletTransactionsTitle'),
          style: TextStyle(fontSize: 15, fontWeight: FontWeight.bold),
        ),
      ),
      if (txns.isEmpty)
        Text(
          '暂无流水',
          key: const Key('walletTransactionsEmpty'),
          style: TextStyle(fontSize: 13, color: context.tokenTextHint),
        )
      else
        for (final txn in txns) ...<Widget>[
          _TxnTile(txn: txn),
          const SizedBox(height: 8),
        ],
    ];
  }

  /// 扫码下单：成功后弹「收款码 / 待确权」对话框，可查询到账。
  Future<void> _startScan(int hours) async {
    final result = await _wallet.startScan(hours);
    if (!mounted) {
      return;
    }
    if (result == null) {
      _toast(_actionError ?? '下单失败，请稍后再试');
      return;
    }
    await _showScanDialog(result);
    if (!mounted) {
      return;
    }
    // 关闭对话框后同步订单 / 余额（可能已在后台被人工确权）
    await _reload();
  }

  Future<void> _showScanDialog(RechargeScanResult result) async {
    final order = result.order;
    await showDialog<void>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        key: const Key('walletScanDialog'),
        title: const Text('扫码充值'),
        content: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Text(
                '订单号：${order.orderNo}',
                key: const Key('walletScanOrderNo'),
                style: const TextStyle(fontSize: 13),
              ),
              const SizedBox(height: 4),
              Text(
                '到账时长：${order.hours} 小时'
                '（${_yuanText(order.amountCents)}）',
                style: const TextStyle(fontSize: 13),
              ),
              const SizedBox(height: 12),
              Container(
                key: const Key('walletScanQrPlaceholder'),
                width: double.infinity,
                padding: const EdgeInsets.symmetric(vertical: 20),
                decoration: BoxDecoration(
                  color: context.tokenSurfaceFill,
                  borderRadius: BorderRadius.circular(12),
                ),
                child: result.mockChannel
                    ? Column(
                        children: <Widget>[
                          Icon(
                            Icons.qr_code_2,
                            size: 64,
                            color: context.tokenTextHint,
                          ),
                          const SizedBox(height: 8),
                          Text(
                            'mock 收款码（演示占位）',
                            key: const Key('walletScanMockText'),
                            style: TextStyle(
                              fontSize: 12,
                              color: context.tokenTextHint,
                            ),
                          ),
                        ],
                      )
                    : Image.network(
                        result.qrcodeUrl,
                        height: 160,
                        fit: BoxFit.contain,
                      ),
              ),
              const SizedBox(height: 10),
              Text(
                result.message,
                style: TextStyle(fontSize: 12, color: context.tokenTextBody),
              ),
            ],
          ),
        ),
        actions: <Widget>[
          TextButton(
            key: const Key('walletScanCloseButton'),
            onPressed: () => Navigator.of(dialogContext).pop(),
            child: const Text('稍后再说'),
          ),
          FilledButton(
            key: const Key('walletScanPollButton'),
            onPressed: () => _pollScan(dialogContext, order.id),
            child: const Text('查询到账'),
          ),
        ],
      ),
    );
  }

  /// 轮询扫码单：已确权则关窗提示并刷新，未确权保留窗口提示。
  Future<void> _pollScan(BuildContext dialogContext, String orderId) async {
    final poll = await _wallet.pollRecharge(orderId);
    if (!mounted) {
      return;
    }
    if (poll == null) {
      _toast(_actionError ?? '查询失败，请稍后再试');
      return;
    }
    if (poll.paid) {
      if (dialogContext.mounted) {
        Navigator.of(dialogContext).pop();
      }
      _toast('充值已到账，余额已刷新');
      return;
    }
    _toast('订单待确认：演示通道需运营后台人工确权后到账');
  }

  /// 卡密核销：成功清空输入并提示入账；失败把服务端中文错误透出。
  Future<void> _redeemCard(String rawCode) async {
    final code = rawCode.trim();
    if (code.isEmpty) {
      _toast('请输入卡密');
      return;
    }
    FocusScope.of(context).unfocus();
    final result = await _wallet.redeemCard(code);
    if (!mounted) {
      return;
    }
    if (result == null) {
      _toast(_actionError ?? '兑换失败，请稍后再试');
      return;
    }
    _cardCodeController.clear();
    _toast(
      '兑换成功：入账 ${_minutesText(result.creditedMinutes)}，'
      '当前余额 ${_minutesText(result.balanceMinutes)}',
    );
  }

  void _toast(String message) {
    if (!mounted) {
      return;
    }
    ScaffoldMessenger.of(context)
      ..hideCurrentSnackBar()
      ..showSnackBar(
        SnackBar(content: Text(message), duration: const Duration(seconds: 3)),
      );
  }

  /// 最近一次动作失败的中文提示（读取公开的 UI 状态，避免触达控制器内部）。
  String? get _actionError => ref.read(walletControllerProvider).actionError;
}

/// 顶部余额卡：预充余额 + 当月免费直播配额进度。
class _BalanceCard extends StatelessWidget {
  const _BalanceCard({required this.overview});

  final WalletOverview overview;

  @override
  Widget build(BuildContext context) {
    final quota = overview.monthlyLive;
    final total = quota.quotaMinutes;
    final remaining = quota.remainingMinutes;
    final progress = (total > 0 ? remaining / total : 0.0).clamp(0.0, 1.0);
    return Card(
      key: const Key('walletBalanceCard'),
      margin: EdgeInsets.zero,
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Row(
              children: <Widget>[
                Text(
                  '预充时长余额',
                  style: TextStyle(fontSize: 13, color: context.tokenTextBody),
                ),
                const Spacer(),
                Text(
                  '当月免费直播',
                  style: TextStyle(fontSize: 13, color: context.tokenTextBody),
                ),
              ],
            ),
            const SizedBox(height: 2),
            Row(
              crossAxisAlignment: CrossAxisAlignment.end,
              children: <Widget>[
                Text(
                  '${overview.balanceMinutes}',
                  key: const Key('walletBalanceMinutesText'),
                  style: TextStyle(
                    fontSize: 34,
                    fontWeight: FontWeight.bold,
                    color: Theme.of(context).colorScheme.primary,
                  ),
                ),
                const SizedBox(width: 4),
                Padding(
                  padding: const EdgeInsets.only(bottom: 5),
                  child: Text(
                    '分钟',
                    style: TextStyle(
                      fontSize: 12,
                      color: context.tokenTextBody,
                    ),
                  ),
                ),
                const Spacer(),
                Padding(
                  padding: const EdgeInsets.only(bottom: 5),
                  child: Text(
                    '剩 $remaining 分钟',
                    key: const Key('walletQuotaRemainingText'),
                    style: const TextStyle(
                      fontSize: 14,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 14),
            ClipRRect(
              borderRadius: BorderRadius.circular(4),
              child: LinearProgressIndicator(
                key: const Key('walletQuotaBar'),
                value: progress.toDouble(),
                minHeight: 6,
                backgroundColor: context.tokenSurfaceFill,
              ),
            ),
            const SizedBox(height: 8),
            Text(
              '免费配额 已用 ${quota.usedMinutes} / 共 $total 分钟'
              ' · 扣减优先用预充余额',
              key: const Key('walletQuotaDetailText'),
              style: TextStyle(fontSize: 12, color: context.tokenTextHint),
            ),
          ],
        ),
      ),
    );
  }
}

/// 扫码充值区：服务端下发档位选择 + 生成收款码（mock 通道占位）。
class _ChargeCard extends ConsumerStatefulWidget {
  const _ChargeCard({
    required this.packs,
    required this.busy,
    required this.onStart,
  });

  final List<PricePack> packs;
  final bool busy;
  final Future<void> Function(int hours) onStart;

  @override
  ConsumerState<_ChargeCard> createState() => _ChargeCardState();
}

class _ChargeCardState extends ConsumerState<_ChargeCard> {
  int _selectedHours = 0;

  @override
  Widget build(BuildContext context) {
    final packs = widget.packs;
    if (packs.isEmpty) {
      return const SizedBox.shrink();
    }
    final selected = packs.any((pack) => pack.hours == _selectedHours)
        ? _selectedHours
        : packs.first.hours;
    PricePack? selectedPack;
    for (final pack in packs) {
      if (pack.hours == selected) {
        selectedPack = pack;
        break;
      }
    }
    return Card(
      key: const Key('walletChargeCard'),
      margin: EdgeInsets.zero,
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: <Widget>[
            Row(
              children: <Widget>[
                const Icon(Icons.account_balance_wallet_outlined, size: 20),
                const SizedBox(width: 8),
                const Text(
                  '预充时长',
                  style: TextStyle(fontSize: 16, fontWeight: FontWeight.bold),
                ),
                const Spacer(),
                Text(
                  '收款到账后即时入账',
                  style: TextStyle(fontSize: 12, color: context.tokenTextHint),
                ),
              ],
            ),
            const SizedBox(height: 12),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: <Widget>[
                for (final pack in packs)
                  ChoiceChip(
                    key: Key('walletPackChip_${pack.hours}'),
                    label: Text(
                      '${_yuanText(pack.amountCents)} / ${pack.hours} 小时',
                    ),
                    selected: pack.hours == selected,
                    onSelected: (_) {
                      setState(() {
                        _selectedHours = pack.hours;
                      });
                    },
                  ),
              ],
            ),
            const SizedBox(height: 14),
            FilledButton(
              key: const Key('walletChargeButton'),
              onPressed: widget.busy || selectedPack == null
                  ? null
                  : () => widget.onStart(selected),
              style: FilledButton.styleFrom(
                minimumSize: const Size.fromHeight(44),
              ),
              child: Text(
                selectedPack == null
                    ? '暂无档位'
                    : '生成收款码 · ${_yuanText(selectedPack.amountCents)}',
              ),
            ),
            const SizedBox(height: 8),
            Text(
              '当前为演示通道：收款码为占位，由运营后台人工确权后到账',
              key: const Key('walletChargeHint'),
              style: TextStyle(fontSize: 11, color: context.tokenTextHint),
            ),
          ],
        ),
      ),
    );
  }
}

/// 卡密兑换：输入卡密入账到预充余额。
class _RedeemCard extends StatelessWidget {
  const _RedeemCard({
    required this.controller,
    required this.busy,
    required this.onRedeem,
  });

  final TextEditingController controller;
  final bool busy;
  final Future<void> Function(String code) onRedeem;

  void _submit(String raw) {
    final code = raw.trim();
    if (code.isNotEmpty) {
      onRedeem(code);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Card(
      key: const Key('walletRedeemCard'),
      margin: EdgeInsets.zero,
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: <Widget>[
            Row(
              children: <Widget>[
                const Icon(Icons.card_giftcard, size: 20),
                const SizedBox(width: 8),
                const Text(
                  '卡密兑换',
                  style: TextStyle(fontSize: 16, fontWeight: FontWeight.bold),
                ),
                const Spacer(),
                Text(
                  '找运营 / 代理购买时长卡',
                  style: TextStyle(fontSize: 12, color: context.tokenTextHint),
                ),
              ],
            ),
            const SizedBox(height: 12),
            TextField(
              key: const Key('walletRedeemInput'),
              controller: controller,
              enabled: !busy,
              decoration: const InputDecoration(
                labelText: '兑换卡密',
                hintText: '请输入卡密',
                border: OutlineInputBorder(),
                isDense: true,
              ),
              onSubmitted: _submit,
            ),
            const SizedBox(height: 12),
            FilledButton.tonal(
              key: const Key('walletRedeemButton'),
              onPressed: busy ? null : () => _submit(controller.text),
              style: FilledButton.styleFrom(
                minimumSize: const Size.fromHeight(44),
              ),
              child: const Text('兑换入账'),
            ),
          ],
        ),
      ),
    );
  }
}

/// 整页错误 / 内联刷新失败提示。
class _InlineErrorCard extends StatelessWidget {
  const _InlineErrorCard({required this.message, required this.onRetry});

  final String message;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Card(
      key: const Key('walletInlineErrorCard'),
      margin: EdgeInsets.zero,
      color: scheme.error.withValues(alpha: 0.08),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
        child: Row(
          children: <Widget>[
            Icon(Icons.error_outline, size: 18, color: scheme.error),
            const SizedBox(width: 8),
            Expanded(
              child: Text(
                '刷新失败：$message',
                style: TextStyle(fontSize: 13, color: scheme.error),
              ),
            ),
            TextButton(
              key: const Key('walletInlineErrorRetryButton'),
              onPressed: onRetry,
              child: const Text('重试'),
            ),
          ],
        ),
      ),
    );
  }
}

/// 充值订单行：渠道 + 状态 + 金额 / 入账时长。
class _OrderTile extends StatelessWidget {
  const _OrderTile({required this.order});

  final RechargeOrder order;

  @override
  Widget build(BuildContext context) {
    final isCard = order.channel == 'card';
    final statusColor = order.paid ? AppColors.live : AppColors.warning;
    final amountText = isCard
        ? '+${_minutesText(order.minutes ?? order.hours! * 60)}'
        : _yuanText(order.amountCents);
    return Card(
      key: Key('walletOrderItem_${order.id}'),
      margin: EdgeInsets.zero,
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Row(
          children: <Widget>[
            Icon(
              order.paid ? Icons.check_circle_outline : Icons.schedule,
              color: statusColor,
            ),
            const SizedBox(width: 10),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  Text(
                    '${isCard ? '卡密核销' : '扫码充值'} · ${order.statusLabel}',
                    style: const TextStyle(
                      fontSize: 14,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                  const SizedBox(height: 2),
                  Text(
                    '${order.orderNo} · ${_formatTime(order.createdAt)}',
                    style: TextStyle(
                      fontSize: 11,
                      color: context.tokenTextHint,
                    ),
                  ),
                ],
              ),
            ),
            const SizedBox(width: 8),
            Column(
              crossAxisAlignment: CrossAxisAlignment.end,
              children: <Widget>[
                Text(
                  amountText,
                  style: TextStyle(
                    fontSize: 14,
                    fontWeight: FontWeight.bold,
                    color: order.paid
                        ? Theme.of(context).colorScheme.primary
                        : context.tokenTextStrong,
                  ),
                ),
                const SizedBox(height: 2),
                Text(
                  order.paid ? '已到账' : order.statusLabel,
                  style: TextStyle(fontSize: 11, color: statusColor),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

/// 最近流水行：来源 + 变动分钟 + 变动后余额。
class _TxnTile extends StatelessWidget {
  const _TxnTile({required this.txn});

  final AmountLedgerTxn txn;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final deltaColor = txn.isCredit ? AppColors.live : scheme.error;
    final remark = txn.remark;
    final meta = [
      if (remark != null && remark.isNotEmpty) remark,
      _formatTime(txn.createdAt),
    ].join(' · ');
    return Card(
      key: Key('walletTxnItem_${txn.id}'),
      margin: EdgeInsets.zero,
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Row(
          children: <Widget>[
            Icon(
              txn.isCredit
                  ? Icons.add_circle_outline
                  : Icons.remove_circle_outline,
              color: deltaColor,
            ),
            const SizedBox(width: 10),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  Text(
                    txn.sourceLabel,
                    style: const TextStyle(
                      fontSize: 14,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                  const SizedBox(height: 2),
                  Text(
                    meta,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      fontSize: 11,
                      color: context.tokenTextHint,
                    ),
                  ),
                ],
              ),
            ),
            const SizedBox(width: 8),
            Column(
              crossAxisAlignment: CrossAxisAlignment.end,
              children: <Widget>[
                Text(
                  '${txn.isCredit ? '+' : ''}${txn.deltaMinutes} 分钟',
                  style: TextStyle(
                    fontSize: 14,
                    fontWeight: FontWeight.bold,
                    color: deltaColor,
                  ),
                ),
                const SizedBox(height: 2),
                Text(
                  '余额 ${txn.balanceAfterMinutes} 分钟',
                  style: TextStyle(fontSize: 11, color: context.tokenTextHint),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}
