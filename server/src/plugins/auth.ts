import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';
import fastifyJwt from '@fastify/jwt';
import { env } from '../config/env';

// JWT 有效期：7 天（秒）
export const JWT_TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60;

// 扩展 @fastify/jwt 类型：让 request.user 与 app.jwt.sign 携带业务载荷
declare module '@fastify/jwt' {
  interface FastifyJWT {
    // 载荷只放 userId，避免把冗余信息塞进 token
    payload: { userId: string };
    user: { userId: string };
  }
}

// 扩展 Fastify 实例：声明 authenticate 装饰器，供各路由 preHandler 复用
declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (
      request: import('fastify').FastifyRequest,
      reply: import('fastify').FastifyReply,
    ) => Promise<void>;
  }
}

/**
 * 鉴权插件：注册 @fastify/jwt，并挂载 Bearer token 校验装饰器。
 * 后续需要登录态的路由统一使用 `{ preHandler: app.authenticate }`。
 */
// 用 fastify-plugin 包装：打破封装作用域，让 app.jwt / app.authenticate 暴露给兄弟路由
export const authPlugin: FastifyPluginAsync = fp(async (app) => {
  await app.register(fastifyJwt, {
    // 密钥来自环境变量（必填），任何环境不得硬编码
    secret: env.JWT_SECRET,
    sign: { expiresIn: JWT_TOKEN_TTL_SECONDS },
  });

  // 校验 Authorization: Bearer <token>，失败统一返回 401
  app.decorate('authenticate', async (request, reply) => {
    try {
      await request.jwtVerify();
    } catch {
      await reply.code(401).send({ error: 'UNAUTHORIZED', message: '未登录或登录已过期' });
    }
  });
});
