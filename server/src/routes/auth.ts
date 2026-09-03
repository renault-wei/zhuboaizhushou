import type { FastifyPluginAsync } from 'fastify';
import { eq } from 'drizzle-orm';
import { db } from '../db/client';
import { users } from '../db/schema';
import { JWT_TOKEN_TTL_SECONDS } from '../plugins/auth';
import { SmsError, smsService } from '../services/sms';

// 中国大陆手机号：1 开头、第二位 3-9、共 11 位数字
const PHONE_PATTERN = /^1[3-9]\d{9}$/;
const SMS_CODE_PATTERN = /^\d{6}$/;

// 返回给客户端的用户字段白名单（刻意排除 douyin_* 等敏感绑定信息）
const publicUserFields = {
  id: users.id,
  phone: users.phone,
  nickname: users.nickname,
  avatarUrl: users.avatarUrl,
  subscriptionStatus: users.subscriptionStatus,
  subscriptionExpiresAt: users.subscriptionExpiresAt,
  createdAt: users.createdAt,
} as const;

/** 校验手机号字段：缺失或格式不对返回 null */
function readPhone(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) {
    return null;
  }
  const phone = (body as Record<string, unknown>).phone;
  return typeof phone === 'string' && PHONE_PATTERN.test(phone) ? phone : null;
}

/** 校验 6 位数字验证码字段 */
function readCode(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) {
    return null;
  }
  const code = (body as Record<string, unknown>).code;
  return typeof code === 'string' && SMS_CODE_PATTERN.test(code) ? code : null;
}

async function selectPublicUserByPhone(phone: string) {
  const rows = await db
    .select(publicUserFields)
    .from(users)
    .where(eq(users.phone, phone))
    .limit(1);
  return rows[0];
}

/**
 * 按手机号查找用户，不存在则自动注册。
 * 用户表 phone 有唯一索引，插入撞冲突时静默跳过再回查，保证并发下不重复建号。
 */
async function findOrCreateUserByPhone(phone: string) {
  const existing = await selectPublicUserByPhone(phone);
  if (existing) {
    return existing;
  }

  await db
    .insert(users)
    .values({ phone, nickname: `用户${phone.slice(-4)}` })
    .onConflictDoNothing();

  const created = await selectPublicUserByPhone(phone);
  if (!created) {
    // 理论上插入成功后必然能查回，此处兜底避免静默返回空
    throw new Error(`自动注册用户失败：${phone}`);
  }
  return created;
}

/** 手机号验证码登录路由：发送验证码 / 校验并登录 / 查询当前用户 */
export const authRoutes: FastifyPluginAsync = async (app) => {
  // 发送验证码：格式校验 + 内存 mock 发送（60 秒重发限制）
  app.post('/api/auth/send-code', async (request, reply) => {
    const phone = readPhone(request.body);
    if (!phone) {
      return reply.code(400).send({ error: 'PHONE_INVALID', message: '手机号格式不正确' });
    }

    try {
      const result = await smsService.sendCode(phone);
      return { message: '验证码已发送', ...result };
    } catch (err) {
      if (err instanceof SmsError && err.code === 'SEND_TOO_FREQUENT') {
        return reply.code(429).send({
          error: err.code,
          message: err.message,
          retryAfterSeconds: err.retryAfterSeconds,
        });
      }
      throw err;
    }
  });

  // 校验验证码：通过后（新用户自动注册）签发 JWT
  app.post('/api/auth/verify-code', async (request, reply) => {
    const phone = readPhone(request.body);
    const code = readCode(request.body);
    if (!phone) {
      return reply.code(400).send({ error: 'PHONE_INVALID', message: '手机号格式不正确' });
    }
    if (!code) {
      return reply.code(400).send({ error: 'CODE_INVALID', message: '验证码格式不正确' });
    }

    try {
      await smsService.verifyCode(phone, code);
    } catch (err) {
      if (err instanceof SmsError) {
        return reply.code(400).send({ error: err.code, message: err.message });
      }
      throw err;
    }

    const user = await findOrCreateUserByPhone(phone);
    const token = app.jwt.sign({ userId: user.id });
    return {
      token,
      tokenType: 'Bearer',
      expiresInSeconds: JWT_TOKEN_TTL_SECONDS,
      user,
    };
  });

  // 当前登录用户信息：走 Bearer 鉴权，不返回任何抖音绑定凭据
  app.get('/api/auth/me', { preHandler: app.authenticate }, async (request, reply) => {
    const rows = await db
      .select(publicUserFields)
      .from(users)
      .where(eq(users.id, request.user.userId))
      .limit(1);
    const user = rows[0];
    if (!user) {
      return reply.code(404).send({ error: 'USER_NOT_FOUND', message: '用户不存在' });
    }
    return { user };
  });
};
