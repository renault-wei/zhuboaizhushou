-- 弹幕采集重启 R1：live_danmaku 扩采集通道字段 + 幂等唯一索引（2026-09-16）
-- 背景：自研抖音采集（D2.3 适配器）需要把「平台 / 房间 / 平台侧消息 id / 事件类型」落库，
--       并以 (platform, msg_key) 唯一索引做断线重连重放的幂等去重。
-- 口径：
--   * 四列全部可空 —— 既有「测试弹幕注入」路径不带这些字段，行为完全不变；
--   * PostgreSQL 唯一索引默认 NULLS DISTINCT，故 platform/msg_key 为 NULL 的
--     历史行与注入行之间不会互相冲突（可无限多条）；
--   * 全部语句幂等（IF NOT EXISTS），重复执行安全。

ALTER TABLE "live_danmaku" ADD COLUMN IF NOT EXISTS "platform" varchar(16);
ALTER TABLE "live_danmaku" ADD COLUMN IF NOT EXISTS "room_ref" varchar(128);
ALTER TABLE "live_danmaku" ADD COLUMN IF NOT EXISTS "msg_key" varchar(128);
ALTER TABLE "live_danmaku" ADD COLUMN IF NOT EXISTS "msg_type" varchar(16);

CREATE UNIQUE INDEX IF NOT EXISTS "live_danmaku_platform_msg_key_unique"
  ON "live_danmaku" ("platform", "msg_key");
