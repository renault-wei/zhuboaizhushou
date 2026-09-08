import type { FastifyPluginAsync } from 'fastify';
import { loopScriptSamples } from '../services/loopScriptSamples';

// 示例循环台本（谈单演示用，G7）：只读预设，不落库、不扣生成配额。
// 客户端「套用示例」把内容带入新建台本编辑器，保存时走 /api/loop-scripts 落库链路
// （逐条敏感词扫描仍在落库前执行，合规红线不变）。
export const loopScriptSamplesRoutes: FastifyPluginAsync = async (app) => {
  // 示例台本列表：登录即可读，返回整本（含全部条目）供客户端预填编辑
  app.get('/api/loop-script-samples', { preHandler: app.authenticate }, async () => {
    return { samples: loopScriptSamples };
  });
};