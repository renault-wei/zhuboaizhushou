# 星辰语音 App（StarVoice）项目交接文档

> - 交接日期：**2026-09-16** ｜ 交接对象：接手开发 / 运维的同学（默认具备 Flutter + Node 基础）
> - 仓库：`D:\codex_project\2026-09-06\give-me-skill\work\zhuboaizhushou` ｜ 远端：`origin https://github.com/renault-wei/zhuboaizhushou`
> - 分支：`feature/atmosphere-and-loopCaster` ｜ HEAD：`f4672f4` ｜ 累计 **131** 条 commit ｜ App 版本：**`0.3.0+95`**
> - 阅读顺序：**本文档 → `AGENTS.md`（硬性规则）→ `docs/PROGRESS.md`（进度看板）→ `docs/SPEC-TASKS.md`（规格与任务）**

## 一、项目一句话

**平台无关的 AI 语音助播**：商家用任意平台开播（抖音 / 视频号 / 快手…），画面继续由真人或实景承担，本系统只在**直播间的后台声音**里做 AI 语音 —— 循环播报商品话术 + 按弹幕做 AI 问答回复。

- 形态：**只出声、不推流、不出画面**。声音出口是「手机 / 电脑的音频输出 → USB 内录声卡 → 直播 App 的麦克风输入」，因此天然跨平台。
- 主播形态：真人**隔一段时间出镜一次**（画面主体），后台 AI 语音主播**持续轮播**介绍产品与团购 / 商品。
- 收费模式：按**直播在线时长 / 轮播**计费 —— 服务端扫码直充 + 卡密批次核销 + 服务端开关下发（已替换早期 ¥99/月订阅方案）。
- 弹幕来源：**外挂适配**（自有 App 内嵌采集 / 第三方弹幕助手转发均为候选）。真实平台弹幕采集**需求已关闭**（2026-09-08 用户拍板），回到「测试弹幕注入优先 + 外挂 / 人工补位」口径。
- 交付目标：**手机 App**（商家侧，Android 优先）+ **公司端控制台**（admin：账号 / 算力 / 卡密 / 计费）。

### 1.1 明确不做（当前口径）

- 不做直播推流、不做画面合成（真人 / 实景画面与系统解耦）。
- 不做真实平台弹幕协议抓取（合规与风控风险，需求已关闭）。
- 不做微服务 / MQ / Docker，单机部署（Node 单进程 + PostgreSQL）。

## 二、当前进度

### 2.1 已完成能力（用户可演示）

| 模块 | 状态 |
| --- | --- |
| 账号与授权 | 手机验证码登录（`SMS_DEV_MODE` 演示环境回传明文验证码）、JWT、《声音授权协议》签署存档 |
| 声音克隆 | 录音页（**2 段**念稿 + 波形 + ≥1min 校验）、克隆任务（CosyVoice 占位，真复刻属阶段 B） |
| 音色库 | 「我的音色」+ **44 条火山预设音色**（女 24 / 男 20）分组列表、真实试听、设为默认音色（用户级，v05 迁移） |
| 话术生成 | DeepSeek 生成（内置禁用语清单 + 命中自动改写 + 安全模板兜底，生成成品必然 ready + pass）、编辑保存 |
| 循环台本 | 台本库 CRUD + 三场景骨架复用生成（单品卖货 / 团购 / 自定义）+ 场次引用 + 开播读快照 |
| 开播配置 | lives CRUD（**已去掉强制实景视频**，支持纯 AI 语音模式）、话术必选、开播互斥 |
| 直播控制 | 一键开播 / 结束状态机、按分钟欠费式结算、合规 AI 角标恒开 |
| 现场工作台 | 循环播报状态胶囊（第 x 条 / 第 y 轮）、热更话术、热更循环台词、测试弹幕注入、助播机出声开关 |
| 实时互动 | 弹幕订阅 → 上下文装配 → DeepSeek 生成 1~2 句 → 敏感词兜底 → 出声；场次级 + 用户级 5s 频控 |
| 音频链路 | 本机 Windows 播放（VB-Cable 注入）/ 手机远程出声（`/api/out/speech/next` FIFO 队列）双出口 |
| 分句缓存 | `tts_audio_cache` 表（v04）+ ttsCache 读写 + 命中自增；**旁路接线属阶段 A1** |
| 氛围语 | 空档插播氛围语（M10，v06 迁移 `atmosphere_settings`） |
| 后台保活 | Android 前台服务（mediaPlayback + WakeLock + WifiLock）+ MethodChannel + 透明引导卡 |
| 收银台 | 余额 / 预充（微信收款码，运营人工确权）/ 服务端开关显隐 / 卡密核销 / 流水 |
| 公司端控制台 | admin（React + AntD）M1~M4：商户 / 算力 / 卡密批次 / 计费看板 |
| 语速 | 口播语速档 50~100（默认「很高」）、火山语速 -20~60（默认 -10，≈4.7 字/秒） |

### 2.2 最新批次（`docs/PROGRESS.md` §6）

| 条 | 内容 |
| --- | --- |
| 66 | `docs/SPEC-TASKS.md` 规格任务梳理归档 + 商业化补差距审计入库（三条口径落档） |
| 65 | 循环台本节奏收紧：条间 6s→2s、轮间 20s→6s + `20260911_v10_loop_gap_tighten.sql` |
| 64 | 云端登录放开：新增 `SMS_DEV_MODE` 开关回传验证码明文（演示环境） |
| 63 | 单台本多音色 5 项修复：开播互斥 + 出声队列按场次隔离 + 音色快照统一 + 试听分离 |
| 62 | 云版部署 + 真机联调验收（见 2.3） |

### 2.3 第 62 条真机验收结论（2026-09-11）

华为云 ECS 对齐 HEAD 整包重建重启（`/health` 200）+ App `0.3.0+93` 云版包 + **华为 ELS-AN10** 真机联调：

- 热更话术（新弹幕立即生效）✅
- 热更循环台词（下一轮生效、不打断当前句）✅
- 弹幕「how much」AI 回复经 `/tmp` wav 取证并手机播出 ✅
- UI 结束直播按 12 分钟结算转 `ended` ✅

---

## 三、代码位置与目录结构

仓库根：`D:\codex_project\2026-09-06\give-me-skill\work\zhuboaizhushou`

```
zhuboaizhushou/
├── AGENTS.md              # 硬性规则，动手前必读
├── HANDOVER.md            # 本文档
├── README.md              # 快速开始与命令索引
├── TASK-T9 ~ TASK-T13.md  # 历史任务单（已完成，仅作背景）
├── installed-app.apk      # 真机安装包（每次发包后覆盖更新）
├── app/                   # 商家端 Flutter（Android 优先）
├── admin/                 # 公司端控制台（React + AntD + Vite）
├── server/                # 后端（Fastify + Drizzle ORM + PostgreSQL）
├── docs/                  # 18 份规格 / 审计 / 计划文档
├── dist/                  # 构建产物、分发
├── outputs/               # 交付物
└── scripts/ssh-proxy.js   # Git 走代理时用
```

### 3.1 `app/`（商家端 Flutter，14 个功能模块）

`app/lib/features/` 下：`agreement`（声音授权协议）、`assistant_speaker`（助播机 / 后台出声）、`auth`（登录）、`coupons`（券 / 商品）、`douyin`（平台绑定，已弱化）、`home`（首页）、`lives`（开播配置 + 列表 + 监控工作台）、`loop_scripts`（循环台本）、`profile`（我的）、`recording`（录音克隆）、`scripts`（话术）、`splash`、`voices`（音色库）、`wallet`（收银台）。

> 导航结构：底部三 Tab —— **首页 / 直播 / 我的**。首页内含「声音克隆 / 话术 / AI 直播」三个入口。

### 3.2 `server/`（后端）

- 入口：`server/src/index.ts`、`server/src/app.ts`
- 路由 `server/src/routes/`（15 个）：`admin`、`agreements`、`atmosphereSettings`、`atmosphereTemplates`、`auth`、`billing`、`billingAdmin`、`douyin`、`health`、`lives`、`loopScripts`、`loopScriptSamples`、`scripts`、`speechOut`、`voices`
- 服务 `server/src/services/`（35 个），关键几个：
  - `liveSpeaker.ts` —— 出声总控（合成 → 播放 → 缓存，缓存旁路属阶段 A1）
  - `volcTTS.ts` —— 火山 TTS 合成（当前整段提交，A5 需内部分段）
  - `liveVoice.ts` —— 音色 / 语速载入
  - `loopCaster.ts` —— 循环台本轮播调度
  - `loopScript.ts` / `loopScriptSamples.ts` —— 台本模型与三场景骨架
  - `interactionEngine.ts` / `reply.ts` / `danmaku.ts` —— 弹幕 → AI 回复管道
  - `ttsCache.ts` / `ttsUsage.ts` —— 音频缓存与用量计量
  - `liveBilling.ts` / `quota.ts` / `ledger.ts` —— 计费、额度、流水
  - `sensitive.ts` —— 敏感词 / 禁用语
  - `remoteSpeechQueue.ts` / `remoteSpeechSink.ts` —— 手机端远程出声 FIFO 队列
  - `voicePlayer.ts` —— 本机 Windows 播放出口
  - `atmosphere.ts` / `atmosphereScheduler.ts` —— 氛围语
- 弹幕采集 `server/src/collectors/`（`collectorManager` + 抖音直连 / 助手转发 / 模拟器三类适配 + 链接解析）：**需求已关闭，代码保留**，当前只有模拟器通道在用（测试弹幕注入）。
- 迁移 `server/drizzle/`（10 个，按文件名顺序执行）：`20260907_atmosphere_templates` → `20260908_v03_billing` → `20260909_v03_volc_preset` → `20260909_v04_tts_audio_cache` → `20260910_v05_user_default_voice` → `20260910_v06_atmosphere_settings` → `20260911_v07_live_speech_rate` → `20260911_v08_speech_rate_rescale` → `20260911_v09_speech_rate_slower` → `20260911_v10_loop_gap_tighten`。
- 测试 `server/tests/`：37 个用例文件（33 通过 / 4 依赖数据库与真实密钥而跳过）。

### 3.3 `admin/`（公司端控制台）

`admin/src/pages/`：`LoginPage`、`DashboardPage`（计费看板）、`MerchantPage`（商户）、`UsagePage`（算力 / 用量）、`CardBatchesPage`（卡密批次）、`OrderPage`（订单）、`AuditPage`（审计）、`AppConfigPage`（服务端开关下发）。

## 四、开发环境与三端启动

开发机为 **Windows**，本机自用验收通过后才谈云与 SaaS。本机工具路径：

| 用途 | 路径 |
| --- | --- |
| Flutter | `E:\dev\flutter\bin\flutter.bat` |
| Android 调试桥 | `E:\Android\sdk\platform-tools\adb.exe` |
| PostgreSQL 客户端 | `E:\dev\pgsql\bin\psql.exe` |
| PostgreSQL 数据目录 | `E:\dev\pgsql\data` |

本机数据库连接串：`postgres://postgres:postgres@127.0.0.1:5432/starvoice`

### 4.1 启动顺序

1. **PostgreSQL（最先）**
   `E:\dev\pgsql\bin\pg_ctl.exe -D E:\dev\pgsql\data start`
   > 不起数据库时后端测试会**静默跳过** DB 用例，`skip` 不等于通过，验收时必须先起库。
2. **后端**：`cd server` → `npm install`（首次）→ `npm run dev`（默认 3000 端口）
   - 首次需按 `server/.env.example` 创建 `server/.env`（键名见第十节，值不进仓库）
   - 建表：`npm run db:migrate`（按 `server/drizzle/` 顺序执行）
3. **公司端控制台**：`cd admin` → `npm install` → `npm run dev`
4. **商家端 App**：`E:\dev\flutter\bin\flutter.bat run`（需先 `adb devices` 确认已连真机）

### 4.2 常用命令

| 场景 | 命令（工作目录） |
| --- | --- |
| 后端类型检查 | `server/` → `npm run typecheck` |
| 后端代码检查 | `server/` → `npm run lint` |
| 后端测试 | `server/` → `npx vitest run --no-file-parallelism` |
| App 静态分析 | `app/` → `flutter analyze` |
| 打包 App | `app/` → `flutter build apk --release` |
| 装到真机 | 仓库根 → `E:\Android\sdk\platform-tools\adb.exe install -r installed-app.apk` |

## 五、云端与部署（当前线上环境）

- 云主机：**华为云 ECS** `113.44.226.189`（Ubuntu，2 核 2G / 40G 系统盘 / 2M 带宽，华北-北京四）
- 登录：`root@113.44.226.189`（密码由持有人线下保管，**不入仓库**）
- 服务目录：`/opt/starvoice/server`，由 **systemd** 单元 `starvoice.service` 托管，端口 **3000**（安全组已放行）
- 部署方式：本地整包同步 → 远端 `npm ci && npm run build` → 执行 `server/drizzle/` 新增迁移 → `systemctl restart starvoice`
- 冒烟：`curl http://113.44.226.189:3000/health` 应返回 200
- App 连接云端：安装包编译时把后端地址指向云主机，改地址需重新打包下发

> Git 推送如遇网络问题，仓库内 `scripts/ssh-proxy.js` 提供 SSH 代理通道（历史走本机 SOCKS5 `7891`），配置方式见 `f4802db` 那条 commit。

## 六、AGENTS.md 硬性规则（不可破）

1. **AI 角标恒开** —— 直播画面必须叠加「AI 智能直播」角标，**任何情况下不可关闭**。
2. **克隆前签授权** —— 声音克隆前必须签《声音授权协议》并存档。
3. **开播前敏感词扫描** —— 话术上播前必须过敏感词 / 禁用语检测。
4. **密钥只走 `.env`** —— 任何密钥、密码、签名指纹**不得写入代码或文档**；`.env` 不进版本库。
5. **第三方调用先查额度** —— 调用外部 AI 前先校验额度，超额拒绝并引导续费。
6. **数据库变更必须写迁移** —— 一律落 `server/drizzle/*.sql`，禁止直接改线上库结构。
7. **单批改动 ≤ 500 行**，范围外的功能不做。
8. **代码风格** —— 注释中文、变量英文；TypeScript strict + `noUncheckedIndexedAccess`；ESLint 的 `no-explicit-any` 是 error 级。
9. **竞品反编译包只作结构 / 交互 / 文案参考**（`D:\codex_project\2026-09-07\ni\outputs\`），**禁止搬运其源码**。

## 七、阶段任务表（详见 `docs/SPEC-TASKS.md`）

### 阶段 A —— 无外部依赖，可立即开工

| ID | 任务 | 关键改动面 | 验收口径 | 状态 |
| --- | --- | --- | --- | --- |
| A1 | 缓存旁路接线 | `services/liveSpeaker.ts`（补 copyFile、`SpeechOverrides` 加 `cacheUserId` / `cacheVoiceKey`）、`services/liveVoice.ts:52-64`（select 补 `userId` / `voiceId`） | 同（音色+语速+文本）第二次出声命中缓存、供应商零调用；写缓存失败不阻断出声 | 待开工 |
| A2 | 循环首轮预热 | `services/loopCaster.ts`（start 前 fire-and-forget 预热，取消即中止，失败逐条 warn） | 预热后整轮全命中，start 不被阻塞 | 待开工（依赖 A1） |
| A3 | 用量计量接线 | `services/liveSpeaker.ts`（仅 miss 且合成成功才 `recordTtsUsage`） | `usage_logs` 仅含真实新合成；命中不写流水、不扣额度 | 待开工（依赖 A1） |
| A4 | 直播中欠费闸门 | `routes/lives.ts`、`services/liveBilling.ts`、`services/quota.ts`、`services/loopCaster.ts`、App 工作台提示 | 余额与免费分钟同时耗尽时**只停口播**、画面继续；工作台提示续费；续费后自动恢复 | 待开工（口径已定） |
| A5 | 话术字数放开与节奏 | `routes/loopScripts.ts:94`（取消 200 字硬拒绝）、`services/loopScript.ts:11`（AI 侧改宽松上限）、`services/volcTTS.ts`（超长文本内部分段 + 拼接） | 用户话术不删字不截断、可保存任意长度；整段出声无句中停顿；条间 2s / 轮间 6s 维持 | **进行中**（见第八节） |

### 阶段 B —— 需外部资源 / 会真花钱

| ID | 任务 | 说明 | 状态 |
| --- | --- | --- | --- |
| B1 | 云端成本实测 | 唯一产生真实费用的里程碑，目标是拿到每小时实测成本与缓存命中率 | 待外部资源 |
| B2 | 支付自动入账 | **本轮只留口子**：预留服务端查单接口与订单字段，仍走人工转账 + 卡密核销 | 只留口子 |
| B3 | OTA 轻量自更新 | 服务端下发版本与更新提示 | 待排期 |

### 阶段 C —— 需多租户模型（未排期）

C1 白标 OEM 多租户 ｜ C2 邀请码分销 ｜ C3 账号注销自助

### 阶段 D —— 商业化增强（待排期）

D1 货盘商品池最小版 ｜ D2 卡密归因到人 / 转副播账户 ｜ D3 使用教程与兑换入口

### 已拍板口径（2026-09-16）

1. **话术字数**：打开 200 字硬限制；用户话术不删字、不截断、不自动切段；AI 生成侧保留宽松安全上限仅拦模型异常输出。
2. **欠费形态**：**只停口播**，画面与推流继续（适配真人主播在场）；续费到账自动恢复、从下一条继续。
3. **支付**：保留口子，个人主体资质**不再阻塞**任何开发任务。

### 待复核（不阻塞开工）

- 火山 TTS 单次请求文本长度上限的实测值；若小于用户可能输入的长度，A5 必须补「合成层内部分段 + 拼接」。

## 八、遗留阻塞与在飞半成品

### 8.1 阻塞项（需外部条件或人工决策）

| 事项 | 说明 |
| --- | --- |
| 本机未起 PostgreSQL | DB 相关用例被跳过，`skip ≠ 通过`；本地验收前必须先起库 |
| 克隆音色真复刻 | 当前为 CosyVoice 占位，真实复刻归入阶段 B |
| 云端遗留脏数据 | 历史 live 记录待清理 |
| 云端缺表 | 云端库尚无 `atmosphere_settings` 表，氛围语相关功能上线需先补迁移 |
| 话术标题为空 | AI 生成话术标题为空时，列表回退显示「未命名话术」 |
| USB 内录声卡未到货 | 手机直播出声链路的最后一环待实物验证 |
| 弹幕来源 | 真实平台弹幕采集需求已关闭，外挂适配方案待定 |
| 静默看门狗 | 方案待拍板 |
| `loopScripts.test.ts` | 存在改动前即失败的用例，非本批引入 |

### 8.2 在飞半成品（**本批未并入，切勿与交接提交混提**）

- `server/src/services/volcTTS.ts` —— A5 的「分段合成 + 拼装」改动，**当前是未提交状态且未验证**。
- `a5-tests.tmp.patch`（仓库外，位于 `D:\codex_project\2026-09-06\give-me-skill\`）—— 面向 `server/tests/volc_tts.test.ts` 的测试补丁，尚未应用。
- A5-2（手填话术 200 → 2000 字放开）尚未开工。

> 接手同学注意：交接时工作区仅应保留本批文档改动；若看到 `volcTTS.ts` 被修改，那是上一位同学的在飞工作，需单独评审后再决定是否提交。

## 九、验收命令与验证结果

以下为交接时点的实测结果（2026-09-16）。

| 检查项 | 命令 | 结果 |
| --- | --- | --- |
| App 静态检查 | `flutter analyze`（工作目录 `app/`） | **No issues found!** |
| 服务端类型检查 | `npm run typecheck`（工作目录 `server/`） | 通过 |
| 服务端 Lint | `npm run lint`（工作目录 `server/`） | 通过 |
| 服务端用例 | `npx vitest run --no-file-parallelism`（工作目录 `server/`） | 33 passed \| 4 skipped（37 文件）；**220 passed \| 160 skipped（380 用例）** |

**读法说明**

- `skipped` 全部是数据库相关用例：本机未起 PostgreSQL 时会被静默跳过，**skip 不等于通过**。本地复验前请先启动 PG（见 §四）。
- 工具版本：Flutter 3.47.2（`E:\dev\flutter`）。
- 历史口径差异：`docs/PROGRESS.md` 头部与 §6 中的用例数（216/372、379）为本批之前的数据，**以本表 220/380 为交接基线**。

## 十、敏感信息说明

**仓库内不含任何密钥、密码或签名指纹。** 全部敏感配置只存在于本机 `server/.env`（已在 `.gitignore` 内），云端对应 systemd 的环境文件。交接时请通过安全渠道单独传递 `.env`，不要贴进 issue、聊天或本文档。

`server/.env` 键名清单（**仅键名，值不落文档**）：

| 分组 | 键名 |
| --- | --- |
| 运行环境 | `NODE_ENV` `HOST` `PORT` `LOG_LEVEL` |
| 数据库 | `DATABASE_URL` |
| DeepSeek（话术生成） | `DEEPSEEK_API_KEY` `DEEPSEEK_BASE_URL` `DEEPSEEK_MODEL` |
| CosyVoice（克隆音色占位） | `COSYVOICE_API_KEY` `COSYVOICE_BASE_URL` `COSYVOICE_MODEL` `MOCK_COSYVOICE` |
| 火山 TTS（线上音色） | `VOLC_TTS_API_KEY` `VOLC_TTS_BASE_URL` `VOLC_TTS_RESOURCE_ID` `VOLC_TTS_SPEAKER` `VOLC_TTS_SAMPLE_RATE` `VOLC_TTS_SPEECH_RATE` |
| 本机发声 | `LIVE_SPEAKER_ENABLED` `LIVE_TTS_PROVIDER` `LOCAL_TTS_VOICE` `LIVE_SPEAKER_OUTPUT` |
| 语音缓存 | `TTS_CACHE_ENABLED` `TTS_CACHE_DIR` |
| 抖音开放平台 | `DOUYIN_CLIENT_KEY` `DOUYIN_CLIENT_SECRET` `DOUYIN_REDIRECT_URI` `MOCK_DOUYIN` |
| 抖音弹幕签名（第三方） | `DOUYIN_SIGN_ENDPOINT_URL` `DOUYIN_SIGN_API_KEY` |
| 微信支付 | `WXPAY_APPID` `WXPAY_MCH_ID` `WXPAY_API_V3_KEY` `WXPAY_PRIVATE_KEY_PATH` `WXPAY_CERT_SERIAL_NO` `WXPAY_NOTIFY_URL` |
| 鉴权与后台账号 | `JWT_SECRET` `ADMIN_INITIAL_USERNAME` `ADMIN_INITIAL_PASSWORD` |

## 十一、文档导航

`docs/` 共 18 份，按用途分四组：

**权威与总览**

| 文档 | 用途 |
| --- | --- |
| `docs/PROGRESS.md` | 主进度看板与变更日志，**变更记录口径以此为准** |
| `docs/db-schema.md` | 数据库表结构设计（S0 定稿） |
| `docs/DEV-SPRINTS.md` | Sprint 排期与完成情况 |
| `docs/SPEC-TASKS.md` | 规格与任务梳理 |

**产品与竞品**

| 文档 | 用途 |
| --- | --- |
| `docs/COMPETITOR-XCAI.md` | 竞品「星辰语音」反编译取证：架构 / 页面 / 接口 / 语音架构 |
| `docs/COMPETITOR-DIFF.md` | 竞品与自身能力差异对照 + 补差距任务清单 |
| `docs/COMMERCIALIZATION-AUDIT.md` | 商业化对齐审计（计费 / 卡密 / 支付） |
| `docs/ui-v2-research.md` | 竞品 UI 调研与三 Tab 信息架构建议 |
| `docs/UI-DESIGN-SPEC.md` | App UI 设计规范 |

**方案与里程碑**

| 文档 | 用途 |
| --- | --- |
| `docs/PLATFORM-NEUTRAL-VOICE.md` | 平台无关 AI 助播的定位口径（已定稿） |
| `docs/PHONE-LIVE-PLAN.md` | 手机直接开播方案、硬件情报与架构共识 |
| `docs/LOOP-BROADCAST-PLAN.md` | 循环台本与播出方案（已拍板基线） |
| `docs/LOWCOST-AUDIO-PLAN.md` | 低成本语音：TTS 分句缓存里程碑 |
| `docs/ATMOSPHERE-INTERACTION-PLAN.md` | 互动语（欢迎语 / 关注语 / 回复语）落地方案 |
| `docs/console-roadmap.md` | 公司端「任务台」控制台路线图 |

**弹幕采集（需求已关闭 / 已结项，留档）**

| 文档 | 用途 |
| --- | --- |
| `docs/DANMAKU-CAPTURE-PLAN.md` | 真实弹幕采集选型 |
| `docs/DANMAKU-COLLECTOR-PLAN.md` | 多平台弹幕采集器内嵌方案 |
| `docs/COLLECTOR-OPENSOURCE-AUDIT.md` | 开源采集器候选审计 |

---

> 交接问题请优先查阅本文件与 `docs/PROGRESS.md`；两者冲突时以 `docs/PROGRESS.md` 的变更记录为准。
