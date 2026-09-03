# starvoice-server

「星辰语音 App」后端服务：Node.js + TypeScript（严格模式）+ Fastify + Drizzle ORM + PostgreSQL。注释用中文，变量名用英文，密钥一律走 .env，代码中不得硬编码任何密钥。

## 本地启动

前置要求：Node.js >= 20；PostgreSQL >= 13（主键 uuid 依赖 gen_random_uuid）。

1. 建库（默认库名 starvoice，可按需修改）：

```bash
psql -U postgres -c "CREATE DATABASE starvoice;"
```

2. 复制环境变量模板并填写：

Windows PowerShell：`Copy-Item .env.example .env`
macOS / Linux：`cp .env.example .env`

3. 安装依赖（依赖由外部安装，本目录执行过一次 `npm install` 即可）：

```bash
npm install
```

4. 首次建表：直接按当前 schema 同步（等价于初始迁移）：

```bash
npm run db:push
```

后续表结构变更必须走迁移文件（见下节「数据库约定」）：

```bash
npm run db:generate   # 在 server/drizzle 生成迁移 SQL
npm run db:migrate    # 执行未应用的迁移
```

5. 启动开发服务：

```bash
npm run dev
```

6. 验证健康检查：浏览器或 curl 打开 `http://127.0.0.1:3000/health`，返回 status 为 ok 即启动成功。

## 常用脚本

| 命令 | 说明 |
| --- | --- |
| npm run dev | 开发模式热重载启动（tsx watch） |
| npm run build | 编译到 dist/ |
| npm run start | 运行编译产物（先 build） |
| npm run lint | ESLint 检查 |
| npm run typecheck | TypeScript 类型检查（不产出文件） |
| npm run db:generate | 依据 schema 生成迁移文件 |
| npm run db:migrate | 执行迁移 |
| npm run db:push | 直接按 schema 同步表结构（仅本地首建用） |
| npm run db:studio | 打开 Drizzle Studio 可视化浏览数据 |

## 目录结构

```text
server/
├── drizzle.config.ts     # Drizzle Kit 配置（生成迁移用）
├── eslint.config.mjs     # ESLint 扁平配置
├── tsconfig.json         # TS 严格模式
├── .env.example          # 环境变量模板（复制为 .env 后填写）
├── drizzle/              # 迁移文件目录（db:generate 生成，提交入库）
└── src/
    ├── index.ts          # 入口：启动 HTTP 服务 + 优雅退出
    ├── app.ts            # 组装 Fastify 实例（集中注册路由/插件）
    ├── config/env.ts     # 环境变量读取与校验
    ├── db/
    │   ├── client.ts     # pg 连接池 + Drizzle client
    │   └── schema.ts     # 核心表 schema（S0 定稿 9 张 + voice_agreements）
    └── routes/
        └── health.ts     # GET /health 健康检查
```

## 数据表

见 `src/db/schema.ts`，S0 定稿 9 张核心表（users、voices、scripts、lives、orders、quotas、usage_logs、admin_users、audit_logs），T3 新增 voice_agreements（声音授权协议签署存档）。

## 工程约定

- 环境变量：把 `.env.example` 复制为 `.env` 后填写；`.env` 已被根目录 .gitignore 忽略，禁止提交。
- 数据库变更写迁移文件（`server/drizzle` 或手写 SQL），不直接改线上表结构。
- 第三方 AI 调用（DeepSeek / CosyVoice / 抖音）先查商家剩余额度，超额直接拒绝；测试一律 mock，不得真实调用。
- 声音克隆前必须完成《声音授权协议》签署并存档；话术开播前必须通过敏感词扫描；直播画面强制叠加「AI 智能直播」角标且无关闭入口。
