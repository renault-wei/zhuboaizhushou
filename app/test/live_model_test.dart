import 'package:flutter_test/flutter_test.dart';

import 'package:starvoice_app/core/models/live.dart';

/// 完整开播配置 JSON：与服务端 /api/lives 返回形状保持一致。
Map<String, dynamic> _liveJson({
  String id = 'live-001',
  String title = '火锅店午市循环直播',
  String status = 'idle',
}) {
  return <String, dynamic>{
    'id': id,
    'title': title,
    'videoSourceUrl': 'https://cdn.example.com/live-001.mp4',
    'couponId': 'c-001-mock',
    'rtmpUrl': 'rtmp://push.example.com/live/stream-001',
    'voiceId': 'v-ready',
    'scriptId': 'script-001',
    'status': status,
    'aiBadgeShown': true,
    'startedAt': '2026-09-04T03:00:00.000Z',
    'endedAt': '2026-09-04T04:00:00.000Z',
    'createdAt': '2026-09-04T02:00:00.000Z',
    'updatedAt': '2026-09-04T02:30:00.000Z',
  };
}

void main() {
  test('fromJson：完整字段映射，含可空字段与时间字符串', () {
    final live = Live.fromJson(_liveJson());

    expect(live.id, 'live-001');
    expect(live.title, '火锅店午市循环直播');
    expect(live.videoSourceUrl, 'https://cdn.example.com/live-001.mp4');
    expect(live.couponId, 'c-001-mock');
    expect(live.rtmpUrl, 'rtmp://push.example.com/live/stream-001');
    expect(live.voiceId, 'v-ready');
    expect(live.scriptId, 'script-001');
    expect(live.status, LiveStatus.idle);
    expect(live.aiBadgeShown, isTrue);
    expect(live.startedAt, '2026-09-04T03:00:00.000Z');
    expect(live.endedAt, '2026-09-04T04:00:00.000Z');
    expect(live.createdAt, '2026-09-04T02:00:00.000Z');
    expect(live.updatedAt, '2026-09-04T02:30:00.000Z');
  });

  test('fromJson：可空字段 null / 空串归一为 null，aiBadgeShown 缺失默认 true', () {
    final live = Live.fromJson(<String, dynamic>{
      ..._liveJson(),
      'couponId': null,
      'rtmpUrl': '',
      'voiceId': null,
      'scriptId': '',
      'startedAt': null,
      'endedAt': null,
      'aiBadgeShown': null,
    });

    expect(live.couponId, isNull);
    expect(live.rtmpUrl, isNull);
    expect(live.voiceId, isNull);
    expect(live.scriptId, isNull);
    expect(live.startedAt, isNull);
    expect(live.endedAt, isNull);
    // 合规兜底：角标字段缺失一律按 true 处理，不把角标当作可关闭项
    expect(live.aiBadgeShown, isTrue);
  });

  test('status 解析：五个合法值 + 未知值兜底 failed', () {
    expect(Live.fromJson(_liveJson(status: 'idle')).status, LiveStatus.idle);
    expect(Live.fromJson(_liveJson(status: 'ready')).status, LiveStatus.ready);
    expect(Live.fromJson(_liveJson(status: 'live')).status, LiveStatus.live);
    expect(Live.fromJson(_liveJson(status: 'ended')).status, LiveStatus.ended);
    expect(Live.fromJson(_liveJson(status: 'failed')).status, LiveStatus.failed);
    expect(
      Live.fromJson(_liveJson(status: 'unknown')).status,
      LiveStatus.failed,
    );
  });

  test('状态枚举中文标签齐全', () {
    expect(LiveStatus.idle.label, '草稿');
    expect(LiveStatus.ready.label, '就绪');
    expect(LiveStatus.live.label, '直播中');
    expect(LiveStatus.ended.label, '已结束');
    expect(LiveStatus.failed.label, '失败');
    expect(LiveStatus.values, hasLength(5));
  });

  test('isEditable：仅 idle 草稿可编辑', () {
    for (final status in LiveStatus.values) {
      final live = Live.fromJson(_liveJson(status: status.name));
      expect(
        live.isEditable,
        status == LiveStatus.idle,
        reason: 'status=${status.name} 的 isEditable 语义错误',
      );
    }
  });

  test('isLive / isFinished / isDeleteProtected 语义正确', () {
    final idle = Live.fromJson(_liveJson(status: 'idle'));
    expect(idle.isLive, isFalse);
    expect(idle.isFinished, isFalse);
    expect(idle.isDeleteProtected, isFalse);

    final ready = Live.fromJson(_liveJson(status: 'ready'));
    expect(ready.isLive, isFalse);
    expect(ready.isFinished, isFalse);
    expect(ready.isDeleteProtected, isTrue);

    final live = Live.fromJson(_liveJson(status: 'live'));
    expect(live.isLive, isTrue);
    expect(live.isFinished, isFalse);
    expect(live.isDeleteProtected, isTrue);

    for (final status in <String>['ended', 'failed']) {
      final finished = Live.fromJson(_liveJson(status: status));
      expect(finished.isLive, isFalse);
      expect(finished.isFinished, isTrue);
      expect(finished.isDeleteProtected, isFalse);
    }
  });
}