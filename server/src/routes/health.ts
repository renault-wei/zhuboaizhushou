import type { FastifyPluginAsync } from 'fastify';
import { env } from '../config/env';

// 健康检查：供本机联调与后续运维探活使用，不依赖数据库
export const healthRoutes: FastifyPluginAsync = async (app) => {
  app.get('/health', async () => ({
    status: 'ok',
    service: 'starvoice-server',
    environment: env.NODE_ENV,
    uptimeSeconds: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
  }));
};
