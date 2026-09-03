import 'dotenv/config';
import { defineConfig } from 'drizzle-kit';

// Drizzle Kit 配置：schema 供 generate/push 使用，out 为迁移文件目录（server/drizzle）
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error('缺少 DATABASE_URL 环境变量，请复制 .env.example 为 .env 后填写');
}

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
  dbCredentials: {
    url: databaseUrl,
  },
});
