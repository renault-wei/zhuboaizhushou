# P-循环台本 & P-播出 里程碑方案（v1.1，用户拍板后定稿基线）

> 状态：口径已按用户拍板（2026-09-07）修订，待登记后开始代码（M1+M2）。
> 目标里程碑：让「画面真人出镜 + 后台 AI 语音主播」从**只回弹幕**升级为**主动循环口播产品/团购券**，并与弹幕回复共用一条出声链路串行播出（空档插入、不打断）。
> 事实源：`docs/PROGRESS.md` §0/§2（G4/G5/G6）、`docs/DEV-SPRINTS.md`；涉及既有模块见第 2 节。

## 0. 用户拍板口径（2026-09-07，以下逐条作为实现约束）

| # | 问题 | 拍板口径 |
|---|---|---|
| Q1 | 台本归属 | **台本可通用（可复用台本库）**；客户需要新台本时，可随时新建/更新。开播配置引用台本，库内台本可被多个场次复用。 |
| Q2 | 空台本 | 正常流程**不会出现空台本**（开播前应绑定台本）。不做「空台本自动兜底」。若客户要快速测试，可用**随机/任选一条 ready 话术**生成临时循环声源；正式场景一律用提供的台本。 |
| Q3 | 条数与字数 | 默认生成 6 条；每条 15–80 字；上限 12 条 / 单条 200 字。 |
| Q4 | 节奏 | 条间间隔默认 **2s**（可配 0–60）；**每轮休息 6s**（可配 0–300）。<br>2026-09-11 修订：原 6s / 20s 使一轮内静默占比近 60%，听感像念稿、且长静默有平台「挂机/低质」判定风险；示例台本与存量数据（5~8s）一并压到 2s，见 `drizzle/20260911_v10_loop_gap_tighten.sql`。 |
| Q5 | 弹幕与循环 | 弹幕回复只在**空档期**插入，**不打断**循环句；若因循环句较长导致回复被顺延、等待时间过长，**频控从回复实际插入出声的时间点重新起算**。 |
| Q6 | 直播中改台本 | **支持热更新**（2026-09-11 修订）：工作台「更新话术」入口或 `POST /api/lives/:id/loop-script` 换绑，引擎**每轮开头重读**台本，于**下一轮**生效、不打断当前句；清空/解绑则本场停止循环只回弹幕。 |
| Q7 | 循环暂停/继续 | 本轮不做；循环停止入口 = 结束直播（真人接管/插话闪避沿用暂缓口径）。 |

> 剩余一处解读备注（若有出入请指出）：Q2 的「随机话术」按「从未绑定台本的场次里，任选该客户一条 ready 话术整段切句循环」实现为**临时测试声源**（不进台本库、随场次结束丢弃）；正式台本绑定后一律用台本。

---

## 1. 背景与目标

### 1.1 现状
- 直播形态已定：**真人出镜 + 后台 AI 语音主播**；App 是配置/控制端，出声端可下沉手机（远程队列，P1 已通）。
- AI 语音目前**只对弹幕做反应**（G4 引擎 `onReply` → `liveSpeaker`），没有弹幕时直播间静音，与「AI 主播循环介绍商品/券」的核心卖点不符。
- 话术（`scripts`）是单条整段生成稿，无法做「多段有节奏的循环口播」。

### 1.2 目标（MVP）
1. **循环台本 = 可复用台本库**：每个商家有自己的台本列表（标题 + 有序短台词），可在多场直播间复用；新台本可随时新建/生成/编辑。
2. 台本可由 **DeepSeek 按行业模板 + 商品快照/话术 + 可选团购券文案一键生成**（一次过审链路沿用 P-话术v1）。
3. 开播配置**绑定一条台本**；开播后**循环播报引擎**按台本节奏自动口播；弹幕回复在空档插入、不打断；结束直播即停止循环。

### 1.3 非目标（本轮不做）
- 真人插话闪避、一键静音/真人接管、循环暂停/继续按钮（沿用「暂缓」口径）。
- 直播中台本热更新（改台本 = 结束本场 → 重开生效）。
- 弹幕回复打断循环句 / 打断式调度。
- 托管无人直播 / RTMP 推流（G2 仍阻塞）。

---

## 2. 现状盘点（可复用资产）

| 模块 | 作用 | 复用点 |
|---|---|---|
| `scripts` / `script.ts` / `routes/scripts.ts` | 话术生成（DeepSeek + 敏感词 + P-话术v1 自动改写/兜底） | 台本生成的提示词与一次过审链路照搬 |
| `sensitive.ts` | `scanSensitive` + `SENSITIVE_GUARD_PROMPT` | 台本每条保存/生成前逐条扫描 |
| `lives` / `live.ts` / `liveSession.ts` | 开播配置与状态机 | `start/end` 是循环播报的启停锚点 |
| `liveSpeaker.ts` | TTS → 出声端统一出口（全局串行队列） | 循环与弹幕回复共用出口，天然串行 |
| `interactionEngine.ts` | 弹幕 → 决策 → DeepSeek → `onReply` | 回复出口同链路；频控计时以实际插入时点更新（Q5） |
| `voicePlayer.ts` / `remoteSpeechQueue` | 播放队列 / 远程队列 | 空档判定的依据（`pendingCount`） |
| `live_form_page.dart` / `live_monitor_page.dart` | 开播配置 / 工作台 | 台本绑定入口 + 循环状态展示 |

---

## 3. 数据模型（定稿）

### 3.1 台本库（两张新表）

```ts
// 循环台本（库）：归属商家、可复用、标题必填
export const loopScripts = pgTable('loop_scripts', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  title: varchar('title', { length: 100 }).notNull(),
  // 生成来源话术（可选）：保留溯源，删除话术不影响台本（快照在 items）
  sourceScriptId: uuid('source_script_id').references(() => scripts.id, { onDelete: 'set null' }),
  ...timestamps(),
}, (table) => [index('loop_scripts_user_id_idx').on(table.userId)]);

// 台本条目录：有序短台词，随台本级联删除
export const loopScriptItems = pgTable('loop_script_items', {
  id: uuid('id').defaultRandom().primaryKey(),
  loopScriptId: uuid('loop_script_id')
    .notNull()
    .references(() => loopScripts.id, { onDelete: 'cascade' }),
  seq: integer('seq').notNull(),          // 1 起递增
  kind: varchar('kind', { length: 20 }),  // opening/product/coupon/warmup/closing/custom（宽松存储，未知=null）
  text: text('text').notNull(),           // 入库前逐条过拦截扫描
  gapAfterSeconds: integer('gap_after_seconds'), // null = 用全局默认 2s（2026-09-11 由 6s 收紧）
  ...timestamps(),
}, (table) => [
  uniqueIndex('loop_script_items_script_seq_unique').on(table.loopScriptId, table.seq),
  index('loop_script_items_loop_script_idx').on(table.loopScriptId),
]);

// lives 增加一列（drizzle schema 追加 + 本地 db:push / 迁移补丁）
loopScriptId: uuid('loop_script_id').references(() => loopScripts.id, { onDelete: 'set null' }),
```

### 3.2 数据口径
- **台本是库、场次是引用**：`lives.loopScriptId` 指向台本。循环播报引擎**每轮开头重读**当前绑定的台本（首轮用开播快照），直播中改绑/改库于**下一轮**生效、不打断当前句；读失败沿用上一轮快照（Q6 修订 2026-09-11）。
- **快照在 items，不随 sourceScript 漂移**：从话术生成台本后，话术再改不影响已生成台本。
- 表结构变更遵守既有口径：本地 `npm run db:push`；需要迁移文件时补 `db:generate` + `db:migrate`。
- 条数/单条校验：`1–12` 条、单条 trim 后 `1–200` 字；`gapAfterSeconds` 为 `null` 或 `0–60` 整数。
- 每条写入/生成前逐条 `scanSensitive`，命中 → 400 `SENSITIVE_BLOCKED` + `matchedWords`（编辑保存拦截口径与 scripts 一致）。

---

## 4. 里程碑划分

| 里程碑 | 内容 | 依赖 | 验收 |
|---|---|---|---|
| M1 台本库数据与接口 | 建表 + 台本 CRUD + 归属/状态/合规校验 + 单测 | — | 服务端台本域测试全绿 |
| M2 台本 AI 生成 | 按来源话术/行业模板/商品快照/券文案生成 N 条 + 自动改写 | M1 | 生成可一次过审或自动改写后保存 |
| M3 App 台本库 + 开播配置绑定 UI | 台本列表页（新建/生成/编辑/删除）+ 开播表单绑台本 | M1+M2 | analyze 0 issue、widget 测试过 |
| M4 播出引擎 loopCaster | 按台本节奏循环推播 + 空档插入 + 启停幂等 + 注入式单测 | M1 | 引擎单测全绿（不出真实声） |
| M5 接线与工作台状态 | start/end 接引擎 + 工作台循环状态展示 | M3+M4 | 路由接线测试 + App 状态胶囊 |
| M6 出声验收 | 本机直播伴侣（免硬件）/ 手机线（硬件到位后）实况 | M5 | 开播循环口播 + 弹幕空档插入 + 结束即停 |

> 代码批次建议：批 A = M1+M2（服务端台本域）；批 B = M3（App 台本库 + 绑定）；批 C = M4+M5（引擎 + 接线 + 工作台）；M6 单独验收。每批完成只汇报一句。

---

## 5. M1 · 台本库数据与接口

### 5.1 归属与状态规则
- 台本归属当前用户；他人/不存在 → 404。
- 删除台本：先解除引用（把 `lives.loopScriptId` 引用它的行置 null），再删除台本与条目。**正在 live 的场次引用台本时**：删除 → 该场次下一轮重读为空 → 停止循环只回弹幕（已播出的句子不受影响）。
- 编辑台本（标题/条目整体替换）任何状态都允许（不依赖场次状态）；**已 live 的场次于下一轮开头重读生效**，无需结束重开。

### 5.2 API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/loop-scripts` | 我的台本列表（含条数摘要），updatedAt 倒序 |
| GET | `/api/loop-scripts/:id` | 台本详情（含 items，seq 升序） |
| POST | `/api/loop-scripts` | 新建台本：`{ title, items: [{ kind?, text, gapAfterSeconds? }] }`；全部过扫描后事务落库 |
| PUT | `/api/loop-scripts/:id` | 整体替换标题与 items（seq=下标+1）；已 live 的引用场次**下一轮开头重读生效**（Q6 修订 2026-09-11） |
| DELETE | `/api/loop-scripts/:id` | 解引用后删除台本与条目 |
| POST | `/api/loop-scripts/generate` | M2：生成不落库，返回草稿 `{ items }` 供「预览后保存」 |

场次绑定（扩展现有 lives API）：
- `PATCH /api/lives/:id` 入参新增 `loopScriptId`（可空，归属校验同 voiceId/scriptId 口径）；`GET /api/lives` 详情/列表返回带 `loopScriptId`，绑定展示信息由 App 端在台本列表内匹配。

### 5.3 M1 测试清单（服务端）
- 归属隔离：他人/不存在 → 404；删除解除引用。
- 新建/替换：seq 正确、间隔存取、事务原子性（坏数据不残留）。
- 拦截：任一条含极限词 → 400 + matchedWords，且不落库。
- 校验：0 条/13 条/空文本/超 200 字/间隔越界 → 400。
- lives 绑定：`loopScriptId` 归属校验、解绑（null）、非法 id → 400/404。

---

## 6. M2 · 台本 AI 生成（DeepSeek）

### 6.1 生成输入（服务端拼装）
- 请求体：`{ sourceScriptId: string; couponText?: string; itemCount?: number }`。
- `sourceScriptId` 必填：必须是当前用户的 `ready+pass` 话术（否则 422 `SCRIPT_REQUIRED`）；其 `industry / productSnapshot / content` 作为提示词语料。
- `couponText` 可选：客户端从已选团购券展示文案带入（如「招牌双人套餐券 ¥99」），有才允许生成 coupon 段。
- `itemCount` 1–12，缺省 6。
- 测试用临时声源（Q2）：台本库「从话术快速生成」同一入口即可覆盖；「随机话术测试」不在本里程碑做专门路由，工作台仅提示未绑定台本（见 §7.3 备注）。

### 6.2 提示词与输出
- 复用 `scriptTemplates[industry].systemPrompt` + `SENSITIVE_GUARD_PROMPT` + 循环口播结构化要求（输出 JSON 数组：`{ kind, text, gapAfterSeconds? }`；kind ∈ opening/product/coupon/warmup/closing；15–80 字/条；可独立听懂；不解释、只输出 JSON）。

### 6.3 一次过审链路（沿用 P-话术v1）
1. 初稿逐条扫描，全过 → 返回草稿。
2. 命中 → 整组改写（回传命中词），最多 2 次。
3. 仍不过 → `GENERATION_FAILED`（文案提示减少绝对化用词），**不落库**。
- 成功返回 200 `{ items, generationNote? }`；客户端预览后 `POST /api/loop-scripts` 落库保存。

### 6.4 M2 测试清单
- 合法 JSON 全过；命中改写 ≤2 次通过 + generationNote；改写仍失败 → 502 不写库；非法 JSON/空数组/超限 → 错误口径；未绑/blocked 话术 → 422。

---

## 7. M3 · App 台本库 + 开播配置绑定 UI

### 7.1 台本库页（新入口，与「话术库」同层）
- 列表：我的台本（标题/条数/更新时间）+「新建台本」。
- 新建流程（两步）：① 选来源 = 我的 ready 话术之一 → ② 一键生成（可带券文案）→ 进入编辑列表预览；或直接「新建空台本」手填。
- 编辑列表：每条文本多行输入 + 间隔秒（0–60，空=默认6）+ 上移/下移/删除 + 添加一句；底部「保存」/「放弃」。
- 行内操作：编辑/删除/复制为草稿；删除需二次确认（提示会被引用场次解绑、进行中场次不受影响）。

### 7.2 开播配置绑定（live_form_page）
- 「绑定话术」区下方新增「**循环台词**」区块：
  - 未绑台本 → 副文案「循环口播需绑定一条循环台本」+ 按钮「去新建/去生成」（跳台本库）；允许不绑继续保存（仅弹幕模式，正常流程建议绑定）。
  - 已绑 → 显示台本名 + 条数摘要 + 可换绑/解绑。
- 绑定写入 `PATCH /api/lives/:id { loopScriptId }`；编辑模式预填。

### 7.3 涉及文件（App）
- `core/models/loop_script.dart`（台本 + 条目模型）；`api_client.dart` 增 6 个方法；
- 新增 `features/loop_scripts/`（列表页 + 编辑页 + controller）；
- `features/lives/` 表单绑定区块；`router/app_router.dart` 加路由；
- `test/fake_backend.dart` 补台本与绑定路由镜像；
- 测试：模型解析、controller、台本列表/新建/编辑 widget、live 表单绑定交互、禁用/越权文案；回归 95/95 基线。

---

## 8. M4 · 播出引擎（loopCaster）

### 8.1 模块与依赖注入（`server/src/services/loopCaster.ts`）

```ts
interface LoopCasterOptions {
  speak(text: string): Promise<{ spoken: boolean }>;   // 默认 liveSpeaker.speak
  loadItems(liveId: string): Promise<Item[] | null>;   // 默认：读 lives.loopScriptId → 台本 items（含“无台本=null”）
  sleep(ms: number): Promise<void>;
  itemGapSeconds: number;   // 默认 6
  loopRestSeconds: number;  // 默认 20
  idlePollMs: number;       // 默认 500（空档避让轮询）
}
interface LoopCaster {
  start(liveId: string): void;  // 幂等：重复 start 忽略
  stop(liveId: string): void;   // 幂等：未在跑忽略
  isRunning(liveId: string): boolean;
  status(liveId): { running: boolean; round: number; currentSeq: number } | null;
}
```

### 8.2 Runner 算法（每场次一条，全局 Map）
```
start(liveId):
  if running(liveId): return            // 幂等
  items = await loadItems(liveId)       // 首轮读快照；此后每轮开头重读（Q6 修订：改绑下一轮生效）
  if items 为 null 或空:
    工作台状态置「未绑定循环台本」；本场只回弹幕（Q2：正常流程不出现；测试声源另议）
    return                              // 不启动 Runner
  loop:
    if round > 0:                         // Q6 修订：轮间休息后重读台本
      await sleep(loopRestSeconds)        // Q4：每轮休息 20s
      reloaded = await loadItems(liveId)  // 改绑下一轮生效；读失败沿用上一轮快照
      if reloaded 为空: break             // 运行中解绑/清空 → 停止循环只回弹幕
      items = reloaded
    round += 1
    for i, item of items:
      if cancelled: break
      // 空档插入：出声链路忙（本地 pending>0）→ 小步等；空闲才推循环句
      while !cancelled && 出声链路忙: await sleep(idlePollMs)
      await speak(item.text)            // 本地端播完 resolve；远程端入队即返回
      if cancelled: break
      await sleep(item.gapAfterSeconds ?? itemGapSeconds)
```

### 8.3 与弹幕回复的协调（Q5 落地）
- 循环与回复共用 `liveSpeaker` 全局出口：本地端 `speak` 播完才 resolve → 天然串行；远程端入队即返回、由手机队列串行消费。
- 弹幕回复（G4 `onReply`）**只在出声链路空闲时插入**；链路忙时自然排在循环句之后，**不打断**。
- 因循环句较长导致回复被顺延时：G4 的场次/用户频控时间戳以**回复实际推入出声链路**的时点更新（重新起算，防两连回复紧贴）；等待过长的回复不丢弃（观众问题不丢）。
- 空档判定的服务端实现：本地端依赖 speak 串行语义即可；远程端以队列 `pendingCount()` 作为忙闲信号，Runner 忙时小步轮询。
- speak 异常/未出声：记日志、继续下一句、节奏照走，不让循环卡死。
- 结束直播 = 唯一停止入口；stop 后清 Map、可再次 start。

### 8.4 M4 测试清单
- 顺序调用、gap/rest 节奏（注入假时钟断言 sleep 参数）、空台本不启动、幂等 start/stop、stop 后不再 speak、空档避让轮询、全程注入假 speak/sleep（**测试不出真实声音**）。
- **热更台本（M4 修订）**：运行中改绑台本 → 下一轮起用新台本；运行中解绑/清空 → 停止循环只回弹幕；重读抛错 → 沿用上一轮快照不中断。

---

## 9. M5 · start/end 接线 + 工作台状态

### 9.1 服务端
- `routes/lives.ts`：`POST .../start` 成功返回后 `loopCaster.start(live.id)`；`POST .../end` 先 `loopCaster.stop(live.id)` 再/或并行结束。
- `POST /api/lives/:id/loop-script`（M4 修订）：直播中热更循环台本。非 live → 409 `LIVE_NOT_LIVE`；台本非本人 → 400 `LOOP_SCRIPT_NOT_OWNED`；空参数 → 400 `LOOP_SCRIPT_REQUIRED`；成功后幂等补 `loopCaster.start(live.id)`。**仅改 `loopScriptId`，不触碰 `scriptId`（话术仍由开播配置绑定）。**
- 接线测试用 `vi.mock` 隔离 loopCaster/liveSpeaker，避免真实出声。
- 已知限制登记：进程重启后 live 状态为 live 但 Runner 不自动恢复（内存态，单商家一期接受）。

### 9.2 监控与工作台
- `getLiveMonitor` 增加：`loopRunning / loopRound / loopCurrentSeq`（来源 `loopCaster.status`）；未绑台本时额外返回 `loopMissing: true`。
- App 工作台状态卡：循环播报中 → 「循环播报中 · 第 x 条 / 第 y 轮」；未绑台本 → 「未绑定循环台本（仅弹幕回复）」提示；结束后消失。

### 9.3 M5 测试
- 服务端：monitor 三态（运行/未运行/未绑台本）；路由接线（mock 隔离）。
- App：fake_backend monitor 补字段；工作台胶囊/提示渲染；回归 95/95。

---

## 10. M6 · 出声验收口径
- 开播 → 听到 AI 按台本顺序循环介绍（间隔符合配置）→ 注入测试弹幕 → 回复在空档自然插入、不重叠 → 结束直播声音即停。
- 执行通道：电脑线（直播伴侣 + 虚拟声卡，本机自测免硬件）为主；手机线（手机开播 + 内录盒/转接线）按 `docs/PHONE-LIVE-PLAN.md` 硬件到位后执行。
- 产品形态不变：画面真人出镜 + 后台 AI 语音主播；循环口播全部走语音后台出声端。

---

## 11. 合规（红线）
1. 台本每条入库前必过 `scanSensitive`；生成 = 提示词防 → 自动改写（≤2）→ 失败不入库。
2. AI 台本沿用「AI 智能直播角标恒开」设定，台词不得自称真人。
3. 商品/券口径只来自 sourceScript 的 productSnapshot 与用户可见 couponText，不编造价格库存。
4. 无任何跳过扫描的开关/旁路。

---

## 12. 不做清单
台本库多商家共享/权限、弹幕打断循环、真人插话闪避、循环暂停/继续、Runner 崩溃恢复、随机话术测试专用路由（Q2 测试用「从 ready 话术生成」覆盖）。

---

## 13. 开发顺序（一步步，每步完汇报一句）
1. 服务端批 A：M1 台本库 CRUD + M2 生成链路 → 服务端全量测试全绿。
2. App 批 B：M3 台本库页 + 开播绑定 → analyze 0 issue + widget 测试全绿。
3. 服务端批 C：M4 loopCaster + M5 接线与 monitor → 服务端全量测试全绿（注入式，不出声）。
4. App 批 D：M5 工作台状态 → App 测试全绿。
5. 验收 M6：本机直播伴侣自测；硬件到位后手机线实况。
6. 每批提交前跑质量基线：服务端 typecheck/lint/全量测试；App analyze/test。
