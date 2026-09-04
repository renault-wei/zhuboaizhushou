# 星辰语音 App（StarVoice）项目交接文档

> **交接人**：原主控 AI 助手  
> **交接日期**：2026-09-04  
> **文档位置**：`D:\星辰语音App\06-代码\starvoice\HANDOVER.md`  
> **适用读者**：接手 StarVoice 项目后端 / 客户端 / 全栈开发的同事

---

## 一、项目一句话

让本地团购商家「不露脸、不出声、不用写稿」，录 3 分钟声音 → AI 克隆音色 → AI 生成团购话术 → 一键实景无人直播卖团购券。

**目标客户**：抖音本地生活团购商家（餐饮 / 到店服务 / 零售优先）。  
**MVP 商业模型**：¥99/月订阅 + 免费额度（1 次克隆 + 2 小时直播）。  
**不做**：数字人、多平台推流、多门店、LLM 实时弹幕互动、多档套餐。

---

## 二、当前进度（按 Sprint 计划对齐）

| Sprint | 主题 | 状态 | 累计 commit 数 |
|---|---|---|---|
| **S0** | 三端脚手架（Flutter App + Node 服务 + React 后台 + DB schema） | ✅ 完成 | 4 |
| **S1** | 登录 + 声音克隆 + 话术生成 | ✅ 完成 | +8（T1-T8 全绿） |
| **S2** | 直播推流核心 | 🟡 进行中（10 / 14） | +2（T9、T10 入库） |
| S3 | 支付 + 额度 + 后台管理 | ⏳ 未开始 | — |
| S4 | 联调 + 修 Bug + 提审 | ⏳ 未开始 | — |

### 2.1 已完成的功能清单（用户可演示）

| # | 功能 | 后端 commit | 客户端页面 | 服务端测试 | 客户端测试 |
|---|---|---|---|---|---|
| S1-T1 | 手机号验证码登录 | `280f189` | `login_page.dart` | ✅ | ✅ |
| S1-T2 | 抖音号 OAuth 绑定/解绑（mock） | `8eeb0ca` | `douyin_bind_page.dart` | ✅ | ✅ |
| S1-T3 | 《声音授权协议》签署存档 v1.0 | `734290f` | `voice_agreement_page.dart` | ✅ | ✅ |
| S1-T4 | 录音页（10 段念稿 + 波形 + ≥3min 校验 + 断点续录） | `ecf1138` | `recording_page.dart` | ✅ | ✅ |
| S1-T5 | 声音克隆（CosyVoice mock + 异步惰性推进） | `ead55af` | —（触发流程） | ✅ | ✅ |
| S1-T6 | 音色库页（列表/状态轮询/删除） | `e49d3b0` | `voice_library_page.dart` | ✅ | ✅ |
| S1-T7+T8 | AI 话术生成（DeepSeek 真调）+ 编辑 + 敏感词拦截 | `6dc0e38` | `script_generate_page.dart` + `script_edit_page.dart` | ✅ | ✅ |
| **S2-T9** | **团购券列表页（抖音 OAuth 拉券，mock）** | **`be6a097`** | `coupon_list_page.dart` | **✅** | **✅（dart analyze 通过）** |
| **S2-T10** | **开播配置页 lives CRUD（选音色/话术/券 + 标题）** | **`9b6a8fc`** | `live_list_page.dart` + `live_form_page.dart` | **✅ 63/63** | **✅（dart analyze 0 error）** |

### 2.2 S2-T10 状态：✅ **已完成并入库（commit `9b6a8fc`）**

> 服务端 + 客户端全部完成，端到端验证通过。S2 剩余 T11-T14。

| 组件 | 状态 | 位置 |
|---|---|---|
| 服务端 service | ✅ 完成 | `server/src/services/live.ts` |
| 服务端 routes | ✅ 完成 | `server/src/routes/lives.ts` |
| 服务端 tests | ✅ 12 项全绿 | `server/tests/lives.test.ts` |
| 客户端 Live 模型 | ✅ 完成 | `app/lib/core/models/live.dart` |
| 客户端 ApiClient 5 方法 | ✅ 完成 | `app/lib/core/network/api_client.dart` |
| 客户端 controllers | ✅ 完成 | `app/lib/features/lives/application/`（2 个） |
| 客户端 UI 页面 | ✅ 完成 | `live_list_page.dart` + `live_form_page.dart` |
| 客户端 widget 测试 | ✅ 完成 | `live_model_test.dart` + `live_list_page_test.dart` + `live_form_page_test.dart` |
| 首页入口 + 路由 + provider | ✅ 完成 | `home_page.dart` / `app_router.dart` / `providers.dart` |
| `dart analyze` | ✅ **0 error** | — |
| 服务端测试总数 | ✅ **63/63 全绿（实测 5.2s）** | — |

**T10 关键合规点**：`aiBadgeShown` 服务端写死 `true`、请求体传 `false`/`status`/`rtmpUrl` 等非白名单字段一律忽略；删除保护（live/ready → 409）；跨用户归属隔离（非本人 → 404）。边界 bug（PATCH 只传非法字段返回 500）已修 → 400 `LIVE_NO_FIELDS_TO_UPDATE`。

---

## 三、代码位置（绝对路径，移交时请直接打包这俩目录）

### 3.1 项目根

```
D:\星辰语音App\                           ← 项目根（含 PRD/原型/技术 POC/开发计划）
D:\星辰语音App\06-代码\                   ← 代码 + 文档
D:\星辰语音App\06-代码\starvoice\          ← ★★★ git 仓库根（移交重点）★★★
```

### 3.2 starvoice 仓库根（`D:\星辰语音App\06-代码\starvoice\`）

```
starvoice/
├── .git/                       ← 本地 git 仓库（无远程）
├── .gitignore                  ← 已忽略 node_modules / build / .dart_tool / .env / server.log*
├── AGENTS.md                   ← ★ Codex/AI 助手硬性约定（必读）
├── README.md
├── TASK-T9.md                  ← 历史任务单（已入库）
├── TASK-T10.md                 ← 当前任务单（未入库，含完整 T10 规格）
├── HANDOVER.md                 ← 本文档
│
├── app/                        ← Flutter 客户端（iOS + Android）
│   ├── lib/
│   │   ├── main.dart           ← 入口
│   │   ├── app.dart            ← MaterialApp + ProviderScope + 路由
│   │   ├── providers.dart      ← 全局 Riverpod providers
│   │   ├── router/app_router.dart   ← go_router 路由表
│   │   ├── core/
│   │   │   ├── config/api_config.dart
│   │   │   ├── models/         ← 8 个数据模型（user/voice/script/coupon/live/douyin_bind_status/voice_agreement/...）
│   │   │   ├── network/        ← dio ApiClient + ApiException + AuthInterceptor
│   │   │   └── storage/session_storage.dart  ← token/user/登录时间持久化
│   │   └── features/           ← 业务模块（每个含 application/ + presentation/）
│   │       ├── splash/         ← 启动页（路由选择）
│   │       ├── auth/           ← 登录
│   │       ├── home/           ← 首页（含所有功能入口）
│   │       ├── douyin/         ← 抖音绑定
│   │       ├── agreement/      ← 声音授权协议
│   │       ├── recording/      ← 录音
│   │       ├── voices/         ← 音色库
│   │       ├── scripts/        ← 话术
│   │       ├── coupons/        ← 团购券
│   │       └── lives/          ← 开播配置（★ T10 部分缺）
│   ├── test/                   ← 23 个 widget/unit 测试（含 fake_backend.dart）
│   ├── pubspec.yaml            ← Flutter SDK ^3.13.2 + dio/riverpod/go_router/shared_preferences/record/path_provider
│   └── README.md
│
├── server/                     ← Node 22 + Fastify 5 + PostgreSQL 17 后端
│   ├── src/
│   │   ├── index.ts            ← 启动入口（监听 PORT，默认 3000）
│   │   ├── app.ts              ← Fastify 应用组装（含全局 content type parser）
│   │   ├── config/env.ts       ← 环境变量加载与默认值
│   │   ├── db/
│   │   │   ├── client.ts       ← Drizzle pg 客户端
│   │   │   └── schema.ts       ← ★ 9 张表完整 schema
│   │   ├── plugins/auth.ts     ← Fastify JWT 鉴权插件（app.authenticate）
│   │   ├── routes/             ← 7 个路由文件（auth/agreements/douyin/health/voices/scripts/coupon/lives）
│   │   └── services/           ← 9 个 service（auth/agreement/voice/script/sensitive/sms/douyin/coupon/live）
│   ├── tests/                  ← 7 个 vitest 集成测试（62/62 全绿）
│   ├── drizzle/                ← ⚠️ 当前无迁移文件（用 db:push 推到 PG）
│   ├── drizzle.config.ts       ← Drizzle Kit 配置
│   ├── package.json            ← 脚本：dev / lint / test / db:generate|migrate|push|studio
│   ├── .env                    ← ★ 已含 DeepSeek API Key（敏感文件，勿提交！）
│   └── README.md
│
├── admin/                      ← React 18 + Vite + Ant Design 5 后台
│   ├── src/
│   │   ├── main.tsx
│   │   ├── App.tsx             ← 路由
│   │   ├── layouts/MainLayout.tsx
│   │   ├── pages/              ← LoginPage / DashboardPage / MerchantPage / OrderPage / AuditPage
│   │   └── components/PagePlaceholder.tsx
│   ├── package.json
│   └── README.md
│
└── docs/
    ├── DEV-SPRINTS.md          ← ★ 完整 Sprint 排期（S0-S4 全部 24 个 P0）
    └── db-schema.md            ← 数据库 ER 图 + 字段说明（与 schema.ts 一一对应）
```

### 3.3 服务端 9 张表（`server/src/db/schema.ts`）

`users` / `voices` / `voice_agreements` / `scripts` / `lives` / `orders` / `quotas` / `usage_logs` / `admin_users` / `audit_logs`  
（注：实际 10 张，含 `voice_agreements`）

**重要字段提醒**：
- `lives.ai_badge_shown`（数据库列）↔ `Live.aiBadgeShown`（代码字段）——**合规：服务端写死 true，禁止覆盖**
- `lives.status` enum: `idle / ready / live / ended / failed`
- `scripts.sensitive_check_status` enum: `draft / passed / blocked`
- `voices.status` enum: `pending / processing / ready / failed`

---

## 四、开发环境

### 4.1 工具位置（Windows + Git Bash）

| 工具 | 路径 / 命令 |
|---|---|
| Node.js | `C:\Users\12230\.workbuddy\binaries\node\versions\22.22.2-2\node.exe`（**用绝对路径**，别走全局 PATH） |
| Flutter SDK | `E:\dev\flutter\bin\flutter.bat` + `E:\dev\flutter\bin\dart.bat` |
| PostgreSQL 17 | 本地默认 `postgres://postgres@127.0.0.1:5432/starvoice` |
| Codex CLI | `C:\Users\12230\.codex\plugins\.plugin-appserver\codex.exe`（v0.153.1） |

### 4.2 三端启动方式

#### 服务端（dev 模式）

```bash
cd /d/星辰语音App/06-代码/starvoice/server
unset http_proxy HTTP_PROXY https_proxy HTTPS_PROXY
export DATABASE_URL='postgres://postgres@127.0.0.1:5432/starvoice'
export JWT_SECRET='starvoice-dev-secret'
"C:/Users/12230/.workbuddy/binaries/node/versions/22.22.2-2/node.exe" \
  node_modules/tsx/dist/cli.mjs src/index.ts
# 默认监听 0.0.0.0:3000
```

测试运行：

```bash
cd /d/星辰语音App/06-代码/starvoice/server
unset http_proxy HTTP_PROXY https_proxy HTTPS_PROXY
npm test   # vitest run，应 62/62 全绿（5s 内）
```

#### 客户端（Flutter）

```bash
cd /d/星辰语音App/06-代码/starvoice/app
export PUB_CACHE="C:/Users/12230/AppData/Local/Pub/Cache"
unset http_proxy HTTP_PROXY https_proxy HTTPS_PROXY
E:/dev/flutter/bin/dart.bat analyze lib test     # 静态检查（必须 0 error）
E:/dev/flutter/bin/flutter.bat run -d windows    # Windows 桌面跑（可体验 S1 完整闭环）
```

**⚠️ 沙箱下 flutter test 会卡住**（`storage.googleapis.com` 在沙箱不可达）。**绕行**：
- 中文路径 `D:\星辰语音App\06-代码\starvoice\app\test\` 会让 Flutter analyze/test 在 Windows 上因非 ASCII 路径崩溃。
- 解决：用 robocopy 把 app 同步到 ASCII 镜像目录（如 `C:\starvoice_mirror\app`）后验证：
  ```powershell
  robocopy "D:\星辰语音App\06-代码\starvoice\app" "C:\starvoice_mirror\app" /MIR `
    /XD .dart_tool build .git /NFL /NDL /NJH /NJS /NP
  # 然后把 .dart_tool 也复制过去，避免重复 pub get
  robocopy "D:\星辰语音App\06-代码\starvoice\app\.dart_tool" "C:\starvoice_mirror\app\.dart_tool" /E
  ```
  在镜像中跑 dart analyze。验收完把镜像删掉，改动自动留在原项目里。

#### 后台（admin）

```bash
cd /d/星辰语音App/06-代码/starvoice/admin
npm install
npm run dev   # vite，默认 5173
```

### 4.3 数据库迁移

⚠️ 当前 `server/drizzle/` **没有迁移文件**。开发用 `db:push` 直接同步 schema 到本地 PG：

```bash
cd /d/星辰语音App/06-代码/starvoice/server
npm run db:push   # 把 schema.ts 推到 PG（首次开发/改表后跑一次）
```

未来要走正式迁移流程：`npm run db:generate` 生成 SQL → `npm run db:migrate`。

---

## 五、AI 辅助开发工作流（Codex + DeepSeek）

### 5.1 启动公式（每次派 Codex 必带环境变量）

```bash
cd /d/星辰语音App/06-代码/starvoice
unset http_proxy HTTP_PROXY https_proxy HTTPS_PROXY
export DEEPSEEK_API_KEY='sk-...你的key...'
export DEEPSEEK_BASE_URL='https://api.deepseek.com'
export DEEPSEEK_MODEL='deepseek-chat'
"/c/Users/12230/.codex/plugins/.plugin-appserver/codex.exe" exec \
  -m deepseek-chat \
  -C "D:/星辰语音App/06-代码/starvoice" \
  --dangerously-bypass-approvals-and-sandbox \
  "<完整的 TASK-*.md 任务单内容>"
```

**坑**：
- 缺 `DEEPSEEK_API_KEY` 时 codex 会以 `DEEPSEEK_API_KEY` 环境变量缺失失败 → **必须 export**
- Codex 不能用 Windows 网络共享/有空格路径 → 必须 `cd /d/星辰语音App/06-代码/starvoice`
- Bash 单行命令 `&&` 后接多行字符串会被截断 → **用单引号包裹整个 prompt 参数**

### 5.2 工作流约定

1. **主控（人类或 AI）** 写 `TASK-*.md` 任务单（参照 `TASK-T9.md` / `TASK-T10.md` 的详细程度）
2. **派 Codex** 执行 → 后台运行（task id 可追踪）
3. **主控验收**：
   - `npm test`（服务端）
   - `dart analyze`（客户端，镜像绕中文路径）
   - 重启服务做端到端 curl 验证
4. **修 bug**：派 Codex 或主控手写
5. **主控 commit**（Codex 不 commit）

---

## 六、AGENTS.md 硬性规则（违反即 bug，整理自 `AGENTS.md`）

1. **合规红线**
   - 直播画面必须叠加「AI 智能直播」角标，**不提供任何关闭入口**（`lives.aiBadgeShown` 一律 true）
   - 声音克隆前必须完成《声音授权协议》签署存档（`voices.agreement_pdf_path`）
   - 话术生成后、开播前必须跑敏感词扫描（`scripts.sensitive_check_status = 'blocked'` 时阻断）
2. **成本红线**：所有第三方 AI 调用必须先查用户额度，超额直接拒绝并返回引导续费文案（S3-T15 实现）
3. **密钥管理**：API Key 走环境变量 / `.env`（`.env` 已 gitignore）。**任何代码、注释、文档不得硬编码密钥**
4. **不做清单**：数字人、多平台推流、多门店、LLM 实时弹幕互动、多档套餐
5. **数据库变更**：写迁移文件（`server/drizzle/`），不直接改表

### 6.1 服务端代码范式（贯穿 S1-T2 之后所有 service）

```typescript
// 接口 + mock 工厂 + 单例 范式
export interface FooService { foo(): Promise<X> }
export class MockFooService implements FooService { ... }
export class RealFooService implements FooService { ... }
export function createFooService(): FooService {
  if (!env.FOO_API_KEY || env.MOCK_FOO === 'true') return new MockFooService();
  return new RealFooService();
}
export const fooService = createFooService();
```

未来接真实服务只换 `RealFooService` 实现，路由不变。

### 6.2 异步克隆惰性推进（voice / lives 等需要异步状态的范式）

service 不写 `setTimeout`。路由层按 `createdAt` 推进状态：
- `pending`（<3s）→ `processing`（3-8s）→ `ready`（≥8s）
- 终态不回退

---

## 七、已踩过的坑（防止重复踩）

| # | 坑 | 解决 |
|---|---|---|
| 1 | Fastify `FST_ERR_CTP_EMPTY_JSON_BODY`（POST 空 body + Content-Type: application/json 报 400） | 在 `server/src/app.ts` 全局 `addContentTypeParser`，空 body 视为 `{}`（T2/T6 两处同坑一次根治） |
| 2 | `JWT_SECRET` 未传导致 jwt.sign 抛出作用域 bug | 用 `@fastify/jwt` 官方插件，不要自己手写 fastify-jwt 封装 |
| 3 | DeepSeek 余额耗尽返回 `Insufficient Balance` | **用户已充值（2026-09-04），当前可用；DeepSeek 模型升级到 deepseek-v4-flash** |
| 4 | Flutter 中文路径 analyze/test 崩溃 | 用 ASCII 镜像（详见 4.2 客户端部分） |
| 5 | 沙箱下 flutter test 卡死（`storage.googleapis.com` 不可达） | 改用 `dart analyze` 静态覆盖；动态测试需关沙箱或在非沙箱环境跑 |
| 6 | Codex 报 `DEEPSEEK_API_KEY` 缺失 | 启动公式必须 export（详见 5.1） |
| 7 | 敏感词「绝对」单字误杀（"绝对够够的"被拦） | 单字「绝对」移除；组合词如「绝对第一」仍由「第一」拦截 |
| 8 | Postgres `localhost:80` vs `127.0.0.1:3000` 混用 | 服务端日志里 `host: "localhost:80"` 是测试请求（测试池），实际接口走 127.0.0.1:3000 |
| 9 | PowerShell `Start-Process` 启动的进程 `ps -ef` 看不到 | 进程由 Windows SCM 管理；用 `curl /health` 验证存活 |
| 10 | `bash nohup ... &` 在 Windows Git Bash 下不稳 | 用 PowerShell `Start-Process -WindowStyle Hidden` 或前台后台任务 |

---

## 八、Sprint 排期总览（剩余）

| 任务 | 主题 | 关键依赖 | 预估 |
|---|---|---|---|
| **S2-T10** | 开播配置 CRUD（lives） | ✅ 完成并入库（`9b6a8fc`） | — |
| S2-T11 | 推流引擎 v1（FFmpeg 合成：视频循环 + TTS 音轨 + 角标） | T10 | 3-5d |
| S2-T12 | RTMP 推流到抖音（企业测试号） | T11 + 抖音 POC 结论 | 2-3d |
| S2-T13 | 一键开播/结束 + 直播中监控页（状态/时长/弹幕日志只读） | T11 | 2-3d |
| S2-T14 | 合规角标三处强制叠加（画面/监控页/后台记录） | T11 | 1-2d |
| S3-T15 | 免费额度逻辑（1 次克隆 + 2h 直播，扣减流水） | T6/T7 | 3d |
| S3-T16 | 微信支付（¥99 订阅 + 回调 + 续期） | T15 | 3d |
| S3-T17~T20 | 后台：商家管理 / 订单 / 数据看板 / 内容审核 / AI 用量 | T16 | 1w |
| S4 | 联调 + 修 Bug + 提审（App Store + 安卓商店） | 全部 | 1w |

**关键风险**（来自 DEV-SPRINTS.md）：
- **T12 RTMP 推流到企业测试号**——依赖抖音 POC 结论（见 `04-技术POC/W1-W2-技术POC验收清单.md`）
- **T11 FFmpeg 合成**——需要视频片段上传与音轨同步，建议先做视频元数据提取 + 静态角标叠加 demo

---

## 九、当前工作区状态（T10 已入库，工作区已基本干净）

```bash
cd /d/星辰语音App/06-代码/starvoice
git status --short
# ?? HANDOVER.md              ← 本文档（未入库，建议随交接 commit）
# ?? server/server.log.err    ← 运行时日志（建议加入 .gitignore，勿提交）
```

> 说明：S1-T6 的 `addContentTypeParser` 全局修复**早已入库**（commit `e49d3b0`，位于 `server/src/app.ts` 第 21 行），无需再处理。

---

## 十、用户资产与敏感信息（移交时不外传）

| 项 | 位置 / 值 | 备注 |
|---|---|---|
| DeepSeek API Key | `server/.env` 中 `DEEPSEEK_API_KEY` | 用户已充值；当前模型 `deepseek-chat` |
| 阿里云 CosyVoice | `.env` 中 `COSYVOICE_*` 字段为空 | 当前全部走 mock（`MockCosyVoiceService`） |
| 抖音开放平台 | `.env` 中 `DOUYIN_*` 字段为空 | 当前全部走 mock（`MockDouyinOAuthService` + `MockDouyinCouponService`） |
| 微信支付 | `.env` 中 `WXPAY_*` 字段为空 | S3-T16 才接入 |
| JWT_SECRET | `.env` 中 `a9bd7272...` | 本地开发值，生产必须换强随机 |
| GitHub 仓库 | 用户提供的 GitHub 地址（对话中提到，未在 `.git/config` 配 remote） | 当前是**纯本地仓库**，无远程。需要时：`git remote add origin <地址> && git push -u origin master` |

---

## 十一、验收清单（接手后请先跑一遍）

```bash
# 1. 服务端测试（应 62/62 全绿）
cd /d/星辰语音App/06-代码/starvoice/server && unset http_proxy HTTP_PROXY https_proxy HTTPS_PROXY && npm test

# 2. 客户端 dart analyze（应 0 error；当前 T10 未完成会有 4 个 error）
cd /d/星辰语音App/06-代码/starvoice/app && export PUB_CACHE="C:/Users/12230/AppData/Local/Pub/Cache" && \
  unset http_proxy HTTP_PROXY https_proxy HTTPS_PROXY && "E:/dev/flutter/bin/dart.bat" analyze lib test

# 3. 端到端：启动服务 → curl 关键接口
# (启动服务端)
# curl /health → 200
# curl /api/douyin/coupons → 401
# curl /api/lives → 401
# curl /api/voices → 401
# curl /api/scripts → 401

# 4. git 历史完整性
cd /d/星辰语音App/06-代码/starvoice && git log --oneline | head -15
# 应看到 12 条 commit（S0 x4 + S1-T1~T8 + S2-T9 = 12）
```

---

## 十二、文档导航（遇到问题先翻这些）

| 问题 | 翻这个 |
|---|---|
| 总体进度 / Sprint 计划 | `docs/DEV-SPRINTS.md` |
| 数据库表结构 / ER 图 | `docs/db-schema.md` + `server/src/db/schema.ts` |
| API 路由清单 | `server/src/routes/`（每个文件顶端有 JSDoc 注释） |
| Codex/AI 助手硬性约定 | `AGENTS.md` |
| 某个任务的具体规格 | `TASK-*.md`（T9、T10 已入库格式典范） |
| 客户端代码组织 | `app/lib/features/`（每个业务模块含 application/presentation 子目录） |
| PRD / 原型 / POC | `D:\星辰语音App\02-PRD\` + `03-原型设计\` + `04-技术POC\` |
| 本会话踩过的所有坑 | `C:\Users\12230\WorkBuddy\2026-09-03-20-12-30\.workbuddy\memory\2026-09-04.md` |

---

**祝接手顺利，有问题找我可以看 memory 里的完整 24 小时开发日志。**