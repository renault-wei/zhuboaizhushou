import { buildApp } from './app';
import { env } from './config/env';
import { pool } from './db/client';
import { autoEndScheduler } from './services/autoEnd';
import { interactionEngine } from './services/interactionEngine';
import { liveCollector } from './services/liveCollector';
import { restoreLiveSessions } from './services/liveRecovery';
import { disposeStats } from './services/interactionStats';
import { disposePendingReplies } from './services/pendingReplies';
import { disposeSpeakerHeartbeat } from './services/speakerHeartbeat';
import { disposeReplyLedger } from './services/replyLedger';

const app = buildApp();

async function bootstrap(): Promise<void> {
  try {
    await app.listen({ host: env.HOST, port: env.PORT });
    // G4：服务起来后订阅实时弹幕事件，驱动互动引擎（退订句柄随进程生命周期常驻）
    interactionEngine.subscribe();
    // R59：**重启恢复** —— 把重启前就在直播中的场次重新拉起来。
    // 直播运行时（音色快照/循环台本/氛围语/弹幕采集/定时关播）全在内存里，
    // 原先只在 `/start` 被拉起；不恢复的话，DB 里 status 还是 live，
    // 但采集断了、台本哑了、**定时关播也不会再响**（那场直播会一直播下去）。
    // 尽力而为：失败只告警，绝不拦住服务启动。
    await restoreLiveSessions((message, err) => app.log.warn({ err }, message));
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
        disposeStats();
        disposePendingReplies();
        disposeSpeakerHeartbeat();
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
