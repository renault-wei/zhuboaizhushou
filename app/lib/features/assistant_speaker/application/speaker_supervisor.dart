import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:starvoice_app/core/models/live.dart';
import 'package:starvoice_app/providers.dart';

/// 控制器把「本次出声属于哪个场次」记在这里（跨进程重启也能读回）。
const String speakerLiveIdKey = 'assistant_speaker_live_id';

/// R68：**助播出声的应用级监督者**。
///
/// 为什么需要它（2026-09-22 真机定位结论）：
///   出声的**启动**原先只有一条路 —— 监控页 `_loadMonitor()` 里那句
///   `status == live → _syncSpeakerAutoStart()` ✗。
///   于是「页面不在（切后台 / 被回收 / App 重启）= 永远起不来」✗，
///   表现就是用户看到的「后台阻塞、切回前台才通」。
///
/// 本监督者把这件事从页面里拿出来：
///   · 只认【服务端场次状态】这一权威事实，不认任何页面是否活着 ✓
///   · 场次在播且出声没在跑 → 拉起来（幂等）✓
///   · 场次进入终态 → 收口并忘掉它 ✓
/// 与 R59 服务端那套「重启后恢复进行中的直播」是同一个思路 ✓。
class SpeakerSupervisor {
  SpeakerSupervisor(this._ref);

  final Ref _ref;
  Timer? _timer;
  bool _running = false;

  /// 复查间隔：出声的启停不该依赖秒级精度，30 秒足够；
  /// 太密会在低端机上白耗电（这事我们已经在内存那一段吃过教训）。
  static const Duration _interval = Duration(seconds: 30);

  void start() {
    if (_running) {
      return;
    }
    _running = true;
    // 先立刻跑一次（App 刚起来时最需要），再按周期复查
    unawaited(_tick());
    _timer = Timer.periodic(_interval, (_) => unawaited(_tick()));
  }

  void dispose() {
    _timer?.cancel();
    _timer = null;
    _running = false;
  }

  Future<void> _tick() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      final liveId = prefs.getString(speakerLiveIdKey);
      if (liveId == null || liveId.isEmpty) {
        return;
      }
      final live = await _ref.read(apiClientProvider).getLive(liveId);
      final controller = _ref.read(assistantSpeakerControllerProvider.notifier);
      if (live.status == LiveStatus.live) {
        // 幂等：已在跑就什么都不做（start 内部会挡）
        controller.start(liveId: liveId);
        return;
      }
      if (live.status == LiveStatus.ended || live.status == LiveStatus.failed) {
        controller.stop();
        await prefs.remove(speakerLiveIdKey);
      }
    } catch (_) {
      // 未登录 / 网络抖动 / 场次已删：一律静默 ——
      // 监督者是保命机制，不能因为一次失败就自杀或打扰用户。
    }
  }
}

/// 应用级单例（非 autoDispose：它要活到进程结束）。
final speakerSupervisorProvider = Provider<SpeakerSupervisor>((ref) {
  final supervisor = SpeakerSupervisor(ref);
  ref.onDispose(supervisor.dispose);
  return supervisor;
});
