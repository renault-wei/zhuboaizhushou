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
    this.generatedScriptContent = '双人火锅套餐，锅底现炒，欢迎到店品尝。',
    this.failScriptsList = false,
    this.failScriptGenerate = false,
    List<Map<String, dynamic>>? voices,
    List<Map<String, dynamic>>? scripts,
  })  : voices = voices ?? <Map<String, dynamic>>[],
        scripts = scripts ?? <Map<String, dynamic>>[];

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

  /// 我的话术（内存）：结构与服务端 /api/scripts 返回保持一致。
  final List<Map<String, dynamic>> scripts;
  int _scriptSeq = 0;

  /// 模拟 DeepSeek 返回的话术全文：生成接口使用，测试可自行配置。
  final String generatedScriptContent;

  /// 模拟我的话术列表接口 500（测试加载失败分支）。
  final bool failScriptsList;

  /// 模拟话术生成接口 500（测试生成失败分支）。
  final bool failScriptGenerate;

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
    if (options.method == 'POST' && path.endsWith('/api/scripts/generate')) {
      return _generateScript(options);
    }
    if (options.method == 'GET' && path.endsWith('/api/scripts')) {
      if (failScriptsList) {
        return _serverError('话术列表服务暂不可用');
      }
      return _jsonResponse(List<Map<String, dynamic>>.from(scripts));
    }
    final scriptItem = RegExp(r'^/api/scripts/([^/]+)$').firstMatch(path);
    if (scriptItem != null && options.method == 'GET') {
      return _getScript(scriptItem.group(1)!);
    }
    if (scriptItem != null && options.method == 'PUT') {
      return _updateScript(options, scriptItem.group(1)!);
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

  /// 生成话术：镜像服务端流程（模拟 DeepSeek 返回配置话术 + 内置拦截词扫描）。
  ResponseBody _generateScript(RequestOptions options) {
    if (failScriptGenerate) {
      return _serverError('话术生成服务暂不可用');
    }
    final body = _readBody(options);
    final industry = body['industry']?.toString() ?? '';
    if (industry != 'restaurant' &&
        industry != 'local_service' &&
        industry != 'retail') {
      return _jsonResponse({'error': 'INDUSTRY_INVALID', 'message': '不支持的行业类型'}, 400);
    }
    final rawProduct = body['product'];
    if (rawProduct is! Map || rawProduct.isEmpty) {
      return _jsonResponse({'error': 'PRODUCT_INVALID', 'message': '商品信息不能为空'}, 400);
    }
    final rawTitle = body['title'];
    final title = rawTitle is String && rawTitle.trim().isNotEmpty
        ? rawTitle.trim()
        : null;
    final scan = _scanSensitive(generatedScriptContent);
    _scriptSeq += 1;
    final id = 'script-${_scriptSeq.toString().padLeft(3, '0')}';
    final now = DateTime.now().toUtc();
    final script = <String, dynamic>{
      'id': id,
      'industry': industry,
      'title': title,
      'productSnapshot': rawProduct,
      'content': generatedScriptContent,
      // 服务端语义：status 为 ready|blocked，sensitiveCheckStatus 为 pass|blocked
      'status': scan['status'] == 'blocked' ? 'blocked' : 'ready',
      'sensitiveCheckStatus': scan['status'],
      'sensitiveMatchedWords': scan['matchedWords'],
      'sensitiveScannedAt': now.toIso8601String(),
      'createdAt': now.toIso8601String(),
      'updatedAt': now.toIso8601String(),
    };
    scripts.insert(0, script);
    return _jsonResponse(script, 201);
  }

  /// 单查话术：找不到返回 404。
  ResponseBody _getScript(String id) {
    final script = _findScript(id);
    if (script == null) {
      return _jsonResponse({'error': 'SCRIPT_NOT_FOUND', 'message': '话术不存在'}, 404);
    }
    return _jsonResponse(script);
  }

  /// 编辑保存话术：重新扫描敏感词并同步 status / 命中词。
  ResponseBody _updateScript(RequestOptions options, String id) {
    final script = _findScript(id);
    if (script == null) {
      return _jsonResponse({'error': 'SCRIPT_NOT_FOUND', 'message': '话术不存在'}, 404);
    }
    final body = _readBody(options);
    final rawContent = body['content'];
    if (rawContent is! String || rawContent.trim().isEmpty) {
      return _jsonResponse({'error': 'CONTENT_REQUIRED', 'message': '话术内容不能为空'}, 400);
    }
    final content = rawContent.trim();
    final scan = _scanSensitive(content);
    final updated = <String, dynamic>{
      ...script,
      'content': content,
      // 服务端语义：status 为 ready|blocked，sensitiveCheckStatus 为 pass|blocked
      'status': scan['status'] == 'blocked' ? 'blocked' : 'ready',
      'sensitiveCheckStatus': scan['status'],
      'sensitiveMatchedWords': scan['matchedWords'],
      'sensitiveScannedAt': DateTime.now().toUtc().toIso8601String(),
      'updatedAt': DateTime.now().toUtc().toIso8601String(),
    };
    if (body.containsKey('title')) {
      final rawTitle = body['title'];
      updated['title'] = rawTitle is String && rawTitle.trim().isNotEmpty
          ? rawTitle.trim()
          : null;
    }
    final index = scripts.indexWhere((item) => item['id'] == id);
    scripts[index] = updated;
    return _jsonResponse(updated);
  }

  Map<String, dynamic>? _findScript(String id) {
    for (final script in scripts) {
      if (script['id'] == id) {
        return script;
      }
    }
    return null;
  }

  /// 内置拦截级敏感词（与服务端 sensitive.ts 保持一致），命中即 blocked。
  static const List<String> _blockedSensitiveWords = <String>[
    '最',
    '第一',
    '顶级',
    '国家级',
    '世界级',
    '绝对',
    '百分百',
    '100%',
    '全网最低',
    '最低价',
    '永久',
    '史无前例',
    '全球领先',
    '行业领先',
    '独家',
    '最佳',
    '首选',
    '极品',
  ];

  Map<String, dynamic> _scanSensitive(String text) {
    final matchedWords = <String>[
      for (final word in _blockedSensitiveWords)
        if (text.contains(word)) word,
    ];
    return <String, dynamic>{
      'status': matchedWords.isEmpty ? 'pass' : 'blocked',
      'matchedWords': matchedWords,
    };
  }

  /// 模拟服务端 500 错误响应（测试错误分支用）。
  ResponseBody _serverError(String message) {
    return _jsonResponse(
      <String, dynamic>{'error': 'INTERNAL_ERROR', 'message': message},
      500,
    );
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
