import { sql } from 'drizzle-orm';
import { db } from '../db/client';

// 审计留痕公共函数（运营 / 合规写操作统一走这里，复用 admin.ts / billingAdmin.ts）
// 写失败抛错：合规红线，宁可让操作失败也不静默丢日志。
export interface AuditLogInput {
  adminUserId: string;
  userId?: string | null;
  action: string;
  resourceType: string;
  resourceId: string;
  detail: Record<string, unknown>;
  ip: string;
}

export async function writeAuditLog(input: AuditLogInput): Promise<void> {
  await db.execute(sql`
    INSERT INTO audit_logs (admin_user_id, user_id, action, resource_type, resource_id, detail, ip)
    VALUES (${input.adminUserId}, ${input.userId ?? null}, ${input.action}, ${input.resourceType},
      ${input.resourceId}, ${sql`${JSON.stringify(input.detail)}::jsonb`}, ${input.ip})
  `);
}
