import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { eq } from 'drizzle-orm';
import { db } from '../src/db/client';
import { adminUsers } from '../src/db/schema';

/**
 * 后台初始管理员账号 seed（npm run admin:seed）：
 * - 口令只从环境变量 ADMIN_INITIAL_USERNAME / ADMIN_INITIAL_PASSWORD 读取，不留任何默认口令；
 * - 账号已存在则刷新口令与在岗状态，保证可重复执行。
 */
async function main(): Promise<void> {
  const username = process.env.ADMIN_INITIAL_USERNAME;
  const password = process.env.ADMIN_INITIAL_PASSWORD;
  if (!username || username.trim().length === 0) {
    throw new Error('缺少 ADMIN_INITIAL_USERNAME：请在 .env 中配置后台初始账号');
  }
  if (!password || password.length < 8) {
    throw new Error('缺少 ADMIN_INITIAL_PASSWORD：口令至少 8 位，请在 .env 中配置（禁止默认口令）');
  }
  if (username === 'admin' && /^admin+$/i.test(password)) {
    throw new Error('禁止使用 admin/admin 弱口令，请设置独立强口令后重试');
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const existing = await db
    .select({ id: adminUsers.id })
    .from(adminUsers)
    .where(eq(adminUsers.username, username.trim()))
    .limit(1);

  if (existing[0]) {
    await db
      .update(adminUsers)
      .set({ passwordHash, isActive: true })
      .where(eq(adminUsers.id, existing[0].id));
    console.log(`后台管理员「${username}」已刷新口令`);
  } else {
    await db.insert(adminUsers).values({ username: username.trim(), passwordHash });
    console.log(`后台管理员「${username}」已创建`);
  }
  await db.$client.end().catch(() => undefined);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
