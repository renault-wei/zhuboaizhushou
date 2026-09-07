import 'package:go_router/go_router.dart';

import 'package:starvoice_app/features/auth/application/auth_controller.dart';
import 'package:starvoice_app/features/auth/presentation/login_page.dart';
import 'package:starvoice_app/features/agreement/presentation/voice_agreement_page.dart';
import 'package:starvoice_app/features/coupons/presentation/coupon_list_page.dart';
import 'package:starvoice_app/features/douyin/presentation/douyin_bind_page.dart';
import 'package:starvoice_app/features/home/presentation/home_page.dart';
import 'package:starvoice_app/features/lives/presentation/live_form_page.dart';
import 'package:starvoice_app/features/lives/presentation/live_list_page.dart';
import 'package:starvoice_app/features/lives/presentation/live_monitor_page.dart';
import 'package:starvoice_app/features/loop_scripts/presentation/loop_script_edit_page.dart';
import 'package:starvoice_app/features/loop_scripts/presentation/loop_script_library_page.dart';
import 'package:starvoice_app/features/loop_scripts/presentation/loop_script_new_page.dart';
import 'package:starvoice_app/features/recording/presentation/recording_page.dart';
import 'package:starvoice_app/features/scripts/presentation/script_edit_page.dart';
import 'package:starvoice_app/features/scripts/presentation/script_generate_page.dart';
import 'package:starvoice_app/features/splash/presentation/splash_page.dart';
import 'package:starvoice_app/features/voices/presentation/voice_library_page.dart';

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
      GoRoute(
        path: '/douyin-bind',
        builder: (context, state) => const DouyinBindPage(),
      ),
      GoRoute(
        path: '/coupons',
        // select=1：作为开播配置表单的「选券」入口，点选即 pop 返回券 id
        builder: (context, state) => CouponListPage(
          selectable: state.uri.queryParameters['select'] == '1',
        ),
      ),
      GoRoute(
        path: '/voice-agreement',
        builder: (context, state) => const VoiceAgreementPage(),
      ),
      GoRoute(
        path: '/recording',
        builder: (context, state) => const RecordingPage(),
      ),
      GoRoute(
        path: '/voices',
        builder: (context, state) => const VoiceLibraryPage(),
      ),
      GoRoute(
        path: '/scripts',
        builder: (context, state) => const ScriptGeneratePage(),
      ),
      GoRoute(
        path: '/scripts/:id/edit',
        builder: (context, state) => ScriptEditPage(
          scriptId: state.pathParameters['id'] ?? '',
        ),
      ),
      GoRoute(
        path: '/loop-scripts',
        // select=1：作为开播配置表单的「绑定循环台本」入口，点选即 pop 返回整本
        builder: (context, state) => LoopScriptLibraryPage(
          selectable: state.uri.queryParameters['select'] == '1',
        ),
      ),
      GoRoute(
        path: '/loop-scripts/new',
        builder: (context, state) => LoopScriptNewPage(
          // copy=<id>：把现有台本复制为新草稿编辑，保存后生成新台本
          copySourceId: state.uri.queryParameters['copy'],
        ),
      ),
      GoRoute(
        path: '/loop-scripts/:id/edit',
        builder: (context, state) => LoopScriptEditPage(
          loopScriptId: state.pathParameters['id'] ?? '',
        ),
      ),
      GoRoute(
        path: '/lives',
        builder: (context, state) => const LiveListPage(),
      ),
      GoRoute(
        path: '/lives/new',
        builder: (context, state) => const LiveFormPage(),
      ),
      GoRoute(
        path: '/lives/:id',
        builder: (context, state) => LiveFormPage(
          liveId: state.pathParameters['id'] ?? '',
        ),
      ),
      GoRoute(
        path: '/lives/:id/monitor',
        builder: (context, state) => LiveMonitorPage(
          liveId: state.pathParameters['id'] ?? '',
        ),
      ),
    ],
  );
}
