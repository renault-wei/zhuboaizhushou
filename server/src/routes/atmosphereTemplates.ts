import type { FastifyPluginAsync } from 'fastify';
import { and, desc, eq } from 'drizzle-orm';
import { db } from '../db/client';
import { atmosphereTemplates as atmosphereTemplatesTable } from '../db/schema';
import { scanSensitive } from '../services/sensitive';
import {
  ATMOSPHERE_CATEGORIES,
  ATMOSPHERE_DEFAULT_TEMPLATES,
  isAtmosphereCategory,
  MAX_ATMOSPHERE_TEXT_LENGTH,
} from '../services/atmosphere';

// 氛围台词库 CRUD（M4.5 竞品「氛围语」复刻）：welcome/follow/thumb/clock/custom 五类短句，
// 供循环播报在空档/事件插播。全部内容入库前必过敏感词扫描，命中拦截级词 400 不落库（合规红线）。

const MAX_LIST_LIMIT = 50;

interface AtmosphereIdParams {
  id: string;
}

interface CreateBody {
  category: unknown;
  text: unknown;
  enabled: unknown;
}

/** 对外 JSON 形状（不含扫描留痕明细，只回显 pass 状态） */
function toApi(row: {
  id: string;
  category: string;
  text: string;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: row.id,
    category: row.category,
    text: row.text,
    enabled: row.enabled,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function readCreateBody(body: unknown): CreateBody {
  if (typeof body !== 'object' || body === null) {
    return { category: null, text: null, enabled: null };
  }
  const record = body as Record<string, unknown>;
  return {
    category: record.category ?? null,
    text: record.text ?? null,
    enabled: record.enabled ?? null,
  };
}

/** 解析并校验请求体：返回归一化字段或错误信息 */
function parseInput(body: CreateBody): { ok: true; fields: { category: string; text: string; enabled: boolean } } | { ok: false; code: string; message: string } {
  if (!isAtmosphereCategory(body.category)) {
    return {
      ok: false,
      code: 'CATEGORY_INVALID',
      message: `氛围类别必须是：${ATMOSPHERE_CATEGORIES.join(' / ')}`,
    };
  }
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (text.length === 0) {
    return { ok: false, code: 'TEXT_REQUIRED', message: '氛围台词不能为空' };
  }
  if (text.length > MAX_ATMOSPHERE_TEXT_LENGTH) {
    return {
      ok: false,
      code: 'TEXT_TOO_LONG',
      message: `氛围台词不能超过 ${MAX_ATMOSPHERE_TEXT_LENGTH} 字`,
    };
  }
  const enabled = body.enabled === undefined || body.enabled === null ? true : body.enabled === true;
  return { ok: true, fields: { category: body.category, text, enabled } };
}

/** 归属 + 存在性查询（氛围台词无级联引用，直接按归属删） */
async function findOwned(id: string, userId: string) {
  const rows = await db
    .select()
    .from(atmosphereTemplatesTable)
    .where(and(eq(atmosphereTemplatesTable.id, id), eq(atmosphereTemplatesTable.userId, userId)))
    .limit(1);
  return rows[0] ?? null;
}

export const atmosphereTemplatesRoutes: FastifyPluginAsync = async (app) => {
  // 我的氛围台词列表：支持 ?category= 过滤，updatedAt 倒序，最多 50 条
  app.get('/api/atmosphere-templates', { preHandler: app.authenticate }, async (request, reply) => {
    const query = request.query as Record<string, unknown> | undefined;
    const rawCategory = query && query.category !== undefined ? String(query.category) : null;
    if (rawCategory && !isAtmosphereCategory(rawCategory)) {
      return reply
        .code(400)
        .send({ error: 'CATEGORY_INVALID', message: 'category 过滤值不合法' });
    }
    const rows = await db
      .select()
      .from(atmosphereTemplatesTable)
      .where(
        rawCategory
          ? and(
              eq(atmosphereTemplatesTable.userId, request.user.userId),
              eq(atmosphereTemplatesTable.category, rawCategory),
            )
          : eq(atmosphereTemplatesTable.userId, request.user.userId),
      )
      .orderBy(desc(atmosphereTemplatesTable.updatedAt))
      .limit(MAX_LIST_LIMIT);
    return rows.map(toApi);
  });

  // 新建一条氛围台词：类别白名单 + 长度校验 + 敏感词扫描后落库（命中 400 不落库）
  app.post('/api/atmosphere-templates', { preHandler: app.authenticate }, async (request, reply) => {
    const parsed = parseInput(readCreateBody(request.body));
    if (!parsed.ok) {
      return reply.code(400).send({ error: parsed.code, message: parsed.message });
    }
    const scan = scanSensitive(parsed.fields.text);
    if (scan.status === 'blocked') {
      return reply.code(400).send({
        error: 'SENSITIVE_BLOCKED',
        message: '氛围台词包含被拦截用语，请修改后再保存',
        matchedWords: scan.matchedWords,
      });
    }
    const created = await db
      .insert(atmosphereTemplatesTable)
      .values({
        userId: request.user.userId,
        category: parsed.fields.category,
        text: parsed.fields.text,
        enabled: parsed.fields.enabled,
        sensitiveCheckStatus: 'pass',
        sensitiveMatchedWords: [],
        sensitiveScannedAt: new Date(),
      })
      .returning();
    const row = created[0];
    if (!row) {
      return reply.code(500).send({ error: 'CREATE_FAILED', message: '创建氛围台词失败' });
    }
    return reply.code(201).send(toApi(row));
  });

  // 一键填充默认模板（M10-A4）：只补「该商家尚无任何一条」的类别，已有内容的类别原样保留（幂等）。
  // 默认文案同样过敏感词扫描：词表更新导致某类默认文案不合规时，该类不落库并回 blocked（宁可不填）。
  app.post('/api/atmosphere-templates/defaults', { preHandler: app.authenticate }, async (request, reply) => {
    const owned = await db
      .select({ category: atmosphereTemplatesTable.category })
      .from(atmosphereTemplatesTable)
      .where(eq(atmosphereTemplatesTable.userId, request.user.userId));
    const ownedCategories = new Set(owned.map((row) => row.category));

    const kept: string[] = [];
    const blocked: string[] = [];
    const pending: { category: string; text: string }[] = [];
    for (const category of ATMOSPHERE_CATEGORIES) {
      if (ownedCategories.has(category)) {
        kept.push(category);
        continue;
      }
      const text = ATMOSPHERE_DEFAULT_TEMPLATES[category];
      if (scanSensitive(text).status === 'blocked') {
        blocked.push(category);
        continue;
      }
      pending.push({ category, text });
    }

    const created =
      pending.length === 0
        ? []
        : await db
            .insert(atmosphereTemplatesTable)
            .values(
              pending.map((entry) => ({
                userId: request.user.userId,
                category: entry.category,
                text: entry.text,
                enabled: true,
                sensitiveCheckStatus: 'pass' as const,
                sensitiveMatchedWords: [],
                sensitiveScannedAt: new Date(),
              })),
            )
            .returning();

    return reply.code(201).send({
      created: created.map(toApi),
      kept,
      blocked,
    });
  });

  // 单条详情
  app.get('/api/atmosphere-templates/:id', { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = request.params as AtmosphereIdParams;
    const row = await findOwned(id, request.user.userId);
    if (!row) {
      return reply.code(404).send({ error: 'ATMOSPHERE_NOT_FOUND', message: '氛围台词不存在' });
    }
    return toApi(row);
  });

  // 整体替换一条（编辑保存口径）：类别/文案/开关整体重写，文本变更时重新过扫描
  app.put('/api/atmosphere-templates/:id', { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = request.params as AtmosphereIdParams;
    const existing = await findOwned(id, request.user.userId);
    if (!existing) {
      return reply.code(404).send({ error: 'ATMOSPHERE_NOT_FOUND', message: '氛围台词不存在' });
    }
    const parsed = parseInput(readCreateBody(request.body));
    if (!parsed.ok) {
      return reply.code(400).send({ error: parsed.code, message: parsed.message });
    }
    const scan = scanSensitive(parsed.fields.text);
    if (scan.status === 'blocked') {
      return reply.code(400).send({
        error: 'SENSITIVE_BLOCKED',
        message: '氛围台词包含被拦截用语，请修改后再保存',
        matchedWords: scan.matchedWords,
      });
    }
    const updated = await db
      .update(atmosphereTemplatesTable)
      .set({
        category: parsed.fields.category,
        text: parsed.fields.text,
        enabled: parsed.fields.enabled,
        sensitiveCheckStatus: 'pass',
        sensitiveMatchedWords: [],
        sensitiveScannedAt: new Date(),
      })
      .where(and(eq(atmosphereTemplatesTable.id, id), eq(atmosphereTemplatesTable.userId, request.user.userId)))
      .returning();
    const row = updated[0];
    if (!row) {
      return reply.code(404).send({ error: 'ATMOSPHERE_NOT_FOUND', message: '氛围台词不存在' });
    }
    return toApi(row);
  });

  // 删除
  app.delete('/api/atmosphere-templates/:id', { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = request.params as AtmosphereIdParams;
    const deleted = await db
      .delete(atmosphereTemplatesTable)
      .where(and(eq(atmosphereTemplatesTable.id, id), eq(atmosphereTemplatesTable.userId, request.user.userId)))
      .returning({ id: atmosphereTemplatesTable.id });
    if (deleted.length === 0) {
      return reply.code(404).send({ error: 'ATMOSPHERE_NOT_FOUND', message: '氛围台词不存在' });
    }
    return reply.code(200).send({ ok: true });
  });
};
