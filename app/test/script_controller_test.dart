import 'package:flutter_test/flutter_test.dart';

import 'package:starvoice_app/core/network/api_client.dart';
import 'package:starvoice_app/core/network/api_exception.dart';
import 'package:starvoice_app/features/scripts/application/script_controller.dart';

import 'fake_backend.dart';

Map<String, dynamic> _scriptJson({
  required String id,
  required String status,
  String title = '话术标题',
  String content = '模拟话术内容，欢迎到店品尝。',
  List<String> matchedWords = const <String>[],
}) {
  return <String, dynamic>{
    'id': id,
    'industry': 'restaurant',
    'title': title,
    'productSnapshot': <String, dynamic>{
      'name': '双人火锅套餐',
      'price': '99 元',
    },
    'content': content,
    'status': status,
    'sensitiveCheckStatus': matchedWords.isEmpty ? 'pass' : 'blocked',
    'sensitiveMatchedWords': matchedWords,
    'sensitiveScannedAt': DateTime.now().toUtc().toIso8601String(),
    'createdAt': DateTime.now().toUtc().toIso8601String(),
  };
}

void main() {
  test('load 拉取我的话术列表', () async {
    final backend = FakeBackend(
      scripts: <Map<String, dynamic>>[
        _scriptJson(
          id: 'script-001',
          status: 'blocked',
          content: '这是最划算的套餐。',
          matchedWords: <String>['最'],
        ),
        _scriptJson(id: 'script-002', status: 'ready'),
      ],
    );
    final controller = ScriptController(ApiClient(buildMockDio(backend)));

    await controller.load();
    expect(controller.state.scripts.length, 2);
    expect(controller.state.scripts.first.id, 'script-001');
    expect(controller.state.scripts.first.isBlocked, isTrue);
    expect(controller.state.loading, isFalse);
    expect(controller.state.error, isNull);

    controller.dispose();
  });

  test('load 失败时写入中文提示', () async {
    // 让 FakeBackend 的话术列表接口返回 500，覆盖 load 的错误分支。
    final backend = FakeBackend(failScriptsList: true);
    final controller = ScriptController(ApiClient(buildMockDio(backend)));

    await controller.load();
    expect(controller.state.loading, isFalse);
    expect(controller.state.error, contains('话术列表服务暂不可用'));
    expect(controller.state.scripts, isEmpty);

    controller.dispose();
  });

  test('generate 成功：返回新话术并插入列表头部', () async {
    final backend = FakeBackend(
      generatedScriptContent: '双人火锅套餐，锅底现炒，欢迎到店品尝。',
      scripts: <Map<String, dynamic>>[
        _scriptJson(id: 'script-000', status: 'ready', title: '旧话术'),
      ],
    );
    final controller = ScriptController(ApiClient(buildMockDio(backend)));

    await controller.load();
    final script = await controller.generate(
      industry: 'restaurant',
      product: <String, String>{'name': '双人火锅套餐', 'price': '99 元'},
    );

    expect(script.id, 'script-001');
    expect(script.status, 'ready');
    expect(script.sensitiveCheckStatus, 'pass');
    expect(script.sensitiveMatchedWords, isEmpty);
    expect(controller.state.generating, isFalse);
    expect(controller.state.scripts.length, 2);
    expect(controller.state.scripts.first.id, 'script-001');
    expect(backend.scripts.length, 2);

    controller.dispose();
  });

  test('generate 命中敏感词：返回 blocked 话术', () async {
    final backend = FakeBackend(
      generatedScriptContent: '这是最划算的套餐，欢迎到店。',
    );
    final controller = ScriptController(ApiClient(buildMockDio(backend)));

    final script = await controller.generate(
      industry: 'restaurant',
      product: <String, String>{'name': '双人火锅套餐'},
    );

    expect(script.isBlocked, isTrue);
    expect(script.sensitiveCheckStatus, 'blocked');
    expect(script.sensitiveMatchedWords, contains('最'));
    expect(controller.state.scripts.first.isBlocked, isTrue);

    controller.dispose();
  });

  test('generate 失败：industry 非法抛出 ApiException 并复位 generating', () async {
    final backend = FakeBackend();
    final controller = ScriptController(ApiClient(buildMockDio(backend)));

    await expectLater(
      controller.generate(
        industry: 'unknown',
        product: <String, String>{'name': 'x'},
      ),
      throwsA(
        isA<ApiException>()
            .having((error) => error.code, 'code', 'INDUSTRY_INVALID'),
      ),
    );
    expect(controller.state.generating, isFalse);
    expect(controller.state.scripts, isEmpty);

    controller.dispose();
  });
}
