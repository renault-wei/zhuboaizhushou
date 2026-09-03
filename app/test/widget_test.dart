import 'dart:convert';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:starvoice_app/app.dart';
import 'package:starvoice_app/providers.dart';

/// 构建使用内存假后端的 dio，测试全程不发起真实网络请求。
Dio _buildMockDio() {
  final dio = Dio(BaseOptions(baseUrl: 'http://localhost:3000'));
  dio.httpClientAdapter = _FakeAuthAdapter();
  return dio;
}

/// 内存版假后端：覆盖登录相关三个接口，响应形状与服务端保持一致。
class _FakeAuthAdapter implements HttpClientAdapter {
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
      final body = _readBody(options);
      final phone = body['phone'];
      return _jsonResponse({
        'token': 'mock-jwt-token',
        'tokenType': 'Bearer',
        'expiresInSeconds': 604800,
        'user': {
          'id': 'user-001',
          'phone': phone,
          'createdAt': '2026-09-04T10:00:00.000Z',
        },
      });
    }
    if (options.method == 'GET' && path.endsWith('/api/auth/me')) {
      return _jsonResponse({
        'user': {
          'id': 'user-001',
          'phone': '13800138000',
          'createdAt': '2026-09-04T10:00:00.000Z',
        },
      });
    }
    return _jsonResponse({'error': 'NOT_FOUND', 'message': '接口不存在'}, 404);
  }

  @override
  void close({bool force = false}) {}
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

void main() {
  testWidgets('登录页冒烟：获取验证码自动填码并登录成功进首页', (WidgetTester tester) async {
    SharedPreferences.setMockInitialValues({});

    await tester.pumpWidget(
      ProviderScope(
        overrides: [dioProvider.overrideWithValue(_buildMockDio())],
        child: const StarVoiceApp(),
      ),
    );

    // 等待启动会话恢复完成：无本地 token 应落在登录页
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('phoneField')), findsOneWidget);

    // 输入手机号并获取验证码
    await tester.enterText(find.byKey(const Key('phoneField')), '13800138000');
    await tester.tap(find.byKey(const Key('sendCodeButton')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 100));

    // dev 模式：send-code 响应携带 code，应自动填入并展示灰色提示
    expect(find.text('开发模式：验证码已自动填入'), findsOneWidget);
    final codeField =
        tester.widget<TextField>(find.byKey(const Key('codeField')));
    expect(codeField.controller?.text, '123456');
    // 60 秒倒计时已启动，按钮进入倒计时禁用态
    expect(find.textContaining('重新获取('), findsOneWidget);

    // 点击登录：mock 后端返回 token/user，应自动跳转首页
    await tester.tap(find.byKey(const Key('loginButton')));
    await tester.pumpAndSettle();

    expect(find.textContaining('138****8000'), findsOneWidget);
    expect(find.textContaining('user-001'), findsOneWidget);
    expect(find.byKey(const Key('logoutButton')), findsOneWidget);
  });
}
