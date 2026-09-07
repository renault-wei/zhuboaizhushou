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
