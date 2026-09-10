-- 手动迁移：新增 atmosphere_settings（氛围语插播频率，M10-A2）
-- 本仓库未启用 drizzle journal：落地方式 = 本文件在目标库执行，或 schema 定义后直接 npm run db:push。
CREATE TABLE IF NOT EXISTS "atmosphere_settings" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "category" varchar(20) NOT NULL,
  "interval_seconds" integer NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "atmosphere_settings_user_category_unique"
  ON "atmosphere_settings" ("user_id", "category");
