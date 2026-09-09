import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

/// 应用底部三 Tab 外壳：首页 / 直播 / 我的。
/// 承载分支页面；新建 / 完善 / 监控等全屏页以顶层路由 push，
/// 覆盖整个外壳（含底部导航），返回后回到原 Tab。
class AppShell extends StatelessWidget {
  const AppShell({super.key, required this.navigationShell});

  final StatefulNavigationShell navigationShell;

  void _selectTab(int index) {
    navigationShell.goBranch(
      index,
      // 重复点击当前 Tab 时回到该分支的首页，避免停留在深层子页
      initialLocation: index == navigationShell.currentIndex,
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: navigationShell,
      bottomNavigationBar: NavigationBar(
        selectedIndex: navigationShell.currentIndex,
        onDestinationSelected: _selectTab,
        destinations: const <NavigationDestination>[
          NavigationDestination(
            key: Key('tabHome'),
            icon: Icon(Icons.home_outlined),
            selectedIcon: Icon(Icons.home_rounded),
            label: '首页',
          ),
          NavigationDestination(
            key: Key('tabLive'),
            icon: Icon(Icons.live_tv_outlined),
            selectedIcon: Icon(Icons.live_tv_rounded),
            label: '直播',
          ),
          NavigationDestination(
            key: Key('tabMe'),
            icon: Icon(Icons.person_outline_rounded),
            selectedIcon: Icon(Icons.person_rounded),
            label: '我的',
          ),
        ],
      ),
    );
  }
}
