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
    this.failCouponsList = false,
    this.failLoopScriptsList = false,
    List<Map<String, dynamic>>? voices,
    List<Map<String, dynamic>>? scripts,
    List<Map<String, dynamic>>? coupons,
    List<Map<String, dynamic>>? lives,
    List<Map<String, dynamic>>? loopScripts,
    List<Map<String, dynamic>>? danmaku,
    List<Uint8List>? speechOut,
    this.failSpeechOut = false,
    this.balanceMinutes = 120,
    this.monthlyQuotaMinutes = 600,
    this.monthlyUsedMinutes = 120,
    this.showCharge = true,
    this.notice = '',
    this.failWalletLoad = false,
    List<Map<String, dynamic>>? pricePacks,
    List<Map<String, dynamic>>? walletTransactions,
    List<Map<String, dynamic>>? rechargeOrders,
    Map<String, int>? redeemableCards,
  }) : voices = voices ?? <Map<String, dynamic>>[],
       scripts = scripts ?? <Map<String, dynamic>>[],
       coupons = coupons ?? _defaultCoupons(),
       lives = lives ?? <Map<String, dynamic>>[],
       loopScripts = loopScripts ?? <Map<String, dynamic>>[],
       danmaku = danmaku ?? <Map<String, dynamic>>[],
       speechOut = speechOut ?? <Uint8List>[],
       pricePacks = pricePacks ?? _defaultPricePacks(),
       walletTransactions = walletTransactions ?? _defaultWalletTransactions(),
       rechargeOrders = rechargeOrders ?? _defaultRechargeOrders(),
       redeemableCards = redeemableCards ?? <String, int>{'TESTCARD0001': 600};

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

  /// 我的团购券（内存）：结构与服务端 /api/douyin/coupons 返回保持一致。
  final List<Map<String, dynamic>> coupons;

  /// 我的开播配置（内存）：结构与服务端 /api/lives 返回保持一致。
  final List<Map<String, dynamic>> lives;

  /// 我的循环台本（内存）：结构与服务端 /api/loop-scripts 返回保持一致；
  /// 列表接口返回摘要（无 items，itemCount 为服务端统计条数），
  /// 详情 / 新建 / 整体替换返回整本（items 带 id 与 seq）。
  final List<Map<String, dynamic>> loopScripts;
  int _loopScriptSeq = 0;

  /// 我的直播弹幕日志（内存）：结构与服务端 /api/lives/:id/danmaku 返回保持一致；
  /// 弹幕网关写入（G3）后条目带 liveId，供按场次过滤与计数。
  final List<Map<String, dynamic>> danmaku;

  /// 远程出声队列（内存）：结构与服务端 /api/out/speech/next 拉取口径一致；
  /// 每次 GET 交付队首一条（空队列返回 204），并给每条 wav 分配 jobId。
  final List<Uint8List> speechOut;

  /// 模拟出声队列接口 500（测试轮询错误分支）。
  bool failSpeechOut;

  /// 已被助播机拉走的条数（也用作 jobId 序号）。
  int speechOutPulledCount = 0;
  int _liveSeq = 0;
  int _danmakuSeq = 0;

  /// 模拟 DeepSeek 返回的话术全文：生成接口使用，测试可自行配置。
  final String generatedScriptContent;

  /// 模拟我的话术列表接口 500（测试加载失败分支）。
  final bool failScriptsList;

  /// 模拟话术生成接口 500（测试生成失败分支）。
  final bool failScriptGenerate;

  /// 模拟团购券列表接口 500（测试加载失败分支）。
  final bool failCouponsList;

  /// 模拟循环台本列表接口 500（测试加载失败分支）。
  final bool failLoopScriptsList;

  /// —— 收银台（M7）内存账本：钱包 / 扫码单 / 卡密 ——

  /// 时长余额（分钟，跨月不清零）：卡密核销 / 扫码确权会累加。
  int balanceMinutes;

  /// 当月免费直播分钟账本（quota）。
  int monthlyQuotaMinutes;
  int monthlyUsedMinutes;

  /// 充值入口是否展示（服务端开关下发）。
  final bool showCharge;

  /// 公告文案（空串 = 不弹）。
  final String notice;

  /// 服务端下发的时长档位 [{hours, amountCents}]。
  final List<Map<String, dynamic>> pricePacks;

  /// 时长流水（内存）：GET /api/wallet 原样返回。
  final List<Map<String, dynamic>> walletTransactions;

  /// 充值订单（内存）：默认 1 条已到账单，扫码下单会追加。
  final List<Map<String, dynamic>> rechargeOrders;

  /// 扫码单（内存）：POST /api/recharge/scan 追加；poll 只读状态。
  final List<Map<String, dynamic>> scanOrders = <Map<String, dynamic>>[];

  /// 可核销卡密：归一化卡号 → 时长分钟；核销后移入 [redeemedCards]。
  final Map<String, int> redeemableCards;

  /// 已核销卡密集合（幂等：重复核销返回 409）。
  final Set<String> redeemedCards = <String>{};
  int _orderSeq = 0;
  int _txnSeq = 0;

  /// 模拟钱包接口 500（测试加载失败分支）。
  bool failWalletLoad;

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
        return _jsonResponse({
          'error': 'CODE_INVALID',
          'message': '授权码无效或已过期，请重新授权',
        }, 400);
      }
      douyinBound = true;
      return _jsonResponse(_douyinBindStatus());
    }
    if (options.method == 'POST' && path.endsWith('/api/douyin/unbind')) {
      douyinBound = false;
      return _jsonResponse({'bound': false});
    }
    if (options.method == 'GET' && path.endsWith('/api/douyin/coupons')) {
      if (failCouponsList) {
        return _serverError('团购券服务暂不可用');
      }
      if (!douyinBound) {
        return _jsonResponse({
          'error': 'DOUYIN_NOT_BOUND',
          'message': '请先绑定抖音号',
        }, 403);
      }
      return _jsonResponse({
        'coupons': List<Map<String, dynamic>>.from(coupons),
      });
    }
    if (options.method == 'GET' && path.endsWith('/api/agreements/voice')) {
      return _jsonResponse({
        'version': '1.0',
        'title': '声音授权协议',
        'content': fakeVoiceAgreementContent,
      });
    }
    if (options.method == 'GET' &&
        path.endsWith('/api/agreements/voice/status')) {
      return _jsonResponse(_voiceAgreementStatus());
    }
    if (options.method == 'POST' &&
        path.endsWith('/api/agreements/voice/sign')) {
      final body = _readBody(options);
      if (body['version'] != '1.0') {
        return _jsonResponse({
          'error': 'VERSION_MISMATCH',
          'message': '协议版本不匹配，请阅读最新协议后重新签署',
        }, 400);
      }
      if (body['agreed'] != true) {
        return _jsonResponse({
          'error': 'NOT_AGREED',
          'message': '请先阅读并勾选同意《声音授权协议》后再签署',
        }, 400);
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
    // 循环台本域：generate 子路径须先于单段正则匹配，避免被 :id 规则吞掉
    if (options.method == 'POST' &&
        path.endsWith('/api/loop-scripts/generate')) {
      return _generateLoopScript(options);
    }
    final loopScriptItem = RegExp(r'^/api/loop-scripts/([^/]+)$')
        .firstMatch(path);
    if (loopScriptItem != null && options.method == 'GET') {
      return _getLoopScript(loopScriptItem.group(1)!);
    }
    if (loopScriptItem != null && options.method == 'PUT') {
      return _replaceLoopScript(options, loopScriptItem.group(1)!);
    }
    if (loopScriptItem != null && options.method == 'DELETE') {
      return _deleteLoopScript(loopScriptItem.group(1)!);
    }
    if (options.method == 'GET' && path.endsWith('/api/loop-scripts')) {
      return _listLoopScripts();
    }
    if (options.method == 'POST' && path.endsWith('/api/loop-scripts')) {
      return _createLoopScript(options);
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
    if (options.method == 'GET' && path.endsWith('/api/out/speech/next')) {
      return _nextSpeechOut();
    }
    // T11 推流 / 会话子路径：/api/lives/:id 下的子路径（video / prepare /
    // stream-status / start / end / monitor / danmaku）需先于单段正则匹配，
    // 避免被 /api/lives/:id 的 GET/PATCH/DELETE 规则吞掉。
    final liveAction = RegExp(
      r'^/api/lives/([^/]+)/(video|prepare|stream-status|start|end|monitor|danmaku)$',
    ).firstMatch(path);
    if (liveAction != null && options.method == 'POST') {
      switch (liveAction.group(2)) {
        case 'video':
          return _uploadLiveVideo(liveAction.group(1)!, options);
        case 'prepare':
          return _prepareLive(liveAction.group(1)!);
        case 'start':
          return _startLive(liveAction.group(1)!);
        case 'end':
          return _endLive(liveAction.group(1)!);
        case 'danmaku':
          return _postDanmaku(liveAction.group(1)!, options);
      }
    }
    if (liveAction != null && options.method == 'GET') {
      switch (liveAction.group(2)) {
        case 'stream-status':
          return _streamStatus(liveAction.group(1)!);
        case 'monitor':
          return _liveMonitor(liveAction.group(1)!);
        case 'danmaku':
          return _listDanmaku(liveAction.group(1)!, options);
      }
    }
    final liveItem = RegExp(r'^/api/lives/([^/]+)$').firstMatch(path);
    if (liveItem != null && options.method == 'GET') {
      return _getLive(liveItem.group(1)!);
    }
    if (liveItem != null && options.method == 'PATCH') {
      return _updateLive(options, liveItem.group(1)!);
    }
    if (liveItem != null && options.method == 'DELETE') {
      return _deleteLive(liveItem.group(1)!);
    }
    if (options.method == 'GET' && path.endsWith('/api/lives')) {
      return _listLives(options);
    }
    if (options.method == 'POST' && path.endsWith('/api/lives')) {
      return _createLive(options);
    }
    // —— 收银台（M7）：服务端开关 / 钱包总览 / 扫码 / 轮询 / 卡密 ——
    if (options.method == 'GET' && path.endsWith('/api/app/config')) {
      return _jsonResponse({'config': _appConfigPayload()});
    }
    if (options.method == 'GET' && path.endsWith('/api/wallet')) {
      if (failWalletLoad) {
        return _serverError('钱包服务暂不可用');
      }
      return _jsonResponse(_walletPayload());
    }
    if (options.method == 'POST' && path.endsWith('/api/recharge/scan')) {
      return _createRechargeScan(options);
    }
    if (options.method == 'POST' && path.endsWith('/api/recharge/poll')) {
      return _pollRecharge(options);
    }
    if (options.method == 'POST' && path.endsWith('/api/cards/redeem')) {
      return _redeemCard(options);
    }
    return _jsonResponse({'error': 'NOT_FOUND', 'message': '接口不存在'}, 404);
  }

  /// 创建克隆任务：镜像服务端校验（先协议后时长与名称），成功落 pending。
  /// 我的开播配置列表：模拟服务端按 updatedAt desc、最多 50 条，支持 ?status= 过滤。
  ResponseBody _listLives(RequestOptions options) {
    final status = options.queryParameters['status']?.toString();
    final result = <Map<String, dynamic>>[
      for (final live in lives)
        if (status == null || live['status'] == status) live,
    ];
    result.sort((a, b) {
      final aAt = DateTime.tryParse(a['updatedAt']?.toString() ?? '');
      final bAt = DateTime.tryParse(b['updatedAt']?.toString() ?? '');
      return (bAt ?? DateTime.fromMillisecondsSinceEpoch(0)).compareTo(
        aAt ?? DateTime.fromMillisecondsSinceEpoch(0),
      );
    });
    return _jsonResponse(result);
  }

  /// 单查开播配置：不存在统一返回 404（FakeBackend 仅模拟单一用户，等同归属隔离）。
  ResponseBody _getLive(String id) {
    final live = _findLive(id);
    if (live == null) {
      return _jsonResponse({
        'error': 'LIVE_NOT_FOUND',
        'message': '开播配置不存在',
      }, 404);
    }
    return _jsonResponse(live);
  }

  /// 创建开播配置草稿：status=idle、aiBadgeShown=true 由服务端写死，
  /// 请求体即使传 status / aiBadgeShown=false 也忽略，防止篡改合规角标。
  ResponseBody _createLive(RequestOptions options) {
    final body = _readBody(options);
    final title = body['title']?.toString().trim() ?? '';
    if (title.isEmpty || title.length > 100) {
      return _jsonResponse({
        'error': 'LIVE_TITLE_INVALID',
        'message': '直播标题不能为空且不超过 100 字',
      }, 400);
    }
    final voiceId = _liveNullable(body['voiceId']);
    final scriptId = _liveNullable(body['scriptId']);
    if (voiceId != null &&
        voices.indexWhere((voice) => voice['id'] == voiceId) < 0) {
      return _jsonResponse({
        'error': 'VOICE_NOT_OWNED',
        'message': '音色不存在或不属于当前用户',
      }, 400);
    }
    if (scriptId != null &&
        scripts.indexWhere((script) => script['id'] == scriptId) < 0) {
      return _jsonResponse({
        'error': 'SCRIPT_NOT_OWNED',
        'message': '话术不存在或不属于当前用户',
      }, 400);
    }
    final loopScriptId = _liveNullable(body['loopScriptId']);
    if (loopScriptId != null &&
        loopScripts.indexWhere((script) => script['id'] == loopScriptId) < 0) {
      return _jsonResponse({
        'error': 'LOOP_SCRIPT_NOT_OWNED',
        'message': '循环台本不存在或不属于当前用户',
      }, 400);
    }
    final id = _nextLiveId();
    final now = DateTime.now().toUtc();
    final live = <String, dynamic>{
      'id': id,
      'title': title,
      'videoSourceUrl': body['videoSourceUrl']?.toString().trim() ?? '',
      'couponId': _liveNullable(body['couponId']),
      'rtmpUrl': null,
      'voiceId': voiceId,
      'scriptId': scriptId,
      'loopScriptId': loopScriptId,
      'status': 'idle',
      'aiBadgeShown': true,
      'startedAt': null,
      'endedAt': null,
      'createdAt': now.toIso8601String(),
      'updatedAt': now.toIso8601String(),
    };
    lives.insert(0, live);
    return _jsonResponse({'live': live}, 201);
  }

  /// 编辑开播配置：缺省字段保留原值；status / aiBadgeShown 无更新入口，角标恒为 true。
  ResponseBody _updateLive(RequestOptions options, String id) {
    final index = lives.indexWhere((live) => live['id'] == id);
    if (index < 0) {
      return _jsonResponse({
        'error': 'LIVE_NOT_FOUND',
        'message': '开播配置不存在',
      }, 404);
    }
    final body = _readBody(options);
    final updated = <String, dynamic>{...lives[index]};
    if (body.containsKey('title')) {
      final title = body['title']?.toString().trim() ?? '';
      if (title.isEmpty || title.length > 100) {
        return _jsonResponse({
          'error': 'LIVE_TITLE_INVALID',
          'message': '直播标题不能为空且不超过 100 字',
        }, 400);
      }
      updated['title'] = title;
    }
    if (body.containsKey('voiceId')) {
      final voiceId = _liveNullable(body['voiceId']);
      if (voiceId != null &&
          voices.indexWhere((voice) => voice['id'] == voiceId) < 0) {
        return _jsonResponse({
          'error': 'VOICE_NOT_OWNED',
          'message': '音色不存在或不属于当前用户',
        }, 400);
      }
      updated['voiceId'] = voiceId;
    }
    if (body.containsKey('scriptId')) {
      final scriptId = _liveNullable(body['scriptId']);
      if (scriptId != null &&
          scripts.indexWhere((script) => script['id'] == scriptId) < 0) {
        return _jsonResponse({
          'error': 'SCRIPT_NOT_OWNED',
          'message': '话术不存在或不属于当前用户',
        }, 400);
      }
      updated['scriptId'] = scriptId;
    }
    if (body.containsKey('loopScriptId')) {
      final loopScriptId = _liveNullable(body['loopScriptId']);
      if (loopScriptId != null &&
          loopScripts.indexWhere((script) => script['id'] == loopScriptId) <
              0) {
        return _jsonResponse({
          'error': 'LOOP_SCRIPT_NOT_OWNED',
          'message': '循环台本不存在或不属于当前用户',
        }, 400);
      }
      updated['loopScriptId'] = loopScriptId;
    }
    if (body.containsKey('couponId')) {
      updated['couponId'] = _liveNullable(body['couponId']);
    }
    if (body.containsKey('videoSourceUrl')) {
      updated['videoSourceUrl'] =
          body['videoSourceUrl']?.toString().trim() ?? '';
    }
    updated['updatedAt'] = DateTime.now().toUtc().toIso8601String();
    lives[index] = updated;
    return _jsonResponse({'live': updated});
  }

  /// 删除开播配置：仅 idle / ended / failed 可删；live / ready 返回 409（删除保护）。
  ResponseBody _deleteLive(String id) {
    final index = lives.indexWhere((live) => live['id'] == id);
    if (index < 0) {
      return _jsonResponse({
        'error': 'LIVE_NOT_FOUND',
        'message': '开播配置不存在',
      }, 404);
    }
    final status = lives[index]['status'];
    if (status == 'processing' || status == 'live' || status == 'ready') {
      return _jsonResponse({
        'error': 'LIVE_IN_PROGRESS',
        'message': '直播进行中或已就绪，不可删除',
      }, 409);
    }
    lives.removeAt(index);
    return _jsonResponse({'ok': true});
  }

  /// 上传实景视频（multipart 字段 video）：镜像服务端落盘语义，
  /// 把 videoSourceUrl 回填为 /uploads/videos/{id}.mp4。测试不读取文件内容，
  /// 只校验 FormData 里存在名为 video 的文件字段。
  ResponseBody _uploadLiveVideo(String id, RequestOptions options) {
    final index = lives.indexWhere((live) => live['id'] == id);
    if (index < 0) {
      return _jsonResponse({
        'error': 'LIVE_NOT_FOUND',
        'message': '开播配置不存在',
      }, 404);
    }
    final data = options.data;
    final hasVideo =
        data is FormData && data.files.any((entry) => entry.key == 'video');
    if (!hasVideo) {
      return _jsonResponse({
        'error': 'VIDEO_REQUIRED',
        'message': '缺少视频文件（multipart 字段 video）',
      }, 400);
    }
    final now = DateTime.now().toUtc().toIso8601String();
    final updated = <String, dynamic>{
      ...lives[index],
      'videoSourceUrl': '/uploads/videos/$id.mp4',
      'updatedAt': now,
    };
    lives[index] = updated;
    return _jsonResponse({'live': updated});
  }

  /// 触发合成（prepare）：镜像服务端前置校验（视频 / 话术 ready+pass / 音色），
  /// mock 合成瞬间完成，直接把状态推进到 ready（真实 FFmpeg 合成在服务端）。
  ResponseBody _prepareLive(String id) {
    final index = lives.indexWhere((live) => live['id'] == id);
    if (index < 0) {
      return _jsonResponse({
        'error': 'LIVE_NOT_FOUND',
        'message': '开播配置不存在',
      }, 404);
    }
    final live = lives[index];
    if ((live['videoSourceUrl']?.toString() ?? '').isEmpty) {
      return _jsonResponse({
        'error': 'VIDEO_NOT_UPLOADED',
        'message': '请先上传实景视频再生成',
      }, 400);
    }
    final scriptId = _liveNullable(live['scriptId']);
    final script = scriptId == null ? null : _findScript(scriptId);
    final scriptReady =
        script != null &&
        script['status'] == 'ready' &&
        script['sensitiveCheckStatus'] == 'pass';
    if (!scriptReady) {
      return _jsonResponse({
        'error': 'SCRIPT_NOT_READY',
        'message': '话术未就绪或敏感词未通过，不能生成',
      }, 400);
    }
    final voiceId = _liveNullable(live['voiceId']);
    if (voiceId == null ||
        voices.indexWhere((voice) => voice['id'] == voiceId) < 0) {
      return _jsonResponse({
        'error': 'VOICE_NOT_SELECTED',
        'message': '请先绑定可用的音色',
      }, 400);
    }
    final now = DateTime.now().toUtc().toIso8601String();
    final updated = <String, dynamic>{
      ...live,
      'status': 'ready',
      'videoSourceUrl': '/uploads/lives/$id.mp4',
      'updatedAt': now,
    };
    lives[index] = updated;
    return _jsonResponse({'live': updated});
  }

  /// 合成 / 直播状态查询：返回 { status, videoSourceUrl, aiBadgeShown }。
  /// aiBadgeShown 由服务端写死 true，客户端无关闭入口。
  ResponseBody _streamStatus(String id) {
    final live = _findLive(id);
    if (live == null) {
      return _jsonResponse({
        'error': 'LIVE_NOT_FOUND',
        'message': '开播配置不存在',
      }, 404);
    }
    return _jsonResponse(<String, dynamic>{
      'status': live['status'],
      'videoSourceUrl': live['videoSourceUrl'],
      'aiBadgeShown': live['aiBadgeShown'],
    });
  }

  /// 远程出声队列拉取（镜像服务端 /api/out/speech/next）：空队列 204；
  /// 有内容则交付队首 wav 字节并带 x-speech-job-id 头（交付即删除语义）。
  ResponseBody _nextSpeechOut() {
    if (failSpeechOut) {
      return _serverError('出声队列服务暂不可用');
    }
    if (speechOut.isEmpty) {
      return ResponseBody.fromString('', 204);
    }
    final bytes = speechOut.removeAt(0);
    speechOutPulledCount += 1;
    return ResponseBody.fromBytes(
      bytes,
      200,
      headers: <String, List<String>>{
        'content-type': <String>['audio/wav'],
        'x-speech-job-id': <String>[
          'speech-mock-${speechOutPulledCount.toString().padLeft(3, '0')}',
        ],
      },
    );
  }

  /// 一键开播（镜像服务端 startLive）：ready → live，记录 startedAt 并清空
  /// endedAt；未就绪返回 400 LIVE_NOT_READY。
  ResponseBody _startLive(String id) {
    final index = lives.indexWhere((live) => live['id'] == id);
    if (index < 0) {
      return _jsonResponse({
        'error': 'LIVE_NOT_FOUND',
        'message': '开播配置不存在',
      }, 404);
    }
    if (lives[index]['status'] != 'ready') {
      return _jsonResponse({
        'error': 'LIVE_NOT_READY',
        'message': '只有合成完成（就绪）的直播才能开播',
      }, 400);
    }
    final now = DateTime.now().toUtc().toIso8601String();
    final updated = <String, dynamic>{
      ...lives[index],
      'status': 'live',
      'startedAt': now,
      'endedAt': null,
      'updatedAt': now,
    };
    lives[index] = updated;
    return _jsonResponse({'live': updated});
  }

  /// 结束直播（镜像服务端 endLive）：live → ended，记录 endedAt；
  /// 非直播中返回 400 LIVE_NOT_LIVE。
  ResponseBody _endLive(String id) {
    final index = lives.indexWhere((live) => live['id'] == id);
    if (index < 0) {
      return _jsonResponse({
        'error': 'LIVE_NOT_FOUND',
        'message': '开播配置不存在',
      }, 404);
    }
    if (lives[index]['status'] != 'live') {
      return _jsonResponse({
        'error': 'LIVE_NOT_LIVE',
        'message': '只有直播中的场次才能结束',
      }, 400);
    }
    final now = DateTime.now().toUtc().toIso8601String();
    final updated = <String, dynamic>{
      ...lives[index],
      'status': 'ended',
      'endedAt': now,
      'updatedAt': now,
    };
    lives[index] = updated;
    return _jsonResponse({'live': updated});
  }

  /// 直播中监控快照（镜像服务端 getLiveMonitor）：状态 + 已播时长 + 弹幕计数。
  ResponseBody _liveMonitor(String id) {
    final live = _findLive(id);
    if (live == null) {
      return _jsonResponse({
        'error': 'LIVE_NOT_FOUND',
        'message': '开播配置不存在',
      }, 404);
    }
    var durationSeconds = 0;
    final startedAt = DateTime.tryParse(live['startedAt']?.toString() ?? '');
    final endedAt = DateTime.tryParse(live['endedAt']?.toString() ?? '');
    if (live['status'] == 'live' && startedAt != null) {
      durationSeconds =
          (DateTime.now().millisecondsSinceEpoch -
              startedAt.millisecondsSinceEpoch) ~/
          1000;
    } else if (live['status'] == 'ended' &&
        startedAt != null &&
        endedAt != null) {
      durationSeconds =
          (endedAt.millisecondsSinceEpoch - startedAt.millisecondsSinceEpoch) ~/
          1000;
    }
    if (durationSeconds < 0) {
      durationSeconds = 0;
    }
    return _jsonResponse(<String, dynamic>{
      'status': live['status'],
      'videoSourceUrl': live['videoSourceUrl'],
      'aiBadgeShown': live['aiBadgeShown'],
      'startedAt': live['startedAt'],
      'endedAt': live['endedAt'],
      'durationSeconds': durationSeconds,
      'danmakuCount': _danmakuFor(id).length,
      'loopRunning': live['loopRunning'] == true,
      'loopRound': (live['loopRound'] as num?)?.toInt() ?? 0,
      'loopCurrentSeq': (live['loopCurrentSeq'] as num?)?.toInt() ?? 0,
      'loopMissing': live['loopMissing'] == true,
    });
  }

  /// 弹幕日志（只读）：按 sentAt 倒序取最近 N 条（缺省 50，镜像服务端）。
  ResponseBody _listDanmaku(String id, RequestOptions options) {
    final live = _findLive(id);
    if (live == null) {
      return _jsonResponse({
        'error': 'LIVE_NOT_FOUND',
        'message': '开播配置不存在',
      }, 404);
    }
    var limit = 50;
    final rawLimit = options.queryParameters['limit'];
    if (rawLimit != null) {
      final parsed = int.tryParse(rawLimit.toString());
      if (parsed == null || parsed < 1) {
        return _jsonResponse({
          'error': 'LIMIT_INVALID',
          'message': 'limit 必须为正整数',
        }, 400);
      }
      limit = parsed;
    }
    final items = List<Map<String, dynamic>>.of(_danmakuFor(id))
      ..sort((a, b) {
        final aAt = DateTime.tryParse(a['sentAt']?.toString() ?? '');
        final bAt = DateTime.tryParse(b['sentAt']?.toString() ?? '');
        return (bAt ?? DateTime.fromMillisecondsSinceEpoch(0)).compareTo(
          aAt ?? DateTime.fromMillisecondsSinceEpoch(0),
        );
      });
    return _jsonResponse(items.take(limit).toList());
  }

  /// 弹幕写入（G3 弹幕网关写入侧模拟）：仅直播中的场次可写，镜像服务端
  /// 校验与错误码（内容非法 400 / 非直播中 409 / 不存在 404），成功 201。
  ResponseBody _postDanmaku(String id, RequestOptions options) {
    final live = _findLive(id);
    if (live == null) {
      return _jsonResponse({
        'error': 'LIVE_NOT_FOUND',
        'message': '开播配置不存在',
      }, 404);
    }
    final body = _readBody(options);
    final content = body['content']?.toString().trim() ?? '';
    if (content.isEmpty || content.length > 200) {
      return _jsonResponse({
        'error': 'CONTENT_INVALID',
        'message': '弹幕内容不能为空且不超过 200 字',
      }, 400);
    }
    if (live['status'] != 'live') {
      return _jsonResponse({
        'error': 'LIVE_NOT_LIVE',
        'message': '只有直播中的场次才能接收弹幕（当前：${live['status']}）',
      }, 409);
    }
    final rawNickname = body['senderNickname']?.toString().trim() ?? '';
    final senderNickname = rawNickname.isEmpty
        ? null
        : (rawNickname.length <= 50
              ? rawNickname
              : rawNickname.substring(0, 50));
    _danmakuSeq += 1;
    final record = <String, dynamic>{
      'id': 'dm-${_danmakuSeq.toString().padLeft(4, '0')}',
      'liveId': id,
      'content': content,
      'senderNickname': senderNickname,
      'sentAt': DateTime.now().toUtc().toIso8601String(),
    };
    danmaku.insert(0, record);
    return _jsonResponse({'danmaku': record}, 201);
  }

  /// 某场次下的弹幕条目（按 liveId 过滤；预置条目必须带 liveId）。
  List<Map<String, dynamic>> _danmakuFor(String liveId) {
    return <Map<String, dynamic>>[
      for (final item in danmaku)
        if (item['liveId']?.toString() == liveId) item,
    ];
  }

  Map<String, dynamic>? _findLive(String id) {
    for (final live in lives) {
      if (live['id'] == id) {
        return live;
      }
    }
    return null;
  }

  /// 生成不与预置用例冲突的 live id：预置为 live-001 时自动顺延，避免覆盖。
  String _nextLiveId() {
    var maxSeq = 0;
    for (final live in lives) {
      final match = RegExp(r'^live-(\d+)$')
          .firstMatch(live['id']?.toString() ?? '');
      final seq = int.tryParse(match?.group(1) ?? '') ?? 0;
      if (seq > maxSeq) {
        maxSeq = seq;
      }
    }
    if (_liveSeq <= maxSeq) {
      _liveSeq = maxSeq + 1;
    }
    final id = 'live-${_liveSeq.toString().padLeft(3, '0')}';
    _liveSeq += 1;
    return id;
  }

  /// 可空字段归一化：null / 空串统一转 null，与服务端语义保持一致。
  String? _liveNullable(Object? raw) {
    final value = raw?.toString().trim() ?? '';
    return value.isEmpty ? null : value;
  }

  ResponseBody _createVoice(RequestOptions options) {
    if (!agreementSigned) {
      return _jsonResponse({
        'error': 'AGREEMENT_REQUIRED',
        'message': '克隆声音前需先签署《声音授权协议》',
      }, 403);
    }
    final body = _readBody(options);
    final rawName = body['name'];
    final name = rawName is String ? rawName.trim() : '';
    final rawDuration = body['sampleDurationSeconds'];
    final duration = rawDuration is num ? rawDuration.toInt() : 0;
    if (duration < 60) {
      return _jsonResponse({
        'error': 'DURATION_TOO_SHORT',
        'message': '录音时长不足 1 分钟',
      }, 400);
    }
    if (name.isEmpty || name.length > 50) {
      return _jsonResponse({
        'error': 'NAME_INVALID',
        'message': '音色名称不能为空且不超过 50 字',
      }, 400);
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
      return _jsonResponse({
        'error': 'VOICE_NOT_FOUND',
        'message': '音色不存在',
      }, 404);
    }
    final voice = voices[index];
    final status = voice['status'];
    if (status == 'pending' || status == 'processing') {
      final createdAt =
          DateTime.tryParse(voice['createdAt']?.toString() ?? '') ??
          DateTime.now().toUtc();
      final elapsedMs = DateTime.now()
          .toUtc()
          .difference(createdAt)
          .inMilliseconds;
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
      return _jsonResponse({
        'error': 'VOICE_NOT_FOUND',
        'message': '音色不存在',
      }, 404);
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
      return _jsonResponse({
        'error': 'INDUSTRY_INVALID',
        'message': '不支持的行业类型',
      }, 400);
    }
    final rawProduct = body['product'];
    if (rawProduct is! Map || rawProduct.isEmpty) {
      return _jsonResponse({
        'error': 'PRODUCT_INVALID',
        'message': '商品信息不能为空',
      }, 400);
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
      return _jsonResponse({
        'error': 'SCRIPT_NOT_FOUND',
        'message': '话术不存在',
      }, 404);
    }
    return _jsonResponse(script);
  }

  /// 编辑保存话术：重新扫描敏感词并同步 status / 命中词。
  ResponseBody _updateScript(RequestOptions options, String id) {
    final script = _findScript(id);
    if (script == null) {
      return _jsonResponse({
        'error': 'SCRIPT_NOT_FOUND',
        'message': '话术不存在',
      }, 404);
    }
    final body = _readBody(options);
    final rawContent = body['content'];
    if (rawContent is! String || rawContent.trim().isEmpty) {
      return _jsonResponse({
        'error': 'CONTENT_REQUIRED',
        'message': '话术内容不能为空',
      }, 400);
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

  // ---------- 循环台本域（镜像 /api/loop-scripts）----------

  /// 我的循环台本列表：镜像服务端按 updatedAt desc、最多 50 条，返回摘要（无 items）。
  ResponseBody _listLoopScripts() {
    if (failLoopScriptsList) {
      return _serverError('循环台本列表服务暂不可用');
    }
    final summaries = <Map<String, dynamic>>[
      for (final script in loopScripts) _loopScriptSummaryOf(script),
    ];
    summaries.sort((a, b) {
      final aAt = DateTime.tryParse(a['updatedAt']?.toString() ?? '');
      final bAt = DateTime.tryParse(b['updatedAt']?.toString() ?? '');
      return (bAt ?? DateTime.fromMillisecondsSinceEpoch(0)).compareTo(
        aAt ?? DateTime.fromMillisecondsSinceEpoch(0),
      );
    });
    return _jsonResponse(summaries);
  }

  /// 列表摘要视图：id / title / sourceScriptId / itemCount / 时间戳。
  Map<String, dynamic> _loopScriptSummaryOf(Map<String, dynamic> script) {
    final items = script['items'];
    return <String, dynamic>{
      'id': script['id'],
      'title': script['title'],
      'sourceScriptId': script['sourceScriptId'],
      'itemCount': items is List ? items.length : (script['itemCount'] ?? 0),
      'createdAt': script['createdAt'],
      'updatedAt': script['updatedAt'],
    };
  }

  /// 单查循环台本：找不到统一返回 404（FakeBackend 仅模拟单一用户，等同归属隔离）。
  ResponseBody _getLoopScript(String id) {
    final script = _findLoopScript(id);
    if (script == null) {
      return _jsonResponse({
        'error': 'LOOP_SCRIPT_NOT_FOUND',
        'message': '循环台本不存在',
      }, 404);
    }
    return _jsonResponse(script);
  }

  Map<String, dynamic>? _findLoopScript(String id) {
    for (final script in loopScripts) {
      if (script['id'] == id) {
        return script;
      }
    }
    return null;
  }

  /// 生成不与预置用例冲突的循环台本 id：预置为 loop-001 时自动顺延，避免覆盖。
  String _nextLoopScriptId() {
    var maxSeq = 0;
    for (final script in loopScripts) {
      final match = RegExp(r'^loop-(\d+)$')
          .firstMatch(script['id']?.toString() ?? '');
      final seq = int.tryParse(match?.group(1) ?? '') ?? 0;
      if (seq > maxSeq) {
        maxSeq = seq;
      }
    }
    if (_loopScriptSeq <= maxSeq) {
      _loopScriptSeq = maxSeq + 1;
    }
    final id = 'loop-${_loopScriptSeq.toString().padLeft(3, '0')}';
    _loopScriptSeq += 1;
    return id;
  }

  /// 归一化台本条目（镜像服务端 normalizeItems）：条数 1-12、文本 1-200 字、
  /// kind 落白名单否则 null、间隔 0-60 否则 null；非法返回 null + 错误。
  (List<Map<String, dynamic>>?, ({String code, String message})?)
  _normalizeLoopItems(Object? raw) {
    if (raw is! List) {
      return (null, (code: 'ITEMS_INVALID', message: '台本条目必须是非空数组'));
    }
    if (raw.isEmpty || raw.length > 12) {
      return (null, (code: 'ITEMS_INVALID', message: '台本条目数需在 1-12 条之间'));
    }
    const kinds = <String>[
      'opening',
      'product',
      'coupon',
      'warmup',
      'closing',
      'custom',
    ];
    final items = <Map<String, dynamic>>[];
    for (var index = 0; index < raw.length; index += 1) {
      final element = raw[index];
      if (element is! Map) {
        return (
          null,
          (code: 'ITEMS_INVALID', message: '第 ${index + 1} 条台本格式不正确'),
        );
      }
      final text = element['text']?.toString().trim() ?? '';
      if (text.isEmpty) {
        return (
          null,
          (code: 'ITEM_TEXT_REQUIRED', message: '第 ${index + 1} 条台词不能为空'),
        );
      }
      if (text.length > 200) {
        return (
          null,
          (code: 'ITEM_TEXT_TOO_LONG', message: '第 ${index + 1} 条台词不能超过 200 字'),
        );
      }
      final rawKind = element['kind'];
      final kind = rawKind is String && kinds.contains(rawKind)
          ? rawKind
          : null;
      int? gapAfterSeconds;
      final rawGap = element['gapAfterSeconds'];
      if (rawGap is num &&
          rawGap == rawGap.roundToDouble() &&
          rawGap >= 0 &&
          rawGap <= 60) {
        gapAfterSeconds = rawGap.toInt();
      }
      items.add(<String, dynamic>{
        'kind': kind,
        'text': text,
        'gapAfterSeconds': gapAfterSeconds,
      });
    }
    return (items, null);
  }

  /// 逐条扫敏感词：命中任一 → 汇总去重命中词（镜像服务端 scanItems）。
  List<String> _scanLoopItems(List<Map<String, dynamic>> items) {
    final matched = <String>[];
    for (final item in items) {
      final scan = _scanSensitive(item['text']?.toString() ?? '');
      final words = scan['matchedWords'];
      if (words is List) {
        for (final word in words) {
          final value = word.toString();
          if (!matched.contains(value)) {
            matched.add(value);
          }
        }
      }
    }
    return matched;
  }

  /// 落库形状：给归一化条目补 id 与 seq（seq 从 1 起，镜像服务端 replaceItemsTx）。
  List<Map<String, dynamic>> _seedLoopItems(
    String headerId,
    List<Map<String, dynamic>> items,
  ) {
    return <Map<String, dynamic>>[
      for (var index = 0; index < items.length; index += 1)
        <String, dynamic>{
          'id': '$headerId-item-${index + 1}',
          'seq': index + 1,
          'kind': items[index]['kind'],
          'text': items[index]['text'],
          'gapAfterSeconds': items[index]['gapAfterSeconds'],
        },
    ];
  }

  /// 新建循环台本：标题 1-100 字、条目逐条过敏感词（命中 400 不落库）；
  /// sourceScriptId 可选但须归属当前用户。
  ResponseBody _createLoopScript(RequestOptions options) {
    final body = _readBody(options);
    final title = body['title']?.toString().trim() ?? '';
    if (title.isEmpty || title.length > 100) {
      return _jsonResponse({
        'error': 'TITLE_INVALID',
        'message': '台本标题不能为空且不超过 100 字',
      }, 400);
    }
    final normalized = _normalizeLoopItems(body['items']);
    final items = normalized.$1;
    final itemError = normalized.$2;
    if (items == null) {
      return _jsonResponse({
        'error': itemError!.code,
        'message': itemError.message,
      }, 400);
    }
    final sourceScriptId = _liveNullable(body['sourceScriptId']);
    if (sourceScriptId != null && _findScript(sourceScriptId) == null) {
      return _jsonResponse({
        'error': 'SCRIPT_NOT_FOUND',
        'message': '话术不存在或不属于当前用户',
      }, 404);
    }
    final matched = _scanLoopItems(items);
    if (matched.isNotEmpty) {
      return _jsonResponse({
        'error': 'SENSITIVE_BLOCKED',
        'message': '台本包含被拦截用语，请修改后再保存',
        'matchedWords': matched,
      }, 400);
    }
    final id = _nextLoopScriptId();
    final nowIso = DateTime.now().toUtc().toIso8601String();
    final script = <String, dynamic>{
      'id': id,
      'title': title,
      'sourceScriptId': sourceScriptId,
      'createdAt': nowIso,
      'updatedAt': nowIso,
      'items': _seedLoopItems(id, items),
    };
    loopScripts.insert(0, script);
    return _jsonResponse(script, 201);
  }

  /// 整体替换循环台本：标题与条目全量重写（引用它的场次待下次开播生效）。
  ResponseBody _replaceLoopScript(RequestOptions options, String id) {
    final index = loopScripts.indexWhere((script) => script['id'] == id);
    if (index < 0) {
      return _jsonResponse({
        'error': 'LOOP_SCRIPT_NOT_FOUND',
        'message': '循环台本不存在',
      }, 404);
    }
    final body = _readBody(options);
    final title = body['title']?.toString().trim() ?? '';
    if (title.isEmpty || title.length > 100) {
      return _jsonResponse({
        'error': 'TITLE_INVALID',
        'message': '台本标题不能为空且不超过 100 字',
      }, 400);
    }
    final normalized = _normalizeLoopItems(body['items']);
    final items = normalized.$1;
    final itemError = normalized.$2;
    if (items == null) {
      return _jsonResponse({
        'error': itemError!.code,
        'message': itemError.message,
      }, 400);
    }
    final matched = _scanLoopItems(items);
    if (matched.isNotEmpty) {
      return _jsonResponse({
        'error': 'SENSITIVE_BLOCKED',
        'message': '台本包含被拦截用语，请修改后再保存',
        'matchedWords': matched,
      }, 400);
    }
    final existing = loopScripts[index];
    final updated = <String, dynamic>{
      ...existing,
      'title': title,
      'items': _seedLoopItems(id, items),
      'updatedAt': DateTime.now().toUtc().toIso8601String(),
    };
    loopScripts[index] = updated;
    return _jsonResponse(updated);
  }

  /// 删除循环台本：先解除引用它的开播配置（loopScriptId 置 null），再删除。
  ResponseBody _deleteLoopScript(String id) {
    final index = loopScripts.indexWhere((script) => script['id'] == id);
    if (index < 0) {
      return _jsonResponse({
        'error': 'LOOP_SCRIPT_NOT_FOUND',
        'message': '循环台本不存在',
      }, 404);
    }
    for (var i = 0; i < lives.length; i += 1) {
      if (lives[i]['loopScriptId'] == id) {
        lives[i] = <String, dynamic>{...lives[i], 'loopScriptId': null};
      }
    }
    loopScripts.removeAt(index);
    return _jsonResponse({'ok': true});
  }

  /// 模拟 DeepSeek 生成循环台本草稿（M2，不落库）：seed 文案固定合规，
  /// 命中拦截词才触发整组改写；返回 items 供「预览后保存」。
  ResponseBody _generateLoopScript(RequestOptions options) {
    final body = _readBody(options);
    final sourceScriptId = _liveNullable(body['sourceScriptId']);
    if (sourceScriptId == null) {
      return _jsonResponse({
        'error': 'SCRIPT_REQUIRED',
        'message': '必须指定来源话术才能生成循环台本',
      }, 400);
    }
    var itemCount = 6;
    final rawCount = body['itemCount'];
    if (rawCount != null) {
      final parsed = num.tryParse(rawCount.toString());
      if (parsed == null ||
          parsed != parsed.roundToDouble() ||
          parsed < 1 ||
          parsed > 12) {
        return _jsonResponse({
          'error': 'ITEM_COUNT_INVALID',
          'message': '期望条目数需在 1-12 之间',
        }, 400);
      }
      itemCount = parsed.toInt();
    }
    final source = _findScript(sourceScriptId);
    if (source == null) {
      return _jsonResponse({
        'error': 'SCRIPT_NOT_FOUND',
        'message': '话术不存在或不属于当前用户',
      }, 404);
    }
    if (source['status'] != 'ready' ||
        source['sensitiveCheckStatus'] != 'pass') {
      return _jsonResponse({
        'error': 'SCRIPT_REQUIRED',
        'message': '仅支持敏感词扫描通过且已就绪的正式话术生成循环台本',
      }, 422);
    }
    final rawCoupon = body['couponText'];
    final hasCoupon = rawCoupon is String && rawCoupon.trim().isNotEmpty;
    const seeds = <String>[
      '欢迎来到直播间，今天给您介绍几款人气好物。',
      '这款招牌套餐份量足、口味稳定，回头客很多。',
      '现在下单还有限时优惠，到手价非常划算。',
      '套餐里的配菜都可以按口味替换，下单时备注即可。',
      '喜欢的朋友可以点击下方团购链接直接购买。',
      '感谢您的停留，有任何问题欢迎在弹幕里告诉我。',
    ];
    var generationNote = '';
    final texts = <String>[];
    for (var index = 0; texts.length < itemCount; index += 1) {
      final seed = seeds[index % seeds.length];
      final scan = _scanSensitive(seed);
      if (scan['status'] == 'blocked' && generationNote.isEmpty) {
        generationNote = 'AI 初稿含违规表述，已自动改写为合规版本（预览后可保存）';
      }
      texts.add(seed);
    }
    final draft = <Map<String, dynamic>>[];
    for (var index = 0; index < itemCount; index += 1) {
      String kind;
      if (index == 0) {
        kind = 'opening';
      } else if (hasCoupon && index % 3 == 0) {
        kind = 'coupon';
      } else if (index % 4 == 0) {
        kind = 'warmup';
      } else {
        kind = 'product';
      }
      draft.add(<String, dynamic>{
        'kind': kind,
        'text': texts[index],
        'gapAfterSeconds': 6,
      });
    }
    return _jsonResponse(<String, dynamic>{
      'items': draft,
      if (generationNote.isNotEmpty) 'generationNote': generationNote,
    });
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

  /// 模拟运营后台把扫码单确权为 paid（本地验收 mock 通道：收款由人工确权）。
  /// 与 /api/recharge/poll 行为一致：置 paid、补 paidAt 并累加时长余额。
  void confirmScanOrder(String orderId) {
    final orderIndex = scanOrders.indexWhere((item) => item['id'] == orderId);
    if (orderIndex < 0 || scanOrders[orderIndex]['status'] == 'paid') {
      return;
    }
    final order = scanOrders[orderIndex];
    order['status'] = 'paid';
    order['paidAt'] = DateTime.now().toUtc().toIso8601String();
    final minutes = (order['minutes'] as num?)?.toInt() ?? 0;
    _creditBalance(
      minutes: minutes,
      sourceKind: 'recharge_order',
      sourceId: orderId,
      remark: '扫码充值 ${order['hours']} 小时',
    );
  }

  Map<String, dynamic> _appConfigPayload() {
    return <String, dynamic>{
      'showCharge': showCharge,
      'pricePacks': List<Map<String, dynamic>>.from(pricePacks),
      'notice': notice,
      'quotaPriority': <String>['balance', 'quota'],
    };
  }

  Map<String, dynamic> _walletPayload() {
    return <String, dynamic>{
      'balanceMinutes': balanceMinutes,
      'monthlyLive': <String, dynamic>{
        'quotaMinutes': monthlyQuotaMinutes,
        'usedMinutes': monthlyUsedMinutes,
        'remainingMinutes': _remainingQuota(),
      },
      'transactions': List<Map<String, dynamic>>.from(walletTransactions),
      'rechargeOrders': List<Map<String, dynamic>>.from(rechargeOrders),
    };
  }

  int _remainingQuota() {
    final remaining = monthlyQuotaMinutes - monthlyUsedMinutes;
    return remaining > 0 ? remaining : 0;
  }

  ResponseBody _createRechargeScan(RequestOptions options) {
    final body = _readBody(options);
    final hours = (body['hours'] as num?)?.toInt();
    if (hours == null || hours <= 0) {
      return _jsonResponse({
        'error': 'HOURS_INVALID',
        'message': '请选择有效充值时长档位',
      }, 400);
    }
    Map<String, dynamic>? pack;
    for (final item in pricePacks) {
      if ((item['hours'] as num?)?.toInt() == hours) {
        pack = item;
        break;
      }
    }
    if (pack == null) {
      return _jsonResponse({
        'error': 'PACK_INVALID',
        'message': '所选时长不在服务端下发的档位中',
        'packs': List<Map<String, dynamic>>.from(pricePacks),
      }, 400);
    }
    _orderSeq += 1;
    final orderNo = 'rn-mock-2026${_orderSeq.toString().padLeft(4, '0')}';
    final minutes = hours * 60;
    final order = <String, dynamic>{
      'id': 'scan-order-$_orderSeq',
      'orderNo': orderNo,
      'kind': 'recharge',
      'channel': 'alipay_scan',
      'hours': hours,
      'minutes': minutes,
      'amountCents': pack['amountCents'],
      'status': 'pending',
      'paidAt': null,
      'createdAt': DateTime.now().toUtc().toIso8601String(),
    };
    scanOrders.add(order);
    rechargeOrders.insert(0, order);
    return _jsonResponse({
      'order': order,
      'qrcodeUrl': 'mock://alipay-scan/$orderNo',
      'mockChannel': true,
      'message': '扫码单已创建（mock 通道）：暂未产生真实收款，请运营在后台人工确权后入账',
    });
  }

  ResponseBody _pollRecharge(RequestOptions options) {
    final body = _readBody(options);
    final orderId = body['orderId']?.toString() ?? '';
    final orderIndex = scanOrders.indexWhere((item) => item['id'] == orderId);
    if (orderIndex < 0) {
      return _jsonResponse({
        'error': 'ORDER_NOT_FOUND',
        'message': '扫码单不存在',
      }, 404);
    }
    final order = scanOrders[orderIndex];
    final paid = order['status'] == 'paid';
    return _jsonResponse({
      'orderId': order['id'],
      'orderNo': order['orderNo'],
      'status': order['status'],
      'paidAt': paid ? order['paidAt'] : null,
      'amountCents': order['amountCents'],
      'hours': order['hours'],
      if (paid) 'balanceMinutes': balanceMinutes,
    });
  }

  ResponseBody _redeemCard(RequestOptions options) {
    final body = _readBody(options);
    final raw = body['code']?.toString() ?? '';
    final code = raw.replaceAll(RegExp(r'[\s-]'), '').toUpperCase();
    if (code.isEmpty || !redeemableCards.containsKey(code)) {
      return _jsonResponse({
        'error': 'CARD_NOT_FOUND',
        'message': '卡密不存在或已失效',
      }, 404);
    }
    if (redeemedCards.contains(code)) {
      return _jsonResponse({
        'error': 'CARD_REDEEMED',
        'message': '该卡密已被使用，请勿重复提交',
      }, 409);
    }
    redeemedCards.add(code);
    _orderSeq += 1;
    final creditedMinutes = redeemableCards[code] ?? 0;
    final orderId = 'card-order-$_orderSeq';
    final orderNo = 'cd-mock-2026${_orderSeq.toString().padLeft(4, '0')}';
    rechargeOrders.insert(0, <String, dynamic>{
      'id': orderId,
      'orderNo': orderNo,
      'channel': 'card',
      'hours': creditedMinutes ~/ 60,
      'minutes': creditedMinutes,
      'amountCents': 0,
      'status': 'paid',
      'paidAt': DateTime.now().toUtc().toIso8601String(),
      'createdAt': DateTime.now().toUtc().toIso8601String(),
    });
    _creditBalance(
      minutes: creditedMinutes,
      sourceKind: 'card_redeem',
      sourceId: orderId,
      remark: '卡密核销 $code',
    );
    return _jsonResponse({
      'status': 'redeemed',
      'batchId': 'batch-mock',
      'orderId': orderId,
      'orderNo': orderNo,
      'creditedMinutes': creditedMinutes,
      'balanceMinutes': balanceMinutes,
    });
  }

  /// 时长余额入账 + 在流水头部追加一行（与 mapLedgerRow 响应结构一致）。
  void _creditBalance({
    required int minutes,
    required String sourceKind,
    required String sourceId,
    required String remark,
  }) {
    balanceMinutes += minutes;
    _txnSeq += 1;
    walletTransactions.insert(0, <String, dynamic>{
      'id': 'wallet-tx-$_txnSeq',
      'deltaMinutes': minutes,
      'balanceAfterMinutes': balanceMinutes,
      'sourceKind': sourceKind,
      'sourceId': sourceId,
      'remark': remark,
      'createdAt': DateTime.now().toUtc().toIso8601String(),
    });
  }

  static List<Map<String, dynamic>> _defaultPricePacks() {
    return <Map<String, dynamic>>[
      <String, dynamic>{'hours': 1, 'amountCents': 990},
      <String, dynamic>{'hours': 10, 'amountCents': 8990},
    ];
  }

  static List<Map<String, dynamic>> _defaultRechargeOrders() {
    return <Map<String, dynamic>>[
      <String, dynamic>{
        'id': 'order-paid-001',
        'orderNo': 'rn-20260908-001',
        'channel': 'alipay_scan',
        'hours': 1,
        'minutes': 60,
        'amountCents': 990,
        'status': 'paid',
        'paidAt': '2026-09-08T08:50:00.000Z',
        'createdAt': '2026-09-08T08:00:00.000Z',
      },
    ];
  }

  static List<Map<String, dynamic>> _defaultWalletTransactions() {
    return <Map<String, dynamic>>[
      <String, dynamic>{
        'id': 'wallet-tx-001',
        'deltaMinutes': -5,
        'balanceAfterMinutes': 115,
        'sourceKind': 'live_deduct',
        'sourceId': null,
        'remark': '直播在线扣减',
        'createdAt': '2026-09-08T10:00:00.000Z',
      },
      <String, dynamic>{
        'id': 'wallet-tx-000',
        'deltaMinutes': 60,
        'balanceAfterMinutes': 120,
        'sourceKind': 'recharge_order',
        'sourceId': 'order-paid-001',
        'remark': '扫码充值 1 小时',
        'createdAt': '2026-09-08T09:00:00.000Z',
      },
    ];
  }

  /// 模拟服务端 500 错误响应（测试错误分支用）。
  ResponseBody _serverError(String message) {
    return _jsonResponse(<String, dynamic>{
      'error': 'INTERNAL_ERROR',
      'message': message,
    }, 500);
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
    return {'signed': true, 'signedAt': agreementSignedAt, 'version': '1.0'};
  }

  /// 默认团购券列表：与服务端 mock 火锅店券保持一致（5 张）。
  static List<Map<String, dynamic>> _defaultCoupons() {
    return <Map<String, dynamic>>[
      <String, dynamic>{
        'couponId': 'c-001-mock',
        'name': '双人火锅套餐',
        'package': '锅底1份+肥牛1份+羊肉1份+蔬菜拼盘1份+饮料2杯',
        'price': 128,
        'originalPrice': 238,
        'sales': 1200,
        'imageUrl': '',
      },
      <String, dynamic>{
        'couponId': 'c-002-mock',
        'name': '四人火锅套餐',
        'package': '锅底2份+肥牛2份+羊肉2份+海鲜拼盘1份+蔬菜拼盘2份+饮料4杯',
        'price': 268,
        'originalPrice': 468,
        'sales': 860,
        'imageUrl': '',
      },
      <String, dynamic>{
        'couponId': 'c-003-mock',
        'name': '招牌麻辣锅底',
        'package': '牛油麻辣锅底1份（2-4人）',
        'price': 68,
        'originalPrice': 98,
        'sales': 2300,
        'imageUrl': '',
      },
      <String, dynamic>{
        'couponId': 'c-004-mock',
        'name': '现切肥牛券',
        'package': '现切鲜肥牛1份（约200g）',
        'price': 39,
        'originalPrice': 59,
        'sales': 3100,
        'imageUrl': '',
      },
      <String, dynamic>{
        'couponId': 'c-005-mock',
        'name': '饮品畅饮券',
        'package': '酸梅汤/柠檬茶任选2杯',
        'price': 19,
        'originalPrice': 28,
        'sales': 1500,
        'imageUrl': '',
      },
    ];
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
