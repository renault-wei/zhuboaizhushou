# 智能回复模块 · 方案与票表

> 状态：**方案已拍板，待开工**（2026-09-17）。
> 来源 = 用户「对标反编译包，需要一个智能回复模块，可以根据弹幕来」；四个决策点已由用户当面拍板（见 §3）。
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

客户端**只发弹幕正文 + task_id，回一个答案**。提示词、知识库、商品上下文全在它自己的服务端 ——
**我们看不到实现，也不去猜**。它那几句「基于商品会智能回复观众问题…支持多轮对话、情感分析」是
**宣传文案**（在 `index` / `ai-home` 的营销区块里），不是代码证据。

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

**已经有 —— 引擎与出声链路都是好的：**

| 能力 | 位置 |
|---|---|
| 弹幕 → 上下文 → DeepSeek 生成 → 敏感校验 → 出口 | `server/src/services/interactionEngine.ts`（G4） |
| 上下文来源 | 绑定话术全文 `scriptContent` + 话术商品快照 `productSnapshot` |
| 节流 | 场次级 5s / 同用户 5s（**硬编码**） |
| 出口 | `onReply` → `liveSpeaker.speak` → 合成 wav → 出声端排队 |
| **回复与台本共用一条出声链路** | `liveSpeaker.ts`：「统一忙闲出口…**弹幕回复 / 循环口播共用一条链路**」 |
| **空档避让 / 空档插播** | `loopCaster.ts`：每句前 `while (isBusy) sleep()`；每句后 `tryInsertAtmosphere` |
| 氛围语模板 CRUD（服务端完整） | `/api/atmosphere-templates` 全套 + `/defaults` |

**缺 —— 配置层几乎是零：**

| 缺口 | 证据 |
|---|---|
| **回复频次硬编码** | `DEFAULT_REPLY_INTERVAL_MS = 5000`，无任何入参可覆盖 |
| **没有回复开关** | `InteractionSkipReason` 里没有 `REPLY_DISABLED` |
| **没有补充知识** | 只能靠绑定话术；商家无法单独加一段"额外说明" |
| **没有配置界面** | App 里搜「互动」/`智能回复` 只有 2 处注释；唯一入口是工作台的「测试弹幕注入」按钮 |
| **氛围语 App 界面 = 0 处** | `app/lib` 下搜「氛围语」/`atmosphere` **0 命中** —— 服务端接口齐全，客户端一个字都没有 |

## 3. 决策记录（2026-09-17 用户拍板）

| # | 决策 | 结论 |
|---|---|---|
| **D1** | **回复的时机** | **弹幕回复必须穿插在语音播报结束之后**（不打断正在播的台本句）。
**我们已经有这个机制**：回复与台本共用一条 FIFO 出声链路，且 `loopCaster` 每句前做空档避让 —— 理论上顺序天然是「台本句 → 回复 → 下一句台本句」。**但从未被测试锁住过**，所以 R22 的第一步是**验证并写成断言**，不是重写。 |
| **D2** | **配置层级** | **账号级**（不是场次级、不是竞品那样每次开播带上去）。同一商家所有场次共用一份回复配置。 |
| **D3** | **知识优先级** | **绑定话术优先**；补充知识在后（补充知识是"更正/补充"的角色，不覆盖绑定话术）。 |
| **D4** | **额度红线** | **本批不做**。额度/算力属于**另一张卡（算力卡的购买与发放）**，不在这批范围内。 |

### 3.1 D1 的机制说明（写给将来的自己）

```ts
// loopCaster.ts 的主循环
while (!state.cancelled && options.isBusy(liveId)) { await options.sleep(idlePollMs); }  // 空档避让
await speakSafely(options.speak, liveId, item.text, voice);                               // 播本条
await tryInsertAtmosphere(liveId, options, voice);                                        // 空档插播（氛围语）
```

而 `defaultIsBusy` = `speechLinePendingCount(liveId) > 0` —— **同一场次出声链路里只要还有没播完的东西，台本就不往下走**。
所以弹幕回复入队后，必然排在「当前正在播的那句之后、下一句之前」。

**这条推论必须在 R22 用单测钉住**（否则哪天有人把 FIFO 改成抢占式，顺序就悄悄坏了，且线上很难复现）。

## 4. 票表（R21~R25，已按决策修订）

| ID | 任务 | 改动面 | 前置 | 验收口径 | 状态 |
|---|---|---|---|---|---|
| **R21** | **账号级智能回复配置（服务端）** | 新表 `user_interaction_settings`（`user_id` 唯一）或 `users` 加列：`reply_enabled boolean default true` / `reply_interval_seconds int default 5` / `reply_extra_knowledge text`；迁移；新增 `GET/PATCH /api/me/interaction` | 无 | 配置可读可改；`reply_interval_seconds` 限 1~60；越界 400；只影响本人 | ⬜ |
| **R22** | **引擎读账号配置 + 锁住回复顺序** | `interactionEngine.ts`：配置随上下文加载；`reply_enabled=false` → 新 skip reason `REPLY_DISABLED`；`globalIntervalMs` 由配置决定；`reply_extra_knowledge` 拼进提示词（**排在绑定话术之后**）。**新增顺序单测**：台本句在播时来弹幕 → 断言出声顺序为「台本句 → 回复 → 下一句」 | R21 | ① 关掉后一条都不生成；② 改成 1s 后两条弹幕 1s 即回（假时钟）；③ **顺序断言通过**；④ 补充知识不覆盖绑定话术 | ⬜ |
| **R23** | **App「智能回复」配置界面（账号级）** | 「我的」页新增「智能回复」入口 + 配置页：开关 + 频次六档（对标竞品 `replyOptions`：`不回复 / 1s / 5s / 10s / 20s / 自定义(1~60s)`）+ 「补充知识」多行文本框；假后端 + widget 冒烟测试 | R21 | 手机上能改并保存；重进页面值仍在；选「不回复」保存为关闭 | ⬜ |
| **R24** | **回复可见（可观测）** | 工作台监控页展示 AI 实际回了什么（复用 `/api/lives/:id/monitor` 或弹幕列表加回复字段） | R22 | 真机发一条测试弹幕，页面上能同时看到「观众说了什么」与「AI 回了什么」 | ⬜ |
| **R25** | **氛围语 App 界面（同族缺口）** | 新建氛围语模板管理页（对接已就绪的 `/api/atmosphere-templates` 全套）+ 场次级开关 | 无 | 商家能在 App 里增删改 welcome/follow/clock/thumb 模板并绑定到场次 | ⬜ |

> **额度/算力红线不在本批**（D4）——它属于算力卡批次（购买与发放）。

## 5. 不做清单

- **不逆向竞品的服务端**（看不到 `getReply` 的实现，也不猜）；只对齐**配置面与交互**。
- **不照抄竞品的 7 档「智能模式」**（D1 相关）：那是描述**它的 AI 自主度**，我们的架构是「循环台本 + 弹幕互动」，不是一回事。我们只做 **开/关 + 频次 + 补充知识**。
- **不做多轮对话 / 情感分析**（竞品的宣传词）：当前是一问一答 + 循环台本；多轮对话需要会话状态，属架构级变更。
