/// 接口业务异常：把后端返回的中文 [message] 透传给 UI 层展示。
class ApiException implements Exception {
  const ApiException({
    required this.code,
    required this.message,
    this.statusCode,
    this.retryAfterSeconds,
    this.matchedWords = const <String>[],
  });

  /// 机器可读错误码，例如 SEND_TOO_FREQUENT / CODE_INVALID / UNAUTHORIZED
  final String code;

  /// 可直接展示给用户的中文提示
  final String message;

  final int? statusCode;

  /// 429 发送太频繁时，建议客户端等待的秒数
  final int? retryAfterSeconds;

  /// 敏感词拦截时命中的拦截级词（去重，仅 SENSITIVE_BLOCKED 类错误携带）
  final List<String> matchedWords;

  bool get isUnauthorized => statusCode == 401;

  @override
  String toString() {
    return 'ApiException(code: $code, message: $message, statusCode: $statusCode)';
  }
}
