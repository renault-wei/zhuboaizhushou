import 'package:flutter/foundation.dart';

/// API 网络配置。
///
/// baseUrl 优先读取 `--dart-define=API_BASE_URL`，未配置时按平台取本地联调地址：
/// Android 模拟器通过 10.0.2.2 访问宿主机，其余平台直接用 localhost。
///
/// ⚠️⚠️ **打云版 / 真机版安装包时必须带上 define** ✗ ——
///   漏了它，装到真机上的包会去连 `10.0.2.2`（那只是**模拟器**访问宿主机的别名，
///   真机上没有任何意义 ✓），现象是「点了没反应 / 像是服务端根本没部署」✗。
///   2026-09-22 就因为这个漏了 define，白装了一版、白查了半天。
///
///   正确命令（与 docs/PROGRESS.md 第 40 条一致）：
///     flutter build apk --release --dart-define=API_BASE_URL=http://<云端地址>:3000
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
