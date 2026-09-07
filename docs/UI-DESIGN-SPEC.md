# 星辰语音 App · UI 设计规范

> 状态：2026-09-07 建档；2026-09-07 UI-1/UI-2 常规页收敛批次（4facf2e）落地后同步刷新。
> 代码事实源 = `app/lib/core/theme/`；进度入口 = `docs/PROGRESS.md` §6。
> 原则：**先令牌、后组件、再页面**；改动 UI 不动语义（文案 / Key / 测试锚点）。

## 1. 设计原则

1. **单一事实源**：颜色全部收敛到 `app/lib/core/theme/app_colors.dart`，页面禁止散写裸色值；换肤只改令牌。
2. **一页一焦点**：现场工作台是直播中长时间注视的操作面板，信息分层 = 状态（在播/时长）＞ AI 主播 ＞ 出声链路 ＞ 弹幕工具 ＞ 合规提示 ＞ 弹幕流水。
3. **长时间注视友好**：现场工作台固定深色（workbench），避免直播布光下白屏刺眼；常规配置页亮色并跟随系统深浅。
4. **主行动唯一**：每屏只保留 1 个主行动（工作台底部「开始直播 / 结束直播」），次行动用描边 / 文字按钮。

## 2. 颜色令牌

### 品牌与语义色
| 令牌 | 值 | 用途 |
|---|---|---|
| `primary` 星橙 | `#FF6B35` | 品牌主色 / 主行动按钮 / 就绪态 |
| `primaryDark` | `#E2541D` | 主色按下态 |
| `primarySoft` | 星橙 12% 透明 | 图标底 / 选中底 |
| `live` | `#22C55E` | 直播中 / 成功 |
| `danger` | `#EF4444` | 结束直播 / 失败 / 异常 |
| `warning` | `#F59E0B` | 合规提示 / 待处理 |
| `info` | `#3B82F6` | 信息 / 待机 |

### 现场暗色（workbench 专属）
| 令牌 | 值 | 用途 |
|---|---|---|
| `nightBg` | `#0E1220` | 页面底 |
| `nightCard` | `#1A2132` | 卡片底 |
| `nightCardHi` | `#242D44` | 输入底 / 图标底 / 渐变亮端 |
| `nightStroke` | `#2E3852` | 描边 / 分隔线 |
| `nightText` | `#F2F4F9` | 主文字 |
| `nightTextDim` | `#A9B2C6` | 次级文字 |
| `nightTextFaint` | `#77809A` | 弱化文字 / 灰态 |

## 3. 主题工厂（app/lib/core/theme/app_theme.dart）

| 主题 | 作用域 | 说明 |
|---|---|---|
| `AppTheme.light()` | 全 App 常规页 | 星橙种子色、亮底、16px 圆角卡 |
| `AppTheme.dark()` | 全 App 常规页（系统深色） | 深底中性灰，跟随 `ThemeMode.system` |
| `AppTheme.workbench()` | 现场直播工作台 | 固定暗色：nightBg 底 + nightCard 卡 + 星橙 / 绿色彩方案 |

## 4. 现场工作台布局（自顶向下）

线框层级（手机竖屏 / 平板同构）：

```
顶部 状态主视觉卡
  · 状态徽章（live=绿、ready=星橙、ended=灰、processing=warning、failed=danger）
  · 圆点 + 阶段文案（直播中 / 待开播 / 已结束…）
  · 右侧大字已播时长 hh:mm:ss（tabular figures）
  · 底部条：弹幕胶囊「弹幕 n 条」+ live 时「AI 实时播报中」
[ready 态] 开播前自检卡（待确认徽章 + 三条对勾清单）
AI 语音主播卡（44px 圆角图标底 + 状态 pill：播报中 / 待开播 / 已停止 / 待机）
[live 态] 助播机出声（手机线）卡（40px 图标底 + 状态 pill + 累计播报 n 条 + 开关）
测试弹幕注入卡（36px 图标底 + 提示 + 输入框 + 星橙「发送」按钮高 48）
合规角标（warning 描边提示条，恒显不可关）
弹幕日志（标题 + 「共 n 条」胶囊；单条 = 圆头像 + 昵称 / 时间 + 内容卡）
```

关键视觉参数：卡片圆角 14–20、描边 `nightStroke` 1px、卡片间距 12、页面左右 padding 16、主行动按钮高 52、测试发送按钮高 48、状态 pill 圆角 999。

## 5. 语义化 Key 锚点（测试保护，勿改名 / 删）

- 状态主视觉卡：`liveMonitorStatus` / `liveMonitorDuration` / `liveMonitorDanmakuCount`
- AI 主播卡：`liveMonitorAiHostCard` / `liveMonitorAiHostState` / `liveMonitorAiHostNote`
- 出声卡：`liveMonitorSpeakerCard` / `liveMonitorSpeakerSwitch` / `liveMonitorSpeakerState`
- 自检卡：`liveMonitorPreflight`；测试弹幕：`liveMonitorTestSection` / `TestInput` / `TestSend` / `TestHint`
- 合规：`liveMonitorBadgeNote`；日志空态：`liveMonitorDanmakuEmpty`
- 底部主操作：`liveMonitorStartButton` / `liveEndButton`

## 6. 批次路线

| 批次 | 范围 | 状态 |
|---|---|---|
| UI-0 | 颜色令牌 + 主题工厂接入 + 现场工作台重排（本规范 §2~§5） | ✅ 2026-09-07 |
| UI-1 | 登录 / 首页 / 音色库 / 话术等常规页统一主题观感走查 | ✅ 2026-09-07（随 UI-2 同批收尾） |
| UI-2 | 素材 / 话术 / 开播表单组件级细化（间距、空态、按钮层级） | ✅ 2026-09-07（4facf2e：登录/首页/音色库/券列表/录音/话术/开播/循环台本/抖音绑定 14 页收敛主题令牌与语义色，深浅双模式成立，App 测试 101/101） |
| UI-3 | 全 App 视觉走查 + 手机 / 平板真机截图验收 | ⏳ 待手机线批次（需内录转换器 / 真机联调现场） |

> UI-1/UI-2 代码收敛已完成（commit 4facf2e）；UI-3 依赖真机（手机 + 内录转换器到手后的手机线联调批次），
> 届时按本规范逐页截图验收并回填色差 / 间距问题。
