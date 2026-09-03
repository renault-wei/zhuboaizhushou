import Fastify from 'fastify';
import { env } from './config/env';
import { authPlugin } from './plugins/auth';
import { agreementsRoutes } from './routes/agreements';
import { authRoutes } from './routes/auth';
import { douyinRoutes } from './routes/douyin';
import { healthRoutes } from './routes/health';

// 组装 Fastify 应用实例：集中注册插件与路由，便于后续测试复用
export function buildApp() {
  const app = Fastify({
    logger: { level: env.LOG_LEVEL },
  });

  // 鉴权插件先注册，auth 路由里才能用上 app.authenticate / app.jwt
  app.register(authPlugin);
  app.register(authRoutes);
  app.register(douyinRoutes);
  app.register(agreementsRoutes);
  app.register(healthRoutes);

  return app;
}
