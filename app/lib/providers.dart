import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import 'package:starvoice_app/core/config/api_config.dart';
import 'package:starvoice_app/core/network/api_client.dart';
import 'package:starvoice_app/core/network/auth_interceptor.dart';
import 'package:starvoice_app/core/storage/session_storage.dart';
import 'package:starvoice_app/core/storage/voice_cache_store.dart';
import 'package:starvoice_app/features/auth/application/auth_controller.dart';
import 'package:starvoice_app/features/coupons/application/coupon_controller.dart';
import 'package:starvoice_app/features/lives/application/live_form_controller.dart';
import 'package:starvoice_app/features/lives/application/live_list_controller.dart';
import 'package:starvoice_app/features/loop_scripts/application/loop_script_controller.dart';
import 'package:starvoice_app/features/assistant_speaker/application/assistant_speaker_controller.dart';
import 'package:starvoice_app/features/assistant_speaker/application/speech_out_player.dart';
import 'package:starvoice_app/features/assistant_speaker/data/audioplayers_speech_out_player.dart';
import 'package:starvoice_app/features/recording/application/recorder_controller.dart';
import 'package:starvoice_app/features/scripts/application/script_controller.dart';
import 'package:starvoice_app/features/voices/application/voice_library_controller.dart';
import 'package:starvoice_app/features/wallet/application/wallet_controller.dart';
import 'package:starvoice_app/router/app_router.dart';

/// 本地会话存储
final sessionStorageProvider = Provider<SessionStorage>((ref) {
  return SessionStorage();
});

/// 音色本地缓存：服务端为准，本地仅作网络失败时的回落
/// （预设目录快照 + 生效默认音色 id，供音色库页与开播表单复用）。
final voiceCacheStoreProvider = Provider<VoiceCacheStore>((ref) {
  return VoiceCacheStore();
});

/// 401 事件总线：dio 拦截器与认证控制器解耦，避免 provider 之间的初始化环。
class UnauthorizedBus {
  Future<void> Function()? _listener;

  void setListener(Future<void> Function() listener) {
    _listener = listener;
  }

  void clearListener() {
    _listener = null;
  }

  Future<void> notify() async {
    final listener = _listener;
    if (listener != null) {
      await listener();
    }
  }
}

/// 401 事件总线实例：由 dio 触发、认证控制器订阅。
final unauthorizedBusProvider = Provider<UnauthorizedBus>((ref) {
  return UnauthorizedBus();
});

/// dio 实例：baseUrl 来自 API_BASE_URL define 或平台默认值，挂载鉴权拦截器
final dioProvider = Provider<Dio>((ref) {
  final storage = ref.watch(sessionStorageProvider);
  final unauthorizedBus = ref.watch(unauthorizedBusProvider);
  final dio = Dio(
    BaseOptions(
      baseUrl: ApiConfig.baseUrl,
      connectTimeout: const Duration(seconds: 10),
      receiveTimeout: const Duration(seconds: 15),
    ),
  );
  dio.interceptors.add(
    AuthInterceptor(
      storage: storage,
      // 401：触发事件总线，由认证控制器清理会话并回登录页
      onUnauthorized: unauthorizedBus.notify,
    ),
  );
  return dio;
});

/// 统一 API 客户端
final apiClientProvider = Provider<ApiClient>((ref) {
  return ApiClient(ref.watch(dioProvider));
});

/// 本机出声播放器：助播机出声端与音色试听共用同一实现，抽成 provider
/// 便于 Widget 测试注入假播放器（不触碰平台音频通道）。
final speechOutPlayerProvider = Provider<SpeechOutPlayer>((ref) {
  final player = AudioplayersSpeechOutPlayer();
  ref.onDispose(player.dispose);
  return player;
});

/// 助播机出声端控制器（P1 手机线）：工作台启用后轮询远程出声队列并本机播放。
/// 全局单例（非 autoDispose）：直播中需持续出声，不随某个页面销毁而停；
/// 停用与页面收尾由调用方（工作台）负责调 stop。
final assistantSpeakerControllerProvider =
    StateNotifierProvider<AssistantSpeakerController, AssistantSpeakerState>((
      ref,
    ) {
      return AssistantSpeakerController(
        ref.watch(apiClientProvider),
        ref.watch(speechOutPlayerProvider),
      );
    });

/// 认证控制器：登录态、会话恢复、登录/登出动作
final authControllerProvider = StateNotifierProvider<AuthController, AuthState>(
  (ref) {
    final controller = AuthController(
      ref.watch(sessionStorageProvider),
      ref.watch(apiClientProvider),
    );
    // 订阅 401 事件：token 失效时清理本地会话并回到登录页
    final unauthorizedBus = ref.watch(unauthorizedBusProvider);
    unauthorizedBus.setListener(controller.handleUnauthorized);
    ref.onDispose(() {
      unauthorizedBus.clearListener();
    });
    return controller;
  },
);

/// 全局路由
final routerProvider = Provider<GoRouter>((ref) {
  final router = createAppRouter(ref.read(authControllerProvider.notifier));
  ref.onDispose(router.dispose);
  return router;
});

/// 录音控制器：录音页使用，默认注入 record 插件实现。
final recorderControllerProvider =
    StateNotifierProvider<RecorderController, RecordingState>((ref) {
      return RecorderController(
        RecordPluginRecorder(),
        defaultRecordingsDirectory,
      );
    });

/// 音色库控制器：音色列表 / 克隆状态轮询 / 删除。
/// autoDispose：离开音色库页即销毁并停止轮询定时器，避免无谓请求。
final voiceLibraryControllerProvider =
    StateNotifierProvider.autoDispose<
      VoiceLibraryController,
      VoiceLibraryState
    >((ref) {
      return VoiceLibraryController(
        ref.watch(apiClientProvider),
        cacheStore: ref.watch(voiceCacheStoreProvider),
      );
    });

/// 话术库控制器：话术生成页使用（列表加载 + DeepSeek 生成）。
/// autoDispose：离开话术页即销毁，避免页面级状态长期驻留。
final scriptControllerProvider =
    StateNotifierProvider.autoDispose<ScriptController, ScriptState>((ref) {
      return ScriptController(ref.watch(apiClientProvider));
    });

/// 循环台本库控制器：循环台本列表页使用（列表加载 + 删除，删除后由服务端解绑引用场次）。
/// autoDispose：离开台本库页即销毁，避免页面级状态长期驻留。
final loopScriptControllerProvider =
    StateNotifierProvider.autoDispose<LoopScriptController, LoopScriptState>((
      ref,
    ) {
      return LoopScriptController(ref.watch(apiClientProvider));
    });

/// 团购券控制器：团购券列表页使用。
/// autoDispose：离开券列表页即销毁，避免页面级状态长期驻留。
final couponControllerProvider =
    StateNotifierProvider.autoDispose<CouponController, CouponState>((ref) {
      return CouponController(ref.watch(apiClientProvider));
    });

/// 收银台控制器：钱包总览 + 服务端开关 + 扫码 / 卡密核销动作。
/// autoDispose：离开收银台页即销毁，避免页面级状态长期驻留。
final walletControllerProvider =
    StateNotifierProvider.autoDispose<WalletController, WalletState>((ref) {
      return WalletController(ref.watch(apiClientProvider));
    });

/// 开播配置列表控制器：开播配置列表页使用（列表 + 引用资源名映射 + 删除）。
/// autoDispose：离开开播配置页即销毁，避免页面级状态长期驻留。
final liveListControllerProvider =
    StateNotifierProvider.autoDispose<LiveListController, LiveListState>((ref) {
      return LiveListController(ref.watch(apiClientProvider));
    });

/// 开播配置表单控制器：按 liveId 维度隔离（空串 = 新建，非空 = 编辑）。
/// autoDispose：离开表单页即销毁；编辑页预填依赖 family 参数读取 /api/lives/:id。
final liveFormControllerProvider = StateNotifierProvider.autoDispose
    .family<LiveFormController, LiveFormState, String>((ref, liveId) {
      return LiveFormController(
        ref.watch(apiClientProvider),
        liveId,
        cacheStore: ref.watch(voiceCacheStoreProvider),
      );
    });
