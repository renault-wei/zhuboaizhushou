/// 开播配置数据模型：字段与服务端 /api/lives 系列接口保持一致。
/// status 取值：idle 草稿 / processing 合成中 / ready 就绪 / live 直播中 /
/// ended 已结束 / failed 失败。
///
/// 合规红线：aiBadgeShown 恒为 true——「AI 智能直播」角标由服务端强制叠加、不提供关闭入口，
/// 客户端仅透传展示，不提供任何隐藏/关闭开关。
enum LiveStatus {
  idle('草稿'),
  processing('合成中'),
  ready('就绪'),
  live('直播中'),
  ended('已结束'),
  failed('失败');

  const LiveStatus(this.label);

  /// 展示用中文标签
  final String label;

  /// 由服务端下发的字符串解析；未知值兜底为 failed，便于尽早暴露前后端状态不同步。
  static LiveStatus fromWire(String? raw) {
    for (final status in LiveStatus.values) {
      if (status.name == raw) {
        return status;
      }
    }
    return LiveStatus.failed;
  }
}

/// 开播配置：绑定音色 + 话术 + 团购券 + 标题的直播编排草稿。
/// T10 仅做 CRUD 配置，不含推流 / 开播逻辑。
class Live {
  const Live({
    required this.id,
    required this.title,
    required this.videoSourceUrl,
    required this.couponId,
    required this.rtmpUrl,
    required this.voiceId,
    required this.scriptId,
    this.loopScriptId,
    required this.status,
    required this.aiBadgeShown,
    required this.startedAt,
    required this.endedAt,
    required this.createdAt,
    required this.updatedAt,
  });

  factory Live.fromJson(Map<String, dynamic> json) {
    return Live(
      id: json['id']?.toString() ?? '',
      title: json['title']?.toString() ?? '',
      videoSourceUrl: json['videoSourceUrl']?.toString() ?? '',
      couponId: _nullableString(json['couponId']),
      rtmpUrl: _nullableString(json['rtmpUrl']),
      voiceId: _nullableString(json['voiceId']),
      scriptId: _nullableString(json['scriptId']),
      loopScriptId: _nullableString(json['loopScriptId']),
      status: LiveStatus.fromWire(json['status']?.toString()),
      // 合规：服务端写死 true；字段缺失按 true 处理，避免误把角标当作可关闭项
      aiBadgeShown: json['aiBadgeShown'] != false,
      startedAt: _nullableString(json['startedAt']),
      endedAt: _nullableString(json['endedAt']),
      createdAt: json['createdAt']?.toString() ?? '',
      updatedAt: json['updatedAt']?.toString() ?? '',
    );
  }

  final String id;

  /// 直播标题（1-100 字）
  final String title;

  /// 实景视频源：T10 默认空串，T11 上传视频后回填 /uploads/videos/...，
  /// prepare 合成成功后更新为产物路径 /uploads/lives/...
  final String videoSourceUrl;

  /// 抖音团购券 id（T10 直接存档，不校验持有关系）
  final String? couponId;

  /// RTMP 推流地址：T10/T11 阶段为空，实际推流在 T12 接入
  final String? rtmpUrl;

  /// 绑定的音色 id
  final String? voiceId;

  /// 绑定的话术 id
  final String? scriptId;

  /// 绑定的循环台本 id（循环口播用；null = 仅弹幕回复模式）
  final String? loopScriptId;

  /// 直播状态：idle / processing / ready / live / ended / failed
  final LiveStatus status;

  /// 合规角标标记：恒为 true（服务端强制叠加「AI 智能直播」，客户端无关闭入口）
  final bool aiBadgeShown;

  /// 开播时间（ISO8601），未开播为 null
  final String? startedAt;

  /// 结束时间（ISO8601），未结束为 null
  final String? endedAt;

  /// 创建时间（ISO8601 字符串）
  final String createdAt;

  /// 最近更新时间（ISO8601 字符串）
  final String updatedAt;

  /// 展示用状态中文标签
  String get statusLabel => status.label;

  /// 是否可编辑：仅 idle（草稿）可编辑；合成中/就绪/直播中/已结束均不可编辑
  bool get isEditable => status == LiveStatus.idle;

  /// 是否直播中
  bool get isLive => status == LiveStatus.live;

  /// 是否已就绪（合成完成、可一键开播）
  bool get isReady => status == LiveStatus.ready;

  /// 是否已结束（ended / failed 均为终态，仅可删除）
  bool get isFinished =>
      status == LiveStatus.ended || status == LiveStatus.failed;

  /// 是否删除受保护（processing/ready/live 不可删，删除会命中服务端 409）
  bool get isDeleteProtected =>
      status == LiveStatus.processing ||
      status == LiveStatus.ready ||
      status == LiveStatus.live;
}

/// 合成 / 直播状态查询结果：对应 GET /api/lives/:id/stream-status 的返回形状，
/// 供客户端轮询合成进度与产物地址。
class LiveStreamStatus {
  const LiveStreamStatus({
    required this.status,
    required this.videoSourceUrl,
    required this.aiBadgeShown,
  });

  factory LiveStreamStatus.fromJson(Map<String, dynamic> json) {
    return LiveStreamStatus(
      status: LiveStatus.fromWire(json['status']?.toString()),
      videoSourceUrl: json['videoSourceUrl']?.toString() ?? '',
      // 合规兜底：缺失按 true 处理，与 Live.fromJson 保持一致
      aiBadgeShown: json['aiBadgeShown'] != false,
    );
  }

  /// 当前状态：idle / processing / ready / live / ended / failed
  final LiveStatus status;

  /// 实景视频源 / 合成产物路径（空串表示尚未上传）
  final String videoSourceUrl;

  /// 合规角标标记：恒为 true（服务端强制叠加，无关闭入口）
  final bool aiBadgeShown;
}

/// 直播中监控快照：对应 GET /api/lives/:id/monitor 的返回形状，
/// 供监控页轮询展示状态、已播时长与弹幕计数。
class LiveMonitor {
  const LiveMonitor({
    required this.status,
    required this.videoSourceUrl,
    required this.aiBadgeShown,
    required this.startedAt,
    required this.endedAt,
    required this.durationSeconds,
    required this.danmakuCount,
  });

  factory LiveMonitor.fromJson(Map<String, dynamic> json) {
    return LiveMonitor(
      status: LiveStatus.fromWire(json['status']?.toString()),
      videoSourceUrl: json['videoSourceUrl']?.toString() ?? '',
      // 合规兜底：缺失按 true 处理，与 Live.fromJson 保持一致
      aiBadgeShown: json['aiBadgeShown'] != false,
      startedAt: _nullableString(json['startedAt']),
      endedAt: _nullableString(json['endedAt']),
      durationSeconds: (json['durationSeconds'] as num?)?.toInt() ?? 0,
      danmakuCount: (json['danmakuCount'] as num?)?.toInt() ?? 0,
    );
  }

  /// 当前状态：idle / processing / ready / live / ended / failed
  final LiveStatus status;

  /// 合成产物 / 实景视频源路径
  final String videoSourceUrl;

  /// 合规角标标记：恒为 true（服务端强制叠加，无关闭入口）
  final bool aiBadgeShown;

  /// 开播时间（ISO8601），未开播为 null
  final String? startedAt;

  /// 结束时间（ISO8601），未结束为 null
  final String? endedAt;

  /// 已播时长（秒）：live = now - startedAt；ended = endedAt - startedAt；其它 0
  final int durationSeconds;

  /// 弹幕总数（live_danmaku 计数）
  final int danmakuCount;

  /// 已播时长格式化为 hh:mm:ss（超过 24h 时小时数继续累加）。
  String get durationLabel {
    final total = durationSeconds < 0 ? 0 : durationSeconds;
    final hours = total ~/ 3600;
    final minutes = (total % 3600) ~/ 60;
    final seconds = total % 60;
    String two(int value) => value.toString().padLeft(2, '0');
    return '${two(hours)}:${two(minutes)}:${two(seconds)}';
  }
}

/// 单条弹幕日志（只读）：对应 GET /api/lives/:id/danmaku 返回数组的元素。
/// T13 不提供写入口，真实弹幕来源待抖音推流接入后灌入。
class LiveDanmaku {
  const LiveDanmaku({
    required this.id,
    required this.content,
    required this.senderNickname,
    required this.sentAt,
  });

  factory LiveDanmaku.fromJson(Map<String, dynamic> json) {
    return LiveDanmaku(
      id: json['id']?.toString() ?? '',
      content: json['content']?.toString() ?? '',
      senderNickname: _nullableString(json['senderNickname']),
      sentAt: json['sentAt']?.toString() ?? '',
    );
  }

  final String id;

  /// 弹幕内容
  final String content;

  /// 发送者昵称（抖音观众，可空）
  final String? senderNickname;

  /// 弹幕到达时间（ISO8601）
  final String sentAt;
}

/// JSON 里的可空字段：null / 空串统一归一为 null。
String? _nullableString(Object? raw) {
  final value = raw?.toString() ?? '';
  return value.isEmpty ? null : value;
}
