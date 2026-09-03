import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { env } from '../config/env';
import * as schema from './schema';

// PostgreSQL 连接池（懒连接：启动服务时不强制要求数据库在线）
export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: 10,
  // 连接超时兜底：数据库不可达时快速失败，避免测试/启动过程长期挂起
  connectionTimeoutMillis: 5000,
});

// Drizzle 查询客户端：业务代码统一从这里访问数据库
export const db = drizzle(pool, { schema });
