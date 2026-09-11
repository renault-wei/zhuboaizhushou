-- 手动迁移：场次口播语速（2026-09-11）
-- 本仓库未启用 drizzle journal：落地方式 = 本文件在目标库执行，或 schema 定义后直接 npm run db:push。
-- 变更：lives 新增 speech_rate（每场口播语速，火山 speech_rate 口径的商家滑块档 50~100）。
-- 口径：NULL = 未设过，合成时回落默认「偏快」档；滑块区间与默认值见 services/liveVoice.ts。
-- 与 server/src/db/schema.ts 保持一致（db:push 对齐源时不会产生额外差异）。

ALTER TABLE "lives" ADD COLUMN IF NOT EXISTS "speech_rate" integer;
