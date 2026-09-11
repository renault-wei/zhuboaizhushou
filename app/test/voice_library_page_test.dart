import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:starvoice_app/core/models/volc_preset.dart';
import 'package:starvoice_app/core/storage/voice_cache_store.dart';
import 'package:starvoice_app/features/assistant_speaker/application/speech_out_player.dart';
import 'package:starvoice_app/features/voices/presentation/voice_library_page.dart';
import 'package:starvoice_app/providers.dart';

import 'fake_backend.dart';

/// 试听假播放器：不碰真实音频通道，记录播放次数与最后一次字节。
class _RecordingSpeechOutPlayer implements SpeechOutPlayer {
  final List<Uint8List> played = <Uint8List>[];
  final List<String> playedUrls = <String>[];

  @override
  Future<void> play(Uint8List wavBytes) async {
    played.add(wavBytes);
  }

  @override
  Future<void> playUrl(String url) async {
    playedUrls.add(url);
  }

  @override
  Future<void> stop() async {}

  @override
  Future<void> dispose() async {}
}

Map<String, dynamic> _voiceJson({
  required String id,
  required String name,
  required String status,
  int durationSeconds = 200,
  DateTime? createdAt,
}) {
  return <String, dynamic>{
    'id': id,
    'name': name,
    'status': status,
    'providerVoiceId': 'cosyvoice-mock-$id',
    'sampleDurationSeconds': durationSeconds,
    'createdAt': (createdAt ?? DateTime.now().toUtc()).toIso8601String(),
  };
}

Future<void> _pumpVoiceLibrary(
  WidgetTester tester,
  FakeBackend backend, {
  SpeechOutPlayer? player,
  VolcPresetCatalog? seedCatalog,
}) async {
  SharedPreferences.setMockInitialValues(<String, Object>{});
  if (seedCatalog != null) {
    // 用真实缓存存储预置快照，覆盖「服务端不可用回落本机缓存」链路
    final store = VoiceCacheStore();
    await store.saveCatalog(seedCatalog);
    await store.saveDefaultPresetId(seedCatalog.defaultPresetId);
  }
  await tester.pumpWidget(
    ProviderScope(
      overrides: [
        dioProvider.overrideWithValue(buildMockDio(backend)),
        if (player != null) speechOutPlayerProvider.overrideWithValue(player),
      ],
      child: const MaterialApp(home: VoiceLibraryPage()),
    ),
  );
  await tester.pumpAndSettle();
}

/// 点按指定 Key：先滚动到可视区（页面较长时按钮可能在屏幕外）再点按。
Future<void> _tapKey(WidgetTester tester, String key) async {
  final finder = find.byKey(Key(key));
  await tester.ensureVisible(finder);
  await tester.pumpAndSettle();
  await tester.tap(finder);
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('空态：无音色时提示去录制并展示引导按钮', (WidgetTester tester) async {
    final backend = FakeBackend();
    await _pumpVoiceLibrary(tester, backend);

    expect(find.byKey(const Key('voiceLibraryPage')), findsOneWidget);
    expect(find.text('音色库'), findsOneWidget);
    expect(find.text('还没有克隆音色，去录制你的第一段声音吧'), findsOneWidget);
    expect(find.byKey(const Key('voiceLibraryGoRecordButton')), findsOneWidget);
    expect(find.byKey(const Key('voiceLibraryRefreshButton')), findsOneWidget);
  });

  testWidgets('预设音色：分组默认折叠，展开后可试听、可设为默认并刷新默认卡', (
    WidgetTester tester,
  ) async {
    final backend = FakeBackend();
    final player = _RecordingSpeechOutPlayer();
    await _pumpVoiceLibrary(tester, backend, player: player);

    // 顶部默认卡先展示服务端生效默认音色（内置目录默认 Vivi 2.0）
    expect(
      tester
          .widget<Text>(find.byKey(const Key('voiceLibraryDefaultName')))
          .data,
      'Vivi 2.0',
    );

    // 预设区按分组展示，默认折叠：组头可见、组内行不可见
    expect(find.byKey(const Key('presetVoiceSection')), findsOneWidget);
    expect(find.byKey(const Key('presetGroup_broadcast')), findsOneWidget);
    expect(
      find.byKey(const Key('presetVoiceRow_zh_male_m191_uranus_bigtts')),
      findsNothing,
    );

    // 展开分组：组内音色行与试听 / 设为默认按钮出现
    await _tapKey(tester, 'presetGroupHeader_broadcast');
    expect(
      find.byKey(const Key('presetVoiceRow_zh_male_m191_uranus_bigtts')),
      findsOneWidget,
    );

    // 试听：走服务端合成接口并交由本机播放器播出
    await _tapKey(tester, 'presetListen_zh_male_m191_uranus_bigtts');
    expect(player.played, hasLength(1));

    // 设为默认：服务端落库 + 本地「默认」标记 + 顶部默认卡切换为新音色
    await _tapKey(tester, 'presetSetDefault_zh_male_m191_uranus_bigtts');
    expect(backend.userDefaultPresetId, 'zh_male_m191_uranus_bigtts');
    expect(
      find.byKey(const Key('presetDefaultMark_zh_male_m191_uranus_bigtts')),
      findsOneWidget,
    );
    expect(
      tester
          .widget<Text>(find.byKey(const Key('voiceLibraryDefaultName')))
          .data,
      '云舟 2.0',
    );
    // 等提示条自动消失，避免测试结束时仍有未完成定时器
    await tester.pump(const Duration(seconds: 5));
    await tester.pumpAndSettle();
  });

  testWidgets('预设音色：服务端不可用时回落本机缓存并如实标注', (WidgetTester tester) async {
    final backend = FakeBackend()..failVolcPresets = true;
    await _pumpVoiceLibrary(
      tester,
      backend,
      seedCatalog: const VolcPresetCatalog(
        presets: <VolcPresetVoice>[
          VolcPresetVoice(
            id: 'zh_female_vv_uranus_bigtts',
            name: 'Vivi 2.0',
            gender: 'female',
            group: 'broadcast',
            recommended: true,
          ),
        ],
        groups: <VolcPresetGroup>[
          VolcPresetGroup(id: 'broadcast', label: '带货口播'),
        ],
        defaultPresetId: 'zh_female_vv_uranus_bigtts',
      ),
    );

    // 如实标注当前展示的是本机缓存，且缓存分组仍可展开查看音色
    expect(find.byKey(const Key('presetCatalogCacheBanner')), findsOneWidget);
    expect(find.byKey(const Key('presetGroup_broadcast')), findsOneWidget);
    await _tapKey(tester, 'presetGroupHeader_broadcast');
    expect(
      find.byKey(const Key('presetVoiceRow_zh_female_vv_uranus_bigtts')),
      findsOneWidget,
    );
  });

  testWidgets('列表：渲染音色名称、状态徽章与时长', (WidgetTester tester) async {
    final backend = FakeBackend(
      voices: <Map<String, dynamic>>[
        _voiceJson(id: 'v-ready', name: '主播小美', status: 'ready'),
        _voiceJson(
          id: 'v-proc',
          name: '老板男声',
          status: 'processing',
          durationSeconds: 215,
        ),
      ],
    );
    await _pumpVoiceLibrary(tester, backend);

    expect(find.byKey(const Key('voiceCard_v-ready')), findsOneWidget);
    expect(find.byKey(const Key('voiceCard_v-proc')), findsOneWidget);
    expect(find.text('主播小美'), findsOneWidget);
    expect(find.text('老板男声'), findsOneWidget);
    expect(find.byKey(const Key('voiceStatus_v-ready')), findsOneWidget);
    expect(find.text('可用'), findsOneWidget);
    expect(find.text('处理中'), findsOneWidget);
    expect(find.textContaining('时长 03:20'), findsOneWidget);
    expect(find.textContaining('时长 03:35'), findsOneWidget);
  });

  testWidgets('克隆状态流转：轮询把 pending 推进到 ready', (WidgetTester tester) async {
    final backend = FakeBackend(
      voices: <Map<String, dynamic>>[
        _voiceJson(
          id: 'v-pending',
          name: '克隆中的声音',
          status: 'pending',
          // 创建已超过 8 秒：首次单查即可按 mock 节奏推进为 ready
          createdAt: DateTime.now().toUtc().subtract(const Duration(seconds: 9)),
        ),
      ],
    );
    await _pumpVoiceLibrary(tester, backend);

    // 初次列表返回 pending：展示「克隆中」
    expect(find.byKey(const Key('voiceStatus_v-pending')), findsOneWidget);
    expect(find.text('克隆中'), findsOneWidget);
    expect(find.text('可用'), findsNothing);

    // 一个轮询周期后：GET :id 返回 ready，徽章变为「可用」
    await tester.pump(const Duration(seconds: 3));
    await tester.pump();
    expect(find.text('可用'), findsOneWidget);
    expect(find.text('克隆中'), findsNothing);
  });

  testWidgets('试听：调服务端真实合成接口并本机播放（档 A）', (WidgetTester tester) async {
    final backend = FakeBackend(
      voices: <Map<String, dynamic>>[
        _voiceJson(id: 'v-ready', name: '主播小美', status: 'ready'),
      ],
    );
    final player = _RecordingSpeechOutPlayer();
    await _pumpVoiceLibrary(tester, backend, player: player);

    await tester.tap(find.byKey(const Key('voiceListen_v-ready')));
    await tester.pumpAndSettle();

    // 走真实试听接口并交由本机播放器播出，不再有 mock 占位文案
    expect(player.played, hasLength(1));
    expect(player.played.single, isNotEmpty);
    expect(find.text('试听需接入真实 CosyVoice（当前为 mock 模式）'), findsNothing);

    // 克隆音色回落演示音色时给出如实提示
    expect(find.textContaining('克隆音色真实复刻待接入'), findsOneWidget);
    await tester.pump(const Duration(seconds: 5));
    await tester.pumpAndSettle();
  });

  testWidgets('试听：服务端不可用时提示试听失败', (WidgetTester tester) async {
    final backend = FakeBackend(
      voices: <Map<String, dynamic>>[
        _voiceJson(id: 'v-ready', name: '主播小美', status: 'ready'),
      ],
    )..failVoicePreview = true;
    final player = _RecordingSpeechOutPlayer();
    await _pumpVoiceLibrary(tester, backend, player: player);

    await tester.tap(find.byKey(const Key('voiceListen_v-ready')));
    await tester.pumpAndSettle();

    expect(player.played, isEmpty);
    expect(find.textContaining('试听失败'), findsOneWidget);
    await tester.pump(const Duration(seconds: 5));
    await tester.pumpAndSettle();
  });

  testWidgets('预设试听（方案 A）：带 previewUrl 直连静态音频，不再走合成接口', (
    WidgetTester tester,
  ) async {
    const String previewPath =
        '/uploads/voice-previews/zh_male_m191_uranus_bigtts.wav';
    final backend = FakeBackend(
      volcPresets: <Map<String, dynamic>>[
        <String, dynamic>{
          'id': 'zh_male_m191_uranus_bigtts',
          'name': '云舟 2.0',
          'gender': 'male',
          'group': 'broadcast',
          'recommended': true,
          'previewUrl': previewPath,
        },
      ],
    );
    final player = _RecordingSpeechOutPlayer();
    await _pumpVoiceLibrary(tester, backend, player: player);

    await _tapKey(tester, 'presetGroupHeader_broadcast');
    await _tapKey(tester, 'presetListen_zh_male_m191_uranus_bigtts');

    // 秒开静态试听：只走 URL 直连播放，不消耗合成接口（无字节播放）
    expect(player.playedUrls, hasLength(1));
    expect(player.playedUrls.single, endsWith(previewPath));
    expect(player.played, isEmpty);
    // 试听状态复位，可重复点播
    expect(find.byKey(const Key('presetListen_zh_male_m191_uranus_bigtts')), findsOneWidget);
  });

  testWidgets('预设试听（方案 A）：无 previewUrl 时回落真合成接口', (WidgetTester tester) async {
    final backend = FakeBackend();
    final player = _RecordingSpeechOutPlayer();
    await _pumpVoiceLibrary(tester, backend, player: player);

    await _tapKey(tester, 'presetGroupHeader_broadcast');
    await _tapKey(tester, 'presetListen_zh_male_m191_uranus_bigtts');

    // 未预生成：走合成接口取字节，本机播放器播出
    expect(player.playedUrls, isEmpty);
    expect(player.played, hasLength(1));
  });

  testWidgets('删除：取消不删除，确认后卡片移除', (WidgetTester tester) async {
    final backend = FakeBackend(
      voices: <Map<String, dynamic>>[
        _voiceJson(id: 'v-del', name: '待删除', status: 'ready'),
      ],
    );
    await _pumpVoiceLibrary(tester, backend);

    await tester.tap(find.byKey(const Key('voiceDelete_v-del')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('voiceDeleteDialog')), findsOneWidget);
    expect(find.text('删除后音色将不可恢复，确定删除？'), findsOneWidget);

    // 取消：音色仍在
    await tester.tap(find.text('取消'));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('voiceCard_v-del')), findsOneWidget);

    // 确认：调用删除接口并从列表移除
    await tester.tap(find.byKey(const Key('voiceDelete_v-del')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('voiceDeleteConfirmButton')));
    await tester.pumpAndSettle();

    expect(find.byKey(const Key('voiceCard_v-del')), findsNothing);
    expect(find.text('还没有克隆音色，去录制你的第一段声音吧'), findsOneWidget);
    expect(backend.voices, isEmpty);
  });

  testWidgets('刷新按钮：重新拉取最新列表', (WidgetTester tester) async {
    final backend = FakeBackend(
      voices: <Map<String, dynamic>>[
        _voiceJson(id: 'v-del', name: '待删除', status: 'ready'),
      ],
    );
    await _pumpVoiceLibrary(tester, backend);
    expect(find.byKey(const Key('voiceCard_v-del')), findsOneWidget);

    // 模拟另一端已删除该音色后点刷新
    backend.voices.clear();
    await tester.tap(find.byKey(const Key('voiceLibraryRefreshButton')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('voiceCard_v-del')), findsNothing);
    expect(find.text('还没有克隆音色，去录制你的第一段声音吧'), findsOneWidget);
  });
}
