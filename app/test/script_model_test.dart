import 'package:flutter_test/flutter_test.dart';

import 'package:starvoice_app/core/models/script.dart';

void main() {
  group('Script', () {
    test('fromJson 解析完整字段', () {
      final script = Script.fromJson(<String, dynamic>{
        'id': 'script-001',
        'industry': 'restaurant',
        'title': '火锅套餐话术',
        'productSnapshot': <String, dynamic>{
          'name': '双人火锅套餐',
          'price': '99 元',
        },
        'content': '锅底现炒、毛肚脆嫩，双人套餐只要 99 元。',
        'status': 'blocked',
        'sensitiveCheckStatus': 'blocked',
        'sensitiveMatchedWords': <dynamic>['最', '顶级'],
        'sensitiveScannedAt': '2026-09-04T10:00:00.000Z',
        'createdAt': '2026-09-04T10:00:00.000Z',
        // 服务端多下发的字段应被忽略，不参与解析
        'userId': 'user-001',
      });

      expect(script.id, 'script-001');
      expect(script.industry, 'restaurant');
      expect(script.title, '火锅套餐话术');
      expect(script.content, contains('锅底现炒'));
      expect(script.status, 'blocked');
      expect(script.sensitiveCheckStatus, 'blocked');
      expect(script.sensitiveMatchedWords, <String>['最', '顶级']);
      expect(script.createdAt, '2026-09-04T10:00:00.000Z');
      expect(script.isBlocked, isTrue);
      expect(script.isReady, isFalse);
      expect(script.displayTitle, '火锅套餐话术');
    });

    test('缺失字段与数值类型容错', () {
      final script = Script.fromJson(<String, dynamic>{
        'id': 1001,
        'industry': 'retail',
        // title 缺失 → null
        'content': 123,
        'status': null,
        // sensitiveMatchedWords 不是 List → 空列表
        'sensitiveMatchedWords': '最',
      });

      expect(script.id, '1001');
      expect(script.title, isNull);
      expect(script.content, '123');
      expect(script.status, 'draft');
      expect(script.sensitiveCheckStatus, isNull);
      expect(script.sensitiveMatchedWords, isEmpty);
      expect(script.createdAt, '');
      expect(script.isDraft, isTrue);
      // 标题为空回退「未命名话术」
      expect(script.displayTitle, '未命名话术');
    });

    test('matchedWords 兼容 List<dynamic> 内的 null / 数字', () {
      final script = Script.fromJson(<String, dynamic>{
        'id': 'script-002',
        'content': 'x',
        'sensitiveMatchedWords': <dynamic>['最', null, 100, ''],
      });

      expect(script.sensitiveMatchedWords, <String>['最', '100']);
    });

    test('状态 getter 区分草稿/可开播/已拦截', () {
      const ready = Script(
        id: 's1',
        industry: 'restaurant',
        title: null,
        content: 'a',
        status: 'ready',
        sensitiveCheckStatus: 'pass',
        sensitiveMatchedWords: <String>[],
        createdAt: '',
      );
      const blocked = Script(
        id: 's2',
        industry: 'restaurant',
        title: 'b',
        content: 'a',
        status: 'blocked',
        sensitiveCheckStatus: 'blocked',
        sensitiveMatchedWords: <String>['最'],
        createdAt: '',
      );

      expect(ready.isReady, isTrue);
      expect(ready.isBlocked, isFalse);
      expect(ready.isDraft, isFalse);
      expect(ready.displayTitle, '未命名话术');
      expect(blocked.isBlocked, isTrue);
      expect(blocked.isReady, isFalse);
      expect(blocked.displayTitle, 'b');
    });
  });
}
