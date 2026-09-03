import 'package:flutter/material.dart';

/// 启动过渡页：会话恢复期间展示加载态。
class SplashPage extends StatelessWidget {
  const SplashPage({super.key});

  @override
  Widget build(BuildContext context) {
    return const Scaffold(
      body: Center(child: CircularProgressIndicator()),
    );
  }
}
