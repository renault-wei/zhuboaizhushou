import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:path_provider/path_provider.dart';

/// 本地已拉取的一条待播音频（R69）。
class StoredSpeech {
  StoredSpeech({
    required this.jobId,
    required this.liveId,
    required this.fileName,
    required this.bytes,
    required this.savedAt,
    this.played = false,
  });

  final String jobId;
  final String? liveId;
  final String fileName;
  final int bytes;
  final DateTime savedAt;
  /// 磁盘不可用时的**内存兜底**：内容仍在本条里，不丢音频 ✓
  /// （规格 §2.1：服务端交付即删，App 手里这份是唯一副本，绝不能因为落盘失败就丢 ✗）
  Uint8List? memoryBytes;
  /// 已播标记 —— **不是删除开关** ✗：删除统一交给 [SpeechOutStore.cleanUp]
  bool played;

  Map<String, Object?> toJson() => <String, Object?>{
    'jobId': jobId,
    'liveId': liveId,
    'fileName': fileName,
    'bytes': bytes,
    'savedAt': savedAt.toIso8601String(),
    'played': played,
  };

  static StoredSpeech? fromJson(Object? raw) {
    if (raw is! Map) return null;
    final jobId = raw['jobId'];
    final fileName = raw['fileName'];
    final savedAt = raw['savedAt'];
    if (jobId is! String || fileName is! String || savedAt is! String) {
      return null;
    }
    final parsed = DateTime.tryParse(savedAt);
    if (parsed == null) return null;
    return StoredSpeech(
      jobId: jobId,
      liveId: raw['liveId'] is String ? raw['liveId'] as String : null,
      fileName: fileName,
      bytes: raw['bytes'] is int ? raw['bytes'] as int : 0,
      savedAt: parsed,
      played: raw['played'] == true,
    );
  }
}

/// 助播音频的**本地库存**（R69）。
///
/// 为什么要有它：
///   手机在后台轮询会被系统降频（实测前台 58 次/分 → 后台 3~10 次/分）✗，
///   而服务的队列是「说一句产一句」。若 App 播完就丢，
///   一旦拉取变慢就立刻断声 ✓
///
///   **播完不丢**，本地就会自然攒下一整轮台本 ——
///   后台拉不动时，本地库存顶着播 ✓✓
///   （这也是 R69 不需要服务端「提前入队」的原因：本地库存本身就是深队列 ✓）
///
/// 硬约束（规格 §2.1 / §4.4）：
///   服务端**交付即删** → App 手里这份是**唯一副本** ✗
///   所以 —— **未播的音频在未达硬上限时【绝不能删】** ✗
class SpeechOutStore {
  SpeechOutStore({
    this.maxItems = 60,
    this.maxBytes = 20 * 1024 * 1024,
    this.playedRetention = const Duration(minutes: 10),
    this.unplayedMaxAge = const Duration(hours: 2),
  });

  /// 条数上限（与规格一致：60 条 ≈ 一轮完整台本）
  final int maxItems;
  /// 总字节上限 —— 单靠条数挡不住大文件 ✗
  final int maxBytes;
  /// 已播条目保留多久（留一点余量，便于排查「刚才那句是什么」）
  final Duration playedRetention;
  /// 未播条目的兜底寿命：服务端那份早已过期，留着也不会再播
  final Duration unplayedMaxAge;

  Directory? _dir;
  final List<StoredSpeech> _items = <StoredSpeech>[];
  /// 清理时被丢弃的条目（供调用方记日志）
  int lastDroppedUnplayed = 0;

  List<StoredSpeech> get items => List<StoredSpeech>.unmodifiable(_items);
  int get length => _items.length;
  int get totalBytes => _items.fold<int>(0, (sum, item) => sum + item.bytes);

  Future<Directory> _ensureDir() async {
    final existing = _dir;
    if (existing != null) return existing;
    final base = await getApplicationSupportDirectory();
    final dir = Directory('${base.path}/speech_out');
    if (!await dir.exists()) {
      await dir.create(recursive: true);
    }
    _dir = dir;
    return dir;
  }

  File _indexFile(Directory dir) => File('${dir.path}/index.json');

  /// 载入索引（App 启动 / 控制器启动时调一次）。失败按空库存处理，不阻断开播。
  Future<void> init() async {
    try {
      final dir = await _ensureDir();
      final file = _indexFile(dir);
      _items.clear();
      if (!await file.exists()) return;
      final raw = jsonDecode(await file.readAsString());
      if (raw is! List) return;
      for (final entry in raw) {
        final item = StoredSpeech.fromJson(entry);
        if (item == null) continue;
        // 索引里有、磁盘上没有 = 上次没写完 / 被系统清了：丢弃该条 ✓
        if (item.fileName.isEmpty) continue; // 内存兜底条目不入索引
        if (!await File('${dir.path}/${item.fileName}').exists()) continue;
        _items.add(item);
      }
    } catch (_) {
      // 库存读不出来不影响出声（大不了回退成「拉一条播一条」）
    }
  }

  Future<void> _persistIndex() async {
    try {
      final dir = await _ensureDir();
      final payload = jsonEncode(_items.map((i) => i.toJson()).toList());
      await _indexFile(dir).writeAsString(payload, flush: true);
    } catch (_) {
      // 索引写失败不影响播放（下次启动重建）
    }
  }

  /// 落盘一条。写失败返回 false（调用方照常播，只是没囤住）。
  Future<bool> put({
    required String jobId,
    required String? liveId,
    required Uint8List bytes,
  }) async {
    // ★注意：`_ensureDir()` 必须在**这个 try 之内** ——
    // 它在单元测试 / 无存储权限的机器上会抛 ✗，
    // 若放在 try 之外，异常会直接跳过下面的内存兜底，把音频弄丢 ✗✓
    try {
      final dir = await _ensureDir();
      final fileName = '$jobId.wav';
      try {
        await File('${dir.path}/$fileName').writeAsBytes(bytes, flush: true);
      } catch (_) {
        _putMemoryOnly(jobId: jobId, liveId: liveId, bytes: bytes);
        return true;
      }
      _items.add(StoredSpeech(
        jobId: jobId,
        liveId: liveId,
        fileName: fileName,
        bytes: bytes.length,
        savedAt: DateTime.now(),
      ));
      await _persistIndex();
      return true;
    } catch (_) {
      // ★这一步是必须的：`_ensureDir()` 自己抛异常时也会落到这里 ✗，
      // 若这里直接 return false，音频就被丢了 ——
      // 而按规格 §2.1（服务端交付即删），App 手里是唯一副本，**绝不能丢** ✓
      _putMemoryOnly(jobId: jobId, liveId: liveId, bytes: bytes);
      return true;
    }
  }

  /// 落盘不可能时的兜底：内容留在内存里，本条照常可播 ✓（只是重启后丢）
  void _putMemoryOnly({
    required String jobId,
    required String? liveId,
    required Uint8List bytes,
  }) {
    final memoryOnly = StoredSpeech(
      jobId: jobId,
      liveId: liveId,
      fileName: '',
      bytes: bytes.length,
      savedAt: DateTime.now(),
    );
    memoryOnly.memoryBytes = bytes;
    _items.add(memoryOnly);
  }

  /// 取最旧的**未播**一条（按落盘时间，保持 FIFO）。
  StoredSpeech? peekNext({String? liveId}) {
    for (final item in _items) {
      if (item.played) continue;
      if (liveId != null && item.liveId != null && item.liveId != liveId) {
        continue;
      }
      return item;
    }
    return null;
  }

  Future<Uint8List?> read(StoredSpeech item) async {
    final memory = item.memoryBytes;
    if (memory != null) {
      return memory;
    }
    try {
      final dir = await _ensureDir();
      final file = File('${dir.path}/${item.fileName}');
      if (!await file.exists()) return null;
      return await file.readAsBytes();
    } catch (_) {
      return null;
    }
  }

  Future<void> markPlayed(StoredSpeech item) async {
    item.played = true;
    await _persistIndex();
  }

  Future<void> _delete(StoredSpeech item) async {
    item.memoryBytes = null;
    if (item.fileName.isEmpty) {
      _items.remove(item);
      return;
    }
    try {
      final dir = await _ensureDir();
      await File('${dir.path}/${item.fileName}').delete();
    } catch (_) {
      // 文件已不在也当删成功
    }
    _items.remove(item);
  }

  /// 清理（规格 §4.4）。返回删除条数。
  ///
  /// 四条规则，按优先级；**硬上限触发时从最旧的未播开始删并计数**（调用方负责告警 ✓）
  Future<int> cleanUp({String? activeLiveId}) async {
    final now = DateTime.now();
    var removed = 0;
    lastDroppedUnplayed = 0;

    // ① 已播 且 超过保留时长 → 删
    for (final item in List<StoredSpeech>.from(_items)) {
      if (item.played && now.difference(item.savedAt) > playedRetention) {
        await _delete(item);
        removed += 1;
      }
    }
    // ② 不属于当前进行中场次 → 删（该场次早就结束了）
    if (activeLiveId != null) {
      for (final item in List<StoredSpeech>.from(_items)) {
        if (item.liveId != null && item.liveId != activeLiveId) {
          await _delete(item);
          removed += 1;
        }
      }
    }
    // ③ 未播 但 超过兜底寿命 → 删（服务端那份早过期，留着也不会再播）
    for (final item in List<StoredSpeech>.from(_items)) {
      if (!item.played && now.difference(item.savedAt) > unplayedMaxAge) {
        await _delete(item);
        removed += 1;
      }
    }
    // ④ 硬上限：条数 / 字节任一超限 → 从**最旧的未播**开始删
    //    ★ 这是唯一允许删未播的路径 ✗ —— 且必须记下来让调用方告警 ✓
    while (_items.length > maxItems || totalBytes > maxBytes) {
      final victim = _oldestUnplayed() ?? (_items.isNotEmpty ? _items.first : null);
      if (victim == null) break;
      if (!victim.played) lastDroppedUnplayed += 1;
      await _delete(victim);
      removed += 1;
    }
    await _persistIndex();
    return removed;
  }

  StoredSpeech? _oldestUnplayed() {
    StoredSpeech? oldest;
    for (final item in _items) {
      if (item.played) continue;
      if (oldest == null || item.savedAt.isBefore(oldest.savedAt)) {
        oldest = item;
      }
    }
    return oldest;
  }
}
