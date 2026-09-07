# starvoice-admin

「星辰语音 App」管理后台（React 18 + Vite + TypeScript + Ant Design 5 + React Router），仅供内部运营使用（公司端任务台，里程碑 M1–M4）。

## 启动步骤

前置要求：Node.js >= 18（推荐 20+）。

```bash
cd admin
npm install      # 首次执行：安装依赖
npm run dev      # 启动开发服务，浏览器打开 http://127.0.0.1:5173
```

联调后端：先启动 `server/`（`npm run dev`，监听 `http://127.0.0.1:3000`），前端以 `/api` 开头的请求会自动代理到该后端。登录使用后端预置运营账号（见 `server` seed 脚本与 `.env`）。

## 常用脚本

| 命令 | 说明 |
| --- | --- |
| `npm run dev` | 开发模式热重载（Vite dev server） |
| `npm run build` | 类型检查（tsc --noEmit）+ 生产构建到 `dist/` |
| `npm run preview` | 本地预览生产构建产物 |
| `npm run lint` | ESLint 检查（TS 严格 + React Hooks 规则） |

## 目录结构

```text
admin/
├── index.html            # HTML 入口（中文标题）
├── vite.config.ts        # Vite 配置：/api 代理到 127.0.0.1:3000
├── tsconfig.json         # TS 严格模式
├── eslint.config.js      # ESLint 扁平配置
└── src/
    ├── main.tsx          # 入口：中文语言包 + Antd App + 浏览器路由
    ├── App.tsx           # 路由与登录守卫：/login 已登录自动跳看板；受保护页未登录回登录页
    ├── auth.ts           # 后台会话存取（localStorage，前端不存密钥）
    ├── api.ts            # 后端接口封装：统一 Bearer 注入 + 401 自动登出 + 领域类型
    ├── index.css         # 全局样式
    ├── layouts/
    │   └── MainLayout.tsx # 侧边栏主布局（看板/商家/算力/订单/审核 + 安全退出）
    └── pages/
        ├── LoginPage.tsx    # 登录页（对接 POST /api/admin/login）
        ├── DashboardPage.tsx# 数据看板：商家/订阅收入/AI 用量/直播四组指标
        ├── MerchantPage.tsx # 商家管理：搜索台账 + 额度调整抽屉（写操作审计留痕）
        ├── UsagePage.tsx    # 算力用量：类别筛选 + 汇总卡 + AI 调用流水
        ├── OrderPage.tsx    # 订单订阅：状态筛选 + 待确权订单人工收款确认
        └── AuditPage.tsx    # 内容审核：拦截话术 / 授权存档 / 审计日志
```

## 页面说明

- `/login`：登录页，对接真实后端登录接口，成功后才写入会话并进入看板；已有会话访问会自动跳转看板。
- `/dashboard`：北极星指标看板（商家规模 / 订阅收入 / AI 用量 / 直播场次）。
- `/merchants`：商家台账（手机号/昵称搜索），可打开「额度调整」抽屉按周期修改字符/话术/直播分钟上限，只改上限、保留已用量，操作自动写审计日志。
- `/usage`：AI 用量流水与汇总，按类别筛选，标识引擎/模型与折算成本。
- `/orders`：订阅订单台账；待确权订单可「确认收款」（模拟支付回调：订阅顺延 30 天 + 当月额度按付费档刷新），重复确权会被后端拦截。
- `/audit`：合规档案三个 Tab —— 话术拦截队列（含命中词，展开看全文）、声音授权协议签署存档、运营审计日志（展开看留痕明细）。

## 约定

- 密钥管理：前端不持有任何 API Key 或敏感配置，一律由 `server/` 通过 `.env` 管理（`.env*` 已被根目录 .gitignore 忽略）。
- 注释用中文、变量名用英文；提交前保证 `npm run lint` 无 error、`npm run build` 通过。
- 里程碑：M1 服务端账号与读接口 → M2 运营写操作 → M3 本后台页面 → M4 商业化配额接线（见 `docs/console-roadmap.md`）。
