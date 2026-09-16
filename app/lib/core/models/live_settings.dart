/// 账号级直播设置（R21）：智能回复 / 自定义违禁词 / 语速默认档。
///
/// 为什么是账号级（用户 2026-09-17 拍板）：一个商家一套直播习惯，不该每开一场重配一次。
/// 竞品是每次开播把 thisset 带上去，我们反过来把它沉淀在账号上。
class LiveSettings {
  const LiveSettings({
    required this.replyEnabled,
    required this.replyIntervalSeconds,
    this.replyExtraKnowledge,
    this.bannedWords,
    this.defaultSpeechRate,
  });

  factory LiveSettings.fromJson(Map<String, dynamic> json) {
    return LiveSettings(
      replyEnabled: json['replyEnabled'] == true,
      replyIntervalSeconds: (json['replyIntervalSeconds'] as num?)?.toInt() ?? 5,
      replyExtraKnowledge: json['replyExtraKnowledge']?.toString(),
      bannedWords: json['bannedWords']?.toString(),
      defaultSpeechRate: (json['defaultSpeechRate'] as num?)?.toInt(),
    );
  }

  /// 智能回复总开关；false = 一条都不生成（服务端连 AI 都不调）
  final bool replyEnabled;

  /// 最小回复间隔（秒）：1~60
  final int replyIntervalSeconds;

  /// 补充知识：拼在**绑定话术之后**（绑定话术优先，补充知识只作更正补充）
  final String? replyExtraKnowledge;

  /// 商家自定义违禁词：中文顿号分隔；**单字符词服务端会忽略**
  final String? bannedWords;

  /// 账号级语速默认档（火山 speech_rate 口径 -20~60）；null = 用服务端默认档
  final int? defaultSpeechRate;

  /// 提交给 PATCH 的载荷（只带要改的字段）
  Map<String, dynamic> toPatch() {
    return <String, dynamic>{
      'replyEnabled': replyEnabled,
      'replyIntervalSeconds': replyIntervalSeconds,
      'replyExtraKnowledge': replyExtraKnowledge,
      'bannedWords': bannedWords,
      'defaultSpeechRate': defaultSpeechRate,
    };
  }

  LiveSettings copyWith({
    bool? replyEnabled,
    int? replyIntervalSeconds,
    String? replyExtraKnowledge,
    String? bannedWords,
    int? defaultSpeechRate,
    bool clearSpeechRate = false,
  }) {
    return LiveSettings(
      replyEnabled: replyEnabled ?? this.replyEnabled,
      replyIntervalSeconds: replyIntervalSeconds ?? this.replyIntervalSeconds,
      replyExtraKnowledge: replyExtraKnowledge ?? this.replyExtraKnowledge,
      bannedWords: bannedWords ?? this.bannedWords,
      defaultSpeechRate: clearSpeechRate ? null : (defaultSpeechRate ?? this.defaultSpeechRate),
    );
  }
}

/// 服务端下发的上下限（避免前端硬编码，与后端校验永远一致）
class LiveSettingsLimits {
  const LiveSettingsLimits({
    required this.replyIntervalMin,
    required this.replyIntervalMax,
    required this.autoEndMinMinutes,
    required this.autoEndMaxMinutes,
    required this.speechRateMin,
    required this.speechRateMax,
    required this.maxTextLength,
  });

  factory LiveSettingsLimits.fromJson(Map<String, dynamic> json) {
    Map<String, dynamic> section(String key) {
      final raw = json[key];
      return raw is Map ? Map<String, dynamic>.from(raw) : <String, dynamic>{};
    }

    final reply = section('replyIntervalSeconds');
    final autoEnd = section('autoEndMinutes');
    final rate = section('defaultSpeechRate');
    return LiveSettingsLimits(
      replyIntervalMin: (reply['min'] as num?)?.toInt() ?? 1,
      replyIntervalMax: (reply['max'] as num?)?.toInt() ?? 60,
      autoEndMinMinutes: (autoEnd['min'] as num?)?.toInt() ?? 10,
      autoEndMaxMinutes: (autoEnd['max'] as num?)?.toInt() ?? 1440,
      speechRateMin: (rate['min'] as num?)?.toInt() ?? -20,
      speechRateMax: (rate['max'] as num?)?.toInt() ?? 60,
      maxTextLength: (json['maxTextLength'] as num?)?.toInt() ?? 2000,
    );
  }

  final int replyIntervalMin;
  final int replyIntervalMax;
  final int autoEndMinMinutes;
  final int autoEndMaxMinutes;
  final int speechRateMin;
  final int speechRateMax;
  final int maxTextLength;
}
