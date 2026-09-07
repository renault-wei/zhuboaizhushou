import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';
import fastifyJwt from '@fastify/jwt';
import { eq } from 'drizzle-orm';
import { env } from '../config/env';
import { db } from '../db/client';
import { adminUsers } from '../db/schema';

// JWT 有效期：7 天（秒）
export const JWT_TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60;

/** 后台管理员上下文（adminAuthenticate 通过后挂在 request.admin） */
interface AdminContext {
  id: string;
  username: string;
  role: 'super_admin' | 'operator';
}

// 扩展 @fastify/jwt 类型：让 request.user 与 app.jwt.sign 携带商家端业务载荷
declare module '@fastify/jwt' {
  interface FastifyJWT {
    // 商家端载荷只放 userId，避免把冗余信息塞进 token
    payload: { userId: string };
    user: { userId: string };
  }
}

// 扩展 Fastify 实例与请求/响应：声明两端鉴权装饰器与后台命名空间方法
declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (
      request: import('fastify').FastifyRequest,
      reply: import('fastify').FastifyReply,
    ) => Promise<void>;
    adminAuthenticate: (
      request: import('fastify').FastifyRequest,
      reply: import('fastify').FastifyReply,
    ) => Promise<void>;
  }

  interface FastifyRequest {
    /** adminAuthenticate 校验通过后挂载的后台管理员上下文 */
    admin: AdminContext | null;
    /** 后台命名空间 token 校验（namespace 插件装饰，失败抛错由装饰器统一兜底） */
    adminJwtVerify: (options?: Record<string, unknown>) => Promise<{ adminId: string }>;
  }

  interface FastifyReply {
    /** 后台命名空间 token 签发（namespace 插件装饰，返回 Promise） */
    adminJwtSign: (
      payload: { adminId: string },
      options?: Record<string, unknown>,
    ) => Promise<string>;
  }
}

/**
 * 鉴权插件：注册 @fastify/jwt（商家端默认 + 后台 admin 命名空间两套独立密钥），
 * 并挂载 Bearer token 校验装饰器。需要登录态的路由统一使用
 * `{ preHandler: app.authenticate }` / `{ preHandler: app.adminAuthenticate }`。
 */
// 用 fastify-plugin 包装：打破封装作用域，让 app.jwt / 各装饰器暴露给兄弟路由
export const authPlugin: FastifyPluginAsync = fp(async (app) => {
  // 商家端命名空间（默认）：先注册，后续命名空间依赖 app.jwt 对象已存在
  await app.register(fastifyJwt, {
    // 密钥来自环境变量（必填），任何环境不得硬编码
    secret: env.JWT_SECRET,
    sign: { expiresIn: JWT_TOKEN_TTL_SECONDS },
  });
  // 后台命名空间：独立密钥 + 独立载荷键（adminId），杜绝商家 token 冒用后台
  await app.register(fastifyJwt, {
    namespace: 'admin',
    secret: env.admin.jwtSecret,
    sign: { expiresIn: JWT_TOKEN_TTL_SECONDS },
  });

  // 商家端：校验 Authorization: Bearer <token>，失败统一返回 401
  app.decorate('authenticate', async (request, reply) => {
    try {
      await request.jwtVerify();
    } catch {
      await reply.code(401).send({ error: 'UNAUTHORIZED', message: '未登录或登录已过期' });
    }
  });

  // 后台：校验 admin 命名空间 token 后回查在岗账号，双重保险（禁用账号即使 token 有效也拒绝）
  app.decorateRequest('admin', null);
  app.decorate('adminAuthenticate', async (request, reply) => {
    let payload: { adminId?: string };
    try {
      payload = await request.adminJwtVerify();
    } catch {
      await reply.code(401).send({ error: 'UNAUTHORIZED', message: '未登录或登录已过期' });
      return;
    }
    if (!payload?.adminId) {
      await reply.code(401).send({ error: 'UNAUTHORIZED', message: '登录凭证无效' });
      return;
    }
    const rows = await db
      .select({
        id: adminUsers.id,
        username: adminUsers.username,
        role: adminUsers.role,
        isActive: adminUsers.isActive,
      })
      .from(adminUsers)
      .where(eq(adminUsers.id, payload.adminId))
      .limit(1);
    const admin = rows[0];
    if (!admin || !admin.isActive) {
      await reply.code(401).send({ error: 'UNAUTHORIZED', message: '账号不存在或已停用' });
      return;
    }
    request.admin = { id: admin.id, username: admin.username, role: admin.role };
  });
});
