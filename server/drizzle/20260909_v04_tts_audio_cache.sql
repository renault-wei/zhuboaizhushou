-- 手动迁移：T3 TTS 分句音频缓存（2026-09-09）
-- 与 server/src/db/schema.ts 保持一致（db:push 对齐源时不会产生额外差异）。
-- 键 = (user_id, voice_key, rate, text_sha256)：voiceKey = 火山预设 id / 克隆 voiceId；
-- 命中不调供应商、不写 usage_logs、不扣 tts_chars_used；产物 wav 存 data/tts-cache，行内存相对路径。

CREATE TABLE IF NOT EXISTS "tts_audio_cache" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "voice_key" varchar(64) NOT NULL,
  "rate" integer NOT NULL DEFAULT 0,
  "text_sha256" varchar(64) NOT NULL,
  "text" text NOT NULL,
  "audio_path" text NOT NULL,
  "chars" integer NOT NULL,
  "hit_count" integer NOT NULL DEFAULT 0,
  "last_hit_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "tts_audio_cache_voice_text_unique"
  ON "tts_audio_cache" ("user_id", "voice_key", "rate", "text_sha256");

CREATE INDEX IF NOT EXISTS "tts_audio_cache_user_idx"
  ON "tts_audio_cache" ("user_id");
