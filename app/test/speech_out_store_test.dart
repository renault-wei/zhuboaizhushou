/// R69：本地音频库存的四条清理规则测试。
///
/// 重点保护一条红线（规格 §4.4 / §2.1）：
///   服务端**交付即删** → App 手里这份是**唯一副本** ✗
///   所以 **未播音频在未达硬上限时，绝不能被删** ✗
library;

import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';

import 'package:starvoice_app/features/assistant_speaker/data/speech_out_store.dart';

Uint8List _bytes(int size) => Uint8List.fromList(List<int>.filled(size, 7));

/// 测试环境里 path_provider 不可用 → store 自动走**内存兜底** ✓
/// （这本身就是被保护的行为：落盘失败绝不丢音频）
Future<SpeechOutStore> _store({
  int maxItems = 60,
  int maxBytes = 20 * 1024 * 1024,
  Duration playedRetention = const Duration(minutes: 10),
  Duration unplayedMaxAge = const Duration(hours: 2),
}) async {
  final store = SpeechOutStore(
    maxItems: maxItems,
    maxBytes: maxBytes,
    playedRetention: playedRetention,
    unplayedMaxAge: unplayedMaxAge,
  );
  await store.init();
  return store;
}

void main() {
  test('落盘失败时退化为内存兜底：条目仍可读出，绝不丢音频', () async {
    final store = await _store();
    final ok = await store.put(
      jobId: 'job-a',
      liveId: 'live-1',
      bytes: _bytes(1024),
    );
    expect(ok, isTrue);
    expect(store.length, 1);

    final next = store.peekNext(liveId: 'live-1');
    expect(next, isNotNull);
    expect(await store.read(next!), hasLength(1024));
  });

  test('★红线：未播音频在未达硬上限时，清理不得删它', () async {
    // 已播保留时长设为 0，让「已播」条目立刻可删 ——
    // 但未播的那条必须活下来 ✓
    final store = await _store(
      playedRetention: Duration.zero,
      unplayedMaxAge: const Duration(hours: 2),
    );
    await store.put(jobId: 'played', liveId: 'live-1', bytes: _bytes(10));
    await store.put(jobId: 'pending', liveId: 'live-1', bytes: _bytes(10));

    final played = store.items.firstWhere((i) => i.jobId == 'played');
    await store.markPlayed(played);

    await store.cleanUp(activeLiveId: 'live-1');

    expect(store.length, 1, reason: '只该删掉已播那条');
    expect(store.peekNext(liveId: 'live-1')!.jobId, 'pending');
    expect(
      store.lastDroppedUnplayed,
      0,
      reason: '未达上限时删未播 = 违反红线',
    );
  });

  test('硬上限：按最旧的未播优先淘汰，并计数以便告警', () async {
    final store = await _store(maxItems: 3);
    for (var i = 1; i <= 4; i += 1) {
      await store.put(
        jobId: 'job-$i',
        liveId: 'live-1',
        bytes: _bytes(10),
      );
    }
    expect(store.length, 4, reason: 'put 不负责淘汰，淘汰交给 cleanUp');

    await store.cleanUp(activeLiveId: 'live-1');

    expect(store.length, 3);
    // 最旧的 job-1 被淘汰，1 条未播被丢弃 —— 必须计数出来
    expect(store.lastDroppedUnplayed, 1);
    expect(store.items.map((i) => i.jobId), isNot(contains('job-1')));
  });

  test('不属于当前进行中场次的条目会被清掉', () async {
    final store = await _store();
    await store.put(jobId: 'old', liveId: 'live-OLD', bytes: _bytes(10));
    await store.put(jobId: 'now', liveId: 'live-NOW', bytes: _bytes(10));

    await store.cleanUp(activeLiveId: 'live-NOW');

    expect(store.length, 1);
    expect(store.peekNext(liveId: 'live-NOW')!.jobId, 'now');
  });

  test('未传 activeLiveId 时不按场次清（避免误删）', () async {
    final store = await _store();
    await store.put(jobId: 'a', liveId: 'live-1', bytes: _bytes(10));
    await store.put(jobId: 'b', liveId: 'live-2', bytes: _bytes(10));

    await store.cleanUp();

    expect(store.length, 2, reason: '不知道当前场次时不该猜着删');
  });

  test('字节上限：总字节超限也会触发淘汰（单靠条数挡不住大文件）', () async {
    final store = await _store(maxItems: 100, maxBytes: 100);
    await store.put(jobId: 'big-1', liveId: 'live-1', bytes: _bytes(80));
    await store.put(jobId: 'big-2', liveId: 'live-1', bytes: _bytes(80));

    await store.cleanUp(activeLiveId: 'live-1');

    expect(store.totalBytes, lessThanOrEqualTo(100));
    expect(store.length, 1);
  });

  test('已播标记只改状态、不删条目（删除权归 cleanUp）', () async {
    final store = await _store();
    await store.put(jobId: 'x', liveId: 'live-1', bytes: _bytes(10));
    final item = store.peekNext(liveId: 'live-1')!;

    await store.markPlayed(item);

    expect(store.length, 1, reason: 'markPlayed 不该顺手删掉');
    expect(store.peekNext(liveId: 'live-1'), isNull, reason: '但不再被当作待播');
  });
}
