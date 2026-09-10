import 'package:flutter_test/flutter_test.dart';

import 'package:starvoice_app/core/network/api_client.dart';
import 'package:starvoice_app/core/network/api_exception.dart';
import 'package:starvoice_app/features/voices/application/voice_library_controller.dart';

import 'fake_backend.dart';

Map<String, dynamic> _voiceJson({
  required String id,
  required String name,
  required String status,
  DateTime? createdAt,
}) {
  return <String, dynamic>{
    'id': id,
    'name': name,
    'status': status,
    'providerVoiceId': 'cosyvoice-mock-$id',
    'sampleDurationSeconds': 200,
    'createdAt': (createdAt ?? DateTime.now().toUtc()).toIso8601String(),
  };
}

void main() {
  test('load 拉取列表，pollStatus 把 pending 轮询推进到 ready 后停止', () async {
    final backend = FakeBackend(
      voices: <Map<String, dynamic>>[
        _voiceJson(
          id: 'v-pending',
          name: '老声音',
          status: 'pending',
          // 创建已超过 8 秒：首次单查即可按 mock 节奏推进为 ready
          createdAt: DateTime.now().toUtc().subtract(const Duration(seconds: 9)),
        ),
        _voiceJson(id: 'v-ready', name: '新声音', status: 'ready'),
      ],
    );
    final controller = VoiceLibraryController(
      ApiClient(buildMockDio(backend)),
    );

    await controller.load();
    expect(controller.state.voices.length, 2);
    expect(controller.state.hasActiveVoices, isTrue);
    expect(
      controller.state.voices.firstWhere((voice) => voice.id == 'v-pending').status,
      'pending',
    );

    await controller.pollStatus();
    expect(
      controller.state.voices.firstWhere((voice) => voice.id == 'v-pending').isReady,
      isTrue,
    );
    expect(controller.state.hasActiveVoices, isFalse);

    controller.dispose();
  });

  test('deleteVoice 成功移除；删除不存在抛出 VOICE_NOT_FOUND', () async {
    final backend = FakeBackend(
      voices: <Map<String, dynamic>>[
        _voiceJson(id: 'v-del', name: '待删除', status: 'ready'),
      ],
    );
    final controller = VoiceLibraryController(
      ApiClient(buildMockDio(backend)),
    );

    await controller.load();
    await controller.deleteVoice('v-del');
    expect(controller.state.voices, isEmpty);
    expect(backend.voices, isEmpty);

    await expectLater(
      controller.deleteVoice('v-del'),
      throwsA(
        isA<ApiException>().having((error) => error.code, 'code', 'VOICE_NOT_FOUND'),
      ),
    );

    controller.dispose();
  });

  test('load 不会清空已拉取的预设目录（下拉刷新并发场景回归）', () async {
    final backend = FakeBackend();
    final controller = VoiceLibraryController(
      ApiClient(buildMockDio(backend)),
    );

    await controller.loadCatalog();
    final presetCount = controller.state.catalog.presets.length;
    expect(presetCount, greaterThan(0));

    // 并发刷新时 load 与 loadCatalog 赛跑：load 先/后完成都不能清空目录
    await controller.load();
    expect(controller.state.catalog.presets.length, presetCount);

    controller.dispose();
  });

  test('setDefaultPreset 成功回填生效默认音色，且 load 后仍保留', () async {
    final backend = FakeBackend();
    final controller = VoiceLibraryController(
      ApiClient(buildMockDio(backend)),
    );

    await controller.loadCatalog();
    await controller.setDefaultPreset(fakeVolcPresetVoices[1]['id'] as String);
    expect(controller.state.catalog.userDefaultPresetId, fakeVolcPresetVoices[1]['id']);

    await controller.load();
    expect(controller.state.catalog.userDefaultPresetId, fakeVolcPresetVoices[1]['id']);

    controller.dispose();
  });
}
