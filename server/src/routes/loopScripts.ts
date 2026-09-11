import type { FastifyPluginAsync } from 'fastify';
import { and, count, desc, eq, inArray } from 'drizzle-orm';
import { db } from '../db/client';
import {
  lives as livesTable,
  loopScriptItems as loopScriptItemsTable,
  loopScripts as loopScriptsTable,
  scripts as scriptsTable,
} from '../db/schema';
import { scanSensitive } from '../services/sensitive';
import {
  DEFAULT_LOOP_ITEM_COUNT,
  DEFAULT_LOOP_SCRIPT_SCENARIO,
  isLoopScriptScenario,
  loopScriptService,
  LoopScriptError,
  LOOP_ITEM_KINDS,
  MAX_LOOP_ITEM_TEXT_LENGTH,
  MAX_LOOP_ITEMS,
  MIN_LOOP_ITEMS,
} from '../services/loopScript';

// ---------- 常量与类型 ----------

/** title 列 varchar(100)，长度上限与表定义对齐 */
const MAX_TITLE_LENGTH = 100;

/** 列表单次返回上限：与 lives 列表口径一致 */
const MAX_LIST_LIMIT = 50;

interface LoopScriptIdParams {
  id: string;
}

/** 归一化后的台本条目（落库 / 扫描使用） */
interface ParsedItem {
  kind: string | null;
  text: string;
  gapAfterSeconds: number | null;
}

interface CreateBody {
  title: unknown;
  items: unknown;
  sourceScriptId: unknown;
}

interface GenerateBody {
  sourceScriptId: unknown;
  couponText: unknown;
  scenario: unknown;
  customBrief: unknown;
  itemCount: unknown;
}

type ItemError = { code: string; message: string };

/** 列表摘要对外形状 */
interface LoopScriptSummary {
  id: string;
  title: string;
  sourceScriptId: string | null;
  itemCount: number;
  createdAt: string;
  updatedAt: string;
}

// ---------- 读取与校验 ----------

/** 台本条目归一化：条数 1-12、文本 trim 后 1-200 字、kind 落白名单否则 null、间隔 0-60 否则 null */
function normalizeItems(raw: unknown): { items: ParsedItem[] } | { error: ItemError } {
  if (!Array.isArray(raw)) {
    return { error: { code: 'ITEMS_INVALID', message: '台本条目必须是非空数组' } };
  }
  if (raw.length < MIN_LOOP_ITEMS || raw.length > MAX_LOOP_ITEMS) {
    return {
      error: {
        code: 'ITEMS_INVALID',
        message: `台本条目数需在 ${MIN_LOOP_ITEMS}-${MAX_LOOP_ITEMS} 条之间`,
      },
    };
  }
  const items: ParsedItem[] = [];
  for (let index = 0; index < raw.length; index += 1) {
    const element = raw[index];
    if (typeof element !== 'object' || element === null || Array.isArray(element)) {
      return { error: { code: 'ITEMS_INVALID', message: `第 ${index + 1} 条台本格式不正确` } };
    }
    const record = element as Record<string, unknown>;
    const text = typeof record.text === 'string' ? record.text.trim() : '';
    if (text.length === 0) {
      return { error: { code: 'ITEM_TEXT_REQUIRED', message: `第 ${index + 1} 条台词不能为空` } };
    }
    if (text.length > MAX_LOOP_ITEM_TEXT_LENGTH) {
      return {
        error: {
          code: 'ITEM_TEXT_TOO_LONG',
          message: `第 ${index + 1} 条台词不能超过 ${MAX_LOOP_ITEM_TEXT_LENGTH} 字`,
        },
      };
    }
    const kindRaw = record.kind;
    const kind =
      typeof kindRaw === 'string' && (LOOP_ITEM_KINDS as readonly string[]).includes(kindRaw)
        ? kindRaw
        : null;
    let gapAfterSeconds: number | null = null;
    const gapRaw = record.gapAfterSeconds;
    if (typeof gapRaw === 'number' && Number.isInteger(gapRaw) && gapRaw >= 0 && gapRaw <= 60) {
      gapAfterSeconds = gapRaw;
    }
    items.push({ kind, text, gapAfterSeconds });
  }
  return { items };
}

/** 逐条敏感词扫描：命中任一 → 汇总去重命中词（合规红线：入库前必扫） */
function scanItems(items: ReadonlyArray<{ text: string }>): string[] {
  const matched = new Set<string>();
  for (const item of items) {
    for (const word of scanSensitive(item.text).matchedWords) {
      matched.add(word);
    }
  }
  return [...matched];
}

function readCreateBody(body: unknown): CreateBody {
  if (typeof body !== 'object' || body === null) {
    return { title: null, items: null, sourceScriptId: null };
  }
  const record = body as Record<string, unknown>;
  return {
    title: record.title ?? null,
    items: record.items ?? null,
    sourceScriptId: record.sourceScriptId ?? null,
  };
}

function readGenerateBody(body: unknown): GenerateBody {
  if (typeof body !== 'object' || body === null) {
    return { sourceScriptId: null, couponText: null, scenario: null, customBrief: null, itemCount: null };
  }
  const record = body as Record<string, unknown>;
  return {
    sourceScriptId: record.sourceScriptId ?? null,
    couponText: record.couponText ?? null,
    scenario: record.scenario ?? null,
    customBrief: record.customBrief ?? null,
    itemCount: record.itemCount ?? null,
  };
}

/** 可选 id：非空字符串才接收，其余一律视为 null */
function optionalId(raw: unknown): string | null {
  return typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : null;
}

// ---------- 归属查询 ----------

/** 按「归属 + 存在性」查当前用户的一条台本 */
async function findOwnedLoopScript(id: string, userId: string) {
  const rows = await db
    .select()
    .from(loopScriptsTable)
    .where(and(eq(loopScriptsTable.id, id), eq(loopScriptsTable.userId, userId)))
    .limit(1);
  return rows[0];
}

/** 按「归属 + 存在性」查当前用户的一条来源话术（返回 undefined 表示不存在或非本人） */
async function findOwnedScript(id: string, userId: string) {
  const rows = await db
    .select()
    .from(scriptsTable)
    .where(and(eq(scriptsTable.id, id), eq(scriptsTable.userId, userId)))
    .limit(1);
  return rows[0];
}

/** 事务内落库：新建/替换统一入口，seq 从 1 起按下标重建 */
async function replaceItemsTx(
  headerId: string,
  items: ParsedItem[],
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
) {
  await tx.delete(loopScriptItemsTable).where(eq(loopScriptItemsTable.loopScriptId, headerId));
  if (items.length === 0) {
    return [];
  }
  const inserted = await tx
    .insert(loopScriptItemsTable)
    .values(
      items.map((item, index) => ({
        loopScriptId: headerId,
        seq: index + 1,
        kind: item.kind,
        text: item.text,
        gapAfterSeconds: item.gapAfterSeconds,
      })),
    )
    .returning();
  return inserted;
}

/**
 * 循环台本库路由（统一前缀 /api/loop-scripts，全部要求登录态）。
 * 台本 = 可复用台本库：商家可新建/编辑/删除，场次通过 PATCH /api/lives/:id 绑定。
 * 合规红线：任何条目落库前必须逐条过敏感词扫描，命中直接 400 不落库，无跳过开关。
 */
export const loopScriptsRoutes: FastifyPluginAsync = async (app) => {
  // 生成台本草稿（M2）：不落库，返回 items 供客户端「预览后保存」。
  // 复用 P-话术v1 一次过审链路：初稿逐条扫描 → 命中整组改写（≤2 次）→ 仍不过 502 不落库。
  app.post('/api/loop-scripts/generate', { preHandler: app.authenticate }, async (request, reply) => {
    const body = readGenerateBody(request.body);
    const sourceScriptId = optionalId(body.sourceScriptId);
    if (!sourceScriptId) {
      return reply
        .code(400)
        .send({ error: 'SCRIPT_REQUIRED', message: '必须指定来源话术才能生成循环台本' });
    }

    let itemCount = DEFAULT_LOOP_ITEM_COUNT;
    if (body.itemCount !== null && body.itemCount !== undefined) {
      const raw = Number(body.itemCount);
      if (!Number.isInteger(raw) || raw < MIN_LOOP_ITEMS || raw > MAX_LOOP_ITEMS) {
        return reply.code(400).send({
          error: 'ITEM_COUNT_INVALID',
          message: `期望条目数需在 ${MIN_LOOP_ITEMS}-${MAX_LOOP_ITEMS} 之间`,
        });
      }
      itemCount = raw;
    }

    const source = await findOwnedScript(sourceScriptId, request.user.userId);
    if (!source) {
      return reply.code(404).send({ error: 'SCRIPT_NOT_FOUND', message: '话术不存在或不属于当前用户' });
    }
    if (source.status !== 'ready' || source.sensitiveCheckStatus !== 'pass') {
      return reply.code(422).send({
        error: 'SCRIPT_REQUIRED',
        message: '仅支持敏感词扫描通过且已就绪的正式话术生成循环台本',
      });
    }

    const couponText =
      typeof body.couponText === 'string' && body.couponText.trim().length > 0
        ? body.couponText.trim()
        : null;

    // 生成场景：缺省按团购；显式传了非白名单值一律 400（避免静默用到错误场景）
    let scenario = DEFAULT_LOOP_SCRIPT_SCENARIO;
    if (body.scenario !== null && body.scenario !== undefined) {
      if (!isLoopScriptScenario(body.scenario)) {
        return reply.code(400).send({
          error: 'SCENARIO_INVALID',
          message: '生成场景不支持，仅支持 single_product / group_buy / custom',
        });
      }
      scenario = body.scenario;
    }
    // 自定义场景的参考素材：非空才透传；未给则由骨架自行发挥、不编造
    const customBrief =
      typeof body.customBrief === 'string' && body.customBrief.trim().length > 0
        ? body.customBrief.trim()
        : null;

    const MAX_GENERATE_REWRITES = 2;
    const input = {
      industry: source.industry,
      product: source.productSnapshot as Record<string, string>,
      sourceContent: source.content,
      couponText,
      scenario,
      customBrief,
      itemCount,
    };
    try {
      let draft = await loopScriptService.generateItems(input);
      let matchedWords = scanItems(draft);
      let rewriteAttempts = 0;
      let generationNote: string | undefined;
      while (matchedWords.length > 0 && rewriteAttempts < MAX_GENERATE_REWRITES) {
        rewriteAttempts += 1;
        draft = await loopScriptService.rewriteItems({ ...input, draft, matchedWords });
        matchedWords = scanItems(draft);
      }
      if (matchedWords.length > 0) {
        return reply.code(502).send({
          error: 'GENERATION_FAILED',
          message: 'AI 多次生成仍含违规表述，请减少绝对化用词后重试，本次结果未保存',
        });
      }
      if (rewriteAttempts > 0) {
        generationNote = 'AI 初稿含违规表述，已自动改写为合规版本（预览后可保存）';
      }
      return reply.code(200).send({
        items: draft,
        ...(generationNote ? { generationNote } : {}),
      });
    } catch (err) {
      if (err instanceof LoopScriptError && err.code === 'GENERATION_FAILED') {
        return reply.code(502).send({ error: err.code, message: err.message });
      }
      throw err;
    }
  });

  // 我的台本列表：仅当前用户，按更新时间倒序，返回条数摘要
  app.get('/api/loop-scripts', { preHandler: app.authenticate }, async (request) => {
    const rows = await db
      .select()
      .from(loopScriptsTable)
      .where(eq(loopScriptsTable.userId, request.user.userId))
      .orderBy(desc(loopScriptsTable.updatedAt))
      .limit(MAX_LIST_LIMIT);
    const ids = rows.map((row) => row.id);
    const countByScript: Record<string, number> = {};
    if (ids.length > 0) {
      const counts = await db
        .select({
          loopScriptId: loopScriptItemsTable.loopScriptId,
          itemCount: count(),
        })
        .from(loopScriptItemsTable)
        .where(inArray(loopScriptItemsTable.loopScriptId, ids))
        .groupBy(loopScriptItemsTable.loopScriptId);
      for (const row of counts) {
        countByScript[row.loopScriptId] = row.itemCount;
      }
    }
    const summaries: LoopScriptSummary[] = rows.map((row) => ({
      id: row.id,
      title: row.title,
      sourceScriptId: row.sourceScriptId,
      itemCount: countByScript[row.id] ?? 0,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    }));
    return summaries;
  });

  // 台本详情：归属校验，非本人或不存在统一 404
  app.get('/api/loop-scripts/:id', { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = request.params as LoopScriptIdParams;
    const header = await findOwnedLoopScript(id, request.user.userId);
    if (!header) {
      return reply.code(404).send({ error: 'LOOP_SCRIPT_NOT_FOUND', message: '循环台本不存在' });
    }
    const items = await db
      .select()
      .from(loopScriptItemsTable)
      .where(eq(loopScriptItemsTable.loopScriptId, id))
      .orderBy(loopScriptItemsTable.seq);
    return { ...header, items };
  });

  // 新建台本：全部条目过敏感词扫描后事务落库；可选 sourceScriptId（须归属当前用户）
  app.post('/api/loop-scripts', { preHandler: app.authenticate }, async (request, reply) => {
    const body = readCreateBody(request.body);
    const title = typeof body.title === 'string' ? body.title.trim() : '';
    if (title.length === 0 || title.length > MAX_TITLE_LENGTH) {
      return reply
        .code(400)
        .send({ error: 'TITLE_INVALID', message: `台本标题不能为空且不超过 ${MAX_TITLE_LENGTH} 字` });
    }
    const normalized = normalizeItems(body.items);
    if ('error' in normalized) {
      return reply.code(400).send({ error: normalized.error.code, message: normalized.error.message });
    }
    const sourceScriptId = optionalId(body.sourceScriptId);
    if (sourceScriptId) {
      const source = await findOwnedScript(sourceScriptId, request.user.userId);
      if (!source) {
        return reply.code(404).send({ error: 'SCRIPT_NOT_FOUND', message: '话术不存在或不属于当前用户' });
      }
    }
    const matchedWords = scanItems(normalized.items);
    if (matchedWords.length > 0) {
      return reply.code(400).send({
        error: 'SENSITIVE_BLOCKED',
        message: '台本包含被拦截用语，请修改后再保存',
        matchedWords,
      });
    }

    const created = await db.transaction(async (tx) => {
      const headers = await tx
        .insert(loopScriptsTable)
        .values({ userId: request.user.userId, title, sourceScriptId })
        .returning();
      const header = headers[0];
      if (!header) {
        throw new Error('创建循环台本失败');
      }
      const insertedItems = await replaceItemsTx(header.id, normalized.items, tx);
      return { header, items: insertedItems };
    });
    return reply.code(201).send({ ...created.header, items: created.items });
  });

  // 整体替换台本标题与条目：引用它的场次待下次开播生效（本轮不做热更新）
  app.put('/api/loop-scripts/:id', { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = request.params as LoopScriptIdParams;
    const existing = await findOwnedLoopScript(id, request.user.userId);
    if (!existing) {
      return reply.code(404).send({ error: 'LOOP_SCRIPT_NOT_FOUND', message: '循环台本不存在' });
    }
    const body = readCreateBody(request.body);
    const title = typeof body.title === 'string' ? body.title.trim() : '';
    if (title.length === 0 || title.length > MAX_TITLE_LENGTH) {
      return reply
        .code(400)
        .send({ error: 'TITLE_INVALID', message: `台本标题不能为空且不超过 ${MAX_TITLE_LENGTH} 字` });
    }
    const normalized = normalizeItems(body.items);
    if ('error' in normalized) {
      return reply.code(400).send({ error: normalized.error.code, message: normalized.error.message });
    }
    const matchedWords = scanItems(normalized.items);
    if (matchedWords.length > 0) {
      return reply.code(400).send({
        error: 'SENSITIVE_BLOCKED',
        message: '台本包含被拦截用语，请修改后再保存',
        matchedWords,
      });
    }

    const updated = await db.transaction(async (tx) => {
      const headers = await tx
        .update(loopScriptsTable)
        .set({ title })
        .where(and(eq(loopScriptsTable.id, id), eq(loopScriptsTable.userId, request.user.userId)))
        .returning();
      const header = headers[0];
      if (!header) {
        throw new Error('更新循环台本失败');
      }
      const insertedItems = await replaceItemsTx(header.id, normalized.items, tx);
      return { header, items: insertedItems };
    });
    return { ...updated.header, items: updated.items };
  });

  // 删除台本：先解除场次引用（lives.loopScriptId 置 null），再删除台本与条目（级联）
  app.delete('/api/loop-scripts/:id', { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = request.params as LoopScriptIdParams;
    const existing = await findOwnedLoopScript(id, request.user.userId);
    if (!existing) {
      return reply.code(404).send({ error: 'LOOP_SCRIPT_NOT_FOUND', message: '循环台本不存在' });
    }
    // 引用解绑：仅解除引用行；进行中场次的内存快照不受影响（M4 引擎口径）
    await db.update(livesTable).set({ loopScriptId: null }).where(eq(livesTable.loopScriptId, id));
    const deleted = await db
      .delete(loopScriptsTable)
      .where(and(eq(loopScriptsTable.id, id), eq(loopScriptsTable.userId, request.user.userId)))
      .returning({ id: loopScriptsTable.id });
    if (deleted.length === 0) {
      return reply.code(404).send({ error: 'LOOP_SCRIPT_NOT_FOUND', message: '循环台本不存在' });
    }
    return reply.code(200).send({ ok: true });
  });
};
