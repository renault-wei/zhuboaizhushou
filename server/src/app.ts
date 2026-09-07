import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import { env } from './config/env';
import { authPlugin } from './plugins/auth';
import { adminRoutes } from './routes/admin';
import { agreementsRoutes } from './routes/agreements';
import { authRoutes } from './routes/auth';
import { douyinRoutes } from './routes/douyin';
import { healthRoutes } from './routes/health';
import { livesRoutes } from './routes/lives';
import { loopScriptsRoutes } from './routes/loopScripts';
import { scriptsRoutes } from './routes/scripts';
import { speechOutRoutes } from './routes/speechOut';
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
  app.register(adminRoutes);
  app.register(authRoutes);
  app.register(douyinRoutes);
  app.register(agreementsRoutes);
  app.register(healthRoutes);
  app.register(scriptsRoutes);
  app.register(voicesRoutes);
  // 视频上传（multipart）：单文件上限 200MB，超出返回 413
  app.register(multipart, { limits: { fileSize: 200 * 1024 * 1024 } });
  app.register(livesRoutes);
  app.register(loopScriptsRoutes);
  app.register(speechOutRoutes);

  return app;
}
