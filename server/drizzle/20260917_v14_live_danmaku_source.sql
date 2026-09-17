-- R47：把「弹幕采集源」从内存提升为**场次配置**（用户 2026-09-17 需求，合并 R17）。
--
-- 背景：原先采集绑定只存在 liveCollector 的内存 Map 里（danmakuSource.ts 顶部注释
-- 「采集绑定是内存态：进程重启后需重新绑定」），于是：
--   ① 服务一重启，正在直播的场次采集就断了（R17）；
--   ② 商家**每次开播都要重新粘一次分享链接**；
--   ③ 换台手机看工作台，采集卡是空的。
--
-- 三列的分工（用户拍板 D4：原文与解析结果都存，但**以原文重新解析为准**）：
--   * danmaku_source_url      原始分享链接 —— 商家看得懂、可编辑；开播时用它重新解析
--   * danmaku_room_ref        解析出的房间号 —— 解析失败时的**兜底**，也用于展示（省一次出网）
--   * danmaku_collect_enabled  本场是否启用采集 —— 开播联动 resume 的依据
--
-- 幂等：三列均可重复执行（IF NOT EXISTS / 带默认值）。
ALTER TABLE lives ADD COLUMN IF NOT EXISTS danmaku_source_url text;
ALTER TABLE lives ADD COLUMN IF NOT EXISTS danmaku_room_ref varchar(128);
ALTER TABLE lives ADD COLUMN IF NOT EXISTS danmaku_collect_enabled boolean NOT NULL DEFAULT false;
