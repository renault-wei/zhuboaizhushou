/// TTS 分段预览结果（R19）：这段文本在合成层会被切成几段、切在哪。
///
/// 为什么要让用户看见：放开 200 字业务限制后（A5-2），长话术走的是
/// 「按标点切段 → 逐段合成 → 拼回单段音频」。份数本身不影响听感，**断点落在哪才影响** ——
/// 断点必须落在标点上，听感才不会有句中停顿。所以这里把每段的字数与正文都带回来。
///
/// 份数一律以**服务端**的 `splitTtsSegments` 为准；客户端不另写一份实现
/// （两份实现一定会漂移，届时看到的份数就不是实际合成的份数）。
class TtsSegmentPreview {
  const TtsSegmentPreview({
    required this.maxCharsPerRequest,
    required this.charCount,
    required this.segmentCount,
    required this.segmentCharCounts,
  });

  factory TtsSegmentPreview.fromJson(Map<String, dynamic> json) {
    final raw = json['segments'];
    return TtsSegmentPreview(
      maxCharsPerRequest: (json['maxCharsPerRequest'] as num?)?.toInt() ?? 0,
      charCount: (json['charCount'] as num?)?.toInt() ?? 0,
      segmentCount: (json['segmentCount'] as num?)?.toInt() ?? 0,
      segmentCharCounts: raw is List
          ? raw
                .whereType<Map>()
                .map((item) => (item['chars'] as num?)?.toInt() ?? 0)
                .toList()
          : const <int>[],
    );
  }

  /// 合成层单次请求的字数上限（服务端口径，通常是 200）
  final int maxCharsPerRequest;
  final int charCount;
  final int segmentCount;

  /// 每段的字数（顺序与合成顺序一致），用于展示断点分布
  final List<int> segmentCharCounts;
}
