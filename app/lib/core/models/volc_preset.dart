/// 火山预设音色目录条目：对应 GET /api/voices/presets 返回 presets 数组的元素。
/// 只读内置目录（不调火山接口），与「我的音色」（克隆）并列成为两种音色来源；
/// live 上以 volcPresetId 存 id，与 voiceId（克隆音色）互斥，二选一。
class VolcPresetVoice {
  const VolcPresetVoice({
    required this.id,
    required this.name,
    required this.gender,
    this.group = '',
    this.recommended = false,
    this.previewUrl,
  });

  factory VolcPresetVoice.fromJson(Map<String, dynamic> json) {
    return VolcPresetVoice(
      id: json['id']?.toString() ?? '',
      name: json['name']?.toString() ?? '',
      gender: json['gender']?.toString() ?? '',
      group: json['group']?.toString() ?? '',
      recommended: json['recommended'] == true,
      previewUrl: json['previewUrl']?.toString(),
    );
  }

  /// 序列化：本机音色缓存落盘用（服务端为准，本地仅作失败回落）
  Map<String, dynamic> toJson() {
    return <String, dynamic>{
      'id': id,
      'name': name,
      'gender': gender,
      'group': group,
      'recommended': recommended,
      'previewUrl': previewUrl,
    };
  }

  /// 火山发音人 ID（TTS speaker 参数，亦为落库外键值）
  final String id;

  /// 客户端展示名（如 Vivi 2.0 / 云舟 2.0）
  final String name;

  /// 性别：female 女声 / male 男声
  final String gender;

  /// 所属分组 id（对应 [VolcPresetGroup.id]；旧服务端未下发时为空串）
  final String group;

  /// 是否推荐：组内置顶并标「推荐」
  final bool recommended;

  /// 试听音频相对路径（方案 A：服务端预生成的静态 wav，如 /uploads/voice-previews/xxx.wav）；
  /// 为空 = 该音色尚未预生成，App 回落 POST /api/voices/preview 真合成兜底。
  final String? previewUrl;

  bool get isFemale => gender == 'female';
}

/// 音色分组元数据：服务端下发分组顺序，客户端按此顺序分组展示。
class VolcPresetGroup {
  const VolcPresetGroup({required this.id, required this.label});

  factory VolcPresetGroup.fromJson(Map<String, dynamic> json) {
    return VolcPresetGroup(
      id: json['id']?.toString() ?? '',
      label: json['label']?.toString() ?? '',
    );
  }

  Map<String, dynamic> toJson() {
    return <String, dynamic>{'id': id, 'label': label};
  }

  final String id;
  final String label;
}

/// 分组后的预设音色：分组标题 + 组内音色（推荐已置顶）。
class PresetVoiceGroup {
  const PresetVoiceGroup({
    required this.id,
    required this.label,
    required this.voices,
  });

  final String id;
  final String label;
  final List<VolcPresetVoice> voices;
}

/// 按服务端分组顺序分组：未在 [groups] 中登记的分组按出现顺序追加在末尾；
/// 组内推荐音色置顶（分区实现，不改动组内其余顺序）。
List<PresetVoiceGroup> groupVolcPresets(
  List<VolcPresetVoice> presets,
  List<VolcPresetGroup> groups,
) {
  final order = <String>[];
  final labels = <String, String>{};
  for (final group in groups) {
    if (!labels.containsKey(group.id)) {
      order.add(group.id);
    }
    labels[group.id] = group.label;
  }
  for (final preset in presets) {
    if (!labels.containsKey(preset.group)) {
      order.add(preset.group);
      labels[preset.group] = preset.group.isEmpty ? '其他' : preset.group;
    }
  }
  final result = <PresetVoiceGroup>[];
  for (final id in order) {
    final voices = presets.where((preset) => preset.group == id).toList();
    if (voices.isEmpty) {
      continue;
    }
    result.add(
      PresetVoiceGroup(
        id: id,
        label: labels[id] ?? id,
        voices: <VolcPresetVoice>[
          ...voices.where((preset) => preset.recommended),
          ...voices.where((preset) => !preset.recommended),
        ],
      ),
    );
  }
  return result;
}

/// 预设音色目录：presets（全部音色）+ groups（分组顺序）+ defaultPresetId（默认音色）。
class VolcPresetCatalog {
  const VolcPresetCatalog({
    required this.presets,
    required this.groups,
    required this.defaultPresetId,
    this.userDefaultPresetId,
  });

  const VolcPresetCatalog.empty()
    : presets = const <VolcPresetVoice>[],
      groups = const <VolcPresetGroup>[],
      defaultPresetId = '',
      userDefaultPresetId = null;

  factory VolcPresetCatalog.fromJson(Map<String, dynamic> json) {
    final rawPresets = json['presets'];
    final rawGroups = json['groups'];
    return VolcPresetCatalog(
      presets: rawPresets is List
          ? rawPresets
                .whereType<Map>()
                .map(
                  (item) =>
                      VolcPresetVoice.fromJson(Map<String, dynamic>.from(item)),
                )
                .toList()
          : const <VolcPresetVoice>[],
      groups: rawGroups is List
          ? rawGroups
                .whereType<Map>()
                .map(
                  (item) =>
                      VolcPresetGroup.fromJson(Map<String, dynamic>.from(item)),
                )
                .toList()
          : const <VolcPresetGroup>[],
      defaultPresetId: json['defaultPresetId']?.toString() ?? '',
      // 用户自己设过的默认音色：null = 没设过（服务端显式回 null 才算没设过）
      userDefaultPresetId: json['userDefaultPresetId']?.toString(),
    );
  }

  final List<VolcPresetVoice> presets;
  final List<VolcPresetGroup> groups;

  /// 新建场次的默认音色 id（服务端下发的「生效值」= 用户默认 ?? 全局默认；空串 = 未提供）
  final String defaultPresetId;

  /// 商家自己设定的默认音色 id（null = 没设过，音色库页据此展示「默认」标记）
  final String? userDefaultPresetId;

  /// 按分组顺序整理后的音色（音色选择面板用）
  List<PresetVoiceGroup> get groupedPresets => groupVolcPresets(presets, groups);

  /// 序列化：本机音色缓存落盘用
  Map<String, dynamic> toJson() {
    return <String, dynamic>{
      'presets': presets.map((preset) => preset.toJson()).toList(),
      'groups': groups.map((group) => group.toJson()).toList(),
      'defaultPresetId': defaultPresetId,
      'userDefaultPresetId': userDefaultPresetId,
    };
  }

  /// 目录是否为空（无任何音色）：缓存回落时用于判断是否有可用数据
  bool get isEmpty => presets.isEmpty;

  VolcPresetCatalog copyWith({
    List<VolcPresetVoice>? presets,
    List<VolcPresetGroup>? groups,
    String? defaultPresetId,
    String? userDefaultPresetId,
    bool clearUserDefault = false,
  }) {
    return VolcPresetCatalog(
      presets: presets ?? this.presets,
      groups: groups ?? this.groups,
      defaultPresetId: defaultPresetId ?? this.defaultPresetId,
      userDefaultPresetId: clearUserDefault
          ? null
          : userDefaultPresetId ?? this.userDefaultPresetId,
    );
  }
}
