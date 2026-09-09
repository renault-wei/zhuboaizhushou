-- 手动迁移：v0.3 纯 AI 语音直播 + 火山预设音色（2026-09-09）
-- 本仓库未启用 drizzle journal：落地方式 = 本文件在目标库执行，或 schema 定义后直接 npm run db:push。
-- 变更：lives 新增 volc_preset_id（每场可选的火山预设音色 id，与 voice_id 克隆音色互斥）。
-- 与 server/src/db/schema.ts 保持一致（db:push 对齐源时不会产生额外差异）。

ALTER TABLE "lives" ADD COLUMN IF NOT EXISTS "volc_preset_id" varchar(64);
