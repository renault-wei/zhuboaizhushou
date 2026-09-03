import 'dart:convert';

import 'package:shared_preferences/shared_preferences.dart';

import 'package:starvoice_app/core/models/user_profile.dart';

/// 本地缓存的完整会话。
class StoredSession {
  const StoredSession({required this.token, this.user, this.loginAt});

  final String token;
  final UserProfile? user;
  final DateTime? loginAt;
}

/// 基于 SharedPreferences 的会话存储：token + 用户信息 + 登录时间。
class SessionStorage {
  static const String _tokenKey = 'auth_token';
  static const String _userKey = 'auth_user';
  static const String _loginAtKey = 'auth_login_at';

  Future<SharedPreferences> get _prefs => SharedPreferences.getInstance();

  /// 读取 token（供 dio 拦截器附带 Authorization 头）。
  Future<String?> readToken() async {
    final prefs = await _prefs;
    final token = prefs.getString(_tokenKey);
    return (token == null || token.isEmpty) ? null : token;
  }

  /// 读取完整会话；无 token 时返回 null。
  Future<StoredSession?> read() async {
    final token = await readToken();
    if (token == null) {
      return null;
    }

    final prefs = await _prefs;
    UserProfile? user;
    final userRaw = prefs.getString(_userKey);
    if (userRaw != null && userRaw.isNotEmpty) {
      try {
        user = UserProfile.fromJson(
          Map<String, dynamic>.from(jsonDecode(userRaw) as Map),
        );
      } catch (_) {
        // 缓存损坏时忽略，仅保留 token
        user = null;
      }
    }

    final loginAtMillis = prefs.getInt(_loginAtKey);
    return StoredSession(
      token: token,
      user: user,
      loginAt: loginAtMillis == null
          ? null
          : DateTime.fromMillisecondsSinceEpoch(loginAtMillis),
    );
  }

  /// 登录成功后落盘 token、user 与登录时间。
  Future<void> save({
    required String token,
    required UserProfile user,
    required DateTime loginAt,
  }) async {
    final prefs = await _prefs;
    await prefs.setString(_tokenKey, token);
    await prefs.setString(_userKey, jsonEncode(user.toJson()));
    await prefs.setInt(_loginAtKey, loginAt.millisecondsSinceEpoch);
  }

  /// 退出登录 / 收到 401 时清理本地会话。
  Future<void> clear() async {
    final prefs = await _prefs;
    await prefs.remove(_tokenKey);
    await prefs.remove(_userKey);
    await prefs.remove(_loginAtKey);
  }
}
