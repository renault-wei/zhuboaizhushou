/// 话术数据模型：字段与服务端 /api/scripts 系列接口保持一致。
/// status 取值：draft（草稿）/ ready（可开播）/ blocked（敏感词拦截）。
class Script {
  const Script({
    required this.id,
    required this.industry,
    required this.title,
    required this.content,
    required this.status,
    required this.sensitiveCheckStatus,
    required this.sensitiveMatchedWords,
    required this.createdAt,
    this.generationNote,
  });

  factory Script.fromJson(Map<String, dynamic> json) {
    final rawMatchedWords = json['sensitiveMatchedWords'];
    final matchedWords = rawMatchedWords is List
        ? rawMatchedWords
              .map((item) => item?.toString() ?? '')
              .where((word) => word.isNotEmpty)
              .toList()
        : <String>[];
    final rawStatus = json['status']?.toString() ?? '';
    return Script(
      id: json['id']?.toString() ?? '',
      industry: json['industry']?.toString() ?? '',
      title: json['title']?.toString(),
      content: json['content']?.toString() ?? '',
      status: rawStatus.isEmpty ? 'draft' : rawStatus,
      sensitiveCheckStatus: json['sensitiveCheckStatus']?.toString(),
      sensitiveMatchedWords: matchedWords,
      createdAt: json['createdAt']?.toString() ?? '',
      generationNote: json['generationNote']?.toString(),
    );
  }

  final String id;

  /// 行业 code：restaurant / local_service / retail
  final String industry;

  /// 话术标题，允许为空（服务端 title 列可空）
  final String? title;
  final String content;
  final String status;

  /// 敏感词扫描结果：pass / blocked
  final String? sensitiveCheckStatus;

  /// 命中的拦截级敏感词（去重）
  final List<String> sensitiveMatchedWords;

  /// 创建时间（ISO8601 字符串）
  final String createdAt;

  /// 生成时的一次性说明（仅生成接口返回：自动改写/安全模板兜底时透传，不入库、刷新后为空）
  final String? generationNote;

  /// 展示用标题：未填时回退为「未命名话术」
  String get displayTitle {
    final raw = title;
    if (raw == null || raw.trim().isEmpty) {
      return '未命名话术';
    }
    return raw;
  }

  bool get isDraft => status == 'draft';
  bool get isReady => status == 'ready';
  bool get isBlocked => status == 'blocked';
}
