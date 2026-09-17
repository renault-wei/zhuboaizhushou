# 智能回复 · 可靠性审计（2026-09-17）

> 起因：用户提问「智能回复的逻辑和实现是否可靠」。
> 方法：**通读链路 + 写探针实测**，不凭感觉下结论。所有结论都附代码位置或实测输出。

## 结论先说

**单条弹幕的链路是可靠的；并发下不可靠。**

分流、闸门、顺序、合规这几块做得扎实；但**频控在并发下完全失效**（已实测），
另有几处内存与可观测性的欠账。**当前状态下不建议在真实热闹直播间长时间无人值守跑。**

## 1. 🔴 严重：频控竞态 —— 已实测复现

### 缺陷

```ts
// services/interactionEngine.ts
const lastGlobalReplyAt = this.lastReplyAtByLive.get(context.liveId);   // ① 读
if (now - lastGlobalReplyAt < globalIntervalMs) return GLOBAL_THROTTLED;

generatedText = await this.options.generateReply(...);                   // ② 等数秒
...
this.lastReplyAtByLive.set(context.liveId, repliedAt);                   // ③ 才写
```

**时间戳在「生成之后」才落**，而生成要几秒。所有在这几秒内到达的弹幕**都会通过检查** ——
典型的 check-then-act 竞态。

### 实测（探针 `scripts/_race-probe.ts`，10 条不同观众弹幕同时到达，账号设定 5 秒/次）

```
并发 10 条不同观众的弹幕，间隔设定 5 秒/次
  DeepSeek 实际调用次数 = 10
  实际产出回复条数     = 10
  若频控可靠，两者都应为 1
```

### 影响（按严重度）

1. **AI 成本放大 N 倍** —— 商家设的 5 秒/次形同虚设；一次刷屏就是 N 次 DeepSeek 调用。
2. **直播间被 AI 语音刷屏** —— N 条回复全部进出声队列（见 §2.5 队列还无上限），
   观众听到的是一串连珠炮，而这**正是商家设频控想避免的事**。
3. 用户级频控同理（同一昵称并发刷屏也全过）。

### 修法（建议）

在**检查通过后立即占位**，生成失败再回滚：

```ts
// 先把时间戳写进去占位，再 await 生成；失败/无需回复时回滚
this.lastReplyAtByLive.set(liveId, now);
try { generatedText = await generateReply(...) } catch { this.lastReplyAtByLive.delete(liveId); ... }
```

更稳的做法是**每场次一条串行队列**（同一 liveId 的 handle 排队执行），
既修竞态，又天然限制并发 DeepSeek 调用数。

## 2. 其余问题（按严重度）

| # | 严重度 | 问题 | 位置 / 证据 | 影响 |
|---|---|---|---|---|
| 2.1 | 🟠 中 | **频控 Map 只 set 从不 delete** | `lastReplyAtByLive` / `lastReplyAtBySender` 全文只有 get/set | 每场次、每 (场次,昵称) 永久驻留 → **长跑内存无界增长** |
| 2.2 | 🟠 中 | **回复台账只在 /start 清** | `clearLiveReplies` 全仓仅 1 处调用 | 建了没再开播的场次，缓冲常驻（每场 ≤50 条，但场次数无界） |
| 2.3 | 🟠 中 | **引擎异常被完全吞掉** | `void this.handle(message).catch(() => undefined)`，**无任何日志** | 链路故障时**静默无感**，排障无从下手（这条最影响可运维性） |
| 2.4 | 🟠 中 | **DeepSeek 失败无重试** | `services/reply.ts` 中 `retry` 零命中 | 一次网络抖动 = 一个观众的问题永远没人答 |
| 2.5 | 🟠 中 | **出声队列无上限** | `remoteSpeechQueue.push` 无 cap | 与 §1 叠加：N 条回复全部排队播出去 |
| 2.6 | 🟡 轻 | 用户级频控只看昵称 | 匿名为 null 时 `senderKey = null` → 整条跳过限制 | 匿名刷屏可绕过用户级频控 |
| 2.7 | 🟡 轻 | `senderIntervalMs` 硬编码 5s | `DEFAULT_SENDER_INTERVAL_MS`，不进账号设置 | 商家只能调场次级，调不了"同一人多久回一次" |
| 2.8 | 🟡 轻 | 每条弹幕打 2 次 DB | `loadLiveInteractionContext` + `loadUserLiveSettings` | 热闹直播间 DB 压力线性增长 |

## 3. 做对的地方（也要说清楚）

- **幂等**：弹幕按 `platform:msgKey` 去重，重复入库不入、不重播 —— 不会因为重连/重放重复回复。
- **事前闸门齐全**：`DANMAKU_EMPTY → LIVE_NOT_FOUND → LIVE_NOT_LIVE → REPLY_DISABLED → 频控`，
  关掉智能回复时**一次 AI 都不调**（省成本的设计是对的）。
- **顺序可靠**：回复与台本句共用 FIFO 出声链路 + 台本每句前空档避让，
  回复**不会打断半句**（已有断言钉住：`loopCaster.test.ts`）。
- **合规双层**：内置词库命中 → 兜底话术；商家自定义词命中 → 整条丢弃。两者语义分开，符合拍板口径。
- **可测性**：依赖全注入、时钟可控，所以上面这些问题才能被单测/探针抓出来。

## 4. 建议票

| ID | 任务 | 优先级 |
|---|---|---|
| **R28** | **修频控竞态**（占位式记账 / 每场次串行队列）+ 队列/并发上限 | 🔴 最高 |
| **R29** | 频控 Map 与回复台账的**回收**（场次结束清理 / LRU 上界） | 🟠 |
| **R30** | **引擎可观测**：handle 异常落日志 + 关键 skip reason 计数 | 🟠 |
| **R31** | DeepSeek 失败**有限重试 + 降级**（重试 1 次，仍失败则记台账不播） | 🟠 |

> 注：**额度红线仍不在本批**（用户 2026-09-17 拍板归算力卡批次）。
