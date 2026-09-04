import 'package:flutter_test/flutter_test.dart';

import 'package:starvoice_app/features/recording/data/reading_passages.dart';

void main() {
  group('念稿数据完整性', () {
    test('共 10 段念稿', () {
      expect(readingPassages.length, 10);
    });

    test('每段 80-120 字（不含空白字符）', () {
      for (var i = 0; i < readingPassages.length; i++) {
        final count = readingPassages[i].replaceAll(RegExp(r'\s'), '').length;
        expect(
          count,
          inInclusiveRange(80, 120),
          reason: '第 ${i + 1} 段实际字数为 $count，超出 80-120 范围',
        );
      }
    });

    test('第 1 段为固定开场白，方便用户热身', () {
      expect(readingPassages.first, startsWith('亲爱的家人们'));
    });

    test('各段内容各不相同', () {
      expect(readingPassages.toSet().length, readingPassages.length);
    });
  });
}
