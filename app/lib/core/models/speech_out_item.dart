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

/// ★R77：`GET /api/out/speech/next` 取号的结果 —— 一个音频 URL + **本条播完后的间隔**。
///
/// 为什么间隔要跟着 URL 一起回来（2026-09-22 真机实测「循环过快、似乎没有等待」）：
///   服务端台本以 ~1 秒/条 入队（远程 sink 是入队即返回），而音频本身有 4.9~9.7 秒；
///   我们的播放端原先**一秒不歇**（`onComplete` → 立刻播下一条）✗，
///   台本里那点间隔被队列完全吸收，用户永远听不到 ✓
/// 竞品 xcai1618 把间隔放在**播放端**（`bgAudio.onEnded` → `setTimeout(Endlater, n)`），
/// 我们据此把服务端的 `gapAfterSeconds` 随条目一路下发到这里 ✓
/// ★★C：条目的**种类** —— 循环台本 / 弹幕回复 / 氛围语。
///
/// 为什么必须显式带上：C 之后循环位置归客户端（游标 `seq`）✓，
///   而**插播不占台本的序号** ✗ —— 客户端必须能判断「这条播完要不要推进游标」✓
/// 对照竞品：它也是分开的 —— 主循环 `audioArray` / 插播 `suiyyin_fu`、`suiyyin_zhu`，
///   `nextsuia()` 先看插播、再看主循环 ✓
enum SpeechJobKind {
  /// 循环台本句（播完 → 游标 +1）
  script,
  /// 弹幕回复插播（播完 → 游标不动）
  reply,
  /// 氛围语插播（播完 → 游标不动）
  atmosphere,
}

/// ★C：按序号取音频的结果（三态）✓
class SpeechItemResult {
  const SpeechItemResult({this.job, this.outOfRange = false, this.noScript = false});

  /// 取到了 ✓
  final SpeechAudioJob? job;

  /// 序号超出本场台本（服务端 409 SEQ_OUT_OF_RANGE）→ 客户端回绕到第 1 条 ✓
  final bool outOfRange;

  /// 本场未绑定循环台本（409 LOOP_SCRIPT_REQUIRED）→ 只播插播，不是错误 ✓
  final bool noScript;
}

/// 解析种类名：未知 / 缺失按 script 处理（旧格式里只有台本条目 ✓）
SpeechJobKind speechJobKindFromName(String? name) {
  return switch (name) {
    'reply' => SpeechJobKind.reply,
    'atmosphere' => SpeechJobKind.atmosphere,
    _ => SpeechJobKind.script,
  };
}

class SpeechAudioJob {
  const SpeechAudioJob({
    required this.url,
    this.gapAfterSeconds = 0,
    this.kind = SpeechJobKind.script,
  });

  /// 音频的**绝对 URL**（原生播放器直接 GET，Dart 侧不搬字节 ✓）
  final String url;

  /// 本条播完之后要等的秒数（0 = 不等，立刻播下一条）
  final double gapAfterSeconds;

  /// ★C：条目种类 —— 决定「播完要不要推进台本游标」✓
  final SpeechJobKind kind;

  Map<String, Object?> toJson() => <String, Object?>{
    'url': url,
    'gap': gapAfterSeconds,
    'kind': kind.name,
  };

  /// 解析一条。**兼容 R74 的旧格式**（纯 URL 字符串 → 按 gap=0 处理 ✓）——
  /// 用户手机上可能还存着升级前写下的待播队列，不能因为换了格式就把它丢掉 ✗
  static SpeechAudioJob? fromJson(Object? raw) {
    if (raw is String) {
      return raw.isEmpty ? null : SpeechAudioJob(url: raw);
    }
    if (raw is Map) {
      final url = raw['url']?.toString() ?? '';
      if (url.isEmpty) {
        return null;
      }
      final gap = raw['gap'];
      return SpeechAudioJob(
        url: url,
        gapAfterSeconds: gap is num ? gap.toDouble() : 0,
        kind: speechJobKindFromName(raw['kind']?.toString()),
      );
    }
    return null;
  }
}

