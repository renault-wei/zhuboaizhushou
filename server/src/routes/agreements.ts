import type { FastifyPluginAsync } from 'fastify';
import { and, desc, eq } from 'drizzle-orm';
import { db } from '../db/client';
import { users, voiceAgreements } from '../db/schema';
import { getLatestVoiceAgreement } from '../services/agreement';

// 签署记录行（用于构造 status 响应，字段按契约裁剪，不下发全文快照）
interface SignedAgreementView {
  signedAt: Date;
  agreementVersion: string;
}

/** 校验登录用户仍存在：token 可能有效但用户已被删除，统一返回 404 */
async function findUserById(userId: string): Promise<{ id: string } | undefined> {
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return rows[0];
}

/** 查询用户签署记录（同用户同版本唯一，最新一条即最终状态） */
async function findSignedAgreement(
  userId: string,
  version?: string,
): Promise<SignedAgreementView | undefined> {
  const conditions = [eq(voiceAgreements.userId, userId)];
  if (version !== undefined) {
    conditions.push(eq(voiceAgreements.agreementVersion, version));
  }
  const rows = await db
    .select({
      signedAt: voiceAgreements.signedAt,
      agreementVersion: voiceAgreements.agreementVersion,
    })
    .from(voiceAgreements)
    .where(and(...conditions))
    .orderBy(desc(voiceAgreements.signedAt))
    .limit(1);
  return rows[0];
}

/** 签署状态响应结构：{ signed, signedAt?, version? } */
function toStatusPayload(signed?: SignedAgreementView) {
  return signed
    ? {
        signed: true,
        signedAt: signed.signedAt.toISOString(),
        version: signed.agreementVersion,
      }
    : { signed: false };
}

/** 读取签署请求体：{ version: string, agreed: boolean } */
function readSignBody(body: unknown): { version: string | null; agreed: boolean } {
  if (typeof body !== 'object' || body === null) {
    return { version: null, agreed: false };
  }
  const record = body as Record<string, unknown>;
  return {
    version: typeof record.version === 'string' ? record.version : null,
    agreed: record.agreed === true,
  };
}

/** 《声音授权协议》签署路由：正文 / 签署状态 / 签署，全部要求登录态 */
export const agreementsRoutes: FastifyPluginAsync = async (app) => {
  // 获取最新版协议正文（只读常量，登录即可读取）
  app.get('/api/agreements/voice', { preHandler: app.authenticate }, async () => {
    const latest = getLatestVoiceAgreement();
    return { version: latest.version, title: latest.title, content: latest.content };
  });

  // 查询当前用户的签署状态（未签署 / 已签署的版本与时间）
  app.get(
    '/api/agreements/voice/status',
    { preHandler: app.authenticate },
    async (request, reply) => {
      const user = await findUserById(request.user.userId);
      if (!user) {
        return reply.code(404).send({ error: 'USER_NOT_FOUND', message: '用户不存在' });
      }
      const signed = await findSignedAgreement(request.user.userId);
      return toStatusPayload(signed);
    },
  );

  // 签署协议：版本必须匹配最新版且 agreed 为 true；同版本重复签署幂等返回（不重复插入）
  app.post(
    '/api/agreements/voice/sign',
    { preHandler: app.authenticate },
    async (request, reply) => {
      const user = await findUserById(request.user.userId);
      if (!user) {
        return reply.code(404).send({ error: 'USER_NOT_FOUND', message: '用户不存在' });
      }

      const latest = getLatestVoiceAgreement();
      const { version, agreed } = readSignBody(request.body);
      if (version !== latest.version) {
        return reply.code(400).send({
          error: 'VERSION_MISMATCH',
          message: `协议版本不匹配，当前最新版本为 ${latest.version}，请阅读最新协议后重新签署`,
        });
      }
      if (!agreed) {
        return reply.code(400).send({
          error: 'NOT_AGREED',
          message: '请先阅读并勾选同意《声音授权协议》后再签署',
        });
      }

      // 幂等：同版本已签署直接返回当前状态，避免重复插入
      const existing = await findSignedAgreement(request.user.userId, latest.version);
      if (existing) {
        return toStatusPayload(existing);
      }

      // 落库存档：版本号 + 协议全文快照 + 签署时间 + IP + User-Agent
      const inserted = await db
        .insert(voiceAgreements)
        .values({
          userId: request.user.userId,
          agreementVersion: latest.version,
          contentSnapshot: latest.content,
          signedAt: new Date(),
          signedIp: request.ip,
          userAgent: request.headers['user-agent'] ?? '',
        })
        .returning({
          signedAt: voiceAgreements.signedAt,
          agreementVersion: voiceAgreements.agreementVersion,
        });
      const created = inserted[0];
      if (!created) {
        // 理论上插入成功必有返回，此处兜底避免静默失败
        throw new Error('写入声音授权协议签署记录失败');
      }
      return toStatusPayload(created);
    },
  );
};
