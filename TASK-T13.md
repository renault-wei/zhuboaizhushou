# T13 · 一键开播/结束 + 直播中监控页（状态 / 时长 / 弹幕日志只读）

## 目标

在 T11 合成产物基础上，补齐「开播生命周期」：**一键开播**（ready → live）、**结束直播**（live → ended），以及一个**直播中监控页**（实时状态 + 已播时长 + 弹幕日志只读）。

**T13 不接 RTMP / 抖音推流**（那是 T12）：开播仅是状态机流转 + 记录 `startedAt`，真实推流后续在 T12 接入后再补。弹幕日志同理——T13 只建表 + 只读查询，真实弹幕来源待抖音推流接入后灌入。

## 现状（已就绪）

- `lives` 表已有 `status`（idle/processing/ready/live/ended/failed）、`startedAt`、`endedAt`、`rtmpUrl`、`aiBadgeShown`。
- T11 的 `prepare` 已能把 `ready` 状态 + 合成产物 `/uploads/lives/{id}.mp4` 落地。
- `live.ts` service 已有 `getLiveById` / `getLiveComposeContext` / `updateLiveInternal`；`lives.ts` 路由已有 CRUD + video/prepare/stream-status。
- 错误范式：`LiveError(code, message)` + 路由层 `statusCodeOf()` 翻译。

## 服务端任务

### 1. schema：新增 `live_danmaku`（弹幕日志，只读）

`server/src/db/schema.ts` 在 `lives` 之后加一张表：

```ts
export const liveDanmaku = pgTable(
  'live_danmaku',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    liveId: uuid('live_id').notNull().references(() => lives.id, { onDelete: 'cascade' }),
    content: text('content').notNull(),                       // 弹幕内容
    senderNickname: varchar('sender_nickname', { length: 50 }), // 发送者昵称（抖音观众，可空）
    sentAt: timestamp('sent_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('live_danmaku_live_id_idx').on(table.liveId),
    index('live_danmaku_sent_at_idx').on(table.sentAt),
  ],
);
```

改完 `npm run db:push` 同步（新表，无枚举变更）。

### 2. service：新增 `src/services/liveSession.ts`（会话生命周期）

复用 `live.ts` 的 `LiveError` / `findOwnedLive` 口径；新增错误码到 `live.ts` 的 `LiveErrorCode`：

```ts
| 'LIVE_NOT_READY'   // 开播时 status !== ready
| 'LIVE_NOT_LIVE'    // 结束时 status !== live
```

`liveSession.ts` 提供：

- `startLive(userId, id): Promise<Live>`：归属隔离（非本人/不存在返回 null，路由转 404）；`status !== 'ready'` → 抛 `LIVE_NOT_READY`（未合成完成不可开播）；置 `status='live'`、`startedAt=now`、清空 `endedAt`。
- `endLive(userId, id): Promise<Live>`：归属隔离；`status !== 'live'` → 抛 `LIVE_NOT_LIVE`；置 `status='ended'`、`endedAt=now`。
- `getLiveMonitor(userId, id)`：归属隔离；返回
  ```ts
  {
    status, videoSourceUrl, aiBadgeShown,
    startedAt, endedAt,
    durationSeconds,   // live: now-startedAt；ended: endedAt-startedAt；其它 0
    danmakuCount,      // live_danmaku 计数
  }
  ```
- `listDanmaku(userId, id, limit=50)`：归属隔离（live 不存在返回 null）；按 `sentAt desc` 取最近 N 条，返回 `LiveDanmaku[]`。

> 弹幕**只读**：T13 不提供写入口（真实来源待抖音推流接入）。测试/演示直接往表里 seed 数据。

### 3. routes：`lives.ts` 追加 4 个接口

- `POST /api/lives/:id/start` → 成功 `{ live }`；未就绪 400 `LIVE_NOT_READY`
- `POST /api/lives/:id/end` → 成功 `{ live }`；非直播中 400 `LIVE_NOT_LIVE`
- `GET /api/lives/:id/monitor` → `{ status, videoSourceUrl, aiBadgeShown, startedAt, endedAt, durationSeconds, danmakuCount }`（供客户端轮询）
- `GET /api/lives/:id/danmaku?limit=50` → 弹幕列表数组 `[{ id, content, senderNickname, sentAt }]`

全部 `preHandler: app.authenticate` + 归属隔离（非本人 404）。

### 4. 测试 `tests/live_session.test.ts`

- 未登录 401
- `start`：`ready` → 200 + status=live + startedAt 非空；`idle` 直接开播 → 400 `LIVE_NOT_READY`
- `end`：`live` → 200 + status=ended + endedAt 非空；`ready` 直接结束 → 400 `LIVE_NOT_LIVE`
- `monitor`：live 状态下 durationSeconds > 0；ready 状态下 durationSeconds = 0；danmakuCount 正确
- `danmaku`：seed 几条后按 sentAt desc 返回；limit 生效
- 归属隔离：B 操作 A 的 live → 404
- 删除保护沿用：live/ready/processing 删除 409（已有，回归即可）

## 客户端任务

### 1. 模型（`app/lib/core/models/live.dart`）

- 新增 `LiveMonitor`：`{ status, videoSourceUrl, aiBadgeShown, startedAt, endedAt, durationSeconds, danmakuCount }`
- 新增 `LiveDanmaku`：`{ id, content, senderNickname, sentAt }`
- `Live` 加 helper：`bool get isReady => status == LiveStatus.ready;`

### 2. ApiClient（`api_client.dart`）新增 4 方法

- `startLive(id)` → `POST /api/lives/{id}/start`
- `endLive(id)` → `POST /api/lives/{id}/end`
- `getLiveMonitor(id)` → `GET /api/lives/{id}/monitor`
- `getLiveDanmaku(id, {limit})` → `GET /api/lives/{id}/danmaku`

### 3. 新增 `live_monitor_page.dart`（直播中监控页）

- 顶部状态卡片：状态徽章 + 已播时长（每秒刷新，`hh:mm:ss`）+ `aiBadgeShown` 恒 true 角标提示
- 弹幕日志列表：只读滚动展示（空则显示「暂无弹幕」），含昵称 + 内容 + 时间
- 轮询：`monitor` 每 3s、`danmaku` 每 3s（进入页面启动，退出停止）
- 「结束直播」按钮 → 调 `endLive` → 成功后 pop 返回

### 4. `live_list_page.dart` 点亮开播/结束/监控入口

- `ready` 卡片：显示「开播」按钮 → `startLive` 成功后刷新列表
- `live` 卡片：显示「进入监控」按钮 → 跳 `/lives/{id}/monitor`；「结束」按钮 → `endLive`（二次确认）
- 现有「查看」占位逻辑对 live 状态改为跳监控页

### 5. router（`app_router.dart`）

- 新增 `GoRoute('/lives/:id/monitor')` → `LiveMonitorPage(liveId: ...)`

### 6. 测试

- `live_model_test.dart`：LiveMonitor / LiveDanmaku 解析、`isReady` 断言
- `fake_backend.dart`：加 start / end / monitor / danmaku 4 个 mock 端点
- `live_monitor_page_test.dart`（可选，MVP 用 fake_backend 覆盖开播→监控流程）

## 验收标准

- 服务端 typecheck / lint / test 全绿（70 + 新增 live_session 测试）
- 客户端 analyze 零 error
- 端到端（主控验证）：
  1. prepare 出 ready 的 live → `POST /start` → status=live、startedAt 记录
  2. `GET /monitor` → durationSeconds 随秒增长
  3. seed 几条弹幕 → `GET /danmaku` 按时间倒序返回
  4. `POST /end` → status=ended、endedAt 记录、durationSeconds 冻结
  5. 未 ready 开播 → 400；未 live 结束 → 400
- `aiBadgeShown` 恒 true，无任何篡改入口

## 注意

- **T13 不推流**：start 只做状态机 + 记录 startedAt，不接 RTMP / 抖音（T12）
- **弹幕只读**：建表 + 只读查询，不提供写接口
- **合规**：`aiBadgeShown` 恒 true，监控页也强制展示角标提示，无关闭入口
- 完成后**不 commit**，留主控验收
