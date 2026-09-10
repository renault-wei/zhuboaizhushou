import 'dart:convert';

import 'package:shared_preferences/shared_preferences.dart';

import 'package:starvoice_app/core/models/volc_preset.dart';

/// 音色本地缓存：**服务端为准，本地只做失败回落**。
///
/// 只缓存只读的内置预设目录与生效默认音色 id：
/// - 网络失败时，音色库页与开播表单仍能展示上次拿到的预设列表与默认音色；
/// - 不缓存商家自己的克隆音色（克隆进度、可用状态一律以服务端实时结果为准）。
/// 任何一次服务端成功响应都会覆盖本地缓存，本地绝不反过来覆盖服务端。
class VoiceCacheStore {
  static const String _catalogKey = 'voice_preset_catalog';
  static const String _defaultKey = 'voice_default_preset_id';

  /// 读取预设目录快照；无缓存 / 缓存损坏 / 本机存储不可用一律返回 null
  /// （调用方回落服务端）。
  Future<VolcPresetCatalog?> readCatalog() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      final raw = prefs.getString(_catalogKey);
      if (raw == null || raw.isEmpty) {
        return null;
      }
      final decoded = jsonDecode(raw);
      if (decoded is! Map) {
        return null;
      }
      final catalog = VolcPresetCatalog.fromJson(
        Map<String, dynamic>.from(decoded),
      );
      return catalog.isEmpty ? null : catalog;
    } catch (_) {
      // 缓存损坏：当作没有缓存，直接走服务端，不让脏数据影响展示
      return null;
    }
  }

  /// 覆盖写入预设目录快照；空目录不写（避免把失败结果写成缓存）。
  /// 写入失败不阻断功能：本地缓存只是弱网回落，服务端始终为准。
  Future<void> saveCatalog(VolcPresetCatalog catalog) async {
    if (catalog.isEmpty) {
      return;
    }
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setString(_catalogKey, jsonEncode(catalog.toJson()));
    } catch (_) {
      return;
    }
  }

  /// 读取缓存的生效默认音色 id；无缓存 / 读取失败返回 null。
  Future<String?> readDefaultPresetId() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      final value = prefs.getString(_defaultKey);
      return (value == null || value.isEmpty) ? null : value;
    } catch (_) {
      return null;
    }
  }

  /// 写入生效默认音色 id；空值表示清除缓存（如服务端回空串）。
  /// 写入失败不阻断功能（同上：服务端始终为准）。
  Future<void> saveDefaultPresetId(String? presetId) async {
    try {
      final prefs = await SharedPreferences.getInstance();
      if (presetId == null || presetId.isEmpty) {
        await prefs.remove(_defaultKey);
        return;
      }
      await prefs.setString(_defaultKey, presetId);
    } catch (_) {
      return;
    }
  }
}
