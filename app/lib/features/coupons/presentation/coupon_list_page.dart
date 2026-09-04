import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import 'package:starvoice_app/core/models/coupon.dart';
import 'package:starvoice_app/features/coupons/application/coupon_controller.dart';
import 'package:starvoice_app/providers.dart';

/// 券图占位色板：mock 阶段无真实券图，按券 ID 哈希稳定取色。
const List<Color> _kPlaceholderPalette = <Color>[
  Color(0xFFF6A24A),
  Color(0xFFE8684A),
  Color(0xFF7A9E54),
  Color(0xFF5B8FF9),
  Color(0xFF9D6BDB),
  Color(0xFF5AA9A8),
];

Color _placeholderColor(String couponId) {
  var hash = 0;
  for (final codeUnit in couponId.codeUnits) {
    hash = (hash * 31 + codeUnit) & 0x7fffffff;
  }
  return _kPlaceholderPalette[hash % _kPlaceholderPalette.length];
}

/// 团购券列表页（路由 /coupons）：拉取当前抖音账号下的团购券，
/// 供后续开播配置页选择「直播挂载商品」。未绑定抖音号时引导去绑定。
class CouponListPage extends ConsumerStatefulWidget {
  const CouponListPage({super.key, this.selectable = false});

  /// 选择模式：作为开播配置表单「选券」入口，点选卡片即 pop 返回券 id。
  final bool selectable;

  @override
  ConsumerState<CouponListPage> createState() => _CouponListPageState();
}

class _CouponListPageState extends ConsumerState<CouponListPage> {
  @override
  void initState() {
    super.initState();
    // 首帧后再拉取列表，避免 build 阶段发起网络请求
    WidgetsBinding.instance.addPostFrameCallback((_) {
      ref.read(couponControllerProvider.notifier).load();
    });
  }

  Future<void> _reload() async {
    await ref.read(couponControllerProvider.notifier).load();
  }

  /// 未绑定抖音号：跳绑定页，返回后刷新券列表。
  Future<void> _goBind() async {
    await context.push('/douyin-bind');
    if (!mounted) {
      return;
    }
    await _reload();
  }

  @override
  Widget build(BuildContext context) {
    final state = ref.watch(couponControllerProvider);
    return Scaffold(
      key: const Key('couponListPage'),
      appBar: AppBar(
        title: const Text('团购券'),
        actions: <Widget>[
          IconButton(
            key: const Key('couponRefreshButton'),
            onPressed: state.loading ? null : _reload,
            icon: const Icon(Icons.refresh),
            tooltip: '刷新',
          ),
        ],
      ),
      body: _buildBody(state),
    );
  }

  Widget _buildBody(CouponState state) {
    if (state.loading && state.coupons.isEmpty) {
      return const Center(
        child: CircularProgressIndicator(key: Key('couponListLoading')),
      );
    }
    if (state.notBound && state.coupons.isEmpty) {
      return _buildNotBoundState();
    }
    if (state.error != null && state.coupons.isEmpty) {
      return _buildErrorState(state.error!);
    }
    if (state.coupons.isEmpty) {
      return _buildEmptyState();
    }
    return RefreshIndicator(
      onRefresh: _reload,
      child: ListView.separated(
        physics: const AlwaysScrollableScrollPhysics(),
        padding: const EdgeInsets.all(16),
        itemCount: state.coupons.length,
        separatorBuilder: (context, index) => const SizedBox(height: 12),
        itemBuilder: (context, index) {
          return _CouponCard(
            coupon: state.coupons[index],
            onTap: widget.selectable
                ? () =>
                    Navigator.of(context).pop(state.coupons[index].couponId)
                : null,
          );
        },
      ),
    );
  }

  /// 未绑定抖音号：引导去绑定。
  Widget _buildNotBoundState() {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(32),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            Icon(Icons.link_off, size: 56, color: Colors.grey.shade400),
            const SizedBox(height: 16),
            const Text(
              '请先绑定抖音号，才能拉取团购券',
              key: Key('couponNotBoundHint'),
              textAlign: TextAlign.center,
            ),
            const SizedBox(height: 20),
            FilledButton.tonal(
              key: const Key('couponGoBindButton'),
              onPressed: _goBind,
              child: const Text('去绑定'),
            ),
          ],
        ),
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
              '团购券加载失败：$message',
              key: const Key('couponListErrorText'),
              textAlign: TextAlign.center,
            ),
            const SizedBox(height: 12),
            OutlinedButton(
              key: const Key('couponListRetryButton'),
              onPressed: _reload,
              child: const Text('重试'),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildEmptyState() {
    return LayoutBuilder(
      builder: (context, constraints) {
        return RefreshIndicator(
          onRefresh: _reload,
          child: ListView(
            physics: const AlwaysScrollableScrollPhysics(),
            children: <Widget>[
              ConstrainedBox(
                constraints: BoxConstraints(minHeight: constraints.maxHeight),
                child: Center(
                  child: Padding(
                    padding: const EdgeInsets.all(32),
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      children: <Widget>[
                        Icon(
                          Icons.confirmation_number_outlined,
                          size: 56,
                          color: Colors.grey.shade400,
                        ),
                        const SizedBox(height: 16),
                        const Text(
                          '暂无团购券，请到抖音生活服务后台创建',
                          key: Key('couponEmptyText'),
                          textAlign: TextAlign.center,
                        ),
                      ],
                    ),
                  ),
                ),
              ),
            ],
          ),
        );
      },
    );
  }
}

/// 单张团购券卡片：色块占位图、券名、套餐内容、售价/原价/折扣、已售数量。
class _CouponCard extends StatelessWidget {
  const _CouponCard({required this.coupon, this.onTap});

  final Coupon coupon;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return GestureDetector(
      behavior: HitTestBehavior.opaque,
      onTap: onTap,
      child: Card(
        key: Key('couponCard_${coupon.couponId}'),
        margin: EdgeInsets.zero,
        clipBehavior: Clip.antiAlias,
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            // 券图占位：mock 阶段无真实券图，按券 ID 稳定取色
            Container(
              width: 72,
              height: 72,
              decoration: BoxDecoration(
                color: _placeholderColor(coupon.couponId),
                borderRadius: BorderRadius.circular(8),
              ),
              alignment: Alignment.center,
              child: const Icon(
                Icons.restaurant,
                color: Colors.white,
                size: 30,
              ),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  Text(
                    coupon.name,
                    style: const TextStyle(
                      fontSize: 16,
                      fontWeight: FontWeight.bold,
                    ),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                  ),
                  const SizedBox(height: 4),
                  Text(
                    coupon.package,
                    style: TextStyle(
                      fontSize: 12,
                      height: 1.4,
                      color: Colors.grey.shade600,
                    ),
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                  ),
                  const SizedBox(height: 8),
                  Row(
                    crossAxisAlignment: CrossAxisAlignment.end,
                    children: <Widget>[
                      Text(
                        coupon.priceText,
                        key: Key('couponPrice_${coupon.couponId}'),
                        style: TextStyle(
                          fontSize: 18,
                          fontWeight: FontWeight.bold,
                          color: scheme.error,
                        ),
                      ),
                      const SizedBox(width: 6),
                      if (coupon.hasDiscount) ...<Widget>[
                        Text(
                          coupon.originalPriceText,
                          style: TextStyle(
                            fontSize: 12,
                            color: Colors.grey.shade500,
                            decoration: TextDecoration.lineThrough,
                          ),
                        ),
                        const SizedBox(width: 6),
                        Container(
                          padding: const EdgeInsets.symmetric(
                            horizontal: 6,
                            vertical: 2,
                          ),
                          decoration: BoxDecoration(
                            color: scheme.error.withValues(alpha: 0.1),
                            borderRadius: BorderRadius.circular(4),
                          ),
                          child: Text(
                            coupon.discountText,
                            key: Key('couponDiscount_${coupon.couponId}'),
                            style: TextStyle(
                              fontSize: 11,
                              color: scheme.error,
                              fontWeight: FontWeight.w600,
                            ),
                          ),
                        ),
                      ],
                      const Spacer(),
                      Text(
                        coupon.salesText,
                        style: TextStyle(
                          fontSize: 12,
                          color: Colors.grey.shade600,
                        ),
                      ),
                    ],
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    ),
  );
  }
}
