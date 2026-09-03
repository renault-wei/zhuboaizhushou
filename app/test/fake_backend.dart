import 'dart:convert';
import 'dart:typed_data';

import 'package:dio/dio.dart';

/// 内存版假后端：覆盖登录相关三个接口与抖音绑定三个接口，
/// 测试全程不发起真实网络请求，响应形状与服务端保持一致。
class FakeBackend implements HttpClientAdapter {
  FakeBackend({
    this.userId = 'user-001',
    this.phone = '13800138000',
    this.douyinBound = false,
    this.douyinNickname = '抖音小店测试号',
    this.avatarUrl = '',
  });

  final String userId;
  final String phone;

  /// 是否已绑定抖音号：GET bind-status 返回当前值，绑定/解绑接口会改写
  bool douyinBound;
  final String douyinNickname;
  final String avatarUrl;

  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<void>? cancelFuture,
  ) async {
    final path = options.path;
    if (options.method == 'POST' && path.endsWith('/api/auth/send-code')) {
      return _jsonResponse({
        'message': '验证码已发送',
        'requestId': 'req-mock-001',
        'resendAfterSeconds': 60,
        'expiresInSeconds': 300,
        'code': '123456',
      });
    }
    if (options.method == 'POST' && path.endsWith('/api/auth/verify-code')) {
      return _jsonResponse({
        'token': 'mock-jwt-token',
        'tokenType': 'Bearer',
        'expiresInSeconds': 604800,
        'user': {'id': userId, 'phone': phone},
      });
    }
    if (options.method == 'GET' && path.endsWith('/api/auth/me')) {
      return _jsonResponse({
        'user': {'id': userId, 'phone': phone},
      });
    }
    if (options.method == 'GET' && path.endsWith('/api/douyin/bind-status')) {
      return _jsonResponse(_douyinBindStatus());
    }
    if (options.method == 'POST' && path.endsWith('/api/douyin/bind')) {
      final body = _readBody(options);
      final code = body['code'];
      if (code is! String || !code.startsWith('mock-')) {
        return _jsonResponse({'error': 'CODE_INVALID', 'message': '授权码无效或已过期，请重新授权'}, 400);
      }
      douyinBound = true;
      return _jsonResponse(_douyinBindStatus());
    }
    if (options.method == 'POST' && path.endsWith('/api/douyin/unbind')) {
      douyinBound = false;
      return _jsonResponse({'bound': false});
    }
    return _jsonResponse({'error': 'NOT_FOUND', 'message': '接口不存在'}, 404);
  }

  Map<String, dynamic> _douyinBindStatus() {
    if (!douyinBound) {
      return {'bound': false};
    }
    return {
      'bound': true,
      'openId': 'mock-openid-test0001',
      'nickname': douyinNickname,
      'avatarUrl': avatarUrl,
      'boundAt': '2026-09-04T10:00:00.000Z',
    };
  }

  @override
  void close({bool force = false}) {}
}

/// 基于 [backend] 构建挂载假后端的 dio。
Dio buildMockDio(FakeBackend backend) {
  final dio = Dio(BaseOptions(baseUrl: 'http://localhost:3000'));
  dio.httpClientAdapter = backend;
  return dio;
}

/// 读取请求体：dio 可能已把 Map 序列化成 JSON 字符串，需兼容 Map 与 String 两种形态。
Map<String, dynamic> _readBody(RequestOptions options) {
  final data = options.data;
  if (data is Map) {
    return Map<String, dynamic>.from(data);
  }
  if (data is String && data.isNotEmpty) {
    return Map<String, dynamic>.from(jsonDecode(data) as Map);
  }
  return <String, dynamic>{};
}

ResponseBody _jsonResponse(Map<String, dynamic> body, [int statusCode = 200]) {
  return ResponseBody.fromString(
    jsonEncode(body),
    statusCode,
    headers: {
      Headers.contentTypeHeader: ['application/json; charset=utf-8'],
    },
  );
}
