import 'package:flutter_test/flutter_test.dart';

import 'package:starvoice_app/core/network/api_client.dart';
import 'package:starvoice_app/core/network/api_exception.dart';
import 'package:starvoice_app/features/loop_scripts/application/loop_script_controller.dart';

import 'fake_backend.dart';

Map<String, dynamic> _loopJson(String id, String title, int itemCount) {
  final now = DateTime.now().toUtc().toIso8601String();
  return <String, dynamic>{
    'id': id,
    'title': title,
    'sourceScriptId': null,
    'itemCount': itemCount,
    'createdAt': now,
    'updatedAt': now,
  };
}

Map<String, dynamic> _liveJson(String id, {String? loopScriptId}) {
  final now = DateTime.now().toUtc().toIso8601String();
  return <String, dynamic>{
    'id': id,
    'title': '午市循环直播',
    'status': 'idle',
    'loopScriptId': loopScriptId,
    'createdAt': now,
    'updatedAt': now,
  };
}

void main() {
  test('load 拉取我的循环台本列表（带条数摘要）', () async {
    final backend = FakeBackend(
      loopScripts: <Map<String, dynamic>>[
        _loopJson('loop-001', '午市循环', 3),
        _loopJson('loop-002', '晚间加播', 5),
      ],
    );
    final controller = LoopScriptController(ApiClient(buildMockDio(backend)));

    await controller.load();

    expect(controller.state.loading, isFalse);
    expect(controller.state.error, isNull);
    expect(controller.state.scripts, hasLength(2));
    final ids = controller.state.scripts.map((item) => item.id).toSet();
    expect(ids, containsAll(<String>['loop-001', 'loop-002']));
    final first =
        controller.state.scripts.firstWhere((item) => item.id == 'loop-001');
    expect(first.title, '午市循环');
    expect(first.itemCount, 3);

    controller.dispose();
  });

  test('列表接口 500：state 记录中文错误提示', () async {
    final backend = FakeBackend(failLoopScriptsList: true);
    final controller = LoopScriptController(ApiClient(buildMockDio(backend)));

    await controller.load();

    expect(controller.state.loading, isFalse);
    expect(controller.state.scripts, isEmpty);
    expect(controller.state.error, '循环台本列表服务暂不可用');

    controller.dispose();
  });

  test('delete 成功：列表移除该条，引用它的开播配置自动解绑', () async {
    final backend = FakeBackend(
      loopScripts: <Map<String, dynamic>>[
        _loopJson('loop-001', '午市循环', 3),
      ],
      lives: <Map<String, dynamic>>[
        _liveJson('live-001', loopScriptId: 'loop-001'),
      ],
    );
    final controller = LoopScriptController(ApiClient(buildMockDio(backend)));
    await controller.load();

    await controller.delete('loop-001');

    expect(controller.state.scripts, isEmpty);
    expect(controller.state.deletingId, isNull);
    expect(backend.loopScripts, isEmpty);
    expect(backend.lives.single['loopScriptId'], isNull);

    controller.dispose();
  });

  test('delete 失败：抛出 ApiException 并复位删除中状态', () async {
    final backend = FakeBackend();
    final controller = LoopScriptController(ApiClient(buildMockDio(backend)));
    await controller.load();

    await expectLater(
      controller.delete('loop-999'),
      throwsA(isA<ApiException>()),
    );
    expect(controller.state.deletingId, isNull);

    controller.dispose();
  });
}
