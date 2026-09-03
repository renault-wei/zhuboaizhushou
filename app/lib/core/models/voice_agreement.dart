/// 声音授权协议正文（字段与服务端 GET /api/agreements/voice 保持一致）。
class VoiceAgreement {
  const VoiceAgreement({
    required this.version,
    required this.title,
    required this.content,
  });

  factory VoiceAgreement.fromJson(Map<String, dynamic> json) {
    return VoiceAgreement(
      version: json['version']?.toString() ?? '',
      title: json['title']?.toString() ?? '',
      content: json['content']?.toString() ?? '',
    );
  }

  /// 协议版本，如 1.0
  final String version;

  /// 协议标题，如《声音授权协议》
  final String title;

  /// 协议正文全文
  final String content;
}

/// 声音授权协议签署状态（服务端 /status 与 /sign 返回同构结构）。
class AgreementStatus {
  const AgreementStatus({
    required this.signed,
    this.signedAt,
    this.version,
  });

  factory AgreementStatus.fromJson(Map<String, dynamic> json) {
    return AgreementStatus(
      signed: json['signed'] == true,
      signedAt: json['signedAt']?.toString(),
      version: json['version']?.toString(),
    );
  }

  /// 是否已签署（同版本重复签署幂等）
  final bool signed;

  /// 签署时间（ISO8601，已签署时返回）
  final String? signedAt;

  /// 已签署的协议版本
  final String? version;
}
