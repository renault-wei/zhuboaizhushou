import 'dart:convert';
import 'dart:typed_data';

import 'package:dio/dio.dart';

/// 假后端下发的《声音授权协议》正文（简化版，覆盖关键条款便于 UI 断言）。
const String fakeVoiceAgreementContent = '''
《声音授权协议》（版本 1.0）

一、授权范围
您授权平台将您提交的录音样本用于声音克隆、试听与合成，并仅用于本平台内的声音克隆与直播带货用途。

二、知情同意
您确认录音样本确由本人录制或拥有合法权利，已知悉声音克隆原理与效果并自愿同意本协议。

三、音色删除
您可随时申请删除本人音色及相关数据，平台核实后将在合理期限内删除。

四、转授权限制
未经您书面同意，平台不得将您的录音样本、克隆音色转授权或提供给第三方。

五、未成年人保护
未满十八周岁的未成年人禁止提交本人声音。

六、数据保存与销毁
平台仅在必要期限内保存相关数据，申请删除或服务终止后依法销毁。
''';

/// 内存版假后端：覆盖登录、抖音绑定与声音授权协议相关接口，
/// 测试全程不发起真实网络请求，响应形状与服务端保持一致。
class FakeBackend implements HttpClientAdapter {
  FakeBackend({
    this.userId = 'user-001',
    this.phone = '13800138000',
    this.douyinBound = false,
    this.douyinNickname = '抖音小店测试号',
    this.avatarUrl = '',
    this.agreementSigned = false,
    this.agreementSignedAt = '2026-09-04T02:00:00.000Z',
    List<Map<String, dynamic>>? voices,
  }) : voices = voices ?? <Map<String, dynamic>>[];

  final String userId;
  final String phone;

  /// 是否已绑定抖音号：GET bind-status 返回当前值，绑定/解绑接口会改写
  bool douyinBound;
  final String douyinNickname;
  final String avatarUrl;

  /// 是否已签署《声音授权协议》：GET status 返回当前值，签署接口会改写
  bool agreementSigned;
  final String agreementSignedAt;

  /// 我的音色（内存）：结构与服务端 /api/voices 返回保持一致；
  /// GET :id 会像服务端一样按创建时间惰性推进克隆状态。
  final List<Map<String, dynamic>> voices;
  int _voiceSeq = 0;

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
    if (options.method == 'GET' && path.endsWith('/api/agreements/voice')) {
      return _jsonResponse({
        'version': '1.0',
        'title': '声音授权协议',
        'content': fakeVoiceAgreementContent,
      });
    }
    if (options.method == 'GET' && path.endsWith('/api/agreements/voice/status')) {
      return _jsonResponse(_voiceAgreementStatus());
    }
    if (options.method == 'POST' && path.endsWith('/api/agreements/voice/sign')) {
      final body = _readBody(options);
      if (body['version'] != '1.0') {
        return _jsonResponse(
          {'error': 'VERSION_MISMATCH', 'message': '协议版本不匹配，请阅读最新协议后重新签署'},
          400,
        );
      }
      if (body['agreed'] != true) {
        return _jsonResponse(
          {'error': 'NOT_AGREED', 'message': '请先阅读并勾选同意《声音授权协议》后再签署'},
          400,
        );
      }
      agreementSigned = true;
      return _jsonResponse(_voiceAgreementStatus());
    }
    if (options.method == 'GET' && path.endsWith('/api/voices')) {
      return _jsonResponse(List<Map<String, dynamic>>.from(voices));
    }
    if (options.method == 'POST' && path.endsWith('/api/voices')) {
      return _createVoice(options);
    }
    final voiceItem = RegExp(r'^/api/voices/([^/]+)$').firstMatch(path);
    if (voiceItem != null && options.method == 'GET') {
      return _getVoice(voiceItem.group(1)!);
    }
    if (voiceItem != null && options.method == 'DELETE') {
      return _deleteVoice(voiceItem.group(1)!);
    }
    return _jsonResponse({'error': 'NOT_FOUND', 'message': '接口不存在'}, 404);
  }

  /// 创建克隆任务：镜像服务端校验（先协议后时长与名称），成功落 pending。
  ResponseBody _createVoice(RequestOptions options) {
    if (!agreementSigned) {
      return _jsonResponse(
        {
          'error': 'AGREEMENT_REQUIRED',
          'message': '克隆声音前需先签署《声音授权协议》',
        },
        403,
      );
    }
    final body = _readBody(options);
    final rawName = body['name'];
    final name = rawName is String ? rawName.trim() : '';
    final rawDuration = body['sampleDurationSeconds'];
    final duration = rawDuration is num ? rawDuration.toInt() : 0;
    if (duration < 180) {
      return _jsonResponse(
        {'error': 'DURATION_TOO_SHORT', 'message': '录音时长不足 3 分钟'},
        400,
      );
    }
    if (name.isEmpty || name.length > 50) {
      return _jsonResponse(
        {'error': 'NAME_INVALID', 'message': '音色名称不能为空且不超过 50 字'},
        400,
      );
    }
    _voiceSeq += 1;
    final id = 'voice-${_voiceSeq.toString().padLeft(3, '0')}';
    final voice = <String, dynamic>{
      'id': id,
      'name': name,
      'status': 'pending',
      'providerVoiceId': 'cosyvoice-mock-$id',
      'sampleDurationSeconds': duration,
      'sampleFingerprint': body['sampleFingerprint'],
      'createdAt': DateTime.now().toUtc().toIso8601String(),
    };
    voices.insert(0, voice);
    return _jsonResponse(voice, 201);
  }

  /// 单查音色：镜像服务端 mock 节奏，按创建时间把 pending/processing 推进到终态。
  ResponseBody _getVoice(String id) {
    final index = voices.indexWhere((voice) => voice['id'] == id);
    if (index < 0) {
      return _jsonResponse(
        {'error': 'VOICE_NOT_FOUND', 'message': '音色不存在'},
        404,
      );
    }
    final voice = voices[index];
    final status = voice['status'];
    if (status == 'pending' || status == 'processing') {
      final createdAt =
          DateTime.tryParse(voice['createdAt']?.toString() ?? '') ??
          DateTime.now().toUtc();
      final elapsedMs =
          DateTime.now().toUtc().difference(createdAt).inMilliseconds;
      String? nextStatus;
      if (elapsedMs >= 8000) {
        nextStatus = 'ready';
      } else if (elapsedMs >= 3000) {
        nextStatus = 'processing';
      }
      if (nextStatus != null && nextStatus != status) {
        final updated = <String, dynamic>{...voice, 'status': nextStatus};
        voices[index] = updated;
        return _jsonResponse(updated);
      }
    }
    return _jsonResponse(voice);
  }

  /// 删除音色：找不到返回 404，成功返回 { ok: true }。
  ResponseBody _deleteVoice(String id) {
    final before = voices.length;
    voices.removeWhere((voice) => voice['id'] == id);
    if (voices.length == before) {
      return _jsonResponse(
        {'error': 'VOICE_NOT_FOUND', 'message': '音色不存在'},
        404,
      );
    }
    return _jsonResponse({'ok': true});
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

  Map<String, dynamic> _voiceAgreementStatus() {
    if (!agreementSigned) {
      return {'signed': false};
    }
    return {
      'signed': true,
      'signedAt': agreementSignedAt,
      'version': '1.0',
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

ResponseBody _jsonResponse(Object body, [int statusCode = 200]) {
  return ResponseBody.fromString(
    jsonEncode(body),
    statusCode,
    headers: {
      Headers.contentTypeHeader: ['application/json; charset=utf-8'],
    },
  );
}
