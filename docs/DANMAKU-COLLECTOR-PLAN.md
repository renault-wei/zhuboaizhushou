# 多平台弹幕采集器内嵌方案与任务清单（D 系列 · 2026-09-16 重启）

> 状态：**已重启（2026-09-16）**。重启理由 = 当初关闭的硬阻塞已消除：用户提供了 `apikey-dy-*` 格式的
> SignWss Web API Key，探针实测返回 `Code:0` 与带签名的 wss 地址。
> （`docs/COMPETITOR-XCAI.md` §6.4 当时的结论正是「需另购 SignWss 可用的 Web API Key，到手后重跑 `sign:smoke`」。）
>
> **交付边界 = 自用自测**（自有直播间 / 低流量 / 观众身份）。对外产品分发是另一个决策
> （AIOBS 合伙人档以上授权 + 平台风控连带），**不在本批次**。
>
> 重启批次票表见 **§11**；执行中把状态回写到该表。
>
> ---
>
> 以下 **2026-09-08 结项时的原文保留不改写**（历史记录）：
>
> 状态：**已结项 / 关闭**。拍板记录 = 2026-09-08 用户：「弹幕抓取需求先关闭，其余收尾 / 结项」。
> 历史轨迹：v0.2 审核通过（2026-09-08）→ v0.3 按 D0.1 审计收口（引入合规拍板门 D2.5）→
> D1 + D2.1/D2.2 + D2.3 + D5.2 离线可自测代码与 AIOBS 签名调查全部归档（提交 `797cae9`，douyin 适配器单测 35 例全绿）。
> 不再推进：D3~D6（落库状态 / 本地演示 / 真实弹幕 AI 联动 / 真机复测）——真实平台采集依赖第三方签名服务
> 或桌面客户端通道，成本与合规风险高（AIOBS Key 实证见 docs/COMPETITOR-XCAI.md §6），与当前
> 「自用、纯 AI、能砍就砍」的范围不符。
> 对外口径回归（与 docs/PLATFORM-NEUTRAL-VOICE.md 一致）：弹幕源 = **测试弹幕注入优先 + 外挂 / 人工补位**，
> 不自研平台采集；`server/src/collectors/*` 离线交付物保留为技术储备，未来重开可复用。
> 本文档保留为历史方案与任务记录，**不作为对外功能蓝本**。
> 关联：`docs/DANMAKU-CAPTURE-PLAN.md`（选型史与红线）、`docs/PLATFORM-NEUTRAL-VOICE.md`（平台无关定位）、
> `docs/DEV-SPRINTS.md`（G3 弹幕网关 / G4 互动引擎）、`docs/PROGRESS.md`（进度看板）。

## 1. 目标（一句话）

> 商家把自己直播间链接 / 分享文本贴进 App → 自动识别平台 → 解析直播间 → 内置采集器以观众身份
> 监听（仅自己直播间、低流量）→ 本地落库与状态展示 → 复用既有 G3/G4 网关与 AI 链路 → 语音回复出声。
> 平台通过「可插拔采集适配器」横向扩展，核心链路（AI / 话术 / 音色 / 出声）完全不感知平台差异。

## 2. 目标架构与代码落点

三段主链路不变，变化只在「采集端」：由外部弹幕助手换成 server 进程内自研采集模块。

```text
直播间分享文本 / 链接
  → LinkResolver（URL 抽取 + 短链展开 + 平台路由）
  → PlatformAdapter.resolve（解析出 platform / roomRef / 连接身份）
  → CollectorWorker（每直播间一条连接：wss / 轮询 + 心跳 + 断线重连）
  → 归一化 UnifiedEvent（chat / gift / like / enter / end，带 msg_key 幂等键）
  → 去重落库（live_danmaku 扩展字段 + 唯一索引）
  → onDanmaku 广播（复用 services/danmaku.ts 既有订阅总线）
  → G4 互动引擎 → DeepSeek → 火山 TTS → 出声队列（既有链路，不动）
```

- 新增代码收敛在 `server/src/collectors/*`（resolver / adapters / manager / types），
  复用既有 `DanmakuGateway.ingest`（services/danmaku.ts）与 `onDanmaku`，不 HTTP 自回环。
- 全部在 server 进程内实现，不引入 SQLite / 独立采集进程 / Docker / 微服务 → 守 AGENTS MVP 红线。
- 存储沿用 PostgreSQL：`live_danmaku` 扩 `platform / room_ref / msg_key / msg_type`，
  加 `(platform, msg_key)` 唯一索引做幂等去重；新增 `collector_watches` 记录监听状态（或复核后并入 lives）。
- 既有 ingest 的「归属 + live 状态校验」不变：采集通道先解析出 userId / liveId 再走同一入口，业务零改动。
- 测试纪律：第三方网络一律 mock / fixture，测试不得真连平台（AGENTS：不花真实调用钱）。

## 3. 开源候选与收录策略（先审后收，商用安全第一）

### 3.1 收录判定规则

| 条件 | 判定 |
|---|---|
| 许可证宽松且允许商用与再分发（MIT / Apache-2.0 等） | 可收录：落 repo 第三方清单 + LICENSE 副本 + 来源标注 |
| 无 LICENSE / AGPL / 自定义禁商条款 | 不拷贝：只读机制，干净房自研（参考协议与字段思路） |
| 明示「仅供学习 / 不得商用」 | 排除商用收录，仅作调研记录 |
| 语言 / 形态不适配（Go 二进制 / Java / C#） | 默认参考为主；收录仅当可进程内调用且不违 MVP 红线 |

### 3.2 候选清单快照（D0.1 复核完成 2026-09-08，逐仓结论见 docs/COLLECTOR-OPENSOURCE-AUDIT.md）

| 候选 | 平台 | 语言 / 形态 | 机制 | License 快照 | 收录建议（初判） |
|---|---|---|---|---|---|
| UniBarrage（BarryWangQwQ） | 抖音/B站/快手/斗鱼/虎牙 | Go 二进制 + REST/WS | 房间号+cookie → 统一弹幕格式转发 | SPDX NOASSERTION，需看 LICENSE 原文 | 统一格式与多平台思路可参考；二进制侧车形态暂不接入 |
| dycast（skmcj） | 抖音 | TypeScript | 房间号 → 弹幕 → WS 转发自建后端 | 无 LICENSE | 不拷贝，机制参考（与本案思路高度一致） |
| DouyinLiveJava（lulajax） | 抖音 | Java SDK | 页面解析 + wss + protobuf | MIT | 可收录参考（跨语言，转译思路为主） |
| DouyinCap（SlimeNull） | 抖音 | C# | 弹幕抓取库 | 无 LICENSE | 参考机制即可 |
| dy_danmaku_java（tiangalon） | 抖音 | Java | 页面 roomId → wss protobuf | 待复核（API 403 未取到） | 参考 |
| live-room-watcher（scx567888） | 多平台 | TypeScript | 页面抓弹幕 / 礼物 / 流地址 | 明示仅供学习不得商用 | 排除商用收录 |
| bilibili-API-collect（SocialSisterYi） | B站 | 文档 | 公共接口与 wss 协议说明 | MIT（2026-01-28 遭 B站警告函后永久关停） | 不引用：平台法务风险（§3.3） |
| B站 wss TS 客户端库（Blivechat 等） | B站 | TypeScript | getDanmuInfo + wss 二进制 | 本期不再扩展审计（涉 B站私有协议） | 暂不收录，D2.5 门后再议 |

> 注：D0.1 已逐仓复核完成（2026-09-08）；本表为快照，行内最终结论以 §3.3 与审计文档为准。
> 任何「收录」动作以复核后的 LICENSE 原文为准，禁止仅凭 README 声明入库。

### 3.3 D0.1 审计关键发现（2026-09-08，详见 docs/COLLECTOR-OPENSOURCE-AUDIT.md）

- `bilibili-API-collect`（B 站弹幕协议文档仓库）2026-01-28 因收到 B 站委托律所律师函而**永久关停**，
  指控内容为「系统性整理平台非公开接口 / 参数 / 安全机制并公开传播」。→ 本项目不得再以该仓库为协议参考来源，
  也不把「B 站私有协议适配」列入本期无风险范围。
- UniBarrage 为「GPL-3.0（非商业）+ 商业需单独授权」双许可 → 不收录，仅读机制思路。
- `live-room-watcher` 仓库根 LICENSE 为 MIT 文本，但 README 明示「仅供学习使用，不得用于商业用途」→ 保守按禁商用处理。
- `DouyinLiveJava`（MIT）：Java 形态，本期只做转译思路参考，不直接收录进 TS 代码库。
- dycast / DouyinCap / dy_danmaku_java：均无 LICENSE → 一律不拷贝。
- **收录落地结论（D0.2）**：本期无可直接收录对象，`vendor/third_party/` 保持空置；
  真实平台协议适配器是否自研，升级为需你拍板的合规门（D2.5）。


## 4. 平台支持分档（审核拍板点 Q1）

### P0 · 一期先行（链路成熟、机制可验证）
- 抖音：分享口令 / 短链 `v.douyin.com/xxx` → live 页身份 → room 信息；网页 wss + protobuf，机制半公开，风险中档。
- B站：`b23.tv/xxx` 或 `live.bilibili.com/{roomId}` → 公共接口归一 room_id；wss 二进制协议文档最全，风险低档。

### P1 · 二期候选
- 快手：分享短链 `v.kuaishou.com/xxx`；弹幕流需登录态且成熟开源少，先做 spike 再决定。

### P2 · 暂不支持并写入产品口径
- 视频号、淘宝点淘、小红书等：无第三方可用的网页弹幕流，或需官方资质 / 客户端协议。

| 平台 | 分享链接形态示例 | 解析要点 | 采集机制 | 复杂度 | 风险档 | 一期 |
|---|---|---|---|---|---|---|
| 抖音 | v.douyin.com/xxx（分享口令内嵌） | 短链展开 → live 页身份 → room 信息 | 网页 wss + protobuf | 高 | 中 | ✅ |
| B站 | b23.tv/xxx 或 live.bilibili.com/{id} | 公共接口归一 room_id | wss 二进制（公开文档） | 低 | 低 | ✅ |
| 快手 | v.kuaishou.com/xxx | 需登录态与页面解析 | 待 spike | 高 | 高 | ⏳ |
| 视频号 | channels.weixin.qq.com/... | 需本人微信态 | 无第三方弹幕流 | - | 高 | ❌ |
| 点淘 / 小红书等 | - | - | 同上 | - | 高 | ❌ |

> **§4 注（v0.3 修订）**：上表「采集机制」列的 wss + protobuf / 二进制为**拍板后才开发**的能力（D2.5），
> 本批 D1/D2 交付以纯函数链接解析 + 可插拔采集核心 + 内置模拟弹幕源（fixture）为主，可 100% 离线自测；
> 不因审计发现退回「外挂适配」口径，而是把「是否解锁真实平台协议适配器」作为独立的合规决策项处理。
> D2.2 验收以「内置模拟弹幕源」（fixture 事件 + 计时器驱动）替代真实 wss 覆盖，核心逻辑 100% 可离线测试。

## 5. 完整任务清单（审核通过后开发）

> 顺序执行；每批独立提交且守 ≤500 行；服务端测试 / `flutter analyze` / `npm run build+lint` 全绿才算完成。
> 批次划分 = **D0 收录与合规口径 → D1 链接解析 → D2 采集器核心 → D3 落库与状态 → D4 本地演示 → D5 AI 联动 → D6 收口**。
> 开源策略落点 = 能收则收：D0 审计通过且许可证允许才进 `vendor/third_party/`；其余只做机制参考、干净房自研（§3.1）。
> **结项注（2026-09-08）**：本清单为历史任务记录，实际执行至 D2.3（离线自测形态）+ D5.2 后整体结项；
> D3 起不再排期，真实平台采集不列入后续功能范围（结项口径见文件头）。

| 编号 | 批次 | 任务 | 依赖 | 验收 |
|---|---|---|---|---|
| D0.1 | 收录与口径 | 逐仓许可证审计 → 产出 `docs/COLLECTOR-OPENSOURCE-AUDIT.md` | 无 | 审计文档已落盘（含逐仓复核日期 / 判定 / 后续用途）；结论 = 本期无可收录 |
| D0.2 | 收录与口径 | 收录落地：仅对审计判定「可收录」的实现（首选 MIT / TS）进 `vendor/third_party/`，附 LICENSE 副本 + 来源 commit + 改动说明 | D0.1 | 本期判定无可收录 → vendor/third_party/ 留空即完成；无许可 / 禁商用代码未混入 |
| D0.3 | 收录与口径 | 合规口径修订稿：采集 = 观众身份连网页公开 wss，仅自己直播间；同步 DANMAKU-CAPTURE-PLAN / PLATFORM-NEUTRAL-VOICE / PROGRESS 口径 | D0.1 评审 | 文档一致，无「外挂适配 / 不自研采集」残留表述 |
| D1.1 | 链接解析 | 分享文本 → URL 抽取 + 短链展开 + 平台路由 registry（LinkResolver） | 无 | fixture 单测覆盖抖音 / B站分享形态；非法输入友好报错 |
| D1.2 | 链接解析 | 抖音 resolve：短链展开 → live 页身份 → room 信息（网络 mock） | D1.1 | 返回 platform / roomRef / 连接所需信息，或明确失败原因 |
| D1.3 | 链接解析 | B站 resolve：短链 / 房间 URL → 公共接口归一 room_id | D1.1 | 含未开播 / 房间不存在等错误分支用例 |
| D1.4 | 链接解析 | 快手分享链解析 spike（拍板后；不作为一期承诺） | D1.1 | spike 结论入档，决定 P1 是否保留 |
| D2.1 | 采集器核心 | 统一事件模型与归一化（chat / gift / like / enter / end，msg_key 幂等键） | D1.2/D1.3 | TS 类型 + 单测 |
| D2.2 | 采集器核心 | CollectorManager：注册 / 注销、每房一 worker、心跳 / 断线重连、并发上限、优雅退出 | D2.1 | mock wss 服务覆盖重连与并发上限 |
| D2.3 | 采集器核心 | 【D2.5 解锁后】抖音 adapter：网页取 wss 地址与 cookie 维护 + protobuf 解码（自研 TS；mock fixture 报文） | D2.5/D2.2 | mock 报文解出 chat / gift；解码失败不崩、记日志 |
| D2.4 | 采集器核心 | 【D2.5 解锁后】B站 adapter：getRoomBaseInfo / getDanmuInfo + wss 二进制 + 心跳 + 压缩解码 | D2.5/D2.2 | mock 报文解出 chat 事件 |
| D2.5 | 合规门 | 真实平台协议适配器解锁拍板：B 站协议文档仓库遭律师函关停 + 开源候选普遍无许可，是否自研 wss/protobuf 适配器需用户拍板并经法律复核 | D0.1 | 拍板记录入档：解锁 → 依序开 D2.3/D2.4；否决 → 本期仅保留模拟源与官方通道预留。2026-09-08 已解锁：用户拍板 + AIOBS 官方试用 Key 探针入档（见 docs/COMPETITOR-XCAI.md §6.4），D2.3 抖音 adapter 离线形态开发完成 |
| D3.1 | 落库与状态 | `live_danmaku` 扩字段 + `(platform, msg_key)` 唯一索引 + `collector_watches` 表 + Drizzle 迁移 | D2.1 | 迁移可执行；重复 msg_key 幂等拒绝 |
| D3.2 | 落库与状态 | 监听控制 API：resolve / start / stop / status（登录态 + 归属校验） | D3.1 | 集成测试覆盖状态机（stopped → listening → stopped） |
| D4.1 | 本地演示 | 本机联调台：贴链接 → 解析预览 → 开始 / 停止 → 实时弹幕（复用工作台弹幕日志 / 胶囊）→ 回放时间线 | D3.2 | 本机开播一次全流程联调通过 |
| D4.2 | 本地演示 | 边界用例：自己账号弹幕不回（防自嗨）、频控、停播自动停止 | D3.2 | 边界用例脚本通过 |
| D5.1 | AI 联动 | collector 事件 → ingest / onDanmaku → G4 引擎 → TTS → 出声端（只接线不改链路） | D3.2 | 注入 mock 弹幕 → 出声队列收到回复 wav |
| D5.2 | AI 联动 | 真机复测：抖音 / B站自己直播间贴链接 → 朋友发弹幕 → 直播间听到 AI 回复（低流量自测） | D5.1 | 复测记录 2+ 条弹幕闭环 |
| D6.1 | 收口 | 服务端全量测试 + flutter analyze / admin build+lint 全绿 | D1~D5 | 测试报告通过 |
| D6.2 | 收口 | 文档同步（G3 状态、DANMAKU-CAPTURE-PLAN、PLATFORM-NEUTRAL-VOICE、PROGRESS、DEV-SPRINTS 增 D 线） | D6.1 | 文档口径无矛盾 |
| D6.3 | 收口 | 演示与拍板记录归档（commit 清单 + 结论） | D6.2 | 留档完成 |


## 6. 数据与 API 草案（评审用，开发时定稿）

统一事件模型（采集器输出，先归一化再落库）：

```ts
interface UnifiedDanmakuEvent {
  platform: "douyin" | "bilibili"; // 后续扩展
  roomRef: string;               // 直播间稳定身份（room id / web_rid）
  liveId: string | null;         // 归属场次（resolve 后绑定）
  msgKey: string;                // 幂等键 = platform + 平台消息 id
  type: "chat" | "gift" | "like" | "enter" | "end";
  content?: string;
  senderNickname?: string;
  happenedAt: string;            // ISO8601，平台事件时间
  raw?: unknown;                 // 原报文（调错用，不入索引）
}
```

- 表变更：`live_danmaku` 增列 `platform / room_ref / msg_key / msg_type`，加唯一索引 `(platform, msg_key)`；
  新增 `collector_watches`（id / liveId / platform / roomRef / status / startedAt / stoppedAt / lastError / 时间戳）。
  迁移走既有 Drizzle / SQL 迁移目录，不改表结构（AGENTS 第 5 条）。
- API 草案：`POST /api/collectors/resolve`（传分享文本，返回平台与房间预览）、
  `POST /api/collectors/start` / `stop`（绑定 liveId，登录态 + 归属校验）、`GET /api/collectors/status`（监听状态）。
  实时弹幕展示复用既有弹幕日志 / 工作台胶囊与 `onDanmaku` 广播，不加第二套推送。

## 7. 合规口径修订稿（待审核拍板）

允许（修订后）：
- 以普通观众身份连接平台网页端公开 wss / 公共接口，仅监听自己或已授权直播间的弹幕；
- 参考公开协议说明与开源实现思路，自研适配器（先过 D0 许可审计）；
- 低流量自测；平台规则或风控变化时随时停用。

禁止（红线不变，延续 DANMAKU-CAPTURE-PLAN）：
- 不做抓包与私有 App 协议逆向；不模拟发包；不做多账号 / 批量 / 刷量采集；
- 不做绕过限流与风控的任何手段；AI 智能直播角标恒开不关闭；
- 不把「采集他人直播间弹幕」做成对外能力或销售承诺；
- 不直接携带第三方闭源 / 无许可 / 禁商用代码进产品。

原「不用非官方 SDK / 框架模拟协议」一句修订为：不直接依赖第三方闭源或未授权实现；
公开网页协议可由自研适配器实现，参考开源须先过 D0 审计。平台官方通道（开放平台 / 企业资质 Webhook）仍留上架增强阶段。

## 8. 审核拍板清单（请逐项确认）

| # | 问题 | 推荐默认 |
|---|---|---|
| Q1 | 一期平台范围 | 抖音 + B站先做；快手只做 spike，不作为一期承诺 |
| Q2 | 运行形态 | server 进程内采集模块（守 MVP 红线，不引独立进程 / Docker） |
| Q3 | 存储 | 沿用 PostgreSQL，扩展 live_danmaku + 新增 collector_watches |
| Q4 | §7 合规口径修订稿 | 接受（观众身份公开 wss + 仅自己直播间 + 先审计后收录） |
| Q5 | 采集入口 | 与既有「测试弹幕注入」并存；抖音绑定页是否一并下线另立任务（不在 D 系列） |
| Q6 | 执行节奏 | D0 审计先行 → D1/D2 采集验证 → 评审后再开 D3~D6 |
| Q7 | 开源收录范围 | 预计可直接收录的很少（多数无 LICENSE / Go / Java / C# 形态）；以自研为主，可收录项只进 vendor/third_party/ 并先过 D0.1 审计 |
| Q8 | D2.5 合规门 | 真实平台协议适配器默认不开发；如拍板解锁，须用户明确同意 + 法律复核后再动（D2.3/D2.4）；若解锁抖音 wss，签名环节的服务商采购属保留项（竞品用 AIOBS，成本调查见 docs/COMPETITOR-XCAI.md §6）；2026-09-08 用户已拍板解锁并给出 AIOBS 官方试用 Key，但探针返回 `ApiKey is invalid`（GUID 非 SignWss 可用 Key，见 §6.4），签名链路等有效 Web API Key 或改走桌面客户端试用 + helperAdapter 路线（2026-09-08 复核：AIOBS 公开文档 + 卡密实证坐实其为桌面端激活码，可走官方客户端 + localhost:6789 控制接口，见 docs/COMPETITOR-XCAI.md §6.5） |

> 结项总注：Q1~Q8 为 2026-09-08 审核时的逐项结论记录；当日随后用户拍板「弹幕抓取需求先关闭」，
> D 系列整体结项（提交 `797cae9`），Q6「评审后再开 D3~D6」不再排期，Q8 的签名 / 客户端两条备选路线冻结留档。

## 9. 不做清单（边界不变 + 新增）

- 不做多平台推流、不替商家开播（红线不变）。
- 不做抓包、私有协议逆向、模拟发包、多账号批量采集（红线不变）。
- 不收录无许可 / 禁商用代码；任何收录先过 D0 审计（新增）。
- 本期不接平台官方企业通道（方向保留到上架增强阶段）。
- 不把视频号 / 点淘 / 小红书等受限平台包装成「已支持」。
- 不引入 SQLite / 独立采集进程 / 消息队列 / Docker（守 AGENTS MVP 红线）。

## 10. 风险与缓解

| 风险 | 缓解 |
|---|---|
| 平台改版 / 风控导致协议失效 | adapter 小批量独立维护；fail-stop 只停该直播间，不影响出声链路；可一键停用 |
| wss / protobuf 协议资料时效 | D0 审计保留参考仓库 commit hash 与日期；自研层避免贴死单一版本 |
| 测试依赖真实网络 | 全部 mock / fixture；真机复测仅在自用直播间低流量执行 |
| 报文异常 / 内容超长 | 归一化层兜底，沿用既有 CONTENT_INVALID 等错误模型，不冒 500 |

## 11. 重启批次票表（2026-09-16 · 自用自测口径）

> 编号**沿用** §5 既有 D 编号，**不新起一套**——本仓库已有六套并行编号（G / T / M / 阶段 A-D / D 系列 / LOWCOST-T），
> 再加一套只会让"说 D 的时候指哪个"更难分辨（见 `CONTEXT.md` 任务编号节）。
> 每批独立提交、守 ≤500 行；服务端 typecheck / lint / 全量测试全绿才算完成。

### 11.1 既有票的现状盘点（2026-09-16 实测）

| 编号 | 任务 | 状态 | 证据 / 缺口 |
|---|---|---|---|
| D0.1 | 开源逐仓许可审计 | ✅ | `docs/COLLECTOR-OPENSOURCE-AUDIT.md` |
| D0.2 | 收录落地 | ✅ | 本期无可收录对象，`vendor/third_party/` 留空 |
| D0.3 | 合规口径修订 | ✅ | 已由 **R0** 重做：`AGENTS.md` 范围行 + 本文件头部 + `docs/adr/0003-danmaku-collector-reopened.md` |
| D1.1 | LinkResolver | ✅ | `server/src/collectors/linkResolver.ts` |
| D1.2 | 抖音 resolve | ✅ | 短链展开器已接（`collectors/shortLinkExpander.ts`：302 跟随 / Location 兜底 / 正文捞 `web_rid`），注入 `linkResolver` 后可直接解 `v.douyin.com` 分享文本 |
| D1.3 | B站 resolve | ⬜ | 非一期（自用自测只走抖音） |
| D1.4 | 快手 spike | ⬜ | P1，不做 |
| D2.1 | 统一事件模型 | ✅ | `collectors/types.ts` / `events.ts` |
| D2.2 | CollectorManager | ✅ | `collectors/collectorManager.ts`：注册 / 每房一 worker / 心跳 / 有界重连 / 并发上限 / 优雅退出 |
| D2.3 | 抖音 adapter（含签名器） | ✅ | `collectors/douyinLiveAdapter.ts`；`createDouyinHttpSigner` 与 SignWss 文档**逐字段同构** |
| D2.4 | B站 adapter | ⬜ | 非一期 |
| D2.5 | 合规门解锁 | ✅ | 2026-09-08 已解锁；2026-09-16 Key 实测 `Code:0` |
| D3.1 | **落库与幂等** | ✅ | **R1**（`8968f22`）：`live_danmaku` 增 `platform/room_ref/msg_key/msg_type` + `(platform,msg_key)` 唯一索引 + `drizzle/20260916_v11_danmaku_collector.sql`；重放不二次广播 |
| D3.2 | **采集控制 API** | ✅ | **R2**（`d0850c6`）：`services/liveCollector.ts` + `routes/danmakuSource.ts`（起 / 停 / 查）——collectors 库**终于有了生产调用点** |
| D4.1 | 本地演示联调台 | ⬜ | App 无绑定直播间入口 |
| D4.2 | 边界用例 | 🟡 | R4 已覆盖「停播自动停」「采集失败不阻断开播」；**防自嗨未做** —— 报文里其实有发送者稳定 id（`douyinWire.ts` 的 `DouyinUserLite.id`），但 `UnifiedDanmakuEvent` 未透出，需先补字段再比对自身账号 |
| D5.1 | **事件接线到既有网关** | ✅ | **R2/R3**：`liveCollector.handleEvent` → `eventToIngestInput` → `danmakuGateway.ingest`；端到端用例已验证「替身采集事件 → 真落库 → 引擎真回复」。`interactionEngine` 确认无需改动 |
| D5.2 | 真机复测 | ⛔ | 需真实房间 ID + 正在开播 |
| D6.1 | 全量测试 | ✅ | **38 文件 / 399 用例：398 passed / 1 skipped / 0 failed**（前置 = `server/.env`；1 skip 为 ffmpeg smoke）；`tsc --noEmit` 与 `eslint` 均 0 |
| D6.2 | 文档同步 | ⬜ | |
| D6.3 | 归档 | ⬜ | |

### 11.2 重启批次（按序执行）

| ID | 任务 | 改动面 | 前置阻塞 | 验收口径 | 状态 |
|---|---|---|---|---|---|
| **R0** | 改范围与口径（= D0.3 重做） | `AGENTS.md`、本文件头部与 §5 结项注、`docs/DANMAKU-CAPTURE-PLAN.md`、`docs/PLATFORM-NEUTRAL-VOICE.md`、`docs/PROGRESS.md`、新增 `docs/adr/0003-*.md` | 无 | 全文口径一致，无"不自研平台采集"残留表述；ADR 写明"当初为什么关、现在为什么开" | ✅ `0c75589` |
| **R1** | 落库与幂等（= D3.1） | `server/src/db/schema.ts`（`liveDanmaku` 增 4 列 + `uniqueIndex('live_danmaku_platform_msg_key_unique')`）、新增 `server/drizzle/*_v11_danmaku_collector.sql`、`server/src/services/danmaku.ts`（写入新列 + 幂等冲突处理） | 无 | 迁移本机可执行（幂等，二次执行全 NOTICE 不报错）；重复 msgKey 幂等不炸且**不二次广播**；既有注入路径行为不变 | ✅ `8968f22` |
| **R2** | 采集控制 API（= D3.2 · 核心） | 新增 `server/src/services/liveCollector.ts`（单例 Manager + 适配器注册 + `liveId→userId` 映射 + start/stop/status）、新增 `server/src/routes/danmakuSource.ts`（`POST/DELETE/GET /api/lives/:id/danmaku-source`）、`server/src/config/env.ts`（新增 `douyinSign` 段）、`server/src/app.ts` 注册、`server/src/index.ts` 关停 `dispose()` | R1 | 替身 adapter 单测（全离线）：绑定 / 解绑 / 状态查询 / 非本人 404 / 已结束 409 / 未配 Key 时 503 且优雅降级。**口径修订**：草稿 / 就绪态允许只登记（201 + `running:false`），由 `/start` 联动拉起 | ✅ `d0850c6` |
| **R3** | 事件接线（= D5.1） | `server/src/services/liveCollector.ts` 的 `onEvent` → `danmakuGateway.ingest(userId, liveId, {content, senderNickname})` | R2 | 端到端：替身采集事件 → 真落 `live_danmaku`（含幂等键）→ `interactionEngine` 真回复。`onReply` 到达即出声链路入口，语音落 wav 由 R5 真连验证 | ✅ `d0850c6` + `8a752ff` |
| **R4** | 开播联动与边界（= D4.1 / D4.2） | `server/src/services/liveSession.ts`、`server/src/routes/lives.ts`（`/start` 自动起、`/end` 自动停）；边界：自己账号弹幕不回、停播自动停 | R3 | `/start` 调 `resume` 拉起、`/end` 调 `suspend` 停止；**采集抛错时开播仍 200**（已验证）；防自嗨见 D4.2 遗留 | ✅ `8a752ff` |
| **R5** | 真连验收（= D5.2 · 自用自测） | 无代码；取证归档 | R4 ＋ **真实房间 ID / 正在开播** | `sign:smoke` → 真连 wss → 收一条真 chat 落库 → AI 回复出声；留 wav + 日志 + DB 行取证 | ⛔ |
| **R6** | 收口（= D6.2 / D6.3） | 全量测试、文档同步、`CONTEXT.md` 术语补充、归档 | R5 | 服务端全绿；文档无矛盾 | 🟡 本批收口中 |

### 11.3 设计要点与已知坑

- **`userId` 不在采集事件里。** `UnifiedDanmakuEvent` 只带 `liveId`（`types.ts` 注释明说"接线层把 watch 绑到 lives 后回填"），
  而 `danmakuGateway.ingest(userId, liveId, …)` 需要 `userId` → **接线层必须在 start 时记下 `liveId → userId`**。
- **`watchKeyOf` 不含 liveId**（键 = `source:platform:roomRef`）。同一房间被两个账号监听会撞键；开播互斥（`LIVE_IN_PROGRESS`）
  挡住了同账号并发，但跨账号同房需在 R2 明确取舍。
- **`collector_watches` 表建议不建。** §6 草案里有它，但 `collectorManager.status()` 已提供内存态；
  自用自测口径下应先砍（AGENTS：能砍就砍）。R1 只做 `live_danmaku` 扩列。
- **R2 大概率超过 500 行上限**（service + routes + env + 装配四块），需按 AGENTS 第 8 条拆成 R2a（service + env）/ R2b（routes + 装配）。
- **云端迁移**：R1 的迁移在本机执行后，云端 ECS `113.44.226.189` 也要执行（沿用既有部署流程）。

## 12. 云端部署与真机出声批次（2026-09-16 · R7~R11）

> 起因：真机联调（USB 装包 + adb 驱动）暴露两个问题 ——
> ① **采集卡状态不轮询**：绑定成功后卡片一直停在「连接中…」，必须退出重进才更新（真机实测踩到）；
> ② **AI 语音从电脑发出而不是手机**：本地 `.env` 是 `LIVE_SPEAKER_OUTPUT=pc` + `LIVE_TTS_PROVIDER=local`，
> 即「在本机用 Windows SAPI 合成并就地播放」，根本不会进手机轮询的那个远程队列。
> **云端生产口径本来就是 `phone` + `volc`**，所以「上云」与「修出声」是同一张票的两面。

| ID | 任务 | 改动面 | 前置阻塞 | 验收口径 | 状态 |
|---|---|---|---|---|---|
| **R7** | 采集卡状态纳入轮询 | `app/lib/features/lives/presentation/live_monitor_page.dart`：`_monitorTimer` 回调里一并调 `_loadDanmakuSource()` | 无 | 绑定后**无需退出重进**，卡片自行从「连接中…」变为「监听中 · 已收到 N 条」 | ✅ 已完成 |
| **R8** | 服务端上云（代码 + 迁移 + 凭据） | 云端执行 `server/drizzle/20260916_v11_danmaku_collector.sql`；`git archive HEAD server` 整包对齐 `/opt/starvoice/`；云端 `.env` 补 `DOUYIN_SIGN_ENDPOINT_URL` / `API_KEY` / `USER_UNIQUE_ID`；`npm run build` → `systemctl restart starvoice.service` | SSH 免密（**已通**） | 公网 `/health` 200；云端 `npm run sign:smoke -- <房间号>` 返回签名 wss；云端采集真连收到弹幕 | ✅ 已完成（`/health` 200、v11 迁移 6→10 列、签名 285ms、真连 `connected`） |
| **R9** | 手机出声口径归位 | 云端 `.env` 已是 `LIVE_SPEAKER_OUTPUT=phone` + `LIVE_TTS_PROVIDER=volc`；**本地**若要手机出声也须改这两项并配真实 `VOLC_TTS_API_KEY`（当前是占位值） | R8 | AI 回复经火山合成 → 入远程队列 → 手机助播机轮询播放；**声音从手机出、不从电脑出** | 🟡 云端口径已就位（`volc` + `phone`），待云版 APK 真机复验 |
| **R10** | 防自嗨 | 给 `UnifiedDanmakuEvent` 补 `senderId`（`douyinWire.ts` 的 `DouyinUserLite.id` 已解出），再与自身账号比对 | 无 | 自己账号发的弹幕不触发回复 | ⬜ |
| **R11** | 云版 APK 与真机复验 | `flutter build apk --dart-define=API_BASE_URL=http://113.44.226.189:3000` + `adb install -r` | R8 | 手机连云端跑通「开播 → 贴链接采集 → 真弹幕 → AI 回复 → **手机出声**」 | ⬜ |

### 12.1 真机联调方法论（本次首次跑通，值得沿用）

`adb screencap` 截图 → **我读图判断** → `adb shell input tap/text` 操作 → 再截图 + **服务端日志交叉核对**。

两个坑：
1. **Flutter 默认不向 `uiautomator` 暴露控件** —— `uiautomator dump` 只有 6 个空容器节点，所以必须**看图点坐标**，不能靠语义树。
2. **`keyevent 4` 在键盘已收起时会弹掉整个页面**（本次把工作台整个弹回首页）。别把它当收键盘用。

> 这套方法证明：「我不能操控手机」是个错误判断。真正做不到的只有一件 —— 我无法成为用户抖音直播间里的观众去发那条弹幕。

## 13. 采集保活与架构解耦批次（2026-09-16 · R13~R17）

> 来源：对照反编译竞品（`source/beautified/app-service.js`）后的架构讨论；用户拍板「按推荐来」，并点名「**保活是我们需要的**」。
> 更正一处我自己的误判：我原以为竞品的保活只是「手机端省电保活」，我们跑服务端就白赚了 —— **错**。
> 竞品 `onclose` 是 **10s 无限重连** + `startCSystemTimer(30, …)` **30s 看门狗**；而我们的 `collectorManager`
> `openAttempts` **累计计数且连接成功后不复位**，超过 3 次即 `finalize(error)` —— **长会话中途断 3 次就永久停摆**。

| ID | 任务 | 改动面 | 前置阻塞 | 验收口径 | 状态 |
|---|---|---|---|---|---|
| **R13** | **采集保活**（用户点名） | ① `collectors/collectorManager.ts`：`openAttempts` 由「累计」改为「**连续失败**」，连接**稳定 ≥30s 后清零**（`stableAfterMs` 可配）；② `services/liveCollector.ts`：加 **30s 看门狗**，绑定存在但会话不在 connected/starting 时自动 `resume()`（对齐竞品 `startCSystemTimer(30)`） | 无 | 长会话第 N 次断线仍能重连（单测）；一直连不上仍会被有界终止；`error` 态会话会被看门狗拉起 | ✅ 已完成（`danmaku_source.test.ts` 4 例：稳定可无限重连 / 不稳定仍被有界终止 / error 后被拉起 / 挂起的不被拉起） |
| **R14** | `UserUniqueId` 固定为自身身份 | `liveCollector.resolveRoom` 不再使用分享者的 `share_user_id`；`.env` 填固定值（`config/env.ts` 的 `douyinSign.userUniqueId` 已是配置项） | 无 | 换任意分享链接，签名用的 `UserUniqueId` **恒定不变**（对齐竞品写死一个数字的语义：那是「客户端是谁」，与链接无关） | ✅ 已完成（`.env` 固定为自身身份 + `config/env.ts` 写明语义；**真连验证**：新身份下 `status: connected`） |
| **R15** | 补 `WebcastSocialMessage`（关注）解码 | `collectors/douyinWire.ts` 增加 social 解码 + `types.ts` 的 `DanmakuMessageType` 加 `follow` + 适配器 `toEvent` 分支 | 无 | 关注事件能进统一事件；**我们已有的 `follow` 氛围语终于有数据源**（当前空转） | ✅ 已完成（`decodeDouyinSocial` 接入适配器；`follow` 进 `KNOWN_MESSAGE_TYPES`；新增 2 例测试。**注意**：`follow` → 氛围语的接线仍是后续项） |
| **R16** | **监听源与场次解耦**（D1 · 大票） | 拆出独立「监听源」资源：可只监听、不落库、不绑直播；落库时才决定归属。涉及 `services/liveCollector.ts`、`routes/danmakuSource.ts`、App 工作台采集卡 | R13 | **不依赖开播也能贴链接监听并看弹幕流水**（用户本次的实际诉求）；开播路径行为不变 | ⬜ |
| **R17** | 绑定表脱离内存（D4 · 债） | `liveCollector` 的 `bindings` 由进程内 Map 改为可持久；或启动时按「已开播场次」自动恢复 | R16 | 服务重启后正在直播的场次采集能自动恢复 | ⬜ |

### 13.1 本轮不做（讨论已定，明确记账）

- **D5 `helperAdapter`（外挂弹幕助手转发）先不接线**：需要一台电脑，与「无电脑商家」冲突；价值在**合规姿态更干净**（读弹幕的是第三方工具、我们不持签名 Key）——留作对外商业化时的备选出口，不是替代。
- **不做客户端采集**：竞品把 `ApiKey` **硬编码在客户端**，解包即得（我们正是这样拿到它那把 Key 的）。服务端持 Key 是正确做法，不因分散算力而放弃。

### 13.2 从反编译学到的三条（已并入上面票）

1. **`UserUniqueId` 是「客户端身份」，与分享链接无关** —— 竞品写死一个数字；我们借用分享者的 `share_user_id` 是语义错误（→ R14）。
2. **它解了 `WebcastSocialMessage`** —— 我们有 `follow` 氛围语却没有数据源（→ R15）。
3. **保活必须做** —— 无限重连 + 看门狗（→ R13）。

### 12.2 对照实验：唯一能把「没人说话」与「订阅坏了」分开的手段

2026-09-16 深夜实测：用户自己直播间连续监听 15 分钟，**181 帧全部只是心跳 ack、零内容事件**，
一度像是订阅故障。换一个**真实公共直播间**（【黄豆豆豆豆豆】`7686079594273327906`）后：

| 观测 | 用户直播间 | 公共直播间 |
|---|---|---|
| 原始帧（同长度窗口） | 181 | 243 |
| 解出消息 | **11**（全是第 1 帧的房间快照） | **397** |
| `WebcastChatMessage` | **0** | **12** |
| `WebcastMemberMessage` | **0** | **209** |
| `WebcastLikeMessage` | **0** | **37** |
| ack 回齐率 | 1/1 | **213/213** |

**结论：链路完全正常，用户房间只是真的没有别的观众。** 佐证 = 该房间当时收到过
`WebcastLowPcuGuideMessage`（抖音自己的低人气引导），平台自身即判定其人气极低。

> **纪律**：当「连接正常、ack 正常、只有心跳」时，**先做对照实验，再动代码**。
> 本次若不设对照，极可能去改本就没坏的 ack 帧格式或 `identity` 参数。


