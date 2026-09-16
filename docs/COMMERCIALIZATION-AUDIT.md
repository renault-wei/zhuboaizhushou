# 星辰语音 · 商业化对齐审计（对照竞品反编译包 xcai1618）

> 状态：只读审计落档（2026-09-11）。**不改代码、不执行任务、不调用第三方**；commit/push 待确认。
> 主轴：**商业化**（收款 / 账本 / 计费 / 卡密 / 定价 / 运营台 / 多租户 / 增长 / 成本 / 发版），
> 输出「已完成 / 部分完成 / 缺失」三段式清单与补差距任务。
> 方法与证据源：
> - 竞品：`D:\codex_project\2026-09-07\ni\outputs\docs\{page-map,api-list,analysis,domain-map}.md`、`source\beautified\app-service.js`（只读）。
> - 我方：`server/src/db/schema.ts`、`server/src/routes/*`、`server/src/services/*`、`app/lib/features/*`、`admin/src/pages/*`、
>   `docs/console-roadmap.md`、`docs/COMPETITOR-DIFF.md`、`docs/LOWCOST-AUDIO-PLAN.md`、`docs/PROGRESS.md`、git 提交记录。
> - 判读原则：以**代码/接口/表结构实证**为准，不采信文档自述；文档与代码冲突时以代码为准并标注。

---

## 1. 结论先行

- **竞品商业化模型** = 白标 OEM 分销（98 域名 / merch_id）+ 卡密分销 + 服务端收款码（无 App 内支付 SDK）
  + 「算力 / 直播时长」双账本 + **App 内运营台**（卡密/充值划转归因）。
- **我方商业化模型** = 服务端扫码直充（半自动）+ 卡密批次核销（可全离线）+ **单一口径时长分钟账本** + **公司端 web 任务台**。
- **骨架完成度约 90%**：账本、计费、卡密、开关下发、收银台、公司端后台、用量计量均已落地；
  **唯一硬件级阻塞 = 真实支付自动入账（M8）**，其余为增长 / OEM 期项。
- **真正缺口只有 4 类**：① 支付自动入账与查单轮询；② OEM / 白标多租户；③ 卡密归因与分销（转给副播 / 邀请码）；
  ④ OTA 自更新 + 增长页（教程 / 兑换入口）。
- **成本侧**：TTS 分句缓存基建已建成，但**只接线了「试听」**，直播轮播尚未预热接线 → 直播时段成本仍高
  （`LOWCOST-AUDIO-PLAN` T4 未做），这是商业化毛利的关键未闭环点。

---

## 2. 竞品商业化全貌（反编译取证）

| 子域 | 竞品证据（页面 / 接口 / 行为） |
|---|---|
| 收款 | **无 App 内支付 SDK**（无 `uni.requestPayment` / `plus.payment`）；服务端生成支付宝收款码、客户端仅展示（`analysis.md` §6）。接口：`api/v1.member/charge`、`api/v1.member/suanliRes` |
| 账本 / 计费 | 双口径：**算力 suanli + 直播时长 live_minute**（`userInfo` 头卡「算力余额 X 小时」+ `.times`「直播时长 X 小时」）。接口：`api/v1.member/tmymember`、`api/v1.member/stream` |
| 卡密 / 分销 | 运营台划转归因：`api/v1.member/cardToUser`（卡密→用户）、`chargeToUser`（充值→用户）、`chargeTobeizhu`（充值→副播）；邀请码 `api/v1.open/getinvite` + 页面 `/pages/live/exchange`「我的邀请码」 |
| 定价 / 套餐 | 价格与档位**全部服务端下发**（包内检索不到静态物品表，`analysis.md`「未写死」）；主售卖凭证 = 会员卡 / 卡密 |
| 运营后台 | **App 内「运营台」** `pages/dulin-setting/dulin-setting`（承担划转 / 归因 / 卡密发放） |
| 多租户 / 白标 | 客户端内置 **98 个运营域名** 按 `merch_id` 区分品牌（`domain-map.md`）；本包 `merch_id=1` → `www.xcai1618.com` |
| 增长 / 账号 | 个人页工具组：兑换卡密、使用教程、隐私政策、地址管理、账户安全、客服拨号、客服微信、账号注销、检查更新、版本号（`ui-v2-research.md` §2、`userInfo`） |
| 成本 | 服务端**分句合成 + 缓存复用 + 播放队列 / 空队历史回放**；App 端零 TTS 调用（`COMPETITOR-XCAI.md` §7） |
| 发版 | 启动即 `socket/httpapi/checkApp?version=&platform=&merchant=1`，命中新版本 → `plus.downloader` 下载 + `plus.runtime.install` 静默升级（`analysis.md` §3） |

---

## 3. 我方商业化已落地（代码取证）

### 3.1 数据模型（`server/src/db/schema.ts`）

| 表 | 用途 | 归属子域 |
|---|---|---|
| `orders` | 订单（含 `kind=subscription|recharge`、`channel`、`hours`、`minutes`、`paid_at`） | 收款 / 定价 |
| `hour_balance_accounts` | 时长余额账户（预充小时包，跨月不清零） | 账本 |
| `hour_balance_ledger` | 时长余额流水（含变动后余额，可对账） | 账本 |
| `quotas` | 月度免费 / 赠送额度（TTS 字符 / 话术次数 / 直播分钟） | 账本 / 成本守门 |
| `usage_logs` | AI 用量流水（计量） | 计量 |
| `card_batches` / `card_codes` | 卡密批次 / 卡密（`unused|redeemed|revoked`） | 卡密 |
| `app_config` | 服务端开关下发（`key→jsonb`：充值入口显隐 / 档位单价 / 公告 / 扣减优先级） | 定价 |
| `admin_users` / `audit_logs` | 运营账号 / 审计留痕 | 运营台 |
| `tts_audio_cache` | TTS 分句音频缓存（键 = 用户+音色+语速+文本 sha256） | 成本 |
| `voice_agreements` | 声音授权存档（合规） | 合规 |

### 3.2 服务端接口（`server/src/routes/*`）

- 商家端（`billing.ts`）：`POST /api/recharge/scan`（扫码下单，`channel=alipay_scan`）、
  `POST /api/recharge/poll`（**只读**轮询）、`POST /api/cards/redeem`（卡密核销入账，幂等）、
  `GET /api/wallet`（余额 / 免费剩余 / 流水 / 最近充值单）、`GET /api/app/config`（开关下发，免登录）。
- 管理端（`admin.ts` + `billingAdmin.ts`）：`login` / `me` / `dashboard` / `merchants` / `quotas`（+ `:userId` 调整）/
  `usage` / `orders`（+ `:id/confirm` 人工确权）/ `audit/{scripts,agreements,logs}` /
  `card-batches`（+ `:id` 明细）/ `app-config`（+ `:key` 读写）。
- 场次计费（`lives.ts`）：`POST /api/lives/:id/end` 触发按整分钟结算。

### 3.3 服务内核（`server/src/services/*`）

- `ledger.ts`：两本账（时长余额 + 月度 quota），默认扣减优先级 `balance → quota`（`app_config.quotaPriority` 可覆盖），
  四种流水来源 `recharge_order / card_redeem / live_deduct / admin_adjust`。
- `liveBilling.ts`：**直播结束时**按已播整分钟「欠费式」结算（先扣余额 → 回落免费分钟 → 缺额留运营对账）。
- `appConfig.ts`：开关与档位读取。`quotaTiers.ts`：免费档定义。`ttsCache.ts`：分句缓存。`ttsUsage.ts`：计量口径。

### 3.4 商家端 App（`app/lib/features/*`）

- `wallet/presentation/wallet_page.dart`：收银台（余额 / 预充 / 服务端开关显隐 / 扫码 / 卡密核销 / 流水）。
- **内置微信收款码兜底**：`app/assets/pay/wechat_collect_qr.jpg` —— 服务端下发 `mock://` 占位时，App 展示该真实收款码
  （**钱可真实到账**，但到账确认靠运营人工确权）。
- `profile/presentation/profile_page.dart`：隐私政策 / 官方客服（微信待配置占位）/ 关于（版本号）。

### 3.5 公司端控制台（`admin/src/pages/*`）

`DashboardPage` / `MerchantPage` / `UsagePage` / `OrderPage`（人工确权）/ `CardBatchesPage`（批次生成 / 导出 / 明细）/
`AppConfigPage`（开关）/ `AuditPage`（拦截话术 / 授权存档 / 审计日志）。

### 3.6 提交流水（本审计时点）

最新提交 `846cf4b`（分支 `feature/atmosphere-and-loopCaster`）；商业化相关批次历史：
`0f7b0e3`（M5 服务端账本）、`d65f0c9`（M6 后台页）、`b2afc5d→6262259→c051828`（M7 商家端收银台）；
进度主档 `docs/PROGRESS.md` §6 第 63 条。

---

## 4. 严谨差异矩阵

图例：✅ 已完成且可用 / 🟡 部分完成（有骨架、差最后一段）/ ❌ 缺失 / 🚫 主动裁剪（定位或合规）。

### 4.1 收款与入账

| 能力 | 竞品 | 我方 | 判定 |
|---|---|---|---|
| 服务端收款码展示 | 支付宝收款码，客户端只展示 | 扫码下单返回 `mock://`，App 用内置**微信**收款码兜底（可真实到账） | ✅ |
| 自动入账（支付回调 / 查单轮询） | 服务端轮询对账自动入账 | `poll` **只读**，入账靠运营后台人工确权 | ❌（M8 阻塞） |
| 真实支付凭证接入 | 有（运营主体商户号） | 无（`额度未就绪前不真调`，合规红线） | ❌（外部依赖） |
| 卡密核销入账（离线） | 有 | 有（批次 / 卡密 / 幂等核销） | ✅ |

### 4.2 账本与计费

| 能力 | 竞品 | 我方 | 判定 |
|---|---|---|---|
| 时长账本（跨月不清零） | 直播时长 live_minute | `hour_balance_accounts` + 流水 | ✅ |
| 免费 / 赠送额度 | 算力 suanli | `quotas`（月度，含免费直播分钟） | ✅ |
| 按分钟结算 | 服务端 | **结束时**按已播整分钟欠费式结算 | ✅ |
| 直播中 402 引导续费闸门 | 有 | **未接线**（仅在结束时结算，中途不停播） | 🟡 |
| 用量计量 | 有 | `usage_logs`（TTS 字符 / 生成次数） | ✅ |
| 扣减优先级可配 | 服务端 | `app_config.quotaPriority` | ✅ |
| 双账本口径（算力 + 时长并行） | 是 | 单一口径（时长分钟）+ 用量流水 | 🟡（设计差异，非缺陷） |

### 4.3 卡密与分销

| 能力 | 竞品 | 我方 | 判定 |
|---|---|---|---|
| 卡密批次生成 / 导出 / 核销 | 有（服务端） | 有（后台批次页 + 商家端核销） | ✅ |
| 卡密 **归因到人**（`cardToUser`） | 有 | 无（核销只入本账号余额） | ❌ |
| **转给副播账户**（`chargeTobeizhu`） | 有 | 无 | ❌ |
| 邀请码 / 分销（`getinvite`） | 有（`/pages/live/exchange`「我的邀请码」） | 无 | ❌ |

### 4.4 定价与套餐

| 能力 | 竞品 | 我方 | 判定 |
|---|---|---|---|
| 档位 / 单价服务端下发 | 是 | 是（`app_config.pricePacks`，改配置不改版） | ✅ |
| 充值入口显隐 / 公告下发 | 是 | 是（`showCharge` / `notice`） | ✅ |
| 会员卡 / 套餐 | 有（`tmymember`，主售卖凭证） | **主动替换**为时长档位（`docs/console-roadmap.md` §1.5），订阅保留为 legacy | 🚫（战略选择） |
| 货盘 / 商品池 | 有（`pages/pallet/pallet`） | 🟡（有券 `coupons`，无商品库） | 🟡 |

### 4.5 运营后台

| 能力 | 竞品 | 我方 | 判定 |
|---|---|---|---|
| 商家台账 / 额度调整 / 用量 / 订单 | 部分（App 内） | 公司端 web：看板 / 商家 / 额度 / 用量 / 订单 | ✅ |
| 人工确权补单 | — | `POST /api/admin/orders/:id/confirm` | ✅ |
| 审计留痕 | 弱 | `audit_logs`（写操作全覆盖） | ✅（反超） |
| 内容审核队列（拦截话术 / 授权存档） | 弱 / 无 | `AuditPage` 三 Tab | ✅（反超） |
| 形态 | **App 内运营台** | **独立公司端 web 控制台** | 🚫（架构差异，非缺失） |

### 4.6 多租户 / 白标 / OEM

| 能力 | 竞品 | 我方 | 判定 |
|---|---|---|---|
| 白标多域名 / 品牌隔离 | 98 域名 + `merch_id` | 无（单租户） | ❌ |
| 租户维度数据模型 | 有 | 仅 `app_config` / `orders.kind` **预留** `merchant` 维度，未落地 | 🟡 |

### 4.7 增长与账号

| 能力 | 竞品 | 我方 | 判定 |
|---|---|---|---|
| 使用教程 / 兑换入口 | 有 | 无教程页（核销入口在收银台内） | ❌ |
| 客服（拨号 / 微信） | 有 | 客服页（微信待配置占位） | 🟡 |
| 账号注销（自助） | 有 | 无自助（引导联系客服） | 🟡 |
| 隐私政策 / 关于 / 版本号 | 有 | 有 | ✅ |
| 地址管理 / 账户安全 | 有 | 无 | 🚫（与业务无关） |

### 4.8 成本（毛利关键）

| 能力 | 竞品 | 我方 | 判定 |
|---|---|---|---|
| 服务端 TTS 合成 | 是 | 是（火山 TTS） | ✅ |
| **分句缓存复用** | 是（全链路） | 基建 `tts_audio_cache` + `ttsCache.ts` **已建成** | ✅ |
| 缓存接线范围 | 全链路（含轮播） | **仅「试听」**（`routes/voices.ts` 预览命中缓存）；**直播轮播未接线** | 🟡 |
| 播放队列 / 空队历史回放 | 是 | 队列 + 按场次隔离（本批修复）；历史回放无 | 🟡 |
| 每小时成本锚点 ≤ 0.4 元 | 达成 | **未达成**（轮播未预热接线） | ❌ |

### 4.9 发版

| 能力 | 竞品 | 我方 | 判定 |
|---|---|---|---|
| OTA 自更新（探针 → 下载 → 静默装） | 有（`checkApp` + `plus.runtime.install`） | 无（每次手动出包 + adb / 手动重装） | ❌ |

---

## 5. 补差距任务清单（商业化优先）

### P0 · 直接决定商业化闭环

| 任务 | 解决 | 前置 / 阻塞 | 建议做法 | 验收口径 |
|---|---|---|---|---|
| **M8 支付自动入账** | 现金真实入账、去人工 | 运营主体支付宝 / 微信商户凭证（**外部**） | 凭证就绪后替换 `mock://` 通道；`poll` 升级为服务端查单 | 扫码支付 → 服务端自动置 `paid` + 入账流水，E2E |
| **TTS 轮播缓存接线（LOWCOST T4）** | 把每小时成本压到 ≤0.4 元锚点 | 无（纯服务端） | `loopCaster` / `liveSpeaker` 合成前走 `findCachedTtsAudio`，首轮预热落缓存 | 1 小时轮播新合成字符 ≤2000；二轮起命中率 >95% |
| **直播中 402 闸门** | 欠费停播，防跑量亏损 | 依赖已完成的账本 | 循环播报每轮前置余额校验，余额+免费尽 → 工作台提示续费并暂停 | 余额耗尽自动暂停 + 引导续费 |
| **OTA 自更新（轻量版）** | 发版不靠人工重装 | 下载源可复用云 ECS | 版本探针接口 + App 启动提示 + 跳转下载 | 新版本提示可复现 |

### P1 · 商业化增强（谈单 / 运营效率）

| 任务 | 解决 | 建议做法 | 验收口径 |
|---|---|---|---|
| 货盘 / 商品池最小版 | 商品运营、绑定场次 | 商品 CRUD + 绑场次（复用 `coupons` 形态） | 列表 + 绑定生效 |
| 卡密归因到人 / 转副播账户 | 代理 / 子账号分发 | `card_codes` 加 `assignee` 维度 + 归因流水 | 核销归因正确 |
| 使用教程 / 兑换入口 | 降低上手门槛 | App 增长页（教程 + 卡密兑换独立入口） | 页面可用 |

### P2 · OEM / 增长期（等收款与租户模型）

| 任务 | 解决 | 前置 |
|---|---|---|
| 白标 / OEM 多租户 | 谈单溢价 | M8 收款 + `merchant` 数据模型落地 |
| 邀请码 / 分销 | 增长 | 收款 + 租户模型 |
| 账号注销自助 | 合规完整体验 | 低（可独立做） |

### 维持不做（🚫 勿再提）

App 内支付 SDK、视频推流引擎、悬浮窗与权限引导、抖音 wss 弹幕直连、地址管理 —— 定位裁剪或合规红线。

---

## 6. 结论与建议

1. **商业化骨架已可自用闭环**：卡密核销 + 时长账本 + 按分钟结算 + 收银台 + 公司端后台，**全部离线可验收**，
   不依赖任何真实支付凭证。这是当前最大的确定性资产。
2. **唯一硬阻塞 = 支付自动入账（M8）**，且是**外部依赖**（运营主体凭证）。凭证到位前，商业化只能停在「人工确权」。
3. **最该先做的代码项 = TTS 轮播缓存接线**：不含外部依赖、纯服务端、直接决定毛利（0.4 元/小时锚点）。
4. **第二优先 = 直播中 402 闸门**：防止欠费跑量（收入侧风险控制），依赖已完成的账本，成本低。
5. **OEM / 白标 / 分销 / 邀请码属 P2**：必须等 M8 收款与 `merchant` 数据模型，否则前置返工。
6. 与既有文档联动：本审计的 P0 与 `docs/LOWCOST-AUDIO-PLAN.md`（T3~T7）、`docs/console-roadmap.md`（M8）一致；
   `docs/COMPETITOR-DIFF.md` 保留全量差异，本档只收敛**商业化**视角。

