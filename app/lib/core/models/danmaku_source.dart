// 弹幕采集源（R2 · D4.1）：服务端 /api/lives/:id/danmaku-source 的状态模型。
//
// 口径（见 docs/DANMAKU-COLLECTOR-PLAN.md §11）：
//   * enabled=false 表示该部署未配置签名 Key，采集通道未启用（此时仍可用「发送测试弹幕」手工注入）；
//   * 绑定是**内存态**，服务端进程重启后需要重新绑定；
//   * binding 是「配置」（贴一次链接，可跨场复用），watch 是「运行态」（随开播起、随结束停）。

/// 一场直播的采集绑定（服务端返回的 source 对象）。
class DanmakuSourceBinding {
  const DanmakuSourceBinding({
    required this.liveId,
    required this.platform,
    required this.roomRef,
    required this.watchKey,
    required this.startedAt,
  });

  factory DanmakuSourceBinding.fromJson(Map<String, dynamic> json) {
    return DanmakuSourceBinding(
      liveId: json['liveId']?.toString() ?? '',
      platform: json['platform']?.toString() ?? '',
      roomRef: json['roomRef']?.toString() ?? '',
      watchKey: json['watchKey']?.toString() ?? '',
      startedAt: json['startedAt']?.toString() ?? '',
    );
  }

  final String liveId;

  /// 平台标识（当前只有 douyin）。
  final String platform;

  /// 平台侧房间号。
  final String roomRef;

  /// 服务端采集会话的幂等键。
  final String watchKey;
  final String startedAt;

  String get platformLabel => switch (platform) {
    'douyin' => '抖音',
    'bilibili' => 'B 站',
    'kuaishou' => '快手',
    _ => platform,
  };
}

/// 采集会话的运行态（来自服务端 collectorManager 的快照）。
class DanmakuSourceWatch {
  const DanmakuSourceWatch({
    required this.status,
    required this.eventCount,
    required this.invalidEvents,
    this.connectedAt,
    this.lastEventAt,
    this.lastError,
  });

  factory DanmakuSourceWatch.fromJson(Map<String, dynamic> json) {
    return DanmakuSourceWatch(
      status: json['status']?.toString() ?? '',
      eventCount: (json['eventCount'] as num?)?.toInt() ?? 0,
      invalidEvents: (json['invalidEvents'] as num?)?.toInt() ?? 0,
      connectedAt: json['connectedAt']?.toString(),
      lastEventAt: json['lastEventAt']?.toString(),
      lastError: json['lastError']?.toString(),
    );
  }

  /// starting / connected / reconnecting / stopped / ended / error
  final String status;

  /// 已转发给业务链路的有效事件数。
  final int eventCount;

  /// 被守卫丢弃的脏事件数。
  final int invalidEvents;

  /// 连接成功时刻（ISO8601；未连接为 null）。
  final String? connectedAt;

  /// **最后一次收到有效事件的时刻**（从未收到为 null）。
  final String? lastEventAt;
  final String? lastError;

  bool get connected => status == 'connected';

  /// 超过这个时长没有事件就提示商家（3 分钟）。
  static const idleWarnSeconds = 180;

  /// 已连接但**多久没有收到任何事件**（秒）；未连接或时间缺失时返回 null。
  ///
  /// 起点是「最后一次事件」，从没收到过就从「连接成功」算 ——
  /// 这样**「曾经收到、后来断了」也能被抓到**（只看 eventCount 是抓不到的）。
  ///
  /// 为什么需要它：2026-09-18 商家中途下播重开，抖音给了新房间号，我们的采集
  /// 仍连着旧房间 —— `connected`、`lastError` 空、台本照跑，**看起来一切正常**，
  /// 实际零事件，AI 独自讲了 15 分钟。详见 docs/LIVE-ROOM-LOCKING.md。
  int? idleSeconds({DateTime? now}) {
    if (!connected) {
      return null;
    }
    final base = DateTime.tryParse(lastEventAt ?? connectedAt ?? '');
    if (base == null) {
      return null;
    }
    final elapsed = (now ?? DateTime.now())
        .toUtc()
        .difference(base.toUtc())
        .inSeconds;
    return elapsed < 0 ? 0 : elapsed;
  }

  /// 连着但长时间零事件 —— 自己判断不了「是我们断了」还是「对面没动静」，必须让商家知道。
  bool get looksIdle => (idleSeconds() ?? 0) >= idleWarnSeconds;

  /// 给用户看的一行状态文案。
  String get label => switch (status) {
    'starting' => '连接中…',
    'connected' => '监听中 · 已收到 $eventCount 条',
    'reconnecting' => '断线重连中…',
    'stopped' => '已停止',
    'ended' => '直播已结束',
    'error' => '采集出错',
    _ => status.isEmpty ? '未在监听' : status,
  };
}

/// GET /api/lives/:id/danmaku-source 的返回。
class DanmakuSourceStatus {
  const DanmakuSourceStatus({required this.enabled, this.binding, this.watch});

  factory DanmakuSourceStatus.fromJson(Map<String, dynamic> json) {
    final bindingRaw = json['binding'];
    final watchRaw = json['watch'];
    return DanmakuSourceStatus(
      enabled: json['enabled'] == true,
      binding: bindingRaw is Map
          ? DanmakuSourceBinding.fromJson(Map<String, dynamic>.from(bindingRaw))
          : null,
      watch: watchRaw is Map
          ? DanmakuSourceWatch.fromJson(Map<String, dynamic>.from(watchRaw))
          : null,
    );
  }

  /// 该部署是否启用了采集通道（未配签名 Key 时为 false）。
  final bool enabled;
  final DanmakuSourceBinding? binding;
  final DanmakuSourceWatch? watch;

  bool get hasBinding => binding != null;

  /// 是否正在监听（有绑定且有活跃会话）。
  bool get running => binding != null && watch != null && watch!.status != 'stopped';
}
