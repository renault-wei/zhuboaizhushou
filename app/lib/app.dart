import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import 'package:starvoice_app/core/theme/app_theme.dart';
import 'package:starvoice_app/features/auth/application/auth_controller.dart';
import 'package:starvoice_app/providers.dart';

/// 应用根组件：负责启动时恢复会话，并在登录态变化时刷新路由守卫。
class StarVoiceApp extends ConsumerStatefulWidget {
  const StarVoiceApp({super.key});

  @override
  ConsumerState<StarVoiceApp> createState() => _StarVoiceAppState();
}

class _StarVoiceAppState extends ConsumerState<StarVoiceApp> {
  late final GoRouter _router;

  @override
  void initState() {
    super.initState();
    _router = ref.read(routerProvider);
    // 首帧渲染后再恢复本地会话，避免在 build 阶段触发网络请求
    WidgetsBinding.instance.addPostFrameCallback((_) {
      ref.read(authControllerProvider.notifier).init();
    });
  }

  @override
  Widget build(BuildContext context) {
    // 登录/登出/401 等状态变化时重新执行路由守卫
    ref.listen<AuthStatus>(
      authControllerProvider.select((state) => state.status),
      (previous, next) => _router.refresh(),
    );

    return MaterialApp.router(
      title: '星辰语音',
      debugShowCheckedModeBanner: false,
      theme: AppTheme.light(),
      darkTheme: AppTheme.dark(),
      themeMode: ThemeMode.system,
      routerConfig: _router,
    );
  }
}
