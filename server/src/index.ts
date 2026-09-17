import { buildApp } from './app';
import { env } from './config/env';
import { pool } from './db/client';
import { autoEndScheduler } from './services/autoEnd';
import { interactionEngine } from './services/interactionEngine';
import { liveCollector } from './services/liveCollector';
import { disposeReplyLedger } from './services/replyLedger';

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
        // 先停掉全部弹幕采集会话（含 wss 连接与重连定时器）与定时关播定时器，再关数据库连接池
        autoEndScheduler.dispose();
        disposeReplyLedger();
        await liveCollector.dispose();
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
