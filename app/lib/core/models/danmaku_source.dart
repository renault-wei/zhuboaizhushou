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
    this.lastError,
  });

  factory DanmakuSourceWatch.fromJson(Map<String, dynamic> json) {
    return DanmakuSourceWatch(
      status: json['status']?.toString() ?? '',
      eventCount: (json['eventCount'] as num?)?.toInt() ?? 0,
      invalidEvents: (json['invalidEvents'] as num?)?.toInt() ?? 0,
      lastError: json['lastError']?.toString(),
    );
  }

  /// starting / connected / reconnecting / stopped / ended / error
  final String status;

  /// 已转发给业务链路的有效事件数。
  final int eventCount;

  /// 被守卫丢弃的脏事件数。
  final int invalidEvents;
  final String? lastError;

  bool get connected => status == 'connected';

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
