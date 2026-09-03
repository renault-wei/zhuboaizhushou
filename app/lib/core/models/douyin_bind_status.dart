/// 抖音账号绑定状态（字段与服务端 /api/douyin/bind-status 保持一致）。
class DouyinBindStatus {
  const DouyinBindStatus({
    required this.bound,
    this.openId,
    this.nickname,
    this.avatarUrl,
    this.boundAt,
  });

  factory DouyinBindStatus.fromJson(Map<String, dynamic> json) {
    return DouyinBindStatus(
      bound: json['bound'] == true,
      openId: json['openId']?.toString(),
      nickname: json['nickname']?.toString(),
      avatarUrl: json['avatarUrl']?.toString(),
      boundAt: json['boundAt']?.toString(),
    );
  }

  /// 是否已绑定抖音号
  final bool bound;

  /// 抖音 open_id（已绑定时返回）
  final String? openId;

  /// 抖音昵称（已绑定时返回）
  final String? nickname;

  /// 抖音头像地址（已绑定时返回）
  final String? avatarUrl;

  /// 绑定时间（ISO8601，已绑定时返回）
  final String? boundAt;
}
