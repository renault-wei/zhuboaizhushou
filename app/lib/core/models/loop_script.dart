/// 循环台本数据模型：字段与服务端 /api/loop-scripts 系列接口保持一致。
///
/// 循环台本 = 可复用台本库（标题 + 有序短台词）；开播配置（Live）通过
/// loopScriptId 引用台本，开播时服务端读取一次快照（库改动不影响进行中场次）。
library;

/// 台本条目录：有序短台词。
/// 生成草稿（generate，不落库）返回的条目没有服务端 id/seq，此时 [id] 为空串、
/// [seq] 为空；持久化条目（详情/新建/整体替换返回）均带 id 与 seq。
class LoopScriptItem {
  const LoopScriptItem({
    this.id = '',
    this.seq,
    this.kind,
    required this.text,
    this.gapAfterSeconds,
  });

  factory LoopScriptItem.fromJson(Map<String, dynamic> json) {
    return LoopScriptItem(
      id: json['id']?.toString() ?? '',
      seq: (json['seq'] as num?)?.toInt(),
      kind: _nullableString(json['kind']),
      text: json['text']?.toString() ?? '',
      gapAfterSeconds: (json['gapAfterSeconds'] as num?)?.toInt(),
    );
  }

  /// 条目 id（草稿条目为空串）
  final String id;

  /// 1 起递增的顺序号（仅持久化条目有；草稿条目为空）
  final int? seq;

  /// 台词类型：opening / product / coupon / warmup / closing / custom；
  /// 未知类型服务端归一为 null（客户端宽松接受字符串，不阻塞展示）。
  final String? kind;

  /// 台词正文（trim 后 1-200 字）
  final String text;

  /// 本条播完后的间隔秒（0-60）；null = 用全局默认 2 秒
  final int? gapAfterSeconds;

  /// 提交给新建 / 整体替换接口的条目载荷：
  /// kind / gapAfterSeconds 缺省时不下发，服务端按 null（默认 2 秒间隔）处理。
  Map<String, dynamic> toPayload() {
    final kind = this.kind;
    final gap = gapAfterSeconds;
    return <String, dynamic>{
      'text': text,
      'kind': ?kind,
      'gapAfterSeconds': ?gap,
    };
  }
}

/// 循环台本：标题 + 有序条目。
/// 列表接口返回摘要（无 items，itemCount 为服务端统计的条数）；
/// 详情 / 新建 / 整体替换返回整本（items 非空，此时以 items.length 为准）。
class LoopScript {
  const LoopScript({
    required this.id,
    required this.title,
    required this.itemCount,
    required this.createdAt,
    required this.updatedAt,
    this.sourceScriptId,
    this.items = const <LoopScriptItem>[],
  });

  factory LoopScript.fromJson(Map<String, dynamic> json) {
    final rawItems = json['items'];
    final items = <LoopScriptItem>[];
    if (rawItems is List) {
      for (final raw in rawItems) {
        if (raw is Map) {
          items.add(LoopScriptItem.fromJson(Map<String, dynamic>.from(raw)));
        }
      }
    }
    final count = (json['itemCount'] as num?)?.toInt() ?? 0;
    return LoopScript(
      id: json['id']?.toString() ?? '',
      title: json['title']?.toString() ?? '',
      // 详情返回整本时以实际条目数为准（服务端列表才带 itemCount 摘要）
      itemCount: items.isNotEmpty ? items.length : count,
      sourceScriptId: _nullableString(json['sourceScriptId']),
      createdAt: json['createdAt']?.toString() ?? '',
      updatedAt: json['updatedAt']?.toString() ?? '',
      items: items,
    );
  }

  final String id;

  /// 台本标题（必填，1-100 字）
  final String title;

  /// 条数摘要（列表接口）；详情返回整本时以 items.length 为准
  final int itemCount;

  /// 生成来源话术 id（可选，保留溯源；删除话术不影响台本快照）
  final String? sourceScriptId;

  /// 创建时间（ISO8601 字符串）
  final String createdAt;

  /// 最近更新时间（ISO8601 字符串）
  final String updatedAt;

  /// 台本条目（seq 升序；列表摘要为空列表）
  final List<LoopScriptItem> items;

  /// 是否空标题（异常数据兜底展示用）
  bool get hasEmptyTitle => title.trim().isEmpty;
}

/// 示例循环台本（谈单演示用，G7）：服务端内置只读预设，不落库、不算用户数据。
/// 客户端「套用示例」把 [items] 带入新建台本编辑器（条目同草稿：无 id/seq），
/// 保存仍走 /api/loop-scripts 落库链路，合规红线不变。
class LoopScriptSample {
  const LoopScriptSample({
    required this.sampleId,
    required this.title,
    this.subtitle = '',
    this.items = const <LoopScriptItem>[],
  });

  factory LoopScriptSample.fromJson(Map<String, dynamic> json) {
    final rawItems = json['items'];
    final items = <LoopScriptItem>[];
    if (rawItems is List) {
      for (final raw in rawItems) {
        if (raw is Map) {
          items.add(LoopScriptItem.fromJson(Map<String, dynamic>.from(raw)));
        }
      }
    }
    return LoopScriptSample(
      sampleId: json['sampleId']?.toString() ?? '',
      title: json['title']?.toString() ?? '',
      subtitle: json['subtitle']?.toString() ?? '',
      items: items,
    );
  }

  /// 稳定示例 id（服务端内置，客户端套用预填用）
  final String sampleId;

  /// 示例标题（套用后作为草稿标题，可再改）
  final String title;

  /// 一句话场景说明（台本库示例区选择用）
  final String subtitle;

  /// 整本条目（顺序即播放顺序；套用后进入编辑器可增删改）
  final List<LoopScriptItem> items;

  /// 示例是否可用：无 id / 空标题 / 空条目均为异常数据，不可套用
  bool get isUsable =>
      sampleId.isNotEmpty && title.trim().isNotEmpty && items.isNotEmpty;
}

/// 生成台本草稿（M2 generate 不落库）：返回条目供「预览后保存」，
/// 与一次性说明（自动改写时透传，不入库、刷新后为空）。
class LoopScriptDraft {
  const LoopScriptDraft({required this.items, this.generationNote});

  factory LoopScriptDraft.fromJson(Map<String, dynamic> json) {
    final rawItems = json['items'];
    final items = <LoopScriptItem>[];
    if (rawItems is List) {
      for (final raw in rawItems) {
        if (raw is Map) {
          items.add(LoopScriptItem.fromJson(Map<String, dynamic>.from(raw)));
        }
      }
    }
    return LoopScriptDraft(
      items: items,
      generationNote: _nullableString(json['generationNote']),
    );
  }

  final List<LoopScriptItem> items;

  /// 生成时的一次性说明（仅生成接口返回：自动改写时透传，不入库）
  final String? generationNote;
}

/// JSON 里的可空字段：null / 空串统一归一为 null。
String? _nullableString(Object? raw) {
  final value = raw?.toString() ?? '';
  return value.isEmpty ? null : value;
}
