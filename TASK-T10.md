# T10 · 开播配置页（lives CRUD：选音色 + 选话术 + 选券 + 标题）

## 目标

完成 S2「开播闭环」第二步：**开播配置 CRUD**。
商户创建「开播配置草稿」时，必须绑定：
- 音色（来自 S1-T5 克隆）
- 话术（来自 S1-T7+T8 生成）
- 团购券（来自 S2-T9 拉取）
- 直播标题（手动输入）
- 实景视频源（**T10 暂留空字符串，T11 上传视频时填充**）

完成 CRUD 后，商户手里就有一份「开播配置草稿」(status=idle)，可以进入 T11/T12 上传视频与推流。

## 现状（已就绪）

- `server/src/db/schema.ts` 的 `lives` 表已就位：
  - `id` uuid PK
  - `userId` uuid FK users
  - `title` varchar(100)
  - `videoSourceUrl` text NOT NULL **（T10 默认 ''）**
  - `couponId` text
  - `rtmpUrl` text
  - `voiceId` uuid FK voices（on delete set null）
  - `scriptId` uuid FK scripts（on delete set null）
  - `status` enum: `idle`/`ready`/`live`/`ended`/`failed`（默认 idle）
  - `aiBadgeShown` boolean default true（合规：强制叠加，不可篡改）
  - `startedAt`/`endedAt` timestamp
  - `createdAt`/`updatedAt` timestamp
- `liveStatusEnum` 已定义：`idle/ready/live/ended/failed`
- 服务端已有 `voices/scripts/douyin` 路由范式，可参考

## 服务端任务

### 1. 新建 `src/services/live.ts` — 直播配置服务（仅 CRUD，**不含推流逻辑**）

#### 类型定义

```ts
export interface Live {
  id: string;
  title: string;
  videoSourceUrl: string;       // T10 默认空串
  couponId: string | null;
  rtmpUrl: string | null;
  voiceId: string | null;
  scriptId: string | null;
  status: 'idle' | 'ready' | 'live' | 'ended' | 'failed';
  aiBadgeShown: boolean;        // 一律 true，禁止篡改
  startedAt: string | null;
  endedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateLiveInput {
  title: string;                 // 1-100 字
  voiceId: string | null;        // null 允许（暂未选）
  scriptId: string | null;
  couponId: string | null;
  videoSourceUrl?: string;       // T10 默认 ''
}

export type UpdateLiveInput = Partial<Pick<CreateLiveInput, 'title' | 'voiceId' | 'scriptId' | 'couponId' | 'videoSourceUrl'>>;
```

#### 服务函数（数据库操作）

```ts
listLives(userId, { limit, status? }): Promise<Live[]>
getLiveById(userId, id): Promise<Live | null>   // 归属隔离：不是我的不能查
createLive(userId, input): Promise<Live>
updateLive(userId, id, patch): Promise<Live | null>
deleteLive(userId, id): Promise<boolean>        // 已 live 的不可删，409 LIVE_IN_PROGRESS
```

#### 校验
- `title`：trim 后 1-100 字，超出 → 抛 `LIVE_TITLE_INVALID`
- `voiceId`：可选；提供时校验存在且归属当前用户，不属于 → 抛 `VOICE_NOT_OWNED`
- `scriptId`：可选；提供时校验存在且归属当前用户，不属于 → 抛 `SCRIPT_NOT_OWNED`
- `couponId`：可选；**T10 暂不校验 openId 仍持有此券**（后续 T11+T12 上传推流时再校验），直接存
- 删除保护：`status='live'` 或 `'ready'` → `LIVE_IN_PROGRESS`（status code 409）

### 2. `src/routes/lives.ts` 新增 CRUD 路由

| Method | Path | Handler | 鉴权 |
|---|---|---|---|
| GET    | `/api/lives`              | listLives          | ✅ app.authenticate |
| GET    | `/api/lives/:id`          | getLive            | ✅ + 归属隔离 |
| POST   | `/api/lives`              | createLive         | ✅ |
| PATCH  | `/api/lives/:id`          | updateLive         | ✅ + 归属隔离 |
| DELETE | `/api/lives/:id`          | deleteLive         | ✅ + 状态保护 |

#### 错误码
- 400 `LIVE_TITLE_INVALID` / `VOICE_NOT_OWNED` / `SCRIPT_NOT_OWNED`
- 401 未登录
- 404 `LIVE_NOT_FOUND`
- 409 `LIVE_IN_PROGRESS`（删除进行中直播）

#### `POST /api/lives` 请求/响应示例

请求：
```json
{
  "title": "火锅店午市循环直播",
  "voiceId": "uuid-of-voice",
  "scriptId": "uuid-of-script",
  "couponId": "coupon-1234abcd",
  "videoSourceUrl": ""
}
```

响应 201：
```json
{
  "live": { /* Live 对象 */ }
}
```

#### `GET /api/lives` 列表过滤

- 默认按 `updatedAt desc`，最多 50 条
- 支持 `?status=idle` 过滤（可选）

### 3. 测试 `tests/lives.test.ts`

- 未登录 401（list/create/get/update/delete）
- 标题为空 / >100 字 400
- voiceId/scriptId 跨用户 400
- 归属隔离：A 创建的 live，B GET/PATCH/DELETE → 404
- CRUD 完整流：create → get → list（含此条） → patch → delete → get 404
- 删除进行中直播：手动构造 status='live'，DELETE 应 409
- POST/PATCH 默认 `aiBadgeShown=true`，且不接受该字段覆盖（防止篡改合规角标）

## 客户端任务

### 1. `core/models/live.dart`

参照 `voice.dart` 风格：不可变字段、`fromJson`、`status` enum、`isEditable` getter（status=idle 时可编辑，否则提示「直播中/已结束，不可编辑」）。

### 2. `ApiClient` 新增 5 方法

- `listLives({status?}) → List<Live>`
- `getLive(id) → Live`
- `createLive({title, voiceId?, scriptId?, couponId?, videoSourceUrl?}) → Live`
- `updateLive(id, patch) → Live`
- `deleteLive(id) → void`

### 3. 页面

#### `lib/features/lives/presentation/live_list_page.dart`

我的直播列表：分段展示「草稿（idle）/ 进行中（live）/ 已结束（ended+failed）」
- 每条卡片：标题 + 状态 tag + 摘要（音色名/话术标题/券名） + 操作按钮（草稿：编辑/删除；进行中：查看/停止 placeholder）
- AppBar 右上角「+」→ `/lives/new`
- 端到端：登录 → 空列表 → 「+」创建 → 列表多一条
- 空态：「还没有开播配置，点击 + 创建第一份」

#### `lib/features/lives/presentation/live_form_page.dart`

路径：`/lives/new`（创建）/`/lives/:id`（编辑复用同一页面，传 initial）
- 字段：
  - 标题输入（必填，1-100 字校验）
  - 选择音色：弹底部 sheet（拉取 `/api/voices`，显示 name + status；只可选 status='ready' 的）
  - 选择话术：弹底部 sheet（拉取 `/api/scripts`，显示 industry + 首句）
  - 选择团购券：直接 push `/coupons`（点选 → `context.pop(couponId)`）
  - 视频源上传：**T10 显式提示「T11 上传视频后回填」，目前置灰**
- 底部按钮「保存草稿」：调用 createLive/updateLive，成功后 pop 回列表并刷新

### 4. 首页入口 + 路由 + provider

- 首页 `home_page.dart`：在「团购券库」卡片下方加「开播配置」入口卡片（图标 Icons.live_tv）
- `app_router.dart`：
  - `/lives` → `LiveListPage`
  - `/lives/new` → `LiveFormPage()`（创建）
  - `/lives/:id` → `LiveFormPage(id: ...)`（编辑，读取 /api/lives/:id 预填）
- `providers.dart`：
  - `liveListControllerProvider` (autoDispose)
  - `liveFormControllerProvider` (autoDispose.family<int?, Live>?) —— 按 liveId 维度
- `coupon_list_page.dart` 已支持 `context.pop(couponId)`，live_form 直接复用即可

### 5. 测试

- Live 模型（status enum、isEditable getter、fromJson 字段完整）
- live_list_page widget 测试：
  - 空态：「还没有开播配置」
  - 一条 idle 草稿卡片 + 编辑/删除按钮
  - AppBar + 跳转 new
- live_form_page widget 测试：
  - 创建模式：标题为空时按钮 disabled
  - 编辑模式：字段预填
- API 客户端：5 方法 round-trip 测试

## 验收标准

- 服务端 typecheck/lint/test 全绿（在 T9 51/51 基础上 +8-12 项）
- 客户端 analyze 零 error（在 T9 基础上 +0 error）
- 端到端：
  1. 登录 → 创建一份 live（带 voiceId/scriptId/couponId）→ 列表多一条
  2. 编辑此 live（改标题）→ 列表显示更新后标题
  3. B 用户尝试 GET A 的 live → 404
  4. 删除此 live → 列表又为空
  5. 构造 status=live 的 live → DELETE 应 409

## 注意

- **合规优先**：`aiBadgeShown` 字段服务端写死 true，请求 body 中即使传 false 也忽略，并在注释里说明「不可关闭合规角标」
- **不要做推流**：T10 只 CRUD 配置，不接 RTMP、不合成视频、不开播
- **T11 上传视频后会 PATCH** `videoSourceUrl`，T10 默认 ''
- 删除保护：仅 idle/ended/failed 可删；live/ready → 409
- 完成后**不 commit**，留主控验收