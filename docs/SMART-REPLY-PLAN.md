# 智能回复模块 · 方案与票表

> 状态：**调研完成，待拍板**（2026-09-17）。来源 = 用户「对标反编译包，需要一个智能回复模块，可以根据弹幕来」。
> 取证对象：`D:\codex_project\2026-09-07\ni\outputs\`（竞品 APK 反编译产物）。

## 1. 竞品实证（反编译取证，非猜测）

### 1.1 它的智能回复是**纯服务端**

```js
// components/sendbullet.vue
uni.request({
  url: apiurl + "api/v1.live/getReply",
  data: { task_id: this.task_id, content: e },   // e = 弹幕正文
  method: "POST",
  success: e => 200 == e.data.code ? t({ anwser: e.data.data }) : ...
})
```

客户端**只发弹幕正文 + task_id，回一个答案**。提示词、知识库、商品上下文全部在它自己的服务端 ——
**我们看不到实现**，也不应该去猜（它那几句"基于商品会智能回复观众问题…支持多轮对话、情感分析"是**宣传文案**，
在 `index` / `ai-home` 等页面的营销区块里，不是代码证据）。

### 1.2 它的配置面 = 一个 `thisset` 对象 + 一族弹窗

```js
// pages/feedback/index-app.vue
thisset: { content: "", exttxt: "", type: "0", welcome: 1, reply: 1,
           person: "", live_id: "", nickname: "", zhu_baifenbi: 30 }

replyOptions:   ["1s/次", "5s/次", "10s/次", "20s/次", "自定义", "不回复"]
welcomeOptions: 同族；follow / clock / thumb 各有 pin_* 开关 + 弹窗
zhineng:        [{0 全自由},{1 半自由},{2 关闭},{3 助播},{4 AI+碎片化},{5 全拟人},{7 碎音频二创}]
```

开播时把整个 `thisset` POST 给 `api/v1.live/opent`，拿回 `{ task_id, sharecode }` ——
**task_id 就是后续 `getReply` 的钥匙**。

| 配置项 | 竞品字段 | 形态 |
|---|---|---|
| 回复开关 / 频次 | `pin_reply` / `reply` | 6 档单选：1s / 5s / 10s / 20s / **自定义(1~60s)** / **不回复** |
| 智能模式 | `type` | 7 档单选（全自由 / 半自由 / 关闭 / 助播 / AI+碎片化 / 全拟人 / 碎音频二创） |
| 知识来源 | `content` + `exttxt` | 话术正文 + 补充说明（自由文本） |
| 发音人 | `person` | 选择 |
| 主播占比 | `zhu_baifenbi` | 滑块（默认 30） |
| 欢迎 / 关注 / 报时 / 点赞 | `pin_welcome` 等 | 与回复**同族**的 4 个弹窗 |

## 2. 我们的现状（代码实证）

**已经有 —— 引擎层是好的：**

| 能力 | 位置 |
|---|---|
| 弹幕 → 上下文 → DeepSeek 生成 → 敏感校验 → 出口 | `server/src/services/interactionEngine.ts`（G4，298 行） |
| 上下文来源 | 绑定话术全文 `scriptContent` + 话术商品快照 `productSnapshot` |
| 节流 | 场次级 5s / 同用户 5s |
| 出口 | `onReply` → G5 TTS / 播放队列 |
| 弹幕网关 | `POST /api/lives/:id/danmaku` + 列表 + monitor |
| **氛围语模板 CRUD（服务端完整）** | `/api/atmosphere-templates` 全套 + `/defaults` |

**缺 —— 配置层几乎是零：**

| 缺口 | 证据 |
|---|---|
| **回复频次硬编码** | `DEFAULT_REPLY_INTERVAL_MS = 5000`，无任何入参可覆盖 |
| **没有回复开关** | `InteractionSkipReason` 里没有 `REPLY_DISABLED` |
| **没有补充知识** | 只能靠绑定话术；商家无法单独加一段"额外说明" |
| **没有配置界面** | App 里搜 `互动`/`智能回复` 只有 2 处注释；唯一的入口是工作台的「测试弹幕注入」按钮 |
| **氛围语 App 界面 = 0 处** | 全仓搜 `氛围语`/`atmosphere` 在 `app/lib` 下 **0 命中** —— 服务端接口齐全，客户端一个字都没有 |
| ⚠️ **AI 回复不查额度** | `InteractionEngineOptions` 无额度依赖，`InteractionSkipReason` 无 `QUOTA_EXCEEDED`。**违反 AGENTS 成本红线**（"所有第三方 AI 调用必须先查该商家剩余额度，超额直接拒绝"） |

## 3. 票表（R21~R25）

| ID | 任务 | 改动面 | 前置 | 验收口径 | 状态 |
|---|---|---|---|---|---|
| **R21** | **场次级智能回复配置（服务端）** | `server/src/db/schema.ts` 给 `lives` 加列（配置是场次级 1:1，不值得新表）：`reply_enabled boolean default true` / `reply_interval_seconds int default 5` / `reply_extra_knowledge text`；迁移；`routes/lives.ts` 增 `GET/PATCH /api/lives/:id/interaction` | 无 | 配置可读可改；`reply_interval_seconds` 限 1~60（或 null=默认）；越界 400；非本人 404 | ⬜ |
| **R22** | **引擎读配置 + 补额度红线** | `interactionEngine.ts`：`LiveInteractionContext` 带上配置；`globalIntervalMs` 由配置决定；`reply_enabled=false` → 新 skip reason `REPLY_DISABLED`；**补额度检查** → 新 skip reason `QUOTA_EXCEEDED`；`reply_extra_knowledge` 并入生成提示词 | R21 | 关掉回复后一条都不生成（单测）；把间隔改成 1s 后两条弹幕间隔 1s 即回（假时钟单测）；**额度耗尽时不再调 DeepSeek** | ⬜ |
| **R23** | **App「智能回复」配置界面** | 场次编辑页新增「智能回复」卡 + 弹窗（对标竞品 `replyOptions`）：`不回复 / 1s/次 / 5s/次 / 10s/次 / 20s/次 / 自定义(1~60s 输入)`；「补充知识」多行文本框；假后端 + widget 冒烟测试 | R21 | 手机上能改频次并保存；重进页面值仍在；选「不回复」后保存为关闭 | ⬜ |
| **R24** | **回复可见（可观测）** | 工作台监控页展示 AI 实际回了什么（复用 `/api/lives/:id/monitor` 或弹幕列表加回复字段） | R22 | 真机发一条测试弹幕，页面上能同时看到「观众说了什么」和「AI 回了什么」 | ⬜ |
| **R25** | **氛围语 App 界面（同族缺口）** | 新建氛围语模板管理页（对接已就绪的 `/api/atmosphere-templates` 全套）+ 场次级开关 | 无 | 商家能在 App 里增删改 welcome/follow/clock/thumb 模板并绑定到场次 | ⬜ |

## 4. 待拍板（开票时留的决策点）

❓ **D1 · 要不要照抄竞品的 7 档「智能模式」？**
竞品的 `全自由 / 半自由 / 助播 / AI+碎片化 / 全拟人 / 碎音频二创` 是在描述**它的 AI 自主度**，
而我们的架构是「循环台本 + 弹幕互动」，两者不是一回事。
➡️ **推荐：不照抄。** 我们只做三件事 —— **开/关**、**频次**、**补充知识**。多一个模式档位就是多一份商家理解成本。

❓ **D2 · 回复配置放场次级还是账号级？**
➡️ **推荐：场次级**（跟竞品一致：`thisset` 是每次开播带上去的）。同一商家不同场次可能卖不同货，知识也该不同。

❓ **D3 · `reply_extra_knowledge` 和绑定话术谁优先？**
➡️ **推荐：两者都进提示词，补充知识在后**（它是"更正/补充"的角色）。

❓ **D4 · 额度红线怎么落地？**
现在 AI 回复**完全不查额度**。查额度要打哪个接口？按次还是按时长扣？
➡️ **推荐：先按「剩余算力 / 时长」做**，与竞品的"算力小时"口径一致（它 `suanli` 不足 25 小时会弹充值提示）。
**这条必须你拍板** —— 它涉及计费口径，不是纯技术选择。

## 5. 不做清单

- **不逆向竞品的服务端**（我们看不到 `getReply` 的实现，也不去猜）；只对齐**配置面与交互**。
- **不做多轮对话 / 情感分析**（竞品的宣传词）：当前架构是"一问一答 + 循环台本"，多轮对话需要会话状态，
  属于架构级变更，不在本批。
