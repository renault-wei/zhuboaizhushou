import type { FastifyPluginAsync } from 'fastify';
import { eq } from 'drizzle-orm';
import { db } from '../db/client';
import { atmosphereSettings as atmosphereSettingsTable } from '../db/schema';
import {
  ATMOSPHERE_CATEGORIES,
  ATMOSPHERE_FREQUENCY_DISABLED_SECONDS,
  ATMOSPHERE_FREQUENCY_RULES,
  ATMOSPHERE_INSERT_PRIORITY,
  ATMOSPHERE_PLACEHOLDERS,
  MAX_ATMOSPHERE_TEXT_LENGTH,
  isAtmosphereCategory,
  isValidAtmosphereInterval,
} from '../services/atmosphere';

// 氛围语插播频率（M10-A2）：五类各一档 + 自定义 + 0（不插播）。
// GET 一次拉全「当前值 + 档位规则 + 模板占位符 + 插播优先级」，作为 App「氛围语」页的数据源；
// PUT 按类别整体替换（upsert），未设置的类别按默认档位生效。
// 口径见 docs/ATMOSPHERE-INTERACTION-PLAN.md §3/§5。

interface CategoryParams {
  category: string;
}

/** 档位规则对外形状（与 service 常量同源，避免前端硬编码） */
function ruleOf(category: (typeof ATMOSPHERE_CATEGORIES)[number]) {
  const rule = ATMOSPHERE_FREQUENCY_RULES[category];
  return {
    defaultSeconds: rule.defaultSeconds,
    minSeconds: rule.minSeconds,
    maxSeconds: rule.maxSeconds,
    // 0 恒为「不插播」合法值，前端据此渲染「不插播」选项
    disabledSeconds: ATMOSPHERE_FREQUENCY_DISABLED_SECONDS,
  };
}

export const atmosphereSettingsRoutes: FastifyPluginAsync = async (app) => {
  app.get('/api/atmosphere-settings', { preHandler: app.authenticate }, async (request) => {
    const rows = await db
      .select({
        category: atmosphereSettingsTable.category,
        intervalSeconds: atmosphereSettingsTable.intervalSeconds,
      })
      .from(atmosphereSettingsTable)
      .where(eq(atmosphereSettingsTable.userId, request.user.userId));

    const savedByCategory = new Map<string, number>();
    for (const row of rows) {
      savedByCategory.set(row.category, row.intervalSeconds);
    }

    return {
      settings: ATMOSPHERE_CATEGORIES.map((category) => {
        const saved = savedByCategory.get(category);
        return {
          category,
          // 未设置 → 回默认档位生效（服务端为准，App 不做默认值推断）
          intervalSeconds:
            saved ?? ATMOSPHERE_FREQUENCY_RULES[category].defaultSeconds,
          isCustom: saved !== undefined,
          rule: ruleOf(category),
        };
      }),
      placeholders: [...ATMOSPHERE_PLACEHOLDERS],
      priority: [...ATMOSPHERE_INSERT_PRIORITY],
      maxTextLength: MAX_ATMOSPHERE_TEXT_LENGTH,
    };
  });

  app.put(
    '/api/atmosphere-settings/:category',
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { category } = request.params as CategoryParams;
      if (!isAtmosphereCategory(category)) {
        return reply.code(400).send({
          error: 'CATEGORY_INVALID',
          message: `氛围类别必须是：${ATMOSPHERE_CATEGORIES.join(' / ')}`,
        });
      }

      const body = (request.body ?? {}) as Record<string, unknown>;
      const intervalSeconds = body.intervalSeconds;
      if (!isValidAtmosphereInterval(category, intervalSeconds)) {
        const rule = ATMOSPHERE_FREQUENCY_RULES[category];
        return reply.code(400).send({
          error: 'INTERVAL_INVALID',
          message: `插播间隔必须是整数秒：${ATMOSPHERE_FREQUENCY_DISABLED_SECONDS}（不插播）或 ${rule.minSeconds}~${rule.maxSeconds}`,
        });
      }
      const seconds = intervalSeconds as number;

      const saved = await db
        .insert(atmosphereSettingsTable)
        .values({
          userId: request.user.userId,
          category,
          intervalSeconds: seconds,
        })
        .onConflictDoUpdate({
          target: [atmosphereSettingsTable.userId, atmosphereSettingsTable.category],
          set: { intervalSeconds: seconds, updatedAt: new Date() },
        })
        .returning({
          category: atmosphereSettingsTable.category,
          intervalSeconds: atmosphereSettingsTable.intervalSeconds,
        });

      const row = saved[0];
      if (!row) {
        return reply.code(500).send({ error: 'SAVE_FAILED', message: '保存插播频率失败' });
      }
      return { category: row.category, intervalSeconds: row.intervalSeconds, isCustom: true };
    },
  );
};
