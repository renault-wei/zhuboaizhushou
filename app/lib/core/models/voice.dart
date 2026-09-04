/// 声音克隆任务（音色）数据模型：字段与服务端 /api/voices 系列接口保持一致。
class Voice {
  const Voice({
    required this.id,
    required this.name,
    required this.status,
    required this.providerVoiceId,
    required this.sampleDurationSeconds,
    required this.createdAt,
  });

  factory Voice.fromJson(Map<String, dynamic> json) {
    return Voice(
      id: json['id']?.toString() ?? '',
      name: json['name']?.toString() ?? '',
      status: json['status']?.toString() ?? '',
      providerVoiceId: json['providerVoiceId']?.toString() ?? '',
      sampleDurationSeconds: (json['sampleDurationSeconds'] as num?)?.toInt() ?? 0,
      createdAt: json['createdAt']?.toString() ?? '',
    );
  }

  final String id;
  final String name;

  /// 克隆状态：pending / processing / ready / failed
  final String status;

  /// CosyVoice 返回的 voice_id
  final String providerVoiceId;

  /// 录音样本时长（秒）
  final int sampleDurationSeconds;

  /// 创建时间（ISO8601 字符串）
  final String createdAt;

  bool get isPending => status == 'pending';
  bool get isProcessing => status == 'processing';
  bool get isReady => status == 'ready';
  bool get isFailed => status == 'failed';

  /// 是否已完成克隆（ready/failed 均为终态，不再推进）
  bool get isTerminal => isReady || isFailed;

  /// 是否仍在克隆中（pending/processing 需要轮询推进）
  bool get isCloning => isPending || isProcessing;
}
