-- 循环台本节奏收紧（2026-09-11）
-- 背景：条间停顿 6s + 轮间休息 20s 使一轮内静默占比近 60%，听感像念稿，
--       且长时间不出声有被直播平台判定「挂机 / 低质」的风险。
-- 口径：条间默认 6s → 2s、轮间休息 20s → 6s（默认值在代码常量里，本脚本只刷存量数据）。
-- 说明：未设值（gap_after_seconds IS NULL）的条目自动跟随新默认值，无需 UPDATE；
--       历史示例台本与生成链路写入的是 5~8 秒，统一压到 2 秒；
--       商家手工设的 >8 秒视为有意为之，保留不动。

UPDATE "loop_script_items"
SET "gap_after_seconds" = 2
WHERE "gap_after_seconds" BETWEEN 5 AND 8;
