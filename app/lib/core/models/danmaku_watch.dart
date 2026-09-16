// 独立弹幕监控（R16 · App 侧）：**不绑场次、不落库**，贴一段分享链接就能看弹幕流水。
//
// 与「场次采集」（工作台里的弹幕采集卡）的区别 —— 这就是「监听源与场次解耦」的用户可见面：
//   * 场次采集：必须先开一场直播，事件落 live_danmaku 并触发 AI 回复 → 出声；
//   * 本页监控：随时可用，事件只存在服务端**内存环形缓冲**里，纯看不落库、不进 AI 链路。
// 用途：验证某个直播间能不能采 / 弹幕长什么样 / 排障时区分「房间没人」与「链路坏了」。

/// 一个独立监控（服务端 returns 的 watch 对象）。
class DanmakuWatch {
  const DanmakuWatch({
    required this.watchId,
    required this.platform,
    required this.roomRef,
    required this.startedAt,
  });

  factory DanmakuWatch.fromJson(Map<String, dynamic> json) {
    return DanmakuWatch(
      watchId: json['watchId']?.toString() ?? '',
      platform: json['platform']?.toString() ?? '',
      roomRef: json['roomRef']?.toString() ?? '',
      startedAt: json['startedAt']?.toString() ?? '',
    );
  }

  final String watchId;
  final String platform;
  final String roomRef;
  final String startedAt;

  String get platformLabel => switch (platform) {
    'douyin' => '抖音',
    'bilibili' => 'B 站',
    'kuaishou' => '快手',
    _ => platform,
  };
}

/// 缓冲里的一条弹幕事件。
class DanmakuWatchEvent {
  const DanmakuWatchEvent({
    required this.seq,
    required this.msgType,
    required this.content,
    required this.senderNickname,
    required this.happenedAt,
  });

  factory DanmakuWatchEvent.fromJson(Map<String, dynamic> json) {
    return DanmakuWatchEvent(
      seq: (json['seq'] as num?)?.toInt() ?? 0,
      msgType: json['msgType']?.toString() ?? '',
      content: json['content']?.toString(),
      senderNickname: json['senderNickname']?.toString(),
      happenedAt: json['happenedAt']?.toString() ?? '',
    );
  }

  /// 单调递增序号，供增量拉取
  final int seq;
  final String msgType;
  final String? content;
  final String? senderNickname;
  final String happenedAt;

  String get typeLabel => switch (msgType) {
    'chat' => '发言',
    'enter' => '进场',
    'like' => '点赞',
    'gift' => '礼物',
    'follow' => '关注',
    _ => msgType,
  };

  /// 只有 chat 有正文；其余类型的内容是适配器生成的描述（如「4个赞」）
  String get displayText {
    final body = content?.trim() ?? '';
    return body.isEmpty ? typeLabel : body;
  }
}

/// GET /api/danmaku-watch/:id/events 的返回。
class DanmakuWatchEvents {
  const DanmakuWatchEvents({required this.events, required this.lastSeq});

  factory DanmakuWatchEvents.fromJson(Map<String, dynamic> json) {
    final raw = json['events'];
    return DanmakuWatchEvents(
      events: raw is List
          ? raw
                .whereType<Map>()
                .map((item) => DanmakuWatchEvent.fromJson(Map<String, dynamic>.from(item)))
                .toList()
          : <DanmakuWatchEvent>[],
      lastSeq: (json['lastSeq'] as num?)?.toInt() ?? 0,
    );
  }

  final List<DanmakuWatchEvent> events;
  final int lastSeq;
}
