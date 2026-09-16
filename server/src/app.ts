import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import { env } from './config/env';
import { authPlugin } from './plugins/auth';
import { adminRoutes } from './routes/admin';
import { agreementsRoutes } from './routes/agreements';
import { atmosphereTemplatesRoutes } from './routes/atmosphereTemplates';
import { atmosphereSettingsRoutes } from './routes/atmosphereSettings';
import { authRoutes } from './routes/auth';
import { billingAdminRoutes } from './routes/billingAdmin';
import { billingRoutes } from './routes/billing';
import { douyinRoutes } from './routes/douyin';
import { healthRoutes } from './routes/health';
import { livesRoutes } from './routes/lives';
import { danmakuSourceRoutes } from './routes/danmakuSource';
import { danmakuWatchRoutes } from './routes/danmakuWatch';
import { liveSettingsRoutes } from './routes/liveSettings';
import { ttsRoutes } from './routes/tts';
import { loopScriptSamplesRoutes } from './routes/loopScriptSamples';
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
  app.register(atmosphereTemplatesRoutes);
  app.register(atmosphereSettingsRoutes);
  app.register(healthRoutes);
  app.register(scriptsRoutes);
  app.register(voicesRoutes);
  // 视频上传（multipart）：单文件上限 200MB，超出返回 413
  app.register(multipart, { limits: { fileSize: 200 * 1024 * 1024 } });
  app.register(livesRoutes);
  // 弹幕采集源控制（R2b）：起 / 停 / 查某场的采集；未配签名 Key 时返回 503 且不影响既有功能
  app.register(danmakuSourceRoutes);
  // 独立弹幕监控（R16）：不绑场次、不落库，贴链接即可看弹幕流水
  app.register(danmakuWatchRoutes);
  // 账号级直播设置（R21/R27）：智能回复配置 / 自定义违禁词 / 语速默认档
  app.register(liveSettingsRoutes);
  // TTS 分段预览（R19）：长话术会被切成几段合成、断点在哪
  app.register(ttsRoutes);
  // 谈单演示：只读示例循环台本（套用后走 /api/loop-scripts 落库链路）
  app.register(loopScriptSamplesRoutes);
  app.register(loopScriptsRoutes);
  app.register(speechOutRoutes);
  // 商业化账本（v0.3 M5）：扫码直充 mock / 卡密核销 / 系统开关；卡密批次后台同批注册
  app.register(billingRoutes);
  app.register(billingAdminRoutes);

  return app;
}
