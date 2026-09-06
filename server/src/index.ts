import { buildApp } from './app';
import { env } from './config/env';
import { pool } from './db/client';
import { interactionEngine } from './services/interactionEngine';

const app = buildApp();

async function bootstrap(): Promise<void> {
  try {
    await app.listen({ host: env.HOST, port: env.PORT });
    // G4：服务起来后订阅实时弹幕事件，驱动互动引擎（退订句柄随进程生命周期常驻）
    interactionEngine.subscribe();
  } catch (err) {
    app.log.error(err, '服务启动失败');
    process.exit(1);
  }
}

// 收到退出信号时优雅关闭 HTTP 服务与数据库连接池
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    app.log.info({ signal }, '收到退出信号，开始优雅关闭');
    void (async () => {
      try {
        await app.close();
        await pool.end();
        process.exit(0);
      } catch (err) {
        app.log.error(err, '优雅关闭失败');
        process.exit(1);
      }
    })();
  });
}

void bootstrap();
