import 'package:flutter/foundation.dart';

/// API 网络配置。
///
/// baseUrl 优先读取 `--dart-define=API_BASE_URL`，未配置时按平台取本地联调地址：
/// Android 模拟器通过 10.0.2.2 访问宿主机，其余平台直接用 localhost。
class ApiConfig {
  ApiConfig._();

  static const String _envBaseUrl = String.fromEnvironment('API_BASE_URL');

  static String get baseUrl {
    if (_envBaseUrl.isNotEmpty) {
      return _envBaseUrl;
    }
    if (defaultTargetPlatform == TargetPlatform.android) {
      return 'http://10.0.2.2:3000';
    }
    return 'http://localhost:3000';
  }
}
