# 多平台弹幕采集器内嵌方案与任务清单（D 系列 · v0.3 执行中）

> 状态：**v0.2 已审核（2026-09-08 用户拍板）→ 开发执行中**；v0.3 = D0.1 审计收口后修订：
> 「B 站协议文档仓库遭警告函永久关停 + 多数开源候选无许可 / 禁商用」入档（docs/COLLECTOR-OPENSOURCE-AUDIT.md，结论 = 本期无可收录，vendor 留空）；
> 真实平台协议适配器（D2.3/D2.4）增加合规拍板门（D2.5），
> 本批先做可完整自测的链接解析 + 采集核心 + 内置模拟弹幕源（D1 + D2.1/D2.2），详见 §3.3 / §4 注。
> 本文件是下一步开发的任务事实源，单批改动仍守 AGENTS ≤500 行约定。
> 关联：`docs/DANMAKU-CAPTURE-PLAN.md`（选型史与红线）、`docs/PLATFORM-NEUTRAL-VOICE.md`（平台无关定位）、
> `docs/DEV-SPRINTS.md`（G3 弹幕网关 / G4 互动引擎）、`docs/PROGRESS.md`（进度看板）。
> 口径修订：本方案把弹幕源从「外挂弹幕助手 / 人工中转 / 不自研采集」升级为「自研内嵌多平台采集器」，
> 并取消对抖音的绑定依赖，仅凭「直播间链接 / 分享文本」识别平台与房间；修订待审核后同步到上述文档。

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
| D2.5 | 合规门 | 真实平台协议适配器解锁拍板：B 站协议文档仓库遭律师函关停 + 开源候选普遍无许可，是否自研 wss/protobuf 适配器需用户拍板并经法律复核 | D0.1 | 拍板记录入档：解锁 → 依序开 D2.3/D2.4；否决 → 本期仅保留模拟源与官方通道预留 |
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
| Q8 | D2.5 合规门 | 真实平台协议适配器默认不开发；如拍板解锁，须用户明确同意 + 法律复核后再动（D2.3/D2.4） |

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

