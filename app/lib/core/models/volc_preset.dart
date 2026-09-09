/// 火山预设音色目录条目：对应 GET /api/voices/presets 返回数组的元素。
/// 只读内置目录（不调火山接口），与「我的音色」（克隆）并列成为两种音色来源；
/// live 上以 volcPresetId 存 id，与 voiceId（克隆音色）互斥，二选一。
class VolcPresetVoice {
  const VolcPresetVoice({
    required this.id,
    required this.name,
    required this.gender,
  });

  factory VolcPresetVoice.fromJson(Map<String, dynamic> json) {
    return VolcPresetVoice(
      id: json['id']?.toString() ?? '',
      name: json['name']?.toString() ?? '',
      gender: json['gender']?.toString() ?? '',
    );
  }

  /// 火山发音人 ID（TTS speaker 参数，亦为落库外键值）
  final String id;

  /// 客户端展示名（如 Vivi 2.0 / 云舟 2.0）
  final String name;

  /// 音色分组：female 女声 / male 男声
  final String gender;

  bool get isFemale => gender == 'female';
}
