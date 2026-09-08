-- 手动迁移：v0.3 商业化账本 M5（console-roadmap §6，2026-09-08）
-- 本仓库未启用 drizzle journal：落地方式 = 本文件在目标库执行，或 schema 定义后直接 npm run db:push。
-- 变更：orders 扩展 kind/channel/hours/minutes；新增时长余额账户/流水、卡密批次/卡密、app_config。
-- 与 server/src/db/schema.ts 保持一致（db:push 对齐源时不会产生额外差异）。

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'order_kind') THEN
    CREATE TYPE "order_kind" AS ENUM ('subscription', 'recharge');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'order_channel') THEN
    CREATE TYPE "order_channel" AS ENUM ('manual', 'alipay_scan', 'card');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'card_batch_status') THEN
    CREATE TYPE "card_batch_status" AS ENUM ('active', 'disabled');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'card_code_status') THEN
    CREATE TYPE "card_code_status" AS ENUM ('unused', 'redeemed', 'revoked');
  END IF;
END $$;

ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "kind" "order_kind" DEFAULT 'subscription' NOT NULL;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "channel" "order_channel" DEFAULT 'manual' NOT NULL;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "hours" integer;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "minutes" integer;

CREATE TABLE IF NOT EXISTS "hour_balance_accounts" (
  "user_id" uuid PRIMARY KEY NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "balance_minutes" integer DEFAULT 0 NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "hour_balance_ledger" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "delta_minutes" integer NOT NULL,
  "balance_after_minutes" integer NOT NULL,
  "source_kind" varchar(30) NOT NULL,
  "source_id" text,
  "remark" varchar(200),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "hour_balance_ledger_user_created_idx" ON "hour_balance_ledger" ("user_id", "created_at");
CREATE INDEX IF NOT EXISTS "hour_balance_ledger_source_idx" ON "hour_balance_ledger" ("source_kind", "source_id");

CREATE TABLE IF NOT EXISTS "card_batches" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name" varchar(100) NOT NULL,
  "total_count" integer NOT NULL,
  "minutes_per_card" integer NOT NULL,
  "status" "card_batch_status" DEFAULT 'active' NOT NULL,
  "remark" varchar(200),
  "created_by" uuid REFERENCES "admin_users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "card_batches_created_by_idx" ON "card_batches" ("created_by");

CREATE TABLE IF NOT EXISTS "card_codes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "batch_id" uuid NOT NULL REFERENCES "card_batches"("id") ON DELETE CASCADE,
  "code" varchar(40) NOT NULL,
  "status" "card_code_status" DEFAULT 'unused' NOT NULL,
  "redeemed_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "redeemed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "card_codes_code_unique" ON "card_codes" ("code");
CREATE INDEX IF NOT EXISTS "card_codes_batch_id_idx" ON "card_codes" ("batch_id");
CREATE INDEX IF NOT EXISTS "card_codes_status_idx" ON "card_codes" ("status");

CREATE TABLE IF NOT EXISTS "app_config" (
  "key" varchar(64) PRIMARY KEY NOT NULL,
  "value" jsonb NOT NULL,
  "updated_by" uuid REFERENCES "admin_users"("id") ON DELETE SET NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
