import type { FastifyPluginAsync } from 'fastify';
import bcrypt from 'bcryptjs';
import { eq, sql } from 'drizzle-orm';
import { db } from '../db/client';
import { adminUsers } from '../db/schema';
import { JWT_TOKEN_TTL_SECONDS } from '../plugins/auth';
import { LEDGER_SOURCE, toLedgerExecutor, topUpMinutes } from '../services/ledger';
import { QUOTA_TIERS, SUBSCRIPTION_PLAN } from '../services/quotaTiers';

// 内部运营工具只读口径：分页上限与默认值
const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 20;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const USAGE_CATEGORIES = ['voice_clone', 'tts', 'script_generation', 'sensitive_check'] as const;
const ORDER_STATUSES = ['pending', 'paid', 'refunded', 'closed'] as const;

/** 校验分页参数：page>=1、pageSize 落在 1-100，非法值回退默认 */
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

/** 可选 uuid 过滤参数：非空且合法才使用，非法直接抛业务提示（由路由转 400） */
function readUuidFilter(value: unknown): string | null {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new Error('QUERY_INVALID:用户 ID 格式不正确');
  }
  return value;
}

/** 读取并校验登录体：{ username, password } */
function readLoginBody(body: unknown): { username: string; password: string } {
  const record = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  const username = typeof record.username === 'string' ? record.username.trim() : '';
  const password = typeof record.password === 'string' ? record.password : '';
  return { username, password };
}

/** 月度周期（period=YYYY-MM）当前值：以数据库时间为准，避免应用/DB 时区漂移 */
async function readCurrentPeriod(): Promise<string> {
  const rows = await db.execute(sql`SELECT to_char(now(), 'YYYY-MM') AS period`);
  return (rows.rows[0]?.period as string) ?? new Date().toISOString().slice(0, 7);
}

/** 校验 period：YYYY-MM，缺省回退当前月；非法抛出业务提示（由路由转 400） */
function readPeriodValue(value: unknown, current: string): string {
  if (value === undefined || value === null || value === '') {
    return current;
  }
  if (typeof value !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) {
    throw new Error('BODY_INVALID:周期格式应为 YYYY-MM');
  }
  return value;
}

/** 额度列白名单（安全拼接动态 SQL 用）：键 = 请求字段，值 = 数据库列名 */
const QUOTA_COLUMNS: Record<
  string,
  'tts_chars_quota' | 'script_generations_quota' | 'live_minutes_quota'
> = {
  ttsCharsQuota: 'tts_chars_quota',
  scriptGenerationsQuota: 'script_generations_quota',
  liveMinutesQuota: 'live_minutes_quota',
};

/** 读取并校验额度调整体：至少提供一档非负整数额度；返回 { period, provided } */
function readQuotaAdjustBody(
  body: unknown,
  current: string,
): { period: string; provided: Map<string, number> } {
  const record = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  const period = readPeriodValue(record.period, current);
  const provided = new Map<string, number>();
  for (const [key, column] of Object.entries(QUOTA_COLUMNS)) {
    const raw = record[key];
    if (raw === undefined || raw === null || raw === '') {
      continue;
    }
    if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0) {
      throw new Error('BODY_INVALID:额度必须是不小于 0 的整数');
    }
    provided.set(column, raw);
  }
  if (provided.size === 0) {
    throw new Error(
      'BODY_INVALID:至少提供一档额度（ttsCharsQuota/scriptGenerationsQuota/liveMinutesQuota）',
    );
  }
  return { period, provided };
}

/** 运营写操作审计留痕（写失败抛错：合规红线，宁可让操作失败也不静默丢日志） */
async function writeAuditLog(input: {
  adminUserId: string;
  userId?: string | null;
  action: string;
  resourceType: string;
  resourceId: string;
  detail: Record<string, unknown>;
  ip: string;
}): Promise<void> {
  await db.execute(sql`
    INSERT INTO audit_logs (admin_user_id, user_id, action, resource_type, resource_id, detail, ip)
    VALUES (${input.adminUserId}, ${input.userId ?? null}, ${input.action}, ${input.resourceType},
      ${input.resourceId}, ${sql`${JSON.stringify(input.detail)}::jsonb`}, ${input.ip})
  `);
}

/**
 * 后台管理接口（统一前缀 /api/admin，全部要求 adminAuthenticate，不开放注册）：
 * 登录 → 数据看板 / 商家台账 / 额度 / 用量 / 订单 / 内容审核只读队列。
 */
export const adminRoutes: FastifyPluginAsync = async (app) => {
  // 后台登录：bcrypt 比对（不区分“账号不存在”与“口令错误”，避免账号枚举）；成功记录 lastLoginAt
  app.post('/api/admin/login', async (request, reply) => {
    const { username, password } = readLoginBody(request.body);
    if (!username || !password) {
      return reply.code(400).send({ error: 'LOGIN_INVALID', message: '账号与口令不能为空' });
    }
    const rows = await db
      .select({
        id: adminUsers.id,
        username: adminUsers.username,
        passwordHash: adminUsers.passwordHash,
        role: adminUsers.role,
        isActive: adminUsers.isActive,
      })
      .from(adminUsers)
      .where(eq(adminUsers.username, username))
      .limit(1);
    const admin = rows[0];
    const ok = admin !== undefined && admin.isActive && (await bcrypt.compare(password, admin.passwordHash));
    if (!ok || !admin) {
      return reply.code(401).send({ error: 'LOGIN_FAILED', message: '账号或口令不正确' });
    }
    await db
      .update(adminUsers)
      .set({ lastLoginAt: new Date() })
      .where(eq(adminUsers.id, admin.id));
    const token = await reply.adminJwtSign({ adminId: admin.id });
    return {
      token,
      tokenType: 'Bearer',
      expiresInSeconds: JWT_TOKEN_TTL_SECONDS,
      admin: { id: admin.id, username: admin.username, role: admin.role },
    };
  });

  // 当前后台账号信息（admin 载荷已由 adminAuthenticate 回查在岗，直接回读即可）
  app.get('/api/admin/me', { preHandler: app.adminAuthenticate }, async (request) => {
    return { admin: request.admin };
  });

  // 数据看板：北极星指标 = 商家数 / 订阅订单与收入 / AI 用量 / 直播场次
  app.get('/api/admin/dashboard', { preHandler: app.adminAuthenticate }, async () => {
    const dashboard = await db.execute(sql`
      SELECT
        (SELECT count(*)::int FROM users) AS total_merchants,
        (SELECT count(*)::int FROM users WHERE created_at >= date_trunc('month', now())) AS new_merchants_month,
        (SELECT count(*)::int FROM users WHERE subscription_status = 'paid') AS paid_merchants,
        (SELECT count(*)::int FROM orders WHERE status = 'paid' AND paid_at >= date_trunc('month', now())) AS orders_month,
        (SELECT coalesce(sum(amount_cents), 0)::int FROM orders WHERE status = 'paid' AND paid_at >= date_trunc('month', now())) AS revenue_month,
        (SELECT count(*)::int FROM orders WHERE status = 'paid') AS orders_total,
        (SELECT coalesce(sum(amount_cents), 0)::int FROM orders WHERE status = 'paid') AS revenue_total,
        (SELECT count(*)::int FROM usage_logs WHERE created_at >= date_trunc('day', now())) AS usage_calls_today,
        (SELECT coalesce(sum(output_chars), 0)::int FROM usage_logs WHERE created_at >= date_trunc('day', now())) AS usage_chars_today,
        (SELECT count(*)::int FROM usage_logs WHERE created_at >= date_trunc('month', now())) AS usage_calls_month,
        (SELECT coalesce(sum(output_chars), 0)::int FROM usage_logs WHERE created_at >= date_trunc('month', now())) AS usage_chars_month,
        (SELECT count(*)::int FROM lives WHERE status = 'live') AS lives_active,
        (SELECT count(*)::int FROM lives) AS lives_total
    `);
    const row = dashboard.rows[0] ?? {};
    return {
      merchants: {
        total: row.totalMerchants ?? 0,
        newThisMonth: row.newMerchantsMonth ?? 0,
        paid: row.paidMerchants ?? 0,
      },
      orders: {
        thisMonth: { count: row.ordersMonth ?? 0, revenueCents: row.revenueMonth ?? 0 },
        total: { count: row.ordersTotal ?? 0, revenueCents: row.revenueTotal ?? 0 },
      },
      usage: {
        today: { calls: row.usageCallsToday ?? 0, chars: row.usageCharsToday ?? 0 },
        thisMonth: { calls: row.usageCallsMonth ?? 0, chars: row.usageCharsMonth ?? 0 },
      },
      lives: { active: row.livesActive ?? 0, total: row.livesTotal ?? 0 },
    };
  });

  // 商家台账：手机号/昵称搜索 + 资源与订单概要
  app.get('/api/admin/merchants', { preHandler: app.adminAuthenticate }, async (request) => {
    const query = request.query as Record<string, unknown>;
    const { page, pageSize } = readPagination(query);
    const search = typeof query.search === 'string' ? query.search.trim() : '';
    const pattern = `%${search}%`;
    const offset = (page - 1) * pageSize;
    const merchants = await db.execute(sql`
      SELECT
        u.id, u.phone, u.nickname, u.subscription_status AS "subscriptionStatus",
        u.subscription_expires_at AS "subscriptionExpiresAt", u.created_at AS "createdAt",
        (SELECT count(*)::int FROM voices v WHERE v.user_id = u.id) AS "voiceCount",
        (SELECT count(*)::int FROM scripts s WHERE s.user_id = u.id) AS "scriptCount",
        (SELECT count(*)::int FROM lives l WHERE l.user_id = u.id) AS "liveCount",
        (SELECT count(*)::int FROM orders o WHERE o.user_id = u.id AND o.status = 'paid') AS "paidOrderCount"
      FROM users u
      WHERE ${search === '' ? sql`true` : sql`(u.phone ILIKE ${pattern} OR COALESCE(u.nickname, '') ILIKE ${pattern})`}
      ORDER BY u.created_at DESC
      LIMIT ${pageSize} OFFSET ${offset}
    `);
    const totals = await db.execute(sql`
      SELECT count(*)::int AS total
      FROM users u
      WHERE ${search === '' ? sql`true` : sql`(u.phone ILIKE ${pattern} OR COALESCE(u.nickname, '') ILIKE ${pattern})`}
    `);
    return { items: merchants.rows, total: totals.rows[0]?.total ?? 0, page, pageSize };
  });

  // 额度列表：支持按商家过滤；未产生用量的商家无额度行（首调时按免费档自动建档）
  app.get('/api/admin/quotas', { preHandler: app.adminAuthenticate }, async (request, reply) => {
    const query = request.query as Record<string, unknown>;
    const { page, pageSize } = readPagination(query);
    let userId: string | null = null;
    try {
      userId = readUuidFilter(query.userId);
    } catch (err) {
      return reply.code(400).send({ error: 'QUERY_INVALID', message: (err as Error).message });
    }
    const offset = (page - 1) * pageSize;
    const quotaRows = await db.execute(sql`
      SELECT q.*, u.phone, u.nickname
      FROM quotas q JOIN users u ON u.id = q.user_id
      WHERE ${userId ? sql`q.user_id = ${userId}` : sql`true`}
      ORDER BY q.period DESC, u.created_at DESC
      LIMIT ${pageSize} OFFSET ${offset}
    `);
    const totals = await db.execute(sql`
      SELECT count(*)::int AS total
      FROM quotas q
      WHERE ${userId ? sql`q.user_id = ${userId}` : sql`true`}
    `);
    return { items: quotaRows.rows, total: totals.rows[0]?.total ?? 0, page, pageSize };
  });

  // AI 用量流水：类别/商家筛选，只读
  app.get('/api/admin/usage', { preHandler: app.adminAuthenticate }, async (request, reply) => {
    const query = request.query as Record<string, unknown>;
    const { page, pageSize } = readPagination(query);
    const category =
      typeof query.category === 'string' &&
      (USAGE_CATEGORIES as readonly string[]).includes(query.category)
        ? query.category
        : '';
    let userId: string | null = null;
    try {
      userId = readUuidFilter(query.userId);
    } catch (err) {
      return reply.code(400).send({ error: 'QUERY_INVALID', message: (err as Error).message });
    }
    const offset = (page - 1) * pageSize;
    const usageRows = await db.execute(sql`
      SELECT g.*, u.phone, u.nickname
      FROM usage_logs g JOIN users u ON u.id = g.user_id
      WHERE ${category ? sql`g.category = ${category}` : sql`true`}
        AND ${userId ? sql`g.user_id = ${userId}` : sql`true`}
      ORDER BY g.created_at DESC
      LIMIT ${pageSize} OFFSET ${offset}
    `);
    const totals = await db.execute(sql`
      SELECT count(*)::int AS total
      FROM usage_logs g
      WHERE ${category ? sql`g.category = ${category}` : sql`true`}
        AND ${userId ? sql`g.user_id = ${userId}` : sql`true`}
    `);
    const summary = await db.execute(sql`
      SELECT
        coalesce(sum(prompt_chars), 0)::int AS promptChars,
        coalesce(sum(output_chars), 0)::int AS outputChars,
        coalesce(sum(cost_cents), 0)::int AS costCents
      FROM usage_logs g
      WHERE ${category ? sql`g.category = ${category}` : sql`true`}
        AND ${userId ? sql`g.user_id = ${userId}` : sql`true`}
    `);
    const sum = summary.rows[0] ?? {};
    return {
      items: usageRows.rows,
      total: totals.rows[0]?.total ?? 0,
      page,
      pageSize,
      summary: {
        promptChars: sum.promptChars ?? 0,
        outputChars: sum.outputChars ?? 0,
        costCents: sum.costCents ?? 0,
      },
    };
  });

  // 订单列表：状态筛选，用于后台订阅管理
  app.get('/api/admin/orders', { preHandler: app.adminAuthenticate }, async (request) => {
    const query = request.query as Record<string, unknown>;
    const { page, pageSize } = readPagination(query);
    const status =
      typeof query.status === 'string' &&
      (ORDER_STATUSES as readonly string[]).includes(query.status)
        ? query.status
        : '';
    const kind = query.kind === 'subscription' || query.kind === 'recharge' ? query.kind : '';
    const channel =
      query.channel === 'manual' || query.channel === 'alipay_scan' || query.channel === 'card'
        ? query.channel
        : '';
    const offset = (page - 1) * pageSize;
    const filters = [
      status ? sql`o.status = ${status}` : undefined,
      kind ? sql`o.kind = ${kind}` : undefined,
      channel ? sql`o.channel = ${channel}` : undefined,
    ].filter((item): item is ReturnType<typeof sql> => item !== undefined);
    const whereSql =
      filters.length > 0 ? sql`WHERE ${sql.join(filters, sql` AND `)}` : sql``;
    const orderRows = await db.execute(sql`
      SELECT o.*, u.phone, u.nickname
      FROM orders o JOIN users u ON u.id = o.user_id
      ${whereSql}
      ORDER BY o.created_at DESC
      LIMIT ${pageSize} OFFSET ${offset}
    `);
    const totals = await db.execute(sql`
      SELECT count(*)::int AS total
      FROM orders o
      ${whereSql}
    `);
    return { items: orderRows.rows, total: totals.rows[0]?.total ?? 0, page, pageSize };
  });

  // 内容审核 Tab 1：拦截话术队列（status=blocked，含命中词，只读供运营查看）
  app.get('/api/admin/audit/scripts', { preHandler: app.adminAuthenticate }, async (request) => {
    const query = request.query as Record<string, unknown>;
    const { page, pageSize } = readPagination(query);
    const offset = (page - 1) * pageSize;
    const scriptRows = await db.execute(sql`
      SELECT s.id, s.title, s.content, s.sensitive_matched_words AS "matchedWords",
        s.sensitive_scanned_at AS "scannedAt", s.created_at AS "createdAt", u.phone, u.nickname
      FROM scripts s JOIN users u ON u.id = s.user_id
      WHERE s.status = 'blocked'
      ORDER BY s.created_at DESC
      LIMIT ${pageSize} OFFSET ${offset}
    `);
    const totals = await db.execute(sql`
      SELECT count(*)::int AS total FROM scripts s WHERE s.status = 'blocked'
    `);
    return { items: scriptRows.rows, total: totals.rows[0]?.total ?? 0, page, pageSize };
  });

  // 内容审核 Tab 2：《声音授权协议》签署存档列表（合规红线：克隆前必须签署）
  app.get('/api/admin/audit/agreements', { preHandler: app.adminAuthenticate }, async (request) => {
    const query = request.query as Record<string, unknown>;
    const { page, pageSize } = readPagination(query);
    const offset = (page - 1) * pageSize;
    const agreementRows = await db.execute(sql`
      SELECT a.id, a.agreement_version AS "agreementVersion", a.signed_at AS "signedAt",
        a.signed_ip AS "signedIp", a.user_agent AS "userAgent", u.phone, u.nickname
      FROM voice_agreements a JOIN users u ON u.id = a.user_id
      ORDER BY a.signed_at DESC
      LIMIT ${pageSize} OFFSET ${offset}
    `);
    const totals = await db.execute(sql`
      SELECT count(*)::int AS total FROM voice_agreements a
    `);
    return { items: agreementRows.rows, total: totals.rows[0]?.total ?? 0, page, pageSize };
  });

  // 内容审核 Tab 3：审计日志（运营写操作留痕，随时间倒序）
  app.get('/api/admin/audit/logs', { preHandler: app.adminAuthenticate }, async (request) => {
    const query = request.query as Record<string, unknown>;
    const { page, pageSize } = readPagination(query);
    const offset = (page - 1) * pageSize;
    const logRows = await db.execute(sql`
      SELECT g.id, g.action, g.resource_type AS "resourceType", g.resource_id AS "resourceId",
        g.detail, g.ip, g.created_at AS "createdAt",
        a.username AS "adminUsername", u.phone AS "userPhone"
      FROM audit_logs g
      LEFT JOIN admin_users a ON a.id = g.admin_user_id
      LEFT JOIN users u ON u.id = g.user_id
      ORDER BY g.created_at DESC
      LIMIT ${pageSize} OFFSET ${offset}
    `);
    const totals = await db.execute(sql`
      SELECT count(*)::int AS total FROM audit_logs g
    `);
    return { items: logRows.rows, total: totals.rows[0]?.total ?? 0, page, pageSize };
  });

  // 额度调整（运营写操作）：按 (user_id, period) 幂等 upsert，只改 quota 不碰 used；审计留痕
  app.put(
    '/api/admin/quotas/:userId',
    { preHandler: app.adminAuthenticate },
    async (request, reply) => {
      const admin = request.admin;
      if (!admin) {
        return reply.code(401).send({ error: 'UNAUTHORIZED', message: '未登录或登录已过期' });
      }
      const params = request.params as Record<string, unknown>;
      const userId = typeof params.userId === 'string' ? params.userId : '';
      if (!UUID_PATTERN.test(userId)) {
        return reply.code(400).send({ error: 'USER_ID_INVALID', message: '用户 ID 格式不正确' });
      }
      let period: string;
      let provided: Map<string, number>;
      try {
        const current = await readCurrentPeriod();
        ({ period, provided } = readQuotaAdjustBody(request.body, current));
      } catch (err) {
        const message = (err as Error).message || 'BODY_INVALID:请求参数不正确';
        const [code, ...rest] = message.split(':');
        return reply.code(400).send({ error: code || 'BODY_INVALID', message: rest.join(':') || message });
      }
      const outcome = await db.transaction(async (tx) => {
        const existingRows = await tx.execute(sql`
          SELECT * FROM quotas WHERE user_id = ${userId} AND period = ${period} FOR UPDATE
        `);
        const existing = existingRows.rows[0] as Record<string, unknown> | undefined;
        if (!existing) {
          const userRows = await tx.execute(sql`SELECT id FROM users WHERE id = ${userId}`);
          if (userRows.rowCount === 0) {
            return { notFound: true };
          }
        }
        const columnNames = [...provided.keys()];
        const valueParts = [...provided.values()].map((value) => sql`${value}`);
        const sets = [
          ...[...provided.entries()].map(([column, value]) => sql`${sql.raw(column)} = ${value}`),
          sql`updated_at = now()`,
        ];
        const upserted = await tx.execute(sql`
          INSERT INTO quotas (user_id, period, ${sql.raw(columnNames.join(', '))})
          VALUES (${userId}, ${period}, ${sql.join(valueParts, sql`, `)})
          ON CONFLICT (user_id, period) DO UPDATE SET ${sql.join(sets, sql`, `)}
          RETURNING *
        `);
        return { notFound: false, before: existing, after: upserted.rows[0] };
      });
      if (outcome.notFound) {
        return reply.code(404).send({ error: 'USER_NOT_FOUND', message: '商家用户不存在' });
      }
      const before = (outcome.before ?? {}) as Record<string, unknown>;
      const after = outcome.after as Record<string, unknown>;
      await writeAuditLog({
        adminUserId: admin.id,
        userId,
        action: 'quota.adjust',
        resourceType: 'quota',
        resourceId: after.id as string,
        detail: {
          period,
          before: {
            ttsCharsQuota: before.tts_chars_quota ?? null,
            scriptGenerationsQuota: before.script_generations_quota ?? null,
            liveMinutesQuota: before.live_minutes_quota ?? null,
          },
          after: {
            ttsCharsQuota: after.tts_chars_quota,
            scriptGenerationsQuota: after.script_generations_quota,
            liveMinutesQuota: after.live_minutes_quota,
          },
        },
        ip: request.ip,
      });
      return {
        quota: {
          userId,
          period: after.period,
          ttsCharsQuota: after.tts_chars_quota,
          ttsCharsUsed: after.tts_chars_used,
          scriptGenerationsQuota: after.script_generations_quota,
          scriptGenerationsUsed: after.script_generations_used,
          liveMinutesQuota: after.live_minutes_quota,
          liveMinutesUsed: after.live_minutes_used,
          updatedAt: after.updated_at,
        },
      };
    },
  );

  // 订单人工确权（模拟支付回调）：
  // subscription → paid + 订阅顺延 + 当月额度按付费档刷新；
  // recharge（v0.3 M5 扫码充值单）→ paid + 按订单分钟入时长账本，不碰订阅 / 免费额度；重复确权 409
  app.post(
    '/api/admin/orders/:id/confirm',
    { preHandler: app.adminAuthenticate },
    async (request, reply) => {
      const admin = request.admin;
      if (!admin) {
        return reply.code(401).send({ error: 'UNAUTHORIZED', message: '未登录或登录已过期' });
      }
      const params = request.params as Record<string, unknown>;
      const orderId = typeof params.id === 'string' ? params.id : '';
      if (!UUID_PATTERN.test(orderId)) {
        return reply.code(400).send({ error: 'ORDER_ID_INVALID', message: '订单 ID 格式不正确' });
      }
      const period = await readCurrentPeriod();
      const paid = QUOTA_TIERS.paid;
      const outcome = await db.transaction(async (tx) => {
        const locked = await tx.execute(sql`
          SELECT * FROM orders WHERE id = ${orderId} FOR UPDATE
        `);
        const order = locked.rows[0] as Record<string, unknown> | undefined;
        if (!order) {
          return { notFound: true, kind: 'missing' as const };
        }
        if (order.status === 'paid') {
          return { conflict: 'ALREADY_CONFIRMED', kind: 'dup' as const };
        }
        if (order.status !== 'pending') {
          return { conflict: 'CANNOT_CONFIRM', kind: 'state' as const };
        }
        await tx.execute(sql`
          UPDATE orders SET status = 'paid', paid_at = now(), updated_at = now() WHERE id = ${orderId}
        `);
        // 充值单：置 paid 后按订单精确分钟入账，不改变订阅状态 / 当月免费额度
        if (order.kind === 'recharge') {
          const minutes = (order.minutes as number | null) ?? 0;
          if (!Number.isInteger(minutes) || minutes <= 0) {
            return { conflict: 'CANNOT_CONFIRM', kind: 'recharge-no-minutes' as const };
          }
          const topUp = await topUpMinutes(toLedgerExecutor(tx), {
            userId: order.user_id as string,
            minutes,
            sourceKind: LEDGER_SOURCE.RECHARGE_ORDER,
            sourceId: orderId,
            remark: `充值扫码单运营确权：${order.order_no as string}`,
          });
          return { notFound: false, branch: 'recharge' as const, order, topUp };
        }
        const userRows = await tx.execute(sql`
          UPDATE users
          SET subscription_status = 'paid',
              subscription_expires_at = GREATEST(coalesce(subscription_expires_at, now()), now())
                + (${SUBSCRIPTION_PLAN.renewDays}) * interval '1 day',
              updated_at = now()
          WHERE id = ${order.user_id}
          RETURNING id, phone, subscription_expires_at AS "subscriptionExpiresAt"
        `);
        const quotaRows = await tx.execute(sql`
          INSERT INTO quotas (user_id, period, tts_chars_quota, script_generations_quota, live_minutes_quota)
          VALUES (${order.user_id}, ${period}, ${paid.ttsCharsQuota}, ${paid.scriptGenerationsQuota}, ${paid.liveMinutesQuota})
          ON CONFLICT (user_id, period) DO UPDATE SET
            tts_chars_quota = ${paid.ttsCharsQuota},
            script_generations_quota = ${paid.scriptGenerationsQuota},
            live_minutes_quota = ${paid.liveMinutesQuota},
            updated_at = now()
          RETURNING *
        `);
        return {
          notFound: false,
          branch: 'subscription' as const,
          order,
          user: userRows.rows[0],
          quota: quotaRows.rows[0],
        };
      });
      if (outcome.notFound) {
        return reply.code(404).send({ error: 'ORDER_NOT_FOUND', message: '订单不存在' });
      }
      if (outcome.conflict) {
        const alreadyPaid = outcome.conflict === 'ALREADY_CONFIRMED';
        return reply.code(409).send({
          error: outcome.conflict,
          message: alreadyPaid ? '订单已确权，请勿重复操作' : '当前订单状态不可确权',
        });
      }
      if (outcome.branch === 'recharge') {
        const order = outcome.order as Record<string, unknown>;
        const topUp = outcome.topUp as { creditedMinutes: number; balanceMinutes: number };
        await writeAuditLog({
          adminUserId: admin.id,
          userId: order.user_id as string,
          action: 'order.confirm',
          resourceType: 'order',
          resourceId: orderId,
          detail: {
            orderNo: order.order_no,
            kind: 'recharge',
            amountCents: order.amount_cents,
            creditedMinutes: topUp.creditedMinutes,
            balanceMinutes: topUp.balanceMinutes,
          },
          ip: request.ip,
        });
        return {
          order: {
            id: orderId,
            orderNo: order.order_no,
            kind: 'recharge',
            amountCents: order.amount_cents,
            status: 'paid',
            paidAt: order.paid_at,
          },
          recharge: {
            creditedMinutes: topUp.creditedMinutes,
            balanceMinutes: topUp.balanceMinutes,
          },
        };
      }
      const order = outcome.order as Record<string, unknown>;
      const user = outcome.user as Record<string, unknown>;
      const quota = outcome.quota as Record<string, unknown>;
      await writeAuditLog({
        adminUserId: admin.id,
        userId: order.user_id as string,
        action: 'order.confirm',
        resourceType: 'order',
        resourceId: orderId,
        detail: {
          orderNo: order.order_no,
          plan: order.plan,
          amountCents: order.amount_cents,
          renewDays: SUBSCRIPTION_PLAN.renewDays,
          subscriptionExpiresAt: user.subscriptionExpiresAt,
        },
        ip: request.ip,
      });
      return {
        order: {
          id: orderId,
          orderNo: order.order_no,
          plan: order.plan,
          amountCents: order.amount_cents,
          status: 'paid',
          paidAt: order.paid_at,
        },
        subscription: {
          status: 'paid',
          expiresAt: user.subscriptionExpiresAt,
        },
        quota: {
          period: quota.period,
          ttsCharsQuota: quota.tts_chars_quota,
          ttsCharsUsed: quota.tts_chars_used,
          scriptGenerationsQuota: quota.script_generations_quota,
          scriptGenerationsUsed: quota.script_generations_used,
          liveMinutesQuota: quota.live_minutes_quota,
          liveMinutesUsed: quota.live_minutes_used,
        },
      };
    },
  );
};
