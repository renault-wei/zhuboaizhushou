# starvoice-admin

「星辰语音 App」管理后台（React 18 + Vite + TypeScript + Ant Design 5 + React Router），仅供内部运营使用。

## 启动步骤

前置要求：Node.js >= 18（推荐 20+）。

```bash
cd admin
npm install      # 依赖由外部安装，本目录执行过一次即可
npm run dev      # 启动开发服务，浏览器打开 http://127.0.0.1:5173
```

联调后端（可选）：先启动 `server/`（`npm run dev`，监听 `http://127.0.0.1:3000`），前端以 `/api` 开头的请求会自动代理到该后端。

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
    ├── main.tsx          # 入口：Ant Design 中文语言包 + 挂载根组件
    ├── App.tsx           # 路由：/login 登录页；/ 主布局
    ├── index.css         # 全局样式
    ├── layouts/
    │   └── MainLayout.tsx # 带侧边栏的主布局（Layout/Menu）
    ├── components/
    │   └── PagePlaceholder.tsx # 业务空页面占位
    └── pages/
        ├── LoginPage.tsx # 登录页（账号/密码/验证码，纯 UI）
        ├── DashboardPage.tsx # 数据看板（空壳）
        ├── MerchantPage.tsx  # 商家管理（空壳）
        ├── OrderPage.tsx     # 订单订阅（空壳）
        └── AuditPage.tsx     # 内容审核（空壳）
```

## 页面说明

- `/login`：登录页，账号 + 密码 + 验证码 + 登录按钮，纯 UI 展示，未接后端接口；可用「跳过登录」进入主布局预览。
- `/`：主布局（Ant Design Layout + Menu 侧边栏），含 4 个可切换的空页面：数据看板 / 商家管理 / 订单订阅 / 内容审核，对应 S3 后台任务（T16–T19）逐个填充。

## 约定

- 密钥管理：前端不持有任何 API Key 或敏感配置，一律由 `server/` 通过 `.env` 管理（`.env*` 已被根目录 .gitignore 忽略）。
- 注释用中文、变量名用英文；提交前保证 `npm run lint` 无 error。
