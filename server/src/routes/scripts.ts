import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { and, desc, eq } from 'drizzle-orm';
import { db } from '../db/client';
import { scripts as scriptsTable } from '../db/schema';
import { scanSensitive } from '../services/sensitive';
import {
  buildSafeScriptFallback,
  isScriptIndustry,
  ScriptError,
  scriptService,
} from '../services/script';

// ---------- 常量与类型 ----------

// title 列 varchar(100)，长度上限与表定义对齐
const MAX_TITLE_LENGTH = 100;

interface ScriptIdParams {
  id: string;
}

/** POST generate 请求体：{ industry, title?, product } */
interface GenerateBody {
  industry: string | null;
  title: string | null;
  product: Record<string, string> | null;
}

/** PUT :id 请求体：{ content, title? }，title 为 undefined 表示未传（保留原值） */
interface UpdateBody {
  content: string | null;
  title: string | null | undefined;
}

/**
 * 读取并清洗商品快照：只收 string 且有内容的字段，
 * 空对象或缺失视为非法（路由返回 400），空串字段不随快照入库。
 */
function readProduct(body: unknown): Record<string, string> | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return null;
  }
  const product: Record<string, string> = {};
  for (const [key, value] of Object.entries(body)) {
    if (typeof value === 'string' && value.trim().length > 0) {
      product[key] = value.trim();
    }
  }
  return Object.keys(product).length > 0 ? product : null;
}

function readGenerateBody(body: unknown): GenerateBody {
  if (typeof body !== 'object' || body === null) {
    return { industry: null, title: null, product: null };
  }
  const record = body as Record<string, unknown>;
  const rawIndustry = record.industry;
  const industry =
    typeof rawIndustry === 'string' && rawIndustry.trim().length > 0 ? rawIndustry.trim() : null;
  const rawTitle = record.title;
  const title = typeof rawTitle === 'string' && rawTitle.trim().length > 0 ? rawTitle.trim() : null;
  return { industry, title, product: readProduct(record.product) };
}

function readUpdateBody(body: unknown): UpdateBody {
  if (typeof body !== 'object' || body === null) {
    return { content: null, title: undefined };
  }
  const record = body as Record<string, unknown>;
  const rawContent = record.content;
  const content =
    typeof rawContent === 'string' && rawContent.trim().length > 0 ? rawContent.trim() : null;
 // title 缺省 → undefined（保留原值）；显式传非字符串或空串 → null（清空标题）
  let title: string | null | undefined;
  if (Object.prototype.hasOwnProperty.call(record, 'title')) {
    const rawTitle = record.title;
    title = typeof rawTitle === 'string' && rawTitle.trim().length > 0 ? rawTitle.trim() : null;
  }
  return { content, title };
}

/** 按「归属 + 存在性」查当前用户的单条话术，不存在返回 undefined */
async function findOwnedScript(id: string, userId: string) {
  const rows = await db
    .select()
    .from(scriptsTable)
    .where(and(eq(scriptsTable.id, id), eq(scriptsTable.userId, userId)))
    .limit(1);
  return rows[0];
}

/** 标题超长统一提示（generate / edit 共用） */
function titleTooLongResponse(reply: FastifyReply) {
  return reply.code(400).send({
    error: 'TITLE_INVALID',
    message: `话术标题不能超过 ${MAX_TITLE_LENGTH} 字`,
  });
}

/**
 * 话术生成与编辑保存路由（统一前缀 /api/scripts，全部要求登录态）。
 * 敏感词扫描为合规红线：生成后、编辑保存后都必须重新扫描。
 */
export const scriptsRoutes: FastifyPluginAsync = async (app) => {
  // 生成话术：真实调 DeepSeek → 敏感词扫描 → 命中自动改写（最多 2 次）→ 仍不过用安全模板兜底
  // 成品入库必然 ready+pass（合规红线不变：入库内容都经过拦截级扫描）
  app.post('/api/scripts/generate', { preHandler: app.authenticate }, async (request, reply) => {
    const { industry, title, product } = readGenerateBody(request.body);
    if (!industry || !isScriptIndustry(industry)) {
      return reply.code(400).send({ error: 'INDUSTRY_INVALID', message: '不支持的行业类型' });
    }
    if (title !== null && title.length > MAX_TITLE_LENGTH) {
      return titleTooLongResponse(reply);
    }
    if (!product) {
      return reply.code(400).send({ error: 'PRODUCT_INVALID', message: '商品信息不能为空' });
    }

    const MAX_GENERATE_REWRITES = 2;
    let content: string;
    let generationNote: string | undefined;
    let rewriteAttempts = 0;
    try {
      content = await scriptService.generateScript({ industry, product });
      let scanned = scanSensitive(content);
      while (scanned.status === 'blocked' && rewriteAttempts < MAX_GENERATE_REWRITES) {
        rewriteAttempts += 1;
        content = await scriptService.rewriteScript({
          industry,
          product,
          draft: content,
          matchedWords: scanned.matchedWords,
        });
        scanned = scanSensitive(content);
      }
      if (scanned.status === 'blocked') {
        content = buildSafeScriptFallback(industry, product);
        scanned = scanSensitive(content);
        if (scanned.status === 'blocked') {
          // 兜底文案已逐字避开拦截词表，走到这里说明词表/模板回归，属内部错误
          throw new Error('安全兜底文案未通过敏感词扫描（内部错误）');
        }
        generationNote =
          'AI 多次生成仍含违规表述，已自动替换为安全模板话术（可直接开播），建议打开查看后润色';
      } else if (rewriteAttempts > 0) {
        generationNote = 'AI 初稿含违规表述，已自动改写为合规版本（可直接开播）';
      }

      const inserted = await db
        .insert(scriptsTable)
        .values({
          userId: request.user.userId,
          industry,
          title,
          productSnapshot: product,
          content,
          status: 'ready',
          sensitiveCheckStatus: 'pass',
          sensitiveMatchedWords: [],
          sensitiveScannedAt: new Date(),
        })
        .returning();
      const created = inserted[0];
      if (!created) {
        // 理论上插入成功必有返回，此处兜底避免静默失败
        throw new Error('保存话术失败');
      }
      // generationNote 仅在发生自动改写/兜底时随响应下发（不入库，刷新后不保留）
      return reply.code(201).send({ ...created, ...(generationNote ? { generationNote } : {}) });
    } catch (err) {
      if (err instanceof ScriptError && err.code === 'GENERATION_FAILED') {
        return reply.code(502).send({ error: err.code, message: err.message });
      }
      throw err;
    }
  });

  // 我的话术列表：仅当前用户，按创建时间倒序
  app.get('/api/scripts', { preHandler: app.authenticate }, async (request) => {
    return db
      .select()
      .from(scriptsTable)
      .where(eq(scriptsTable.userId, request.user.userId))
      .orderBy(desc(scriptsTable.createdAt));
  });

  // 话术详情：归属校验，非本人或不存在统一 404
  app.get('/api/scripts/:id', { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = request.params as ScriptIdParams;
    const script = await findOwnedScript(id, request.user.userId);
    if (!script) {
      return reply.code(404).send({ error: 'SCRIPT_NOT_FOUND', message: '话术不存在' });
    }
    return script;
  });

  // 编辑保存：更新 content/title 后重新敏感词扫描（编辑可能引入敏感词）
  app.put('/api/scripts/:id', { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = request.params as ScriptIdParams;
    const existing = await findOwnedScript(id, request.user.userId);
    if (!existing) {
      return reply.code(404).send({ error: 'SCRIPT_NOT_FOUND', message: '话术不存在' });
    }

    const { content, title } = readUpdateBody(request.body);
    if (!content) {
      return reply.code(400).send({ error: 'CONTENT_REQUIRED', message: '话术内容不能为空' });
    }
    if (title !== undefined && title !== null && title.length > MAX_TITLE_LENGTH) {
      return titleTooLongResponse(reply);
    }

    const scanned = scanSensitive(content);
    const updated = await db
      .update(scriptsTable)
      .set({
        content,
        // title 未传保留原值；传空串/非字符串视为清空
        title: title === undefined ? existing.title : title,
        status: scanned.status === 'blocked' ? 'blocked' : 'ready',
        sensitiveCheckStatus: scanned.status,
        sensitiveMatchedWords: scanned.matchedWords,
        sensitiveScannedAt: new Date(),
      })
      .where(and(eq(scriptsTable.id, id), eq(scriptsTable.userId, request.user.userId)))
      .returning();
    const row = updated[0];
    if (!row) {
      throw new Error('更新话术失败');
    }
    return row;
  });
};
