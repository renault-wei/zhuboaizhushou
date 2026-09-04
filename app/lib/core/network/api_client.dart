import 'package:dio/dio.dart';

import 'package:starvoice_app/core/models/douyin_bind_status.dart';
import 'package:starvoice_app/core/models/user_profile.dart';
import 'package:starvoice_app/core/models/voice.dart';
import 'package:starvoice_app/core/models/voice_agreement.dart';
import 'package:starvoice_app/core/models/script.dart';
import 'package:starvoice_app/core/network/api_exception.dart';

/// 发送验证码的结果。dev 模式下服务端会额外返回明文 [code] 便于联调。
class SendCodeResult {
  const SendCodeResult({
    required this.requestId,
    required this.resendAfterSeconds,
    required this.expiresInSeconds,
    this.code,
  });

  factory SendCodeResult.fromJson(Map<String, dynamic> json) {
    return SendCodeResult(
      requestId: json['requestId']?.toString() ?? '',
      resendAfterSeconds: (json['resendAfterSeconds'] as num?)?.toInt() ?? 60,
      expiresInSeconds: (json['expiresInSeconds'] as num?)?.toInt() ?? 300,
      code: json['code']?.toString(),
    );
  }

  final String requestId;
  final int resendAfterSeconds;
  final int expiresInSeconds;

  /// 仅开发/测试环境返回，生产环境为空
  final String? code;
}

/// 校验验证码并登录的结果。
class VerifyCodeResult {
  const VerifyCodeResult({required this.token, required this.user});

  factory VerifyCodeResult.fromJson(Map<String, dynamic> json) {
    final userJson = json['user'];
    return VerifyCodeResult(
      token: json['token']?.toString() ?? '',
      user: UserProfile.fromJson(
        userJson is Map ? Map<String, dynamic>.from(userJson) : <String, dynamic>{},
      ),
    );
  }

  final String token;
  final UserProfile user;
}

/// 统一的 API 客户端，封装手机号验证码登录相关的三个接口。
class ApiClient {
  ApiClient(this._dio);

  final Dio _dio;

  /// 发送验证码；60 秒内重复发送会命中 SEND_TOO_FREQUENT（429）。
  Future<SendCodeResult> sendCode(String phone) async {
    try {
      final response = await _dio.post<Map<String, dynamic>>(
        '/api/auth/send-code',
        data: {'phone': phone},
      );
      return SendCodeResult.fromJson(response.data ?? <String, dynamic>{});
    } on DioException catch (error) {
      throw _toApiException(error);
    }
  }

  /// 校验验证码并登录，成功后返回 JWT 与用户信息。
  Future<VerifyCodeResult> verifyCode(String phone, String code) async {
    try {
      final response = await _dio.post<Map<String, dynamic>>(
        '/api/auth/verify-code',
        data: {'phone': phone, 'code': code},
      );
      return VerifyCodeResult.fromJson(response.data ?? <String, dynamic>{});
    } on DioException catch (error) {
      throw _toApiException(error);
    }
  }

  /// 获取当前登录用户；token 失效时服务端返回 401。
  Future<UserProfile> fetchCurrentUser() async {
    try {
      final response = await _dio.get<Map<String, dynamic>>('/api/auth/me');
      final data = response.data ?? <String, dynamic>{};
      final userJson = data['user'];
      return UserProfile.fromJson(
        userJson is Map ? Map<String, dynamic>.from(userJson) : data,
      );
    } on DioException catch (error) {
      throw _toApiException(error);
    }
  }

  /// 查询当前用户的抖音绑定状态。
  Future<DouyinBindStatus> fetchDouyinBindStatus() async {
    try {
      final response = await _dio.get<Map<String, dynamic>>('/api/douyin/bind-status');
      return DouyinBindStatus.fromJson(response.data ?? <String, dynamic>{});
    } on DioException catch (error) {
      throw _toApiException(error);
    }
  }

  /// 用抖音授权 code 绑定抖音号；错误（如已被绑定/冲突）透传服务端中文 message。
  Future<DouyinBindStatus> bindDouyin(String code) async {
    try {
      final response = await _dio.post<Map<String, dynamic>>(
        '/api/douyin/bind',
        data: {'code': code},
      );
      return DouyinBindStatus.fromJson(response.data ?? <String, dynamic>{});
    } on DioException catch (error) {
      throw _toApiException(error);
    }
  }

  /// 解绑抖音号，返回未绑定状态。
  /// 注意：显式发送空 JSON 对象 `{}`，避免携带 Content-Type 但空 body
  /// 触发 Fastify 的 FST_ERR_CTP_EMPTY_JSON_BODY（400）。
  Future<DouyinBindStatus> unbindDouyin() async {
    try {
      final response = await _dio.post<Map<String, dynamic>>(
        '/api/douyin/unbind',
        data: <String, dynamic>{},
      );
      return DouyinBindStatus.fromJson(response.data ?? <String, dynamic>{});
    } on DioException catch (error) {
      throw _toApiException(error);
    }
  }

  /// 获取最新版《声音授权协议》正文。
  Future<VoiceAgreement> fetchVoiceAgreement() async {
    try {
      final response = await _dio.get<Map<String, dynamic>>('/api/agreements/voice');
      return VoiceAgreement.fromJson(response.data ?? <String, dynamic>{});
    } on DioException catch (error) {
      throw _toApiException(error);
    }
  }

  /// 查询当前用户的《声音授权协议》签署状态。
  Future<AgreementStatus> fetchVoiceAgreementStatus() async {
    try {
      final response = await _dio.get<Map<String, dynamic>>('/api/agreements/voice/status');
      return AgreementStatus.fromJson(response.data ?? <String, dynamic>{});
    } on DioException catch (error) {
      throw _toApiException(error);
    }
  }

  /// 签署《声音授权协议》；服务端对同版本重复签署幂等返回 200（不重复插入）。
  Future<AgreementStatus> signVoiceAgreement({required String version}) async {
    try {
      final response = await _dio.post<Map<String, dynamic>>(
        '/api/agreements/voice/sign',
        data: <String, dynamic>{'version': version, 'agreed': true},
      );
      return AgreementStatus.fromJson(response.data ?? <String, dynamic>{});
    } on DioException catch (error) {
      throw _toApiException(error);
    }
  }

  /// 我的音色列表（服务端按创建时间倒序返回）。
  Future<List<Voice>> listVoices() async {
    try {
      final response = await _dio.get<List<dynamic>>('/api/voices');
      final data = response.data;
      if (data is List) {
        return data
            .whereType<Map>()
            .map((item) => Voice.fromJson(Map<String, dynamic>.from(item)))
            .toList();
      }
      return <Voice>[];
    } on DioException catch (error) {
      throw _toApiException(error);
    }
  }

  /// 创建声音克隆任务（提交录音样本），成功返回 201 + pending 音色。
  Future<Voice> createVoice({
    required String name,
    required int sampleDurationSeconds,
    String? sampleFingerprint,
  }) async {
    try {
      final response = await _dio.post<Map<String, dynamic>>(
        '/api/voices',
        data: <String, dynamic>{
          'name': name,
          'sampleDurationSeconds': sampleDurationSeconds,
          'sampleFingerprint': ?sampleFingerprint,
        },
      );
      return Voice.fromJson(response.data ?? <String, dynamic>{});
    } on DioException catch (error) {
      throw _toApiException(error);
    }
  }

  /// 查询单个音色状态（克隆进度轮询）。
  Future<Voice> getVoice(String id) async {
    try {
      final response = await _dio.get<Map<String, dynamic>>('/api/voices/$id');
      return Voice.fromJson(response.data ?? <String, dynamic>{});
    } on DioException catch (error) {
      throw _toApiException(error);
    }
  }

  /// 删除音色。
  /// 注意：显式发送空 JSON 对象 `{}`，避免携带 Content-Type 但空 body
  /// 触发 Fastify 的 FST_ERR_CTP_EMPTY_JSON_BODY（400）。
  Future<void> deleteVoice(String id) async {
    try {
      await _dio.delete<Map<String, dynamic>>(
        '/api/voices/$id',
        data: <String, dynamic>{},
      );
    } on DioException catch (error) {
      throw _toApiException(error);
    }
  }

  /// 生成话术：真实调用 DeepSeek（需数秒），返回 201 + 已完成敏感词扫描的话术。
  Future<Script> generateScript({
    required String industry,
    String? title,
    required Map<String, String> product,
  }) async {
    try {
      final response = await _dio.post<Map<String, dynamic>>(
        '/api/scripts/generate',
        data: <String, dynamic>{
          'industry': industry,
          'title': ?title,
          'product': product,
        },
      );
      return Script.fromJson(response.data ?? <String, dynamic>{});
    } on DioException catch (error) {
      throw _toApiException(error);
    }
  }

  /// 我的话术列表（服务端按创建时间倒序返回）。
  Future<List<Script>> listScripts() async {
    try {
      final response = await _dio.get<List<dynamic>>('/api/scripts');
      final data = response.data;
      if (data is List) {
        return data
            .whereType<Map>()
            .map((item) => Script.fromJson(Map<String, dynamic>.from(item)))
            .toList();
      }
      return <Script>[];
    } on DioException catch (error) {
      throw _toApiException(error);
    }
  }

  /// 查询单条话术（含归属校验）。
  Future<Script> getScript(String id) async {
    try {
      final response = await _dio.get<Map<String, dynamic>>('/api/scripts/$id');
      return Script.fromJson(response.data ?? <String, dynamic>{});
    } on DioException catch (error) {
      throw _toApiException(error);
    }
  }

  /// 编辑保存话术：服务端保存后会重新做敏感词扫描并返回最新话术。
  Future<Script> updateScript(String id, {required String content, String? title}) async {
    try {
      final response = await _dio.put<Map<String, dynamic>>(
        '/api/scripts/$id',
        data: <String, dynamic>{'content': content, 'title': ?title},
      );
      return Script.fromJson(response.data ?? <String, dynamic>{});
    } on DioException catch (error) {
      throw _toApiException(error);
    }
  }
  /// 把 dio 异常统一转换为携带后端中文 message 的 [ApiException]。
  ApiException _toApiException(DioException error) {
    final response = error.response;
    if (response == null) {
      return const ApiException(
        code: 'NETWORK_ERROR',
        message: '网络连接失败，请检查网络后重试',
      );
    }

    Map<String, dynamic> body = const <String, dynamic>{};
    if (response.data is Map) {
      body = Map<String, dynamic>.from(response.data as Map);
    }
    final retryAfterSeconds = body['retryAfterSeconds'];
    return ApiException(
      code: body['error']?.toString() ?? 'HTTP_${response.statusCode}',
      message: body['message']?.toString() ?? _defaultMessage(response.statusCode),
      statusCode: response.statusCode,
      retryAfterSeconds: retryAfterSeconds is num ? retryAfterSeconds.toInt() : null,
    );
  }

  String _defaultMessage(int? statusCode) {
    switch (statusCode) {
      case 400:
        return '请求参数不正确';
      case 401:
        return '未登录或登录已过期';
      case 404:
        return '请求的资源不存在';
      case 429:
        return '操作过于频繁，请稍后重试';
      default:
        return '服务异常，请稍后重试';
    }
  }
}
