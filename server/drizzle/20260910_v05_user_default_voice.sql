-- 手动迁移：用户默认音色（2026-09-10）
-- 本仓库未启用 drizzle journal：落地方式 = 本文件在目标库执行，或 schema 定义后直接 npm run db:push。
-- 变更：users 新增 default_volc_preset_id（商家默认音色 = 火山预设 id，服务端为准；NULL = 未设置，回落全局默认）。
-- 口径：本批只支持预设音色设为默认；克隆音色设默认留到档 B（声音真复刻）接入后另开字段。
-- 与 server/src/db/schema.ts 保持一致（db:push 对齐源时不会产生额外差异）。

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "default_volc_preset_id" varchar(64);
