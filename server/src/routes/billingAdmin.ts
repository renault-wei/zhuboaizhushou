import type { FastifyPluginAsync } from 'fastify';
import { randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db } from '../db/client';
import { writeAuditLog } from '../services/audit';
import {
  APP_CONFIG_KEYS,
  normalizeConfigValue,
  readAppConfig,
  type AppConfigKey,
} from '../services/appConfig';

// ---------- 后台卡密批次 / 系统开关（v0.3 商业化 M5 服务端，M6 出页面）----------
// 卡密 = 线下 / 渠道分发的时长凭证（不经过真实资金接口），核销由商家端 API 完成；
// 开关 = app_config 白名单 Key 全局下发，写操作全部留痕 audit_logs。

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 20;
const MAX_BATCH_COUNT = 200;
const MIN_CARD_MINUTES = 1;
const MAX_CARD_MINUTES = 10080;
// 卡密字符集：去掉易混淆的 0/O/1/I/L，便于人工抄录
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 16;

function readPagination(query: Record<string, unknown>): { page: number; pageSize: number } {
  const rawPage = typeof query.page === 'string' ? Number(query.page) : NaN;
  const rawSize = typeof query.pageSize === 'string' ? Number(query.pageSize) : NaN;
  const page = Number.isInteger(rawPage) && rawPage >= 1 ? rawPage : 1;
  const pageSize =
    Number.isInteger(rawSize) && rawSize >= 1 && rawSize <= MAX_PAGE_SIZE
      ? rawSize
      : DEFAULT_PAGE_SIZE;
  return { page, pageSize };
}

/** 生成一张规范卡密：大写字母数字，入库不带分隔符（展示层再分组） */
function randomCardCode(): string {
  const bytes = randomBytes(CODE_LENGTH);
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i += 1) {
    code += CODE_CHARS.charAt((bytes[i] ?? 0) % CODE_CHARS.length);
  }
  return code;
}

function displayCardCode(code: string): string {
  return code.replace(/(.{4})/g, '$1-').replace(/-$/, '');
}

function readBatchBody(body: unknown): {
  name: string;
  count: number;
  minutesPerCard: number;
  remark: string;
} {
  const record = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  const name = typeof record.name === 'string' ? record.name.trim() : '';
  const count = typeof record.count === 'number' && Number.isInteger(record.count) ? record.count : NaN;
  const minutesPerCard =
    typeof record.minutesPerCard === 'number' && Number.isInteger(record.minutesPerCard)
      ? record.minutesPerCard
      : NaN;
  const remark = typeof record.remark === 'string' ? record.remark.trim() : '';
  return { name, count, minutesPerCard, remark };
}

/**
 * 后台卡密批次与系统开关（统一 /api/admin 前缀，全部要求 adminAuthenticate）：
 * POST /api/admin/card-batches 生成批次（卡密一次生成，返回可导出清单）
 * GET  /api/admin/card-batches 批次列表（含已核销统计）
 * GET  /api/admin/card-batches/:id 批次明细（卡密 / 核销状态 / 核销人）
 * GET/PUT /api/admin/app-config[/:key] 系统开关读取 / 写入（写留痕）
 */
export const billingAdminRoutes: FastifyPluginAsync = async (app) => {
  app.post(
    '/api/admin/card-batches',
    { preHandler: app.adminAuthenticate },
    async (request, reply) => {
      const admin = request.admin;
      if (!admin) {
        return reply.code(401).send({ error: 'UNAUTHORIZED', message: '未登录或登录已过期' });
      }
      const body = readBatchBody(request.body);
      if (body.name.length === 0 || body.name.length > 100) {
        return reply.code(400).send({ error: 'NAME_INVALID', message: '批次名称不能为空且不超过 100 字' });
      }
      if (!Number.isInteger(body.count) || body.count < 1 || body.count > MAX_BATCH_COUNT) {
        return reply.code(400).send({
          error: 'COUNT_INVALID',
          message: `单批卡密数量须在 1-${MAX_BATCH_COUNT} 之间`,
        });
      }
      if (
        !Number.isInteger(body.minutesPerCard) ||
        body.minutesPerCard < MIN_CARD_MINUTES ||
        body.minutesPerCard > MAX_CARD_MINUTES
      ) {
        return reply.code(400).send({
          error: 'MINUTES_INVALID',
          message: `单张卡密时长须在 ${MIN_CARD_MINUTES}-${MAX_CARD_MINUTES} 分钟之间`,
        });
      }
      if (body.remark.length > 200) {
        return reply.code(400).send({ error: 'REMARK_INVALID', message: '备注不能超过 200 字' });
      }
      const created = await db.transaction(async (tx) => {
        const exec = tx as { execute: (query: Parameters<typeof db.execute>[0]) => Promise<unknown> };
        const batchRows = await exec.execute(sql`
          INSERT INTO card_batches
            (name, total_count, minutes_per_card, status, remark, created_by)
          VALUES
            (${body.name}, ${body.count}, ${body.minutesPerCard}, 'active',
             ${body.remark.length > 0 ? body.remark : null}, ${admin.id})
          RETURNING id, name, total_count, minutes_per_card, status, remark, created_at
        `);
        const batch = (batchRows as { rows: Record<string, unknown>[] }).rows[0];
        if (!batch) {
          throw new Error('创建卡密批次失败：数据库未返回批次行');
        }
        const codes: string[] = [];
        for (let i = 0; i < body.count; i += 1) {
          let inserted = false;
          for (let attempt = 0; attempt < 5 && !inserted; attempt += 1) {
            const code = randomCardCode();
            try {
              await exec.execute(sql`
                INSERT INTO card_codes (batch_id, code) VALUES (${batch.id}, ${code})
              `);
              codes.push(code);
              inserted = true;
            } catch (err) {
              // 唯一索引碰撞（概率极低）：换码重试，不把冲突当成业务失败
              if ((err as { code?: string }).code !== '23505') {
                throw err;
              }
            }
          }
          if (!inserted) {
            throw new Error('卡密生成冲突，请重试');
          }
        }
        return { batch, codes };
      });
      await writeAuditLog({
        adminUserId: admin.id,
        action: 'card_batch.create',
        resourceType: 'card_batch',
        resourceId: created.batch.id as string,
        detail: {
          name: body.name,
          count: body.count,
          minutesPerCard: body.minutesPerCard,
        },
        ip: request.ip,
      });
      return {
        batch: {
          id: created.batch.id,
          name: created.batch.name,
          totalCount: created.batch.total_count,
          minutesPerCard: created.batch.minutes_per_card,
          status: created.batch.status,
          remark: created.batch.remark,
          createdAt: created.batch.created_at,
        },
        codes: created.codes.map((code) => ({ code, displayCode: displayCardCode(code) })),
      };
    },
  );

  app.get('/api/admin/card-batches', { preHandler: app.adminAuthenticate }, async (request) => {
    const query = request.query as Record<string, unknown>;
    const { page, pageSize } = readPagination(query);
    const status = query.status === 'active' || query.status === 'disabled' ? query.status : '';
    const offset = (page - 1) * pageSize;
    const rows = await db.execute(sql`
      SELECT b.id, b.name, b.total_count, b.minutes_per_card, b.status, b.remark,
             b.created_at,
             count(c.id)::int AS issued_count,
             count(c.id) FILTER (WHERE c.status = 'redeemed')::int AS redeemed_count
      FROM card_batches b LEFT JOIN card_codes c ON c.batch_id = b.id
      WHERE ${status ? sql`b.status = ${status}` : sql`true`}
      GROUP BY b.id
      ORDER BY b.created_at DESC
      LIMIT ${pageSize} OFFSET ${offset}
    `);
    const totals = await db.execute(sql`
      SELECT count(*)::int AS total
      FROM card_batches
      WHERE ${status ? sql`status = ${status}` : sql`true`}
    `);
    return { items: rows.rows, total: totals.rows[0]?.total ?? 0, page, pageSize };
  });

  app.get(
    '/api/admin/card-batches/:id',
    { preHandler: app.adminAuthenticate },
    async (request, reply) => {
      const params = request.params as Record<string, unknown>;
      const batchId = typeof params.id === 'string' ? params.id : '';
      if (!UUID_PATTERN.test(batchId)) {
        return reply.code(400).send({ error: 'BATCH_ID_INVALID', message: '批次 ID 格式不正确' });
      }
      const batchRows = await db.execute(sql`
        SELECT id, name, total_count, minutes_per_card, status, remark, created_by, created_at
        FROM card_batches WHERE id = ${batchId}
      `);
      const batch = batchRows.rows[0] as Record<string, unknown> | undefined;
      if (!batch) {
        return reply.code(404).send({ error: 'BATCH_NOT_FOUND', message: '卡密批次不存在' });
      }
      const codeRows = await db.execute(sql`
        SELECT c.id, c.code, c.status, c.redeemed_at, c.created_at,
               u.phone AS redeemed_phone, u.nickname AS redeemed_nickname
        FROM card_codes c
        LEFT JOIN users u ON u.id = c.redeemed_by_user_id
        WHERE c.batch_id = ${batchId}
        ORDER BY (c.status = 'unused') DESC, c.created_at DESC
      `);
      return {
        batch: {
          id: batch.id,
          name: batch.name,
          totalCount: batch.total_count,
          minutesPerCard: batch.minutes_per_card,
          status: batch.status,
          remark: batch.remark,
          createdAt: batch.created_at,
        },
        codes: codeRows.rows.map((row) => ({
          id: row.id,
          code: row.code,
          displayCode: displayCardCode(row.code as string),
          status: row.status,
          redeemedPhone: row.redeemed_phone ?? null,
          redeemedNickname: row.redeemed_nickname ?? null,
          redeemedAt: row.redeemed_at ?? null,
          createdAt: row.created_at,
        })),
      };
    },
  );

  app.get('/api/admin/app-config', { preHandler: app.adminAuthenticate }, async () => {
    const rows = await db.execute(sql`
      SELECT c.key, c.value, c.updated_at, u.username AS updated_by_username
      FROM app_config c
      LEFT JOIN admin_users u ON u.id = c.updated_by
      ORDER BY c.key
    `);
    return {
      config: await readAppConfig(),
      rows: rows.rows.map((row) => ({
        key: row.key,
        value: row.value,
        updatedBy: row.updated_by_username ?? null,
        updatedAt: row.updated_at,
      })),
    };
  });

  app.put(
    '/api/admin/app-config/:key',
    { preHandler: app.adminAuthenticate },
    async (request, reply) => {
      const admin = request.admin;
      if (!admin) {
        return reply.code(401).send({ error: 'UNAUTHORIZED', message: '未登录或登录已过期' });
      }
      const params = request.params as Record<string, unknown>;
      const key = typeof params.key === 'string' ? params.key : '';
      if (!(APP_CONFIG_KEYS as readonly string[]).includes(key)) {
        return reply.code(400).send({ error: 'CONFIG_KEY_INVALID', message: '不支持的配置项' });
      }
      const body = (typeof request.body === 'object' && request.body !== null
        ? request.body
        : {}) as Record<string, unknown>;
      const normalized = normalizeConfigValue(key as AppConfigKey, body.value);
      if ('error' in normalized) {
        return reply.code(400).send({ error: normalized.error, message: '配置值不合法' });
      }
      const valueJson = JSON.stringify(normalized.value);
      const rows = await db.execute(sql`
        INSERT INTO app_config (key, value, updated_by, updated_at)
        VALUES (${key}, ${sql`${valueJson}::jsonb`}, ${admin.id}, now())
        ON CONFLICT (key) DO UPDATE SET
          value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()
        RETURNING key, value, updated_at
      `);
      await writeAuditLog({
        adminUserId: admin.id,
        action: 'app_config.update',
        resourceType: 'app_config',
        resourceId: key,
        detail: { key, value: normalized.value },
        ip: request.ip,
      });
      const row = rows.rows[0];
      if (!row) {
        throw new Error('保存系统开关失败：数据库未返回配置行');
      }
      return { key: row.key, value: row.value, updatedAt: row.updated_at };
    },
  );
};
