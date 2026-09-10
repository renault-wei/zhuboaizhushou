import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:starvoice_app/features/assistant_speaker/application/speech_out_player.dart';
import 'package:starvoice_app/features/voices/presentation/voice_library_page.dart';
import 'package:starvoice_app/providers.dart';

import 'fake_backend.dart';

/// 试听假播放器：不碰真实音频通道，记录播放次数与最后一次字节。
class _RecordingSpeechOutPlayer implements SpeechOutPlayer {
  final List<Uint8List> played = <Uint8List>[];

  @override
  Future<void> play(Uint8List wavBytes) async {
    played.add(wavBytes);
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
}) async {
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

void main() {
  testWidgets('空态：无音色时提示去录制并展示引导按钮', (WidgetTester tester) async {
    final backend = FakeBackend();
    await _pumpVoiceLibrary(tester, backend);

    expect(find.byKey(const Key('voiceLibraryPage')), findsOneWidget);
    expect(find.text('我的音色'), findsOneWidget);
    expect(find.text('还没有音色，去录制你的第一段声音吧'), findsOneWidget);
    expect(find.byKey(const Key('voiceLibraryGoRecordButton')), findsOneWidget);
    expect(find.byKey(const Key('voiceLibraryRefreshButton')), findsOneWidget);
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
    expect(find.text('还没有音色，去录制你的第一段声音吧'), findsOneWidget);
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
    expect(find.text('还没有音色，去录制你的第一段声音吧'), findsOneWidget);
  });
}
