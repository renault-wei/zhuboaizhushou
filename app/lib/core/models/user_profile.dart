/// 登录用户公开信息（字段与服务端返回保持一致）。
class UserProfile {
  const UserProfile({required this.id, required this.phone, this.createdAt});

  factory UserProfile.fromJson(Map<String, dynamic> json) {
    return UserProfile(
      id: json['id']?.toString() ?? '',
      phone: json['phone']?.toString() ?? '',
      createdAt: json['createdAt']?.toString(),
    );
  }

  final String id;
  final String phone;

  /// 用户创建时间（注册时间，服务端下发）
  final String? createdAt;

  Map<String, dynamic> toJson() {
    return {'id': id, 'phone': phone, 'createdAt': createdAt};
  }
}
