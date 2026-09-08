# 星辰语音 App（StarVoice）代码仓库

> 让本地团购商家在自选直播平台（抖音 / 快手 / 视频号…）开播时，多一位不累的 AI 语音助播：
> 自动循环口播团购话术、实时回应弹幕，真人只需出镜补位。平台无关：只出声、不推流。

## 仓库结构（Monorepo）

```
starvoice/
├── app/      # Flutter 客户端（iOS + Android）
├── server/   # 后端服务（Node.js + PostgreSQL，MVP 单体）
├── admin/    # 管理后台（Web）
└── docs/     # 开发相关文档（PRD、排期、接口约定）
```

## 技术栈（MVP，全部外采 AI 能力）

| 层 | 选型 |
|---|---|
| 客户端 | Flutter 3.x（一套代码双端） |
| 后端 | Node.js 22 + Fastify + PostgreSQL |
| AI 声音克隆 | 阿里云 CosyVoice（主）/ 火山引擎（备） |
| AI 话术生成 | DeepSeek API |
| 主形态语音出口 | 平台无关：助播机出声 → 商家正在开播的任意直播平台 |
| 托管推流（可选辅助线） | FFmpeg 合成 → 抖音 RTMP（G2 暂停待 key，非主形态） |
| 支付 | 微信支付（¥99/月订阅） |

## 开发流程

1. 开发顺序严格按 `docs/DEV-SPRINTS.md` 的 Sprint 计划
2. AI 辅助开发（Codex CLI + DeepSeek）必须遵守 `AGENTS.md` 约定
3. 每完成一个功能包 git commit 一次，commit message 格式：`feat|fix|refactor(scope): 描述`
4. 主分支 master 保护，开发在 feature/* 分支进行

## 文档索引

- 产品需求：`../../02-PRD/`
- 开发计划：`../../05-开发计划/`
- Sprint 排期：`docs/DEV-SPRINTS.md`
