import 'package:flutter_test/flutter_test.dart';

import 'package:starvoice_app/core/models/voice.dart';

void main() {
  group('Voice', () {
    test('fromJson 解析完整字段', () {
      final voice = Voice.fromJson(<String, dynamic>{
        'id': 'voice-001',
        'name': '主播小美',
        'status': 'ready',
        'providerVoiceId': 'cosyvoice-001',
        'sampleDurationSeconds': 200,
        'createdAt': '2026-09-04T10:00:00.000Z',
        // 服务端多下发的字段应被忽略，不参与解析
        'userId': 'user-001',
        'provider': 'cosyvoice',
      });

      expect(voice.id, 'voice-001');
      expect(voice.name, '主播小美');
      expect(voice.status, 'ready');
      expect(voice.providerVoiceId, 'cosyvoice-001');
      expect(voice.sampleDurationSeconds, 200);
      expect(voice.createdAt, '2026-09-04T10:00:00.000Z');
    });

    test('缺失字段与数值类型容错', () {
      final voice = Voice.fromJson(<String, dynamic>{
        'id': 1001,
        'sampleDurationSeconds': 180.0,
      });

      expect(voice.id, '1001');
      expect(voice.name, '');
      expect(voice.status, '');
      expect(voice.sampleDurationSeconds, 180);
      expect(voice.providerVoiceId, '');
    });

    test('状态便捷 getter 区分克隆中与终态', () {
      const pending = Voice(
        id: 'v1',
        name: 'a',
        status: 'pending',
        providerVoiceId: '',
        sampleDurationSeconds: 200,
        createdAt: '',
      );
      const processing = Voice(
        id: 'v2',
        name: 'b',
        status: 'processing',
        providerVoiceId: '',
        sampleDurationSeconds: 200,
        createdAt: '',
      );
      const ready = Voice(
        id: 'v3',
        name: 'c',
        status: 'ready',
        providerVoiceId: '',
        sampleDurationSeconds: 200,
        createdAt: '',
      );
      const failed = Voice(
        id: 'v4',
        name: 'd',
        status: 'failed',
        providerVoiceId: '',
        sampleDurationSeconds: 200,
        createdAt: '',
      );

      expect(pending.isPending, isTrue);
      expect(pending.isCloning, isTrue);
      expect(pending.isTerminal, isFalse);
      expect(processing.isProcessing, isTrue);
      expect(processing.isCloning, isTrue);
      expect(ready.isReady, isTrue);
      expect(ready.isTerminal, isTrue);
      expect(ready.isCloning, isFalse);
      expect(failed.isFailed, isTrue);
      expect(failed.isTerminal, isTrue);
    });
  });
}
