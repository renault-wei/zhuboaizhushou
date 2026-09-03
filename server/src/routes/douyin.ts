import type { FastifyPluginAsync } from 'fastify';
import { and, eq, ne } from 'drizzle-orm';
import { db } from '../db/client';
import { users } from '../db/schema';
import { DouyinError, douyinOAuthService } from '../services/douyin';

// users 表整行类型（含抖音绑定凭据，仅服务端内部使用，绝不下发客户端）
type UserRow = typeof users.$inferSelect;

/** 读取授权码字段：必须是非空字符串，否则返回 null */
function readCode(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) {
    return null;
  }
  const code = (body as Record<string, unknown>).code;
  return typeof code === 'string' && code.trim().length > 0 ? code.trim() : null;
}

async function findUserById(userId: string): Promise<UserRow | undefined> {
  const rows = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  return rows[0];
}

interface DouyinBoundInfo {
  bound: true;
  openId: string;
  nickname?: string;
  avatarUrl?: string;
  boundAt: string;
}

/**
 * 把已绑定用户转成响应结构（openId / boundAt 来自库内绑定记录；
 * 昵称/头像实时拉取抖音公开信息，拉取失败不阻断查询）。
 */
async function toBoundInfo(user: UserRow): Promise<DouyinBoundInfo> {
  const openId = user.douyinOpenId;
  if (!openId) {
    throw new Error('toBoundInfo 仅用于已绑定用户');
  }
  const info: DouyinBoundInfo = {
    bound: true,
    openId,
    // 绑定即整行更新，updatedAt 可视为最近一次绑定时间（MVP 无单独 bound_at 列）
    boundAt: user.updatedAt.toISOString(),
  };
  if (user.douyinAccessToken) {
    try {
      const douyinUser = await douyinOAuthService.getUserInfo(user.douyinAccessToken, openId);
      info.nickname = douyinUser.nickname;
      info.avatarUrl = douyinUser.avatarUrl;
    } catch {
      // 公开信息拉取失败不影响已绑定状态展示
    }
  }
  return info;
}

/** 抖音 OAuth 绑定路由：查询绑定状态 / 绑定 / 解绑，全部要求登录态 */
export const douyinRoutes: FastifyPluginAsync = async (app) => {
  // 查询当前用户的抖音绑定状态
  app.get('/api/douyin/bind-status', { preHandler: app.authenticate }, async (request, reply) => {
    const user = await findUserById(request.user.userId);
    if (!user) {
      return reply.code(404).send({ error: 'USER_NOT_FOUND', message: '用户不存在' });
    }
    if (!user.douyinOpenId) {
      return { bound: false };
    }
    return toBoundInfo(user);
  });

  // 绑定抖音号：mock 授权码（mock- 前缀）换 open_id + token 后落库
  app.post('/api/douyin/bind', { preHandler: app.authenticate }, async (request, reply) => {
    const userId = request.user.userId;
    const code = readCode(request.body);
    if (!code) {
      return reply.code(400).send({ error: 'CODE_INVALID', message: '授权码为空或非法，请重新授权' });
    }

    const user = await findUserById(userId);
    if (!user) {
      return reply.code(404).send({ error: 'USER_NOT_FOUND', message: '用户不存在' });
    }

    let tokenResult: Awaited<ReturnType<typeof douyinOAuthService.exchangeCode>>;
    try {
      tokenResult = await douyinOAuthService.exchangeCode(code);
    } catch (err) {
      if (err instanceof DouyinError && err.code === 'CODE_INVALID') {
        return reply.code(400).send({ error: 'CODE_INVALID', message: err.message });
      }
      throw err;
    }

    // 当前账号已绑定其他抖音号：返回 409 并附上当前绑定信息
    if (user.douyinOpenId && user.douyinOpenId !== tokenResult.openId) {
      return reply.code(409).send({
        error: 'ALREADY_BOUND',
        message: '当前账号已绑定其他抖音号，请先解绑再绑定新账号',
        ...(await toBoundInfo(user)),
      });
    }

    // 该抖音号已被其他用户绑定：唯一索引兜底，先查后写
    const conflicts = await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.douyinOpenId, tokenResult.openId), ne(users.id, userId)))
      .limit(1);
    if (conflicts[0]) {
      return reply.code(409).send({ error: 'OPENID_CONFLICT', message: '该抖音账号已被其他账号绑定' });
    }

    // 落库绑定凭据（同账号重复绑定视为刷新 token）
    await db
      .update(users)
      .set({
        douyinOpenId: tokenResult.openId,
        douyinAccessToken: tokenResult.accessToken,
        douyinRefreshToken: tokenResult.refreshToken,
        douyinTokenExpiresAt: new Date(Date.now() + tokenResult.expiresInSeconds * 1000),
      })
      .where(eq(users.id, userId));

    const updated = await findUserById(userId);
    if (!updated) {
      // 理论上更新成功必然能查回，兜底避免静默返回
      throw new Error('抖音绑定后回查用户失败');
    }
    return toBoundInfo(updated);
  });

  // 解绑抖音号：清空绑定凭据（MVP 允许解绑重绑，不删历史数据）
  app.post('/api/douyin/unbind', { preHandler: app.authenticate }, async (request) => {
    await db
      .update(users)
      .set({
        douyinOpenId: null,
        douyinAccessToken: null,
        douyinRefreshToken: null,
        douyinTokenExpiresAt: null,
      })
      .where(eq(users.id, request.user.userId));
    return { bound: false };
  });
};
