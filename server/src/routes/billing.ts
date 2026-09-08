import type { FastifyPluginAsync } from 'fastify';
import { sql } from 'drizzle-orm';
import { db } from '../db/client';
import { readPublicAppConfig } from '../services/appConfig';
import {
  LEDGER_SOURCE,
  readBalanceMinutes,
  toLedgerExecutor,
  topUpMinutes,
} from '../services/ledger';

// ---------- 商家端充值（v0.3 商业化 M5：服务端扫码直充 mock 通道 / 轮询 / 卡密核销）----------
// 收款合规：本地自用验收阶段不真调第三方支付；扫码单返回 mock 占位收款码，
// 确认入账 = 运营后台人工确权（M8 凭证接入后替换为查单轮询自动入账）。
// 卡密核销不经过任何资金接口：核销即按批次时长入账，天然离线可验收。

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function genOrderNo(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `${prefix}-${Date.now().toString(36)}-${rand}`;
}

/** 卡密归一：去掉空白 / 短横线并转大写（与入库的规范卡密比对） */
function normalizeCardCode(raw: unknown): string {
  if (typeof raw !== 'string') {
    return '';
  }
  return raw.replace(/[\s-]/g, '').toUpperCase();
}

/**
 * 商家端充值 / 卡密 / 开关路由：
 * POST /api/recharge/scan 服务端扫码下单（mock 通道）
 * POST /api/recharge/poll 轮询确认（mock 通道只读，paid 由运营确权置位）
 * POST /api/cards/redeem 卡密核销入账（幂等：重复提交不重复入账）
 * GET  /api/app/config   服务端开关下发（商家端读取）
 */
export const billingRoutes: FastifyPluginAsync = async (app) => {
  // 扫码下单：档位来自服务端下发（app_config.pricePacks），凭证未接入返回 mock 占位
  app.post('/api/recharge/scan', { preHandler: app.authenticate }, async (request, reply) => {
    const userId = request.user.userId;
    const body = (typeof request.body === 'object' && request.body !== null
      ? request.body
      : {}) as Record<string, unknown>;
    const rawHours = body.hours;
    const hours = typeof rawHours === 'number' && Number.isInteger(rawHours) ? rawHours : NaN;
    if (!Number.isInteger(hours) || (hours as number) <= 0) {
      return reply.code(400).send({ error: 'HOURS_INVALID', message: '请选择有效充值时长档位' });
    }
    const config = await readPublicAppConfig();
    const pack = config.pricePacks.find((item) => item.hours === hours);
    if (!pack) {
      return reply.code(400).send({
        error: 'PACK_INVALID',
        message: '所选时长不在服务端下发的档位中',
        packs: config.pricePacks,
      });
    }
    const orderNo = genOrderNo('rn');
    const rows = await db.execute(sql`
      INSERT INTO orders
        (user_id, order_no, kind, channel, plan, hours, minutes, amount_cents, status)
      VALUES
        (${userId}, ${orderNo}, 'recharge', 'alipay_scan', 'recharge',
         ${pack.hours}, ${pack.hours * 60}, ${pack.amountCents}, 'pending')
      RETURNING id, order_no, hours, minutes, amount_cents, status, created_at
    `);
    const order = rows.rows[0];
    if (!order) {
      throw new Error('创建充值订单失败：数据库未返回订单行');
    }
    return {
      order: {
        id: order.id,
        orderNo: order.order_no,
        kind: 'recharge',
        channel: 'alipay_scan',
        hours: order.hours,
        minutes: order.minutes,
        amountCents: order.amount_cents,
        status: order.status,
        createdAt: order.created_at,
      },
      // mock 通道：本地验收阶段不产生真实收款码；M8 凭证接入后由服务端生成支付宝收款码
      qrcodeUrl: `mock://alipay-scan/${order.order_no}`,
      mockChannel: true,
      message: '扫码单已创建（mock 通道）：暂未产生真实收款，请运营在后台人工确权后入账',
    };
  });

  // 轮询确认：只读订单状态，paid 后附带最新时长余额
  app.post('/api/recharge/poll', { preHandler: app.authenticate }, async (request, reply) => {
    const userId = request.user.userId;
    const body = (typeof request.body === 'object' && request.body !== null
      ? request.body
      : {}) as Record<string, unknown>;
    const orderId = typeof body.orderId === 'string' ? body.orderId : '';
    if (!UUID_PATTERN.test(orderId)) {
      return reply.code(400).send({ error: 'ORDER_ID_INVALID', message: '订单 ID 格式不正确' });
    }
    const rows = await db.execute(sql`
      SELECT id, order_no, kind, channel, hours, minutes, amount_cents, status, paid_at
      FROM orders
      WHERE id = ${orderId} AND user_id = ${userId}
        AND kind = 'recharge' AND channel = 'alipay_scan'
      LIMIT 1
    `);
    const order = rows.rows[0] as Record<string, unknown> | undefined;
    if (!order) {
      return reply.code(404).send({ error: 'ORDER_NOT_FOUND', message: '扫码单不存在' });
    }
    const paid = order.status === 'paid';
    return {
      orderId: order.id,
      orderNo: order.order_no,
      status: order.status,
      paidAt: paid ? order.paid_at : null,
      amountCents: order.amount_cents,
      hours: order.hours,
      // paid 后附带当前余额，供收银台确认页即时展示
      balanceMinutes: paid ? await readBalanceMinutes(userId) : undefined,
    };
  });

  // 卡密核销：单事务内完成「置核销 + 建充值订单 + 时长入账」，重复提交 409 不重复入账
  app.post('/api/cards/redeem', { preHandler: app.authenticate }, async (request, reply) => {
    const userId = request.user.userId;
    const body = (typeof request.body === 'object' && request.body !== null
      ? request.body
      : {}) as Record<string, unknown>;
    const code = normalizeCardCode(body.code);
    if (code.length < 8 || code.length > 40) {
      return reply.code(400).send({ error: 'CARD_CODE_INVALID', message: '卡密格式不正确' });
    }
    const outcome = await db.transaction(async (tx) => {
      const exec = toLedgerExecutor(tx);
      const locked = await exec.execute(sql`
        SELECT c.id AS card_id, c.status, c.code,
               b.id AS batch_id, b.status AS batch_status, b.minutes_per_card AS minutes_per_card
        FROM card_codes c JOIN card_batches b ON b.id = c.batch_id
        WHERE c.code = ${code}
        FOR UPDATE OF c
      `);
      const card = locked.rows[0] as Record<string, unknown> | undefined;
      if (!card) {
        return { notFound: true as const };
      }
      if (card.status === 'revoked') {
        return { revoked: true as const };
      }
      if (card.status === 'redeemed') {
        return { redeemed: true as const };
      }
      if (card.batch_status !== 'active') {
        return { batchDisabled: true as const };
      }
      const minutes = card.minutes_per_card as number;
      const orderNo = genOrderNo('cd');
      const orderRows = await exec.execute(sql`
        INSERT INTO orders
          (user_id, order_no, kind, channel, plan, hours, minutes, amount_cents, status, paid_at)
        VALUES
          (${userId}, ${orderNo}, 'recharge', 'card', 'recharge',
           floor(${minutes} / 60), ${minutes}, 0, 'paid', now())
        RETURNING id, order_no, minutes
      `);
      const order = orderRows.rows[0] as Record<string, unknown>;
      await exec.execute(sql`
        UPDATE card_codes
        SET status = 'redeemed', redeemed_by_user_id = ${userId}, redeemed_at = now()
        WHERE id = ${card.card_id}
      `);
      const topUp = await topUpMinutes(exec, {
        userId,
        minutes,
        sourceKind: LEDGER_SOURCE.CARD_REDEEM,
        sourceId: order.id as string,
        remark: `卡密核销 ${card.code as string}`,
      });
      return {
        batchId: card.batch_id as string,
        orderId: order.id as string,
        orderNo: order.order_no as string,
        creditedMinutes: topUp.creditedMinutes,
        balanceMinutes: topUp.balanceMinutes,
      };
    });
    if ('notFound' in outcome) {
      return reply.code(404).send({ error: 'CARD_NOT_FOUND', message: '卡密不存在或已失效' });
    }
    if ('revoked' in outcome) {
      return reply.code(409).send({ error: 'CARD_REVOKED', message: '该卡密已作废，请联系客服' });
    }
    if ('redeemed' in outcome) {
      return reply.code(409).send({ error: 'CARD_REDEEMED', message: '该卡密已被使用，请勿重复提交' });
    }
    if ('batchDisabled' in outcome) {
      return reply.code(409).send({ error: 'BATCH_DISABLED', message: '该卡密所属批次已停用' });
    }
    return {
      status: 'redeemed',
      batchId: outcome.batchId,
      orderId: outcome.orderId,
      orderNo: outcome.orderNo,
      creditedMinutes: outcome.creditedMinutes,
      balanceMinutes: outcome.balanceMinutes,
    };
  });

  // 服务端开关下发（公开）：商家端开屏 / 收银台读取，无登录态也允许
  app.get('/api/app/config', async () => {
    return { config: await readPublicAppConfig() };
  });
};
