import 'package:go_router/go_router.dart';

import 'package:starvoice_app/features/auth/application/auth_controller.dart';
import 'package:starvoice_app/features/auth/presentation/login_page.dart';
import 'package:starvoice_app/features/douyin/presentation/douyin_bind_page.dart';
import 'package:starvoice_app/features/home/presentation/home_page.dart';
import 'package:starvoice_app/features/splash/presentation/splash_page.dart';

/// 构建全局路由：根据认证状态在 启动页 / 登录页 / 首页 之间做守卫跳转。
GoRouter createAppRouter(AuthController authController) {
  return GoRouter(
    initialLocation: '/splash',
    redirect: (context, state) {
      final authState = authController.currentState;
      final location = state.matchedLocation;
      switch (authState.status) {
        case AuthStatus.restoring:
          return location == '/splash' ? null : '/splash';
        case AuthStatus.unauthenticated:
          return location == '/login' ? null : '/login';
        case AuthStatus.authenticated:
          if (location == '/login' || location == '/splash') {
            return '/home';
          }
          return null;
      }
    },
    routes: [
      GoRoute(path: '/splash', builder: (context, state) => const SplashPage()),
      GoRoute(path: '/login', builder: (context, state) => const LoginPage()),
      GoRoute(path: '/home', builder: (context, state) => const HomePage()),
      GoRoute(path: '/douyin-bind', builder: (context, state) => const DouyinBindPage()),
    ],
  );
}
