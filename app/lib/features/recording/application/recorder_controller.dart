import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:path_provider/path_provider.dart';
import 'package:record/record.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// 念稿总段数。
const int recordingSegmentCount = 2;

/// 提交克隆要求的最短总时长（秒）：2 段全完成且总时长 ≥ 1 分钟。
const int minimumTotalSeconds = 60;

/// 实时波形保留的采样点数量。
const int waveformSampleCount = 48;

/// record 插件的最小接口：仅暴露本功能用到的方法，便于测试注入假实现。
abstract class AudioRecorderAdapter {
  Future<bool> hasPermission({bool request = true});

  Future<void> start(RecordConfig config, {required String path});

  Future<void> pause();

  Future<void> resume();

  Future<String?> stop();

  Future<void> cancel();

  Stream<Amplitude> onAmplitudeChanged(Duration interval);

  Future<void> dispose();
}

/// 生产实现：包装 pub.dev 的 record 插件（AudioRecorder）。
class RecordPluginRecorder implements AudioRecorderAdapter {
  final AudioRecorder _inner = AudioRecorder();

  @override
  Future<bool> hasPermission({bool request = true}) {
    return _inner.hasPermission(request: request);
  }

  @override
  Future<void> start(RecordConfig config, {required String path}) {
    return _inner.start(config, path: path);
  }

  @override
  Future<void> pause() => _inner.pause();

  @override
  Future<void> resume() => _inner.resume();

  @override
  Future<String?> stop() => _inner.stop();

  @override
  Future<void> cancel() => _inner.cancel();

  @override
  Stream<Amplitude> onAmplitudeChanged(Duration interval) {
    return _inner.onAmplitudeChanged(interval);
  }

  @override
  Future<void> dispose() => _inner.dispose();
}

/// 单段录音信息：文件名 + 时长，用于 UI 与持久化。
class SegmentRecord {
  const SegmentRecord({required this.fileName, required this.durationSeconds});

  factory SegmentRecord.fromJson(Map<String, dynamic> json) {
    return SegmentRecord(
      fileName: json['fileName']?.toString() ?? '',
      durationSeconds: (json['durationSeconds'] as num?)?.toInt() ?? 0,
    );
  }

  /// 录音文件名，如 segment_01.m4a
  final String fileName;

  /// 该段录音时长（秒）
  final int durationSeconds;

  Map<String, dynamic> toJson() {
    return <String, dynamic>{
      'fileName': fileName,
      'durationSeconds': durationSeconds,
    };
  }
}

/// 录音控制器当前阶段：idle=未录音/本段未开始，recording=录音中，paused=暂停中。
enum RecorderPhase { idle, recording, paused }

/// 录音流程的完整 UI 状态。
class RecordingState {
  const RecordingState({
    required this.segments,
    required this.currentIndex,
    required this.phase,
    required this.elapsedSeconds,
    required this.waveform,
    required this.restoring,
    this.lastCompletedIndex = -1,
    this.errorMessage,
  });

  /// 各段录音结果（下标与念稿一一对应，未录为 null）。
  final List<SegmentRecord?> segments;

  /// 当前聚焦的段（0-1）；为 2 表示 2 段全部完成。
  final int currentIndex;

  final RecorderPhase phase;

  /// 当前段已累计录音秒数（暂停期间不计时）。
  final int elapsedSeconds;

  /// 最近 N 个归一化振幅采样点（0-1），供柱状波形绘制。
  final List<double> waveform;

  /// 是否正在从本地恢复上次进度。
  final bool restoring;

  /// 最近一次「完成本段」的段下标，-1 表示本会话尚未完成过任何段。
  final int lastCompletedIndex;

  /// 最后一次操作错误提示（权限被拒 / 录音启动失败等）。
  final String? errorMessage;

  /// 已完成的段数。
  int get completedCount => segments.where((s) => s != null).length;

  /// 总时长：已完成各段之和；若正在录音/暂停，则叠加当前段已计时长。
  int get totalSeconds {
    var total = 0;
    for (final segment in segments) {
      if (segment != null) {
        total += segment.durationSeconds;
      }
    }
    if (phase != RecorderPhase.idle) {
      total += elapsedSeconds;
    }
    return total;
  }

  /// 当前段是否为「已录过但被选中重录」的状态。
  bool get currentSegmentRecorded {
    if (currentIndex < 0 || currentIndex >= segments.length) {
      return false;
    }
    return segments[currentIndex] != null;
  }

  bool get allSegmentsCompleted => completedCount >= segments.length;
}

/// 录音控制器：封装 record 插件 + 波形采样 + 段落时长与 shared_preferences 持久化。
class RecorderController extends StateNotifier<RecordingState> {
  RecorderController(
    this._recorder,
    this._directoryProvider, {
    DateTime Function()? now,
  }) : _now = now ?? DateTime.now,
       super(
         RecordingState(
           segments: List<SegmentRecord?>.filled(recordingSegmentCount, null),
           currentIndex: 0,
           phase: RecorderPhase.idle,
           elapsedSeconds: 0,
           waveform: const <double>[],
           restoring: true,
         ),
       );

  final AudioRecorderAdapter _recorder;
  final Future<String> Function() _directoryProvider;
  final DateTime Function() _now;

  static const String _storageKey = 'recording_segments_v1';

  StreamSubscription<Amplitude>? _amplitudeSubscription;
  Timer? _ticker;
  DateTime? _activeSince;
  Duration _accumulated = Duration.zero;

  /// 从 shared_preferences 恢复上次录音进度。
  Future<void> init() async {
    final prefs = await SharedPreferences.getInstance();
    final raw = prefs.getString(_storageKey);
    final segments = List<SegmentRecord?>.filled(recordingSegmentCount, null);
    if (raw != null && raw.isNotEmpty) {
      try {
        final decoded = jsonDecode(raw);
        if (decoded is List) {
          for (final item in decoded) {
            if (item is! Map) {
              continue;
            }
            final map = Map<String, dynamic>.from(item);
            final index = (map['index'] as num?)?.toInt();
            if (index == null || index < 0 || index >= recordingSegmentCount) {
              continue;
            }
            segments[index] = SegmentRecord.fromJson(map);
          }
        }
      } catch (_) {
        // 本地缓存损坏时忽略，重新开始
      }
    }
    _emit(
      segments: segments,
      currentIndex: _firstIncompleteIndex(segments) ?? recordingSegmentCount,
      phase: RecorderPhase.idle,
      elapsedSeconds: 0,
      waveform: const <double>[],
      restoring: false,
      errorMessage: null,
    );
  }

  /// 开始录音当前段；若该段已录过则视为重录（成功后覆盖旧记录）。
  Future<void> startCurrentSegment() async {
    if (state.restoring || state.phase != RecorderPhase.idle) {
      return;
    }
    if (state.currentIndex >= recordingSegmentCount) {
      return;
    }
    await _beginRecording();
  }

  /// 从指定段开始录音（用于点选已完成段重录），需处于 idle。
  Future<void> recordSegment(int index) async {
    if (state.restoring ||
        state.phase != RecorderPhase.idle ||
        index < 0 ||
        index >= recordingSegmentCount) {
      return;
    }
    _emit(currentIndex: index, elapsedSeconds: 0, waveform: const <double>[]);
    await _beginRecording();
  }

  /// 回到指定段（仅 idle 状态可用），便于查看/重录历史段。
  Future<void> selectSegment(int index) async {
    if (state.restoring || state.phase != RecorderPhase.idle) {
      return;
    }
    if (index < 0 || index >= recordingSegmentCount) {
      return;
    }
    _emit(
      currentIndex: index,
      elapsedSeconds: 0,
      waveform: const <double>[],
      errorMessage: null,
    );
  }

  Future<void> _beginRecording() async {
    bool granted;
    try {
      granted = await _recorder.hasPermission();
    } catch (_) {
      _emit(errorMessage: '无法访问麦克风，请检查设备后重试');
      return;
    }
    if (!granted) {
      _emit(errorMessage: '需要麦克风权限才能录音，请到系统设置中开启后重试');
      return;
    }

    final index = state.currentIndex;
    final filePath = await _filePathFor(index);
    try {
      await _recorder.start(const RecordConfig(), path: filePath);
    } catch (_) {
      _emit(errorMessage: '录音启动失败，请重试');
      return;
    }

    // 仅在真正开始录音后才清除旧记录，避免权限失败误删历史进度
    final segments = List<SegmentRecord?>.from(state.segments);
    if (segments[index] != null) {
      segments[index] = null;
    }
    _activeSince = _now();
    _accumulated = Duration.zero;
    _startTicker();
    _subscribeAmplitude();
    _emit(
      segments: segments,
      phase: RecorderPhase.recording,
      elapsedSeconds: 0,
      waveform: const <double>[],
      errorMessage: null,
    );
    await _persist();
  }

  /// 暂停当前段录音（时长冻结）。
  Future<void> pauseCurrentSegment() async {
    if (state.phase != RecorderPhase.recording) {
      return;
    }
    // 冻结当前已累计时长：暂停期间不计时，恢复后从该值继续叠加
    _accumulated = _currentElapsed();
    _activeSince = null;
    await _recorder.pause();
    _stopTicker();
    _emit(
      phase: RecorderPhase.paused,
      elapsedSeconds: _accumulated.inSeconds,
      errorMessage: null,
    );
  }

  /// 继续被暂停的当前段录音。
  Future<void> resumeCurrentSegment() async {
    if (state.phase != RecorderPhase.paused) {
      return;
    }
    _activeSince = _now();
    await _recorder.resume();
    _startTicker();
    _emit(
      phase: RecorderPhase.recording,
      elapsedSeconds: _currentElapsed().inSeconds,
      errorMessage: null,
    );
  }

  /// 完成本段：停止录音并按当前累计时长落盘该段，随后跳到下一未完成段。
  Future<bool> finishCurrentSegment() async {
    if (state.phase == RecorderPhase.idle) {
      return false;
    }
    final elapsed = _currentElapsed();
    _activeSince = null;
    _accumulated = Duration.zero;
    _stopTicker();
    try {
      await _recorder.stop();
    } catch (_) {
      // 停止失败不阻塞流程，本地没有可恢复的录音状态
    }
    final seconds = elapsed.inSeconds;
    if (seconds <= 0) {
      _emit(phase: RecorderPhase.idle, elapsedSeconds: 0, errorMessage: null);
      return false;
    }

    final index = state.currentIndex;
    final segments = List<SegmentRecord?>.from(state.segments);
    segments[index] = SegmentRecord(
      fileName: _fileNameFor(index),
      durationSeconds: seconds,
    );
    _emit(
      segments: segments,
      currentIndex: _firstIncompleteIndex(segments) ?? recordingSegmentCount,
      phase: RecorderPhase.idle,
      elapsedSeconds: 0,
      waveform: const <double>[],
      lastCompletedIndex: index,
      errorMessage: null,
    );
    await _persist();
    return true;
  }

  /// 页面销毁（pop）时若正在录音：自动停止并保存当前段进度。
  Future<void> saveProgressAndStop() async {
    if (state.phase == RecorderPhase.idle) {
      return;
    }
    final index = state.currentIndex;
    final elapsed = _currentElapsed();
    _activeSince = null;
    _accumulated = Duration.zero;
    _stopTicker();
    try {
      await _recorder.stop();
    } catch (_) {
      // 同上：尽量释放录音资源
    }
    final seconds = elapsed.inSeconds;
    final segments = List<SegmentRecord?>.from(state.segments);
    var nextIndex = state.currentIndex;
    if (seconds > 0 && index < recordingSegmentCount) {
      segments[index] = SegmentRecord(
        fileName: _fileNameFor(index),
        durationSeconds: seconds,
      );
      nextIndex = _firstIncompleteIndex(segments) ?? recordingSegmentCount;
    }
    _emit(
      segments: segments,
      currentIndex: nextIndex,
      phase: RecorderPhase.idle,
      elapsedSeconds: 0,
      waveform: const <double>[],
      errorMessage: null,
    );
    await _persist();
  }

  /// 清空上次操作留下的错误提示。
  void clearError() {
    if (state.errorMessage != null) {
      _emit(errorMessage: null);
    }
  }

  /// 归一化 dBFS 振幅（约 -60 ~ 0 dB）到 0-1，供柱状波形使用。
  double normalizeAmplitude(double dbFS) {
    return ((dbFS + 60) / 60).clamp(0.0, 1.0).toDouble();
  }

  Duration _currentElapsed() {
    final active = _activeSince;
    if (active == null) {
      return _accumulated;
    }
    return _accumulated + _now().difference(active);
  }

  void _startTicker() {
    _ticker ??= Timer.periodic(const Duration(milliseconds: 250), (_) {
      if (state.phase != RecorderPhase.recording) {
        return;
      }
      final seconds = _currentElapsed().inSeconds;
      if (seconds != state.elapsedSeconds) {
        _emit(elapsedSeconds: seconds);
      }
    });
  }

  void _stopTicker() {
    _ticker?.cancel();
    _ticker = null;
  }

  void _subscribeAmplitude() {
    _amplitudeSubscription ??= _recorder
        .onAmplitudeChanged(const Duration(milliseconds: 200))
        .listen((amplitude) {
          if (state.phase != RecorderPhase.recording) {
            return;
          }
          final waveform = List<double>.from(state.waveform);
          if (waveform.length >= waveformSampleCount) {
            waveform.removeAt(0);
          }
          waveform.add(normalizeAmplitude(amplitude.current));
          _emit(waveform: waveform);
        });
  }

  String _fileNameFor(int index) {
    return 'segment_${(index + 1).toString().padLeft(2, '0')}.m4a';
  }

  Future<String> _filePathFor(int index) async {
    final directory = await _directoryProvider();
    return '$directory${Platform.pathSeparator}${_fileNameFor(index)}';
  }

  static int? _firstIncompleteIndex(List<SegmentRecord?> segments) {
    for (var i = 0; i < segments.length; i++) {
      if (segments[i] == null) {
        return i;
      }
    }
    return null;
  }

  Future<void> _persist() async {
    final prefs = await SharedPreferences.getInstance();
    final entries = <Map<String, dynamic>>[];
    for (var i = 0; i < state.segments.length; i++) {
      final segment = state.segments[i];
      if (segment == null) {
        continue;
      }
      entries.add(<String, dynamic>{'index': i, ...segment.toJson()});
    }
    await prefs.setString(_storageKey, jsonEncode(entries));
  }

  void _emit({
    List<SegmentRecord?>? segments,
    int? currentIndex,
    RecorderPhase? phase,
    int? elapsedSeconds,
    List<double>? waveform,
    int? lastCompletedIndex,
    String? errorMessage,
    bool? restoring,
  }) {
    state = RecordingState(
      segments: segments ?? state.segments,
      currentIndex: currentIndex ?? state.currentIndex,
      phase: phase ?? state.phase,
      elapsedSeconds: elapsedSeconds ?? state.elapsedSeconds,
      waveform: waveform ?? state.waveform,
      restoring: restoring ?? state.restoring,
      lastCompletedIndex: lastCompletedIndex ?? state.lastCompletedIndex,
      errorMessage: errorMessage,
    );
  }

  @override
  void dispose() {
    _stopTicker();
    _amplitudeSubscription?.cancel();
    super.dispose();
  }
}

/// 默认录音目录：<应用文档目录>/recordings，确保目录存在后返回路径。
Future<String> defaultRecordingsDirectory() async {
  final base = await getApplicationDocumentsDirectory();
  final directory = Directory(
    '${base.path}${Platform.pathSeparator}recordings',
  );
  await directory.create(recursive: true);
  return directory.path;
}

/// 时长格式化：mm:ss。
String formatRecordingDuration(int totalSeconds) {
  final minutes = (totalSeconds ~/ 60).toString().padLeft(2, '0');
  final seconds = (totalSeconds % 60).toString().padLeft(2, '0');
  return '$minutes:$seconds';
}
