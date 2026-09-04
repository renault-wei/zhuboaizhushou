# T11 · 推流引擎 v1：FFmpeg 合成（循环视频 + TTS 音轨 + 角标叠加 → 本地文件）

## 目标

完成 S2「直播推流核心」的**引擎**：把商户上传的实景视频 + 话术音轨 + 合规角标，用 FFmpeg 合成一个可直接推流的本地文件。**T11 不推抖音**（T12 做），只产出合成文件，验证 FFmpeg 链路跑通。

## 已完成的技术验证（主控亲自跑通，直接照抄命令）

FFmpeg 4.3 已就位于 `server/bin/ffmpeg.exe`（含 libfreetype/libx264/libx265/libass）。三大能力全部实测通过：

### ① 角标叠加（drawtext，中文字体 simhei.ttf）
```bash
ffmpeg -y -f lavfi -i "testsrc=duration=3:size=640x360:rate=25" \
  -vf "drawtext=text='AI智能直播':fontfile='C\:/Windows/Fonts/simhei.ttf':fontsize=28:fontcolor=white:box=1:boxcolor=black@0.5:boxborderw=8:x=20:y=20" \
  -c:v libx264 -pix_fmt yuv420p out.mp4
```
**注意**：fontfile 路径里的 `:` 必须转义成 `\:`；text 若含空格/特殊字符需整体用单引号包住。

### ② 视频循环 + 音轨合成（-stream_loop -1 + sine 音轨模拟 TTS）
```bash
ffmpeg -y -stream_loop -1 -i 源视频.mp4 \
  -f lavfi -i "sine=frequency=440:duration=10" \
  -t 10 \
  -vf "drawtext=...同上..." \
  -map 0:v -map 1:a -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest out_loop.mp4
```
实测输出：Duration 10.02s、Video h264 640x360、Audio aac 44100Hz mono。

### FFmpeg 定位规则（写进 service，务必遵守）
1. `process.env.FFMPEG_PATH`（显式指定，最优先）
2. 否则 `path.resolve(process.cwd(), 'bin', 'ffmpeg.exe')`（项目自带）
3. 否则回退到系统 PATH 的 `ffmpeg`（生产/CI 环境）

## 现状（已就绪）

- `server/bin/ffmpeg.exe` 已就位（.gitignore 已忽略 `server/bin/`）
- `server/uploads/` 目录 .gitignore 已忽略（存视频文件）
- `lives` 表已有 `videoSourceUrl`（text NOT NULL，T10 默认 ''）、`status`（idle/ready/live/ended/failed）、`aiBadgeShown`（boolean 恒 true）
- 现有「接口 + mock 工厂 + 单例」范式见 `voice.ts` / `script.ts` / `douyin.ts`

## 服务端任务

### 1. schema 变更：`liveStatusEnum` 加 `processing`

`server/src/db/schema.ts` 第 32 行：
```ts
export const liveStatusEnum = pgEnum('live_status', ['idle', 'ready', 'live', 'ended', 'failed']);
```
改为：
```ts
export const liveStatusEnum = pgEnum('live_status', ['idle', 'processing', 'ready', 'live', 'ended', 'failed']);
```
状态流转：`idle`（草稿）→ `processing`（合成中）→ `ready`（可推流）→ `live`（T12 直播中）→ `ended/failed`。
改完 `npm run db:push` 同步 PG enum（PG 端 `ALTER TYPE live_status ADD VALUE 'processing'`）。

### 2. 依赖：`@fastify/multipart`（视频上传）

`npm install @fastify/multipart`（主控可能已装，先 `npm ls @fastify/multipart` 确认，没有就装）。
在 `app.ts` 注册：`app.register(multipart, { limits: { fileSize: 200 * 1024 * 1024 } })`。

### 3. 新建 `src/services/streaming.ts` — 推流引擎（FFmpeg 合成）

```ts
// 接口 + 工厂 + 单例范式（未来换云端转码只换实现）
export interface StreamingService {
  /** 合成直播视频：源视频循环 + TTS 音轨 + 角标 → 输出 mp4 文件 */
  composeLive(input: ComposeInput): Promise<ComposeResult>;
}

export interface ComposeInput {
  sourceVideoPath: string;   // 商户上传的实景视频绝对路径
  scriptText: string;        // 话术全文（TTS 用，T11 先 mock 音轨）
  outputPath: string;        // 合成输出绝对路径（如 server/uploads/lives/{liveId}.mp4）
  durationSeconds: number;   // 目标直播时长（T11 demo 默认 30s）
  badgeText?: string;        // 角标文字，默认 'AI智能直播'
}
export interface ComposeResult {
  outputPath: string;
  durationSeconds: number;
  fileSizeBytes: number;
}
```

#### `MockStreamingService`（T11 实现）
- `resolveFfmpegPath()`：按上面「FFmpeg 定位规则」解析
- `generateTtsTrack(scriptText, outputPath, durationSeconds)`：**TTS mock** —— 用 ffmpeg 生成 `sine` 正弦音轨（440Hz，时长=durationSeconds）落盘，模拟「用克隆音色读话术」；真实 CosyVoice TTS 留后续换 `RealStreamingService`
- `composeLive()`：用 `child_process.spawnSync` 跑 ffmpeg（`-stream_loop -1` + `sine` 音轨 + `drawtext` 角标 + `-t durationSeconds`），命令参照上面「已验证的命令」，注意 Windows 路径转义（fontfile `:` → `\:`、路径用双引号包住）
- 失败时 throw `StreamingError`（携带 ffmpeg stderr 摘要，便于排查）
- 输出文件存在性 + 大小校验（>0 字节才算成功）

### 4. 扩展 `src/routes/lives.ts`（或新建 streaming 路由，任选但保持 lives 命名一致）

#### `POST /api/lives/:id/video` — 上传实景视频（multipart）
- `preHandler: app.authenticate` + 归属隔离（非本人 404）
- 用 `request.file()` 读 multipart 字段 `video`（单文件，mp4，≤200MB）
- 存到 `server/uploads/videos/{liveId}.mp4`（先 mkdir -p）
- 成功更新 `lives.videoSourceUrl = '/uploads/videos/{liveId}.mp4'`，返回 `{ live }`
- 校验：无文件 → 400 `VIDEO_REQUIRED`；非 mp4 → 400 `VIDEO_TYPE_INVALID`；文件为空 → 400 `VIDEO_EMPTY`

#### `POST /api/lives/:id/prepare` — 触发合成（同步，T11 v1）
- `preHandler: app.authenticate` + 归属隔离
- 前置校验：
  - `videoSourceUrl` 非空（未上传 → 400 `VIDEO_NOT_UPLOADED`）
  - `scriptId` 非空且 `sensitive_check_status = 'pass'`（话术未生成或敏感词 blocked → 400 `SCRIPT_NOT_READY`）
  - `voiceId` 非空（未选音色 → 400 `VOICE_NOT_SELECTED`）
- 状态置 `processing` → 调 `streamingService.composeLive()` 合成（durationSeconds 默认 30，从 body `durationSeconds` 可选覆盖，clamp 到 [10, 3600]）
- 合成成功 → `videoSourceUrl = '/uploads/lives/{liveId}.mp4'`、`status = 'ready'` → 返回 `{ live }`
- 合成失败 → `status = 'failed'` → 500 `COMPOSE_FAILED`（附 ffmpeg 错误摘要）
- 删除保护沿用 T10：`status = live/ready` 时不可删（409）；`processing` 也算进行中，一并 409

#### `GET /api/lives/:id/stream-status` — 查询合成/直播状态
- 返回 `{ status, videoSourceUrl, aiBadgeShown }`（供客户端轮询）

### 5. 测试 `tests/streaming.test.ts`

- 未登录 401
- 未上传视频直接 prepare → 400 `VIDEO_NOT_UPLOADED`
- 未选话术/话术 blocked → 400 `SCRIPT_NOT_READY`
- 未选音色 → 400 `VOICE_NOT_SELECTED`
- 上传视频（用 `form-data` 或手动 multipart body）→ 200，videoSourceUrl 更新
- prepare 成功 → status 变 ready（**若 FFmpeg 可用**则真合成断言输出文件存在 + 时长>0；**若 FFmpeg 不可用则 skip 真合成部分，只验证状态流转 + mock 工厂注入**）
- prepare 时 FFmpeg 抛错 → status 变 failed
- `aiBadgeShown` 全程恒 true 不可篡改
- 归属隔离：B 用户操作 A 的 live → 404

> 测试原则（AGENTS.md）：第三方/重计算一律 mock。FFmpeg 真合成**只在检测到 `server/bin/ffmpeg.exe` 存在时跑 1 个冒烟用例**，其余用例注入 `MockStreamingService`（返回假 ComposeResult）避免测试慢。

## 客户端任务

### 1. `Live` 模型加 `processing` 状态

`app/lib/core/models/live.dart` 的 `LiveStatus` enum 加 `processing('合成中')`，`fromWire` 兜底不变。

### 2. `ApiClient` 新增 3 方法
- `uploadLiveVideo(id, filePath)` → `POST /api/lives/{id}/video`（multipart）
- `prepareLive(id, {durationSeconds?})` → `POST /api/lives/{id}/prepare`
- `getLiveStreamStatus(id)` → `GET /api/lives/{id}/stream-status`

### 3. `live_form_page.dart` 点亮「视频上传」按钮（原置灰）
- 表单加「上传实景视频」区：选择本地视频（`file_picker` 或 `image_picker`，MVP 可用简化的文件路径输入 + 假上传按钮占位，但**必须真实调 uploadLiveVideo**）
- 上传成功后显示「已上传」+ 文件名
- 「保存草稿」后新增/保留「生成直播视频」按钮 → 调 prepareLive → 成功后提示「已生成，可开播（T12）」
- 编辑模式下若 status=ready/live 则禁用编辑（沿用 isEditable getter）

### 4. 测试
- `live_model_test.dart`：加 processing 状态断言
- `live_form_page_test.dart`：上传按钮从置灰→可点、prepare 成功提示
- `fake_backend.dart`：加 upload/prepare/stream-status 3 个 mock 端点

## 验收标准

- 服务端 typecheck/lint/test 全绿（63 + 新增 streaming 测试）
- 客户端 analyze 零 error
- 端到端（主控亲自验证）：
  1. 登录 → 建 live（选音色+话术+券）→ 上传一个真实 mp4 → videoSourceUrl 更新
  2. prepare → status 变 ready，`server/uploads/lives/{liveId}.mp4` 文件生成、时长>0、可播放
  3. 未上传就 prepare → 400；话术 blocked → 400
  4. `aiBadgeShown` 恒 true
- FFmpeg 真合成冒烟：`server/bin/ffmpeg.exe` 存在时跑一次真合成断言输出文件

## 注意

- **T11 不推流**：不接 RTMP、不推抖音，只出本地合成文件
- **合规**：角标 `drawtext` 强制叠加，无任何关闭入口；`aiBadgeShown` 恒 true
- **FFmpeg 路径转义**：Windows 下 fontfile 的 `:` 必须 `\:`，路径用双引号
- **TTS 是 mock**：sine 音轨占位，真实 CosyVoice TTS 留后续
- 完成后**不 commit**，留主控验收
