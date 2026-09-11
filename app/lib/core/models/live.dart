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
    required this.volcPresetId,
    required this.speechRate,
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
      volcPresetId: _nullableString(json['volcPresetId']),
      speechRate: (json['speechRate'] as num?)?.toInt(),
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

  /// 火山预设音色 id（内置目录，只读）：与 [voiceId] 互斥，二选一
  final String? volcPresetId;

  /// 口播语速档：火山 speech_rate 口径的商家滑块档（-20~60，0 = 正常语速，负值更慢）；
  /// null = 未设过，服务端按默认档（-10）兜底
  final int? speechRate;

  /// 绑定的克隆音色 id（来自「我的音色」）：与 [volcPresetId] 互斥，二选一
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

  /// 是否已绑定出声来源（克隆音色 / 火山预设音色任一）：无音色的草稿无法就绪开播
  bool get hasVoiceSource => voiceId != null || volcPresetId != null;

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
    required this.loopRunning,
    required this.loopRound,
    required this.loopCurrentSeq,
    required this.loopMissing,
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
      loopRunning: json['loopRunning'] == true,
      loopRound: (json['loopRound'] as num?)?.toInt() ?? 0,
      loopCurrentSeq: (json['loopCurrentSeq'] as num?)?.toInt() ?? 0,
      loopMissing: json['loopMissing'] == true,
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

  /// 循环台本 Runner 是否运行中（live 且有绑定台本且已开播才可能为 true）
  final bool loopRunning;

  /// 已播轮数（服务端内存态；进程重启不恢复属已知限制）
  final int loopRound;

  /// 当前轮到第几条（1 起；空闲 / 结束为 0）
  final int loopCurrentSeq;

  /// 未绑定循环台本：开播也只回弹幕，工作台需提示
  final bool loopMissing;

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

/// 直播结束的按分钟结算摘要：对应 POST /api/lives/:id/end 响应中的 billing。
/// 服务端口径 =「先扣时长余额 → 回落当月免费直播分钟」的缺额式结算；不足 1
/// 分钟 settledMinutes=0（不扣费）。billing 缺失 = 结算未启用或服务端异常降级
/// （结束本身不阻断），客户端只做展示、不参与金额计算。
class LiveBilling {
  const LiveBilling({
    required this.settledMinutes,
    required this.drawnFromBalance,
    required this.drawnFromQuota,
    required this.shortfallMinutes,
  });

  factory LiveBilling.fromJson(Map<String, dynamic> json) {
    int intOf(Object? raw) => (raw is num) ? raw.toInt() : 0;
    return LiveBilling(
      settledMinutes: intOf(json['settledMinutes']),
      drawnFromBalance: intOf(json['drawnFromBalance']),
      drawnFromQuota: intOf(json['drawnFromQuota']),
      shortfallMinutes: intOf(json['shortfallMinutes']),
    );
  }

  /// 结算到的整分钟数（不足 1 分钟 = 0，不产生任何扣减）
  final int settledMinutes;

  /// 本次从「时长余额」抵扣的分钟数
  final int drawnFromBalance;

  /// 本次从「当月免费直播分钟」抵扣的分钟数
  final int drawnFromQuota;

  /// 余额与免费分钟都尽后的缺额分钟数（>0 = 欠费式结算，系统已记录）
  final int shortfallMinutes;

  /// 结束弹层用结算文案：不足 1 分钟给出「未计费」提示；有结算时逐项列出
  /// 抵扣与缺额（无缺额不展示缺额行）。
  String get summaryText {
    if (settledMinutes <= 0) {
      return '本场直播不足 1 分钟，未产生时长扣费';
    }
    final lines = <String>['本场按直播分钟计费，共结算 $settledMinutes 分钟'];
    if (drawnFromBalance > 0) {
      lines.add('· 时长余额抵扣 $drawnFromBalance 分钟');
    }
    if (drawnFromQuota > 0) {
      lines.add('· 免费直播时长抵扣 $drawnFromQuota 分钟');
    }
    if (shortfallMinutes > 0) {
      lines.add('· 可用时长不足 $shortfallMinutes 分钟，系统已记录待对账');
    }
    return lines.join('\n');
  }
}

/// 结束直播响应：POST /api/lives/:id/end 返回 live + 可选 billing。
/// 客户端只在结束成功后读取一次做展示，不参与计费计算。
class LiveEndSummary {
  const LiveEndSummary({required this.live, this.billing});

  factory LiveEndSummary.fromJson(Map<String, dynamic> json) {
    final liveJson = json['live'];
    final billingJson = json['billing'];
    return LiveEndSummary(
      live: Live.fromJson(
        liveJson is Map ? Map<String, dynamic>.from(liveJson) : json,
      ),
      billing: billingJson is Map
          ? LiveBilling.fromJson(Map<String, dynamic>.from(billingJson))
          : null,
    );
  }

  /// 结束后的最新开播配置（status = ended）
  final Live live;

  /// 按分钟结算摘要；结算未启用 / 服务端降级时为 null
  final LiveBilling? billing;
}
