-- 真机功能测试种子数据（演示账号 13800138000 / user 44c8abd9-7da0-45ef-9c64-bc47288bbf31）
INSERT INTO voices (id, user_id, name, provider, provider_voice_id, status)
VALUES
 ('10000000-0000-4000-8000-000000000001','44c8abd9-7da0-45ef-9c64-bc47288bbf31','火山-行星女声·天','volc','zh_female_vv_uranus_bigtts','ready'),
 ('10000000-0000-4000-8000-000000000002','44c8abd9-7da0-45ef-9c64-bc47288bbf31','火山-行星女声·火','volc','zh_female_vv_mars_bigtts','ready'),
 ('10000000-0000-4000-8000-000000000003','44c8abd9-7da0-45ef-9c64-bc47288bbf31','火山-行星女声·木','volc','zh_female_vv_jupiter_bigtts','ready');

INSERT INTO scripts (id, user_id, industry, title, product_snapshot, content, status, sensitive_check_status, sensitive_matched_words, sensitive_scanned_at)
VALUES (
 '20000000-0000-4000-8000-000000000001','44c8abd9-7da0-45ef-9c64-bc47288bbf31','火锅','双人火锅套餐演示话术',
 '{"title":"双人火锅福利套餐","price":99,"unit":"份","features":["锅底三选一","肥牛一份","虾滑一份","时蔬拼盘"]}'::jsonb,
 '欢迎家人们来到直播间，今天给大伙儿带来一份超值的双人火锅套餐。锅底三选一，配菜有肥牛、虾滑和时蔬拼盘，两个人吃刚刚好。只要九十九元，点击下方团购链接就能下单。喜欢的朋友点点关注，先囤再用不亏。',
 'ready','pass','[]'::jsonb, now());

INSERT INTO loop_scripts (id, user_id, title, source_script_id)
VALUES ('30000000-0000-4000-8000-000000000001','44c8abd9-7da0-45ef-9c64-bc47288bbf31','火锅循环台本·演示','20000000-0000-4000-8000-000000000001');

INSERT INTO loop_script_items (loop_script_id, seq, kind, text, gap_after_seconds)
VALUES
 ('30000000-0000-4000-8000-000000000001',1,'opening','欢迎家人们来到直播间，今天给大家带来一份超值的双人火锅套餐。',8),
 ('30000000-0000-4000-8000-000000000001',2,'product','锅底三选一，配菜有肥牛、虾滑和时蔬拼盘，两个人吃刚刚好。',6),
 ('30000000-0000-4000-8000-000000000001',3,'coupon','套餐只要九十九元，点击下方团购链接就能下单，先囤再用不亏。',6),
 ('30000000-0000-4000-8000-000000000001',4,'warmup','喜欢的朋友点点关注，主播每天中午都在这里给大家推荐实惠套餐。',6),
 ('30000000-0000-4000-8000-000000000001',5,'closing','还在犹豫的朋友抓紧了，数量有限，先到先得。',8);

INSERT INTO atmosphere_templates (user_id, category, text, enabled)
VALUES
 ('44c8abd9-7da0-45ef-9c64-bc47288bbf31','welcome','欢迎 {昵称} 来到直播间，喜欢可以点点关注哦。',true),
 ('44c8abd9-7da0-45ef-9c64-bc47288bbf31','clock','现在是整点报时，福利套餐还在，需要的家人们抓紧下单。',true);

INSERT INTO lives (id, user_id, title, video_source_url, voice_id, script_id, loop_script_id, status)
VALUES (
 '40000000-0000-4000-8000-000000000001','44c8abd9-7da0-45ef-9c64-bc47288bbf31','火锅店午市循环直播·演示',
 '/uploads/lives/demo.mp4',
 '10000000-0000-4000-8000-000000000001',
 '20000000-0000-4000-8000-000000000001',
 '30000000-0000-4000-8000-000000000001',
 'ready');