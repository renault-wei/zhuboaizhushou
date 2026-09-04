import Fastify from 'fastify';
import { env } from './config/env';
import { authPlugin } from './plugins/auth';
import { agreementsRoutes } from './routes/agreements';
import { authRoutes } from './routes/auth';
import { douyinRoutes } from './routes/douyin';
import { healthRoutes } from './routes/health';
import { scriptsRoutes } from './routes/scripts';
import { voicesRoutes } from './routes/voices';

// 组装 Fastify 应用实例：集中注册插件与路由，便于后续测试复用
export function buildApp() {
  const app = Fastify({
    logger: { level: env.LOG_LEVEL },
  });

  // 容忍空 JSON body：DELETE / unbind 等无 body 请求若带 Content-Type: application/json
  // 且 body 为空，默认 JSON parser 会抛 FST_ERR_CTP_EMPTY_JSON_BODY（400）。
  // 这里覆盖为「空 body 视为空对象 {}」，一劳永逸避免各路由重复规避。
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    const raw = body.toString();
    if (raw.length === 0) {
      done(null, {});
      return;
    }
    try {
      done(null, JSON.parse(raw));
    } catch (err) {
      done(err as Error, undefined);
    }
  });

  // 鉴权插件先注册，auth 路由里才能用上 app.authenticate / app.jwt
  app.register(authPlugin);
  app.register(authRoutes);
  app.register(douyinRoutes);
  app.register(agreementsRoutes);
 app.register(healthRoutes);
  app.register(scriptsRoutes);
 app.register(voicesRoutes);

  return app;
}
