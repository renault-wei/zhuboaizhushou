import 'package:dio/dio.dart';

import 'package:starvoice_app/core/storage/session_storage.dart';

/// dio 拦截器：
/// - 请求发出前自动附带本地 token（Authorization: `Bearer <token>`）
/// - 收到 401 时清除本地会话并通知认证层跳转登录页
class AuthInterceptor extends Interceptor {
  AuthInterceptor({required this.storage, required this.onUnauthorized});

  final SessionStorage storage;

  /// 401 回调，由认证层负责清 token / 更新状态触发路由跳转
  final Future<void> Function() onUnauthorized;

  @override
  Future<void> onRequest(
    RequestOptions options,
    RequestInterceptorHandler handler,
  ) async {
    final token = await storage.readToken();
    if (token != null) {
      options.headers['Authorization'] = 'Bearer $token';
    }
    handler.next(options);
  }

  @override
  Future<void> onError(DioException err, ErrorInterceptorHandler handler) async {
    if (err.response?.statusCode == 401) {
      await onUnauthorized();
    }
    handler.next(err);
  }
}
