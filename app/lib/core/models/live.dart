/// 开播配置数据模型：字段与服务端 /api/lives 系列接口保持一致。
/// status 取值：idle 草稿 / ready 就绪 / live 直播中 / ended 已结束 / failed 失败。
///
/// 合规红线：aiBadgeShown 恒为 true——「AI 智能直播」角标由服务端强制叠加、不提供关闭入口，
/// 客户端仅透传展示，不提供任何隐藏/关闭开关。
enum LiveStatus {
  idle('草稿'),
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

  /// 实景视频源：T10 默认空串，T11 上传视频后回填
  final String videoSourceUrl;

  /// 抖音团购券 id（T10 直接存档，不校验持有关系）
  final String? couponId;

  /// RTMP 推流地址：T10 阶段为空，推流在 T11/T12 接入
  final String? rtmpUrl;

  /// 绑定的音色 id
  final String? voiceId;

  /// 绑定的话术 id
  final String? scriptId;

  /// 直播状态：idle / ready / live / ended / failed
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

  /// 是否可编辑：仅 idle（草稿）可编辑；直播中/已结束不可编辑
  bool get isEditable => status == LiveStatus.idle;

  /// 是否直播中
  bool get isLive => status == LiveStatus.live;

  /// 是否已结束（ended / failed 均为终态，仅可删除）
  bool get isFinished =>
      status == LiveStatus.ended || status == LiveStatus.failed;

  /// 是否删除受保护（ready/live 不可删，删除会命中服务端 409）
  bool get isDeleteProtected =>
      status == LiveStatus.ready || status == LiveStatus.live;
}

/// JSON 里的可空字段：null / 空串统一归一为 null。
String? _nullableString(Object? raw) {
  final value = raw?.toString() ?? '';
  return value.isEmpty ? null : value;
}
