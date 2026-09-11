import 'dart:convert';
import 'dart:typed_data';

import 'package:dio/dio.dart';

import 'package:starvoice_app/core/models/coupon.dart';
import 'package:starvoice_app/core/models/app_config.dart';
import 'package:starvoice_app/core/models/douyin_bind_status.dart';
import 'package:starvoice_app/core/models/live.dart';
import 'package:starvoice_app/core/models/user_profile.dart';
import 'package:starvoice_app/core/models/voice.dart';
import 'package:starvoice_app/core/models/voice_agreement.dart';
import 'package:starvoice_app/core/models/volc_preset.dart';
import 'package:starvoice_app/core/models/script.dart';
import 'package:starvoice_app/core/models/loop_script.dart';
import 'package:starvoice_app/core/models/speech_out_item.dart';
import 'package:starvoice_app/core/models/wallet.dart';
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
        userJson is Map
            ? Map<String, dynamic>.from(userJson)
            : <String, dynamic>{},
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
      final response = await _dio.get<Map<String, dynamic>>(
        '/api/douyin/bind-status',
      );
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

  /// 拉取当前抖音账号的团购券列表（必须先绑定抖音号）。
  /// 未绑定抖音号时服务端返回 403 DOUYIN_NOT_BOUND。
  Future<List<Coupon>> fetchCoupons() async {
    try {
      final response = await _dio.get<Map<String, dynamic>>(
        '/api/douyin/coupons',
      );
      final data = response.data ?? <String, dynamic>{};
      final raw = data['coupons'];
      if (raw is List) {
        return raw
            .whereType<Map>()
            .map((item) => Coupon.fromJson(Map<String, dynamic>.from(item)))
            .toList();
      }
      return <Coupon>[];
    } on DioException catch (error) {
      throw _toApiException(error);
    }
  }

  /// 获取钱包总览：时长余额 + 当月免费直播剩余 + 时长流水 + 最近充值单。
  Future<WalletOverview> fetchWalletOverview() async {
    try {
      final response = await _dio.get<Map<String, dynamic>>('/api/wallet');
      return WalletOverview.fromJson(response.data ?? <String, dynamic>{});
    } on DioException catch (error) {
      throw _toApiException(error);
    }
  }

  /// 获取服务端开关下发（公开接口）：充值入口显隐 / 档位 / 公告。
  Future<PublicAppConfig> fetchAppConfig() async {
    try {
      final response = await _dio.get<Map<String, dynamic>>('/api/app/config');
      final data = response.data ?? <String, dynamic>{};
      final configJson = data['config'];
      return PublicAppConfig.fromJson(
        configJson is Map
            ? Map<String, dynamic>.from(configJson)
            : <String, dynamic>{},
      );
    } on DioException catch (error) {
      throw _toApiException(error);
    }
  }

  /// 服务端扫码下单（mock 通道返回占位收款码；M8 凭证接入后替换为真实收款码）。
  Future<RechargeScanResult> createRechargeOrderScan({
    required int hours,
  }) async {
    try {
      final response = await _dio.post<Map<String, dynamic>>(
        '/api/recharge/scan',
        data: <String, dynamic>{'hours': hours},
      );
      return RechargeScanResult.fromJson(response.data ?? <String, dynamic>{});
    } on DioException catch (error) {
      throw _toApiException(error);
    }
  }

  /// 轮询扫码单确认状态：paid 后附带最新时长余额。
  Future<RechargePollResult> pollRecharge({required String orderId}) async {
    try {
      final response = await _dio.post<Map<String, dynamic>>(
        '/api/recharge/poll',
        data: <String, dynamic>{'orderId': orderId},
      );
      return RechargePollResult.fromJson(response.data ?? <String, dynamic>{});
    } on DioException catch (error) {
      throw _toApiException(error);
    }
  }

  /// 卡密核销入账（幂等：同一卡密重复提交返回 409 CARD_REDEEMED）。
  Future<RedeemCardResult> redeemCard({required String code}) async {
    try {
      final response = await _dio.post<Map<String, dynamic>>(
        '/api/cards/redeem',
        data: <String, dynamic>{'code': code},
      );
      return RedeemCardResult.fromJson(response.data ?? <String, dynamic>{});
    } on DioException catch (error) {
      throw _toApiException(error);
    }
  }

  /// 获取最新版《声音授权协议》正文。
  Future<VoiceAgreement> fetchVoiceAgreement() async {
    try {
      final response = await _dio.get<Map<String, dynamic>>(
        '/api/agreements/voice',
      );
      return VoiceAgreement.fromJson(response.data ?? <String, dynamic>{});
    } on DioException catch (error) {
      throw _toApiException(error);
    }
  }

  /// 查询当前用户的《声音授权协议》签署状态。
  Future<AgreementStatus> fetchVoiceAgreementStatus() async {
    try {
      final response = await _dio.get<Map<String, dynamic>>(
        '/api/agreements/voice/status',
      );
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

  /// 火山预设音色目录（只读内置，不调火山接口）：返回 presets + 分组顺序 +
  /// 默认音色（生效值 = 商家默认 ?? 全局默认）+ 商家自己设过的默认音色，
  /// 音色选择在「克隆音色 / 火山预设」两组之间互斥，live 落库走 volcPresetId。
  Future<VolcPresetCatalog> fetchVolcPresetCatalog() async {
    try {
      final response = await _dio.get<Map<String, dynamic>>(
        '/api/voices/presets',
      );
      return VolcPresetCatalog.fromJson(response.data ?? <String, dynamic>{});
    } on DioException catch (error) {
      throw _toApiException(error);
    }
  }

  /// 火山预设音色列表（仅需音色本身的调用方用）。
  Future<List<VolcPresetVoice>> listVolcPresetVoices() async {
    return (await fetchVolcPresetCatalog()).presets;
  }

  /// 设置 / 清空商家默认音色（服务端为准）：presetId 传 null 表示清空、
  /// 回落服务端全局默认。返回服务端生效的默认音色 id（供本地缓存对齐）。
  /// 只影响新建开播配置的预填，不改动已有场次各自记住的音色。
  Future<String> setDefaultVoice({String? presetId}) async {
    try {
      final response = await _dio.put<Map<String, dynamic>>(
        '/api/voices/default',
        data: <String, dynamic>{'presetId': presetId},
      );
      return response.data?['defaultPresetId']?.toString() ?? '';
    } on DioException catch (error) {
      throw _toApiException(error);
    }
  }

  /// 音色试听（档 A）：服务端用固定演示短句做一次真实合成，返回 wav 字节。
  /// demoFallback=true 表示请求的是克隆音色、服务端回落演示预设音色
  /// （X-Voice-Preview-Fallback 头），客户端据此如实提示用户。
  Future<({Uint8List bytes, bool demoFallback})> previewVoice({
    String? presetId,
    String? voiceId,
  }) async {
    try {
      final response = await _dio.post<Uint8List>(
        '/api/voices/preview',
        data: <String, dynamic>{
          if (presetId != null && presetId.isNotEmpty) 'presetId': presetId,
          if (voiceId != null && voiceId.isNotEmpty) 'voiceId': voiceId,
        },
        options: Options(responseType: ResponseType.bytes),
      );
      final bytes = response.data;
      if (bytes == null || bytes.isEmpty) {
        throw const ApiException(
          code: 'VOICE_PREVIEW_EMPTY',
          message: '试听音频为空，请稍后重试',
        );
      }
      return (
        bytes: bytes,
        demoFallback:
            response.headers.value('x-voice-preview-fallback') != null,
      );
    } on DioException catch (error) {
      throw _toBytesApiException(error);
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
  Future<Script> updateScript(
    String id, {
    required String content,
    String? title,
  }) async {
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

  /// 生成循环台本草稿（M2，不落库）：必须指定我的 ready+pass 正式话术；
  /// 返回草稿条目供「预览后保存」。复用一次过审链路：初稿含违规表述时服务端
  /// 自动改写，成品条目必然不含敏感词；仍失败返回 502 GENERATION_FAILED。
  Future<LoopScriptDraft> generateLoopScriptDraft({
    required String sourceScriptId,
    String? couponText,
    String? scenario,
    String? customBrief,
    int? itemCount,
  }) async {
    try {
      final response = await _dio.post<Map<String, dynamic>>(
        '/api/loop-scripts/generate',
        data: <String, dynamic>{
          'sourceScriptId': sourceScriptId,
          'couponText': ?couponText,
          'scenario': ?scenario,
          'customBrief': ?customBrief,
          'itemCount': ?itemCount,
        },
      );
      return LoopScriptDraft.fromJson(response.data ?? <String, dynamic>{});
    } on DioException catch (error) {
      throw _toApiException(error);
    }
  }

  /// 我的循环台本列表：服务端按 updatedAt 倒序返回（带条数摘要）。
  Future<List<LoopScript>> listLoopScripts() async {
    try {
      final response = await _dio.get<List<dynamic>>('/api/loop-scripts');
      final data = response.data;
      if (data is List) {
        return data
            .whereType<Map>()
            .map((item) => LoopScript.fromJson(Map<String, dynamic>.from(item)))
            .toList();
      }
      return <LoopScript>[];
    } on DioException catch (error) {
      throw _toApiException(error);
    }
  }

  /// 查询单个循环台本（含归属校验，非本人或不存在返回 404），items 按 seq 升序。
  Future<LoopScript> getLoopScript(String id) async {
    try {
      final response = await _dio.get<Map<String, dynamic>>(
        '/api/loop-scripts/$id',
      );
      return LoopScript.fromJson(response.data ?? <String, dynamic>{});
    } on DioException catch (error) {
      throw _toApiException(error);
    }
  }

  /// 新建循环台本：标题 + 有序条目整体落库；条目逐个过敏感词扫描，
  /// 命中返回 400 SENSITIVE_BLOCKED + matchedWords。成功返回 201 + 整本。
  Future<LoopScript> createLoopScript({
    required String title,
    required List<Map<String, dynamic>> items,
    String? sourceScriptId,
  }) async {
    try {
      final response = await _dio.post<Map<String, dynamic>>(
        '/api/loop-scripts',
        data: <String, dynamic>{
          'title': title,
          'items': items,
          'sourceScriptId': ?sourceScriptId,
        },
      );
      return LoopScript.fromJson(response.data ?? <String, dynamic>{});
    } on DioException catch (error) {
      throw _toApiException(error);
    }
  }

  /// 整体替换台本标题与条目（seq = 下标+1）：引用它的场次待下次开播生效，
  /// 不做热更新。命中敏感词同样返回 400 SENSITIVE_BLOCKED + matchedWords。
  Future<LoopScript> updateLoopScript(
    String id, {
    required String title,
    required List<Map<String, dynamic>> items,
  }) async {
    try {
      final response = await _dio.put<Map<String, dynamic>>(
        '/api/loop-scripts/$id',
        data: <String, dynamic>{'title': title, 'items': items},
      );
      return LoopScript.fromJson(response.data ?? <String, dynamic>{});
    } on DioException catch (error) {
      throw _toApiException(error);
    }
  }

  /// 删除循环台本：服务端先把引用它的开播配置解绑（loopScriptId 置 null），
  /// 再级联删除条目；正在直播的场次内存快照不受影响。
  Future<void> deleteLoopScript(String id) async {
    try {
      await _dio.delete<Map<String, dynamic>>('/api/loop-scripts/$id');
    } on DioException catch (error) {
      throw _toApiException(error);
    }
  }
  /// 示例循环台本（谈单演示用）：登录即可读，服务端内置只读返回整本。
  /// 套用示例不落库、不扣生成配额；客户端把内容带入新建编辑器后，
  /// 保存仍走 /api/loop-scripts 的落库前敏感词扫描链路，合规红线不变。
  Future<List<LoopScriptSample>> fetchLoopScriptSamples() async {
    try {
      final response = await _dio.get<Map<String, dynamic>>(
        '/api/loop-script-samples',
      );
      final data = response.data ?? <String, dynamic>{};
      final raw = data['samples'];
      if (raw is List) {
        return raw
            .whereType<Map>()
            .map(
              (item) => LoopScriptSample.fromJson(
                Map<String, dynamic>.from(item),
              ),
            )
            .toList();
      }
      return <LoopScriptSample>[];
    } on DioException catch (error) {
      throw _toApiException(error);
    }
  }

  /// 我的开播配置列表：服务端按 updatedAt desc 返回、最多 50 条，支持 ?status= 过滤。
  Future<List<Live>> listLives({String? status}) async {
    try {
      final response = await _dio.get<List<dynamic>>(
        '/api/lives',
        queryParameters: <String, dynamic>{'status': ?status},
      );
      final data = response.data;
      if (data is List) {
        return data
            .whereType<Map>()
            .map((item) => Live.fromJson(Map<String, dynamic>.from(item)))
            .toList();
      }
      return <Live>[];
    } on DioException catch (error) {
      throw _toApiException(error);
    }
  }

  /// 查询单个开播配置（含归属校验，非本人或不存在返回 404）。
  Future<Live> getLive(String id) async {
    try {
      final response = await _dio.get<Map<String, dynamic>>('/api/lives/$id');
      return _parseLive(response.data);
    } on DioException catch (error) {
      throw _toApiException(error);
    }
  }

  /// 创建开播配置草稿：服务端默认 status=idle、aiBadgeShown=true（合规写死，
  /// 请求体即使传 status / aiBadgeShown=false 也一律忽略，防止篡改合规角标）。
  Future<Live> createLive({
    required String title,
    String? volcPresetId,
    int? speechRate,
    String? voiceId,
    String? scriptId,
    String? loopScriptId,
    String? videoSourceUrl,
  }) async {
    try {
      final response = await _dio.post<Map<String, dynamic>>(
        '/api/lives',
        data: <String, dynamic>{
          'title': title,
          'volcPresetId': volcPresetId,
          'speechRate': ?speechRate,
          'voiceId': voiceId,
          'scriptId': scriptId,
          'loopScriptId': loopScriptId,
          'videoSourceUrl': ?videoSourceUrl,
        },
      );
      return _parseLive(response.data);
    } on DioException catch (error) {
      throw _toApiException(error);
    }
  }

  /// 编辑开播配置：整体提交标题/音色/话术（null 表示清空绑定）；
  /// status / aiBadgeShown 无更新入口，角标恒为 true 不可篡改。
  Future<Live> updateLive({
    required String id,
    String? title,
    String? volcPresetId,
    int? speechRate,
    String? voiceId,
    String? scriptId,
    String? loopScriptId,
    String? videoSourceUrl,
  }) async {
    try {
      final response = await _dio.patch<Map<String, dynamic>>(
        '/api/lives/$id',
        data: <String, dynamic>{
          'title': title,
          // 显式带 null：编辑页整体提交当前绑定，null 表示未绑定（服务端置空该列）
          'volcPresetId': volcPresetId,
          // 显式带 null：null 表示清档、交回服务端默认档（-10）
          'speechRate': speechRate,
          'voiceId': voiceId,
          'scriptId': scriptId,
          'loopScriptId': loopScriptId,
          'videoSourceUrl': ?videoSourceUrl,
        },
      );
      return _parseLive(response.data);
    } on DioException catch (error) {
      throw _toApiException(error);
    }
  }

  /// 直播中更换循环台本（M4 热更）：仅直播中（status=live）可调，其他状态服务端 409。
  /// 生效时机：服务端循环引擎每轮开头重读台本，换绑于「下一轮」生效，不打断当前句。
  Future<Live> bindLiveLoopScript(
    String id, {
    required String loopScriptId,
  }) async {
    try {
      final response = await _dio.post<Map<String, dynamic>>(
        '/api/lives/$id/loop-script',
        data: <String, dynamic>{'loopScriptId': loopScriptId},
      );
      return _parseLive(response.data);
    } on DioException catch (error) {
      throw _toApiException(error);
    }
  }

  /// 直播中更换「话术」（热更）：仅直播中（status=live）可调，其他状态服务端 409；
  /// 话术须归属当前用户且已过审，否则 400。生效时机：弹幕回复上下文按条实时读取，
  /// 换绑后新弹幕立即用新话术，只改 scriptId（不动循环台本）。
  Future<Live> bindLiveScript(
    String id, {
    required String scriptId,
  }) async {
    try {
      final response = await _dio.post<Map<String, dynamic>>(
        '/api/lives/$id/script',
        data: <String, dynamic>{'scriptId': scriptId},
      );
      return _parseLive(response.data);
    } on DioException catch (error) {
      throw _toApiException(error);
    }
  }

  /// 删除开播配置：仅 idle / ended / failed 可删；ready / live 会被服务端 409 拦截。
  /// 注意：显式发送空 JSON 对象 `{}`，避免携带 Content-Type 但空 body
  /// 触发 Fastify 的 FST_ERR_CTP_EMPTY_JSON_BODY（400）。
  Future<void> deleteLive(String id) async {
    try {
      await _dio.delete<Map<String, dynamic>>(
        '/api/lives/$id',
        data: <String, dynamic>{},
      );
    } on DioException catch (error) {
      throw _toApiException(error);
    }
  }

  /// 上传实景视频（multipart 字段 video，仅 mp4，≤200MB）：服务端落盘
  /// uploads/videos/{id}.mp4 并回填 videoSourceUrl 后返回最新开播配置。
  /// [filePath] 为本机 mp4 文件绝对路径。
  Future<Live> uploadLiveVideo(String id, String filePath) async {
    try {
      final fileName = filePath.split(RegExp(r'[\\/]')).last;
      final formData = FormData.fromMap(<String, dynamic>{
        'video': await MultipartFile.fromFile(filePath, filename: fileName),
      });
      final response = await _dio.post<Map<String, dynamic>>(
        '/api/lives/$id/video',
        data: formData,
      );
      return _parseLive(response.data);
    } on DioException catch (error) {
      throw _toApiException(error);
    }
  }

  /// 触发合成（prepare）：服务端前置校验（已传视频 / 话术 ready+pass / 已选音色），
  /// 成功把状态推进到 ready 并返回最新开播配置；失败抛 [ApiException]。
  Future<Live> prepareLive(String id, {int? durationSeconds}) async {
    try {
      final response = await _dio.post<Map<String, dynamic>>(
        '/api/lives/$id/prepare',
        data: <String, dynamic>{'durationSeconds': ?durationSeconds},
      );
      return _parseLive(response.data);
    } on DioException catch (error) {
      throw _toApiException(error);
    }
  }

  /// 查询合成 / 直播状态（客户端轮询用），返回 { status, videoSourceUrl,
  /// aiBadgeShown }；aiBadgeShown 由服务端写死为 true。
  Future<LiveStreamStatus> getLiveStreamStatus(String id) async {
    try {
      final response = await _dio.get<Map<String, dynamic>>(
        '/api/lives/$id/stream-status',
      );
      return LiveStreamStatus.fromJson(response.data ?? <String, dynamic>{});
    } on DioException catch (error) {
      throw _toApiException(error);
    }
  }

  /// 一键开播：ready → live，记录 startedAt；成功返回最新开播配置。
  /// 未就绪（status !== ready）服务端返回 400 LIVE_NOT_READY。
  Future<Live> startLive(String id) async {
    try {
      final response = await _dio.post<Map<String, dynamic>>(
        '/api/lives/$id/start',
        data: <String, dynamic>{},
      );
      return _parseLive(response.data);
    } on DioException catch (error) {
      throw _toApiException(error);
    }
  }

  /// 结束直播：live → ended，记录 endedAt；返回最新开播配置与按分钟结算摘要
  /// （billing 为空 = 结算未启用或服务端降级，结束本身不阻断）。
  /// 非直播中（status !== live）服务端返回 400 LIVE_NOT_LIVE。
  Future<LiveEndSummary> endLive(String id) async {
    try {
      final response = await _dio.post<Map<String, dynamic>>(
        '/api/lives/$id/end',
        data: <String, dynamic>{},
      );
      return LiveEndSummary.fromJson(response.data ?? <String, dynamic>{});
    } on DioException catch (error) {
      throw _toApiException(error);
    }
  }

  /// 查询直播中监控快照（客户端轮询用）：状态 + 已播时长 + 弹幕计数。
  Future<LiveMonitor> getLiveMonitor(String id) async {
    try {
      final response = await _dio.get<Map<String, dynamic>>(
        '/api/lives/$id/monitor',
      );
      return LiveMonitor.fromJson(response.data ?? <String, dynamic>{});
    } on DioException catch (error) {
      throw _toApiException(error);
    }
  }

  /// 查询弹幕日志（只读）：按 sentAt 倒序返回最近 N 条。
  Future<List<LiveDanmaku>> getLiveDanmaku(String id, {int? limit}) async {
    try {
      final response = await _dio.get<List<dynamic>>(
        '/api/lives/$id/danmaku',
        queryParameters: <String, dynamic>{'limit': ?limit},
      );
      final data = response.data;
      if (data is List) {
        return data
            .whereType<Map>()
            .map(
              (item) => LiveDanmaku.fromJson(Map<String, dynamic>.from(item)),
            )
            .toList();
      }
      return <LiveDanmaku>[];
    } on DioException catch (error) {
      throw _toApiException(error);
    }
  }

  /// 注入一条弹幕（模拟观众提问 / 联调用）：写入弹幕网关（G3）后会触发
  /// 实时互动引擎（G4）生成回复并由本机语音出口播报（G5）。
  /// 仅直播中的场次可写入（非 live 服务端返回 409 LIVE_NOT_LIVE）。
  Future<LiveDanmaku> postDanmaku(String id, {required String content}) async {
    try {
      final response = await _dio.post<Map<String, dynamic>>(
        '/api/lives/$id/danmaku',
        data: <String, dynamic>{'content': content},
      );
      final raw = response.data?['danmaku'];
      return LiveDanmaku.fromJson(
        raw is Map ? Map<String, dynamic>.from(raw) : <String, dynamic>{},
      );
    } on DioException catch (error) {
      throw _toApiException(error);
    }
  }

  /// 拉取远程出声队列队首一条播报（P1 手机线·助播机出声端轮询用）：
  /// 空队列返回 null（服务端 204）；有内容返回 wav 字节与 jobId
  /// （交付即从服务端删除，无重试语义）。
  Future<SpeechOutItem?> fetchNextOutSpeech() async {
    try {
      final response = await _dio.get<Uint8List?>(
        '/api/out/speech/next',
        options: Options(responseType: ResponseType.bytes),
      );
      if (response.statusCode == 204 ||
          response.data == null ||
          response.data!.isEmpty) {
        return null;
      }
      return SpeechOutItem(
        jobId: response.headers.value('x-speech-job-id'),
        wavBytes: response.data!,
      );
    } on DioException catch (error) {
      throw _toBytesApiException(error);
    }
  }

  /// 二进制错误响应（字节流）按 UTF-8 解出 JSON，透传服务端中文 message，
  /// 与默认 JSON 接口的报错文案口径一致；解析失败退回默认文案。
  ApiException _toBytesApiException(DioException error) {
    final response = error.response;
    final raw = response?.data;
    if (raw is Uint8List && raw.isNotEmpty) {
      try {
        final body = jsonDecode(utf8.decode(raw));
        if (body is Map) {
          final message = body['message']?.toString();
          if (message != null && message.isNotEmpty) {
            return ApiException(
              code: body['error']?.toString() ?? 'HTTP_${response!.statusCode}',
              message: message,
              statusCode: response!.statusCode,
            );
          }
        }
      } catch (_) {
        // 响应体不是 JSON：退回默认文案
      }
    }
    return _toApiException(error);
  }

  /// 从响应体解析 Live：POST/PATCH 形如 { live: {...} }，GET :id 直接返回对象本身。
  Live _parseLive(Map<String, dynamic>? data) {
    final raw = data?['live'];
    if (raw is Map) {
      return Live.fromJson(Map<String, dynamic>.from(raw));
    }
    return Live.fromJson(data ?? <String, dynamic>{});
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
    final rawMatchedWords = body['matchedWords'];
    final matchedWords = rawMatchedWords is List
        ? rawMatchedWords
              .map((item) => item?.toString() ?? '')
              .where((word) => word.isNotEmpty)
              .toList()
        : const <String>[];
    return ApiException(
      code: body['error']?.toString() ?? 'HTTP_${response.statusCode}',
      message:
          body['message']?.toString() ?? _defaultMessage(response.statusCode),
      statusCode: response.statusCode,
      retryAfterSeconds: retryAfterSeconds is num
          ? retryAfterSeconds.toInt()
          : null,
      matchedWords: matchedWords,
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
