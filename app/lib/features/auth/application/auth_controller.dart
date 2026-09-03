import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'package:starvoice_app/core/models/user_profile.dart';
import 'package:starvoice_app/core/network/api_client.dart';
import 'package:starvoice_app/core/network/api_exception.dart';
import 'package:starvoice_app/core/storage/session_storage.dart';

/// 登录状态：restoring 启动恢复中；unauthenticated 未登录；authenticated 已登录。
enum AuthStatus { restoring, unauthenticated, authenticated }

/// 认证状态快照（不可变）。
class AuthState {
  const AuthState({
    required this.status,
    this.user,
    this.token,
    this.loginAt,
  });

  final AuthStatus status;
  final UserProfile? user;
  final String? token;

  /// 本地记录的登录成功时间
  final DateTime? loginAt;

  bool get isAuthenticated => status == AuthStatus.authenticated;
}

/// 认证控制器：负责会话恢复、验证码登录与退出登录。
class AuthController extends StateNotifier<AuthState> {
  AuthController(this._storage, this._apiClient)
      : super(const AuthState(status: AuthStatus.restoring));

  final SessionStorage _storage;
  final ApiClient _apiClient;
  bool _initStarted = false;

  /// 当前认证状态（供路由守卫读取）。
  AuthState get currentState => state;

  /// 冷启动恢复会话：
  /// 有本地 token 先调 /api/auth/me 校验，成功进首页；401 清 token 回登录页。
  Future<void> init() async {
    if (_initStarted) {
      return;
    }
    _initStarted = true;

    final session = await _storage.read();
    if (session == null) {
      state = const AuthState(status: AuthStatus.unauthenticated);
      return;
    }

    try {
      final user = await _apiClient.fetchCurrentUser();
      state = AuthState(
        status: AuthStatus.authenticated,
        user: user,
        token: session.token,
        loginAt: session.loginAt ?? DateTime.now(),
      );
    } on ApiException catch (error) {
      if (error.isUnauthorized) {
        await _storage.clear();
        state = const AuthState(status: AuthStatus.unauthenticated);
      } else if (session.user != null) {
        // 非 401（如后端暂不可达）：先用本地缓存进入首页，避免误踢已登录用户
        state = AuthState(
          status: AuthStatus.authenticated,
          user: session.user,
          token: session.token,
          loginAt: session.loginAt ?? DateTime.now(),
        );
      } else {
        await _storage.clear();
        state = const AuthState(status: AuthStatus.unauthenticated);
      }
    } catch (_) {
      // 解析等未知异常兜底：按未登录处理
      await _storage.clear();
      state = const AuthState(status: AuthStatus.unauthenticated);
    }
  }

  /// 发送验证码；返回结果供登录页处理 dev 模式自动填码与倒计时。
  Future<SendCodeResult> sendCode(String phone) {
    return _apiClient.sendCode(phone);
  }

  /// 校验验证码登录：成功后保存 token 与 user，由路由守卫跳转首页。
  Future<void> loginWithCode({required String phone, required String code}) async {
    final result = await _apiClient.verifyCode(phone, code);
    final now = DateTime.now();
    await _storage.save(token: result.token, user: result.user, loginAt: now);
    state = AuthState(
      status: AuthStatus.authenticated,
      user: result.user,
      token: result.token,
      loginAt: now,
    );
  }

  /// 退出登录：清除本地会话，路由跳回登录页。
  Future<void> logout() async {
    await _storage.clear();
    state = const AuthState(status: AuthStatus.unauthenticated);
  }

  /// dio 拦截器收到 401 时回调：清 token 并回到登录页。
  Future<void> handleUnauthorized() async {
    await _storage.clear();
    if (state.status != AuthStatus.unauthenticated) {
      state = const AuthState(status: AuthStatus.unauthenticated);
    }
  }
}
