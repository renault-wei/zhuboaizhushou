-- 手动迁移：新增 atmosphere_templates（氛围台词库，M4.5 竞品「氛围语」复刻）
-- 本仓库未启用 drizzle journal：落地方式 = 本文件在目标库执行，或 schema 定义后直接 npm run db:push。
CREATE TABLE IF NOT EXISTS "atmosphere_templates" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "category" varchar(20) NOT NULL,
  "text" text NOT NULL,
  "enabled" boolean DEFAULT true NOT NULL,
  "sensitive_check_status" "sensitive_check_status" DEFAULT 'pass' NOT NULL,
  "sensitive_matched_words" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "sensitive_scanned_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "atmosphere_templates_user_id_idx" ON "atmosphere_templates" ("user_id");