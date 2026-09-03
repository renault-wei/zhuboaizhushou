import Fastify from 'fastify';
import { env } from './config/env';
import { healthRoutes } from './routes/health';

// 组装 Fastify 应用实例：集中注册插件与路由，便于后续测试复用
export function buildApp() {
  const app = Fastify({
    logger: { level: env.LOG_LEVEL },
  });

  app.register(healthRoutes);

  return app;
}
