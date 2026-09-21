import 'dart:typed_data';

/// 远程出声队列交付的一条播报（P1 手机线·助播机出声端）：
/// 服务端把合成好的 wav 交到远程队列后，助播机通过轮询接口取走。
/// 拉取成功即视为交付（已出声语义），文件在服务端随响应清理。
class SpeechOutItem {
  const SpeechOutItem({required this.jobId, required this.wavBytes});

  /// 服务端下发的播报唯一 id（响应头 x-speech-job-id），联调 / 日志定位用。
  final String? jobId;

  /// wav 音频字节：交给本机播放器出声（经音频转接线进入开播手机）。
  final Uint8List wavBytes;
}

/// R61：**待播清单**里的一条（只读，不含字节）。
///
/// 手机先用它问「这场有几条待播」，再逐条走 /next 下载 ——
/// 于是播放与拉取解耦：拉得慢也不影响正在播的。
///
/// 语义边界：**看到清单 ≠ 已取走** —— 服务端的 take 是原子取出，
/// 所以两条 App 同时拉也不会重复播。
class SpeechPendingItem {
  const SpeechPendingItem({required this.jobId, this.liveId});

  /// 服务端下发的播报唯一 id。
  final String jobId;

  /// 归属场次（服务端未标记时为空）。
  final String? liveId;
}

