-- 账号级直播设置 + 场次级定时关播（2026-09-17 · R21/R26/R27）
--
-- 背景（用户拍板）：
--   * 智能回复配置放**账号级**（不是场次级、不是竞品那样每次开播带上去）
--   * 绑定话术**优先**，补充知识只作更正补充
--   * 定时关播**最低 10 分钟**（对齐竞品「定时关播最低设置10分钟」）
--   * 自定义违禁词放**账号级**
--
-- 幂等：全部 IF NOT EXISTS，重复执行安全。

CREATE TABLE IF NOT EXISTS "user_live_settings" (
  "user_id" uuid PRIMARY KEY REFERENCES "users"("id") ON DELETE CASCADE,
  -- 智能回复总开关：false = 一条都不生成，且不调 DeepSeek（省成本）
  "reply_enabled" boolean NOT NULL DEFAULT true,
  -- 场次级最小回复间隔（秒）：1~60
  "reply_interval_seconds" integer NOT NULL DEFAULT 5,
  -- 补充知识：拼在绑定话术之后，不覆盖
  "reply_extra_knowledge" text,
  -- 商家自定义违禁词：中文顿号分隔；单字符词后端忽略
  "banned_words" text,
  -- 账号级语速默认档：火山 speech_rate 口径 -20~60
  "default_speech_rate" integer,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

-- 定时关播：距开播 N 分钟后自动收尾；NULL = 不限
ALTER TABLE "lives" ADD COLUMN IF NOT EXISTS "auto_end_minutes" integer;
