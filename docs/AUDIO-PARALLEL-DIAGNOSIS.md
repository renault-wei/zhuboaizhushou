# 声音不能并行（后台播放）· 定位（R58，先定位不执行）

> 用户提出：**「声音应该可以并行 …… 就是后台播放的问题」**。本文只定位，不动代码。

---

## 1. 结论先说

**根因：我们的两个播放器都在向 Android 申请「永久独占」音频焦点（`AUDIOFOCUS_GAIN`）。**

Android 的原文语义就是独占 —— `audioplayers` 包里对 `gain` 的注释写着：

> **AUDIOFOCUS_GAIN expresses the fact that your application is now the sole source of audio that the user is listening to.**
> Examples of uses of this focus gain are for **music playback, for a game or a video player**.

**「the sole source of audio」** —— 我们一说上话，手机上别的音频就得让路。

---

## 2. 证据链

### (a) 我们把播放器裸创建，从未设置音频上下文

```dart
// app/lib/features/assistant_speaker/data/audioplayers_speech_out_player.dart:22
final player = AudioPlayer();   // ← 就这一行，没有 audioContext 参数
```

全局搜索 `lib/` 下的 `setAudioContext` / `AudioContext`：**零命中** ✗

所以用的是 `audioplayers` 的默认上下文。

### (b) 默认上下文就是独占

`audioplayers_platform_interface-7.2.0/lib/src/api/audio_context.dart:92`：

```dart
const AudioContextAndroid({
  this.isSpeakerphoneOn = false,
  this.audioMode        = AndroidAudioMode.normal,
  this.stayAwake        = false,                 // ← 播放期间不自己加 WakeLock
  this.contentType      = AndroidContentType.music,
  this.usageType        = AndroidUsageType.media,
  this.audioFocus       = AndroidAudioFocus.gain, // ★ 独占
});
```

### (c) 而且是**两个**播放器，各申请一次

`app/lib/providers.dart`：

```dart
/// 本机出声播放器：助播机出声端与音色试听共用同一实现…
final speechOutPlayerProvider = Provider<SpeechOutPlayer>((ref) {
  final player = AudioplayersSpeechOutPlayer();   // → AudioPlayer() → gain
});

/// 音色试听专用播放器：与助播出声端**物理分离**，避免直播中试听打断 / 交叠
final voicePreviewPlayerProvider = Provider<SpeechOutPlayer>((ref) {
  final player = AudioplayersSpeechOutPlayer();   // → AudioPlayer() → gain
});
```

> 那段注释很说明问题：**开发者当年已经观察到「二者会互相打断 / 交叠」** ——
> 但那是**症状**，根因是**两个都申请了独占**。
> 用「物理分离」去解，只挡住了「自己和自己」✗ —— **完全没解决「和别的 App」** ✗。
> 而真正的修法恰恰相反：让它们**都别独占**。

---

## 3. 这会表现成什么样（对得上用户描述）

| 场景 | 现在的行为 | 应该的行为 |
|---|---|---|
| 助播机开始出声 | **手机/车机上正在放的音乐、导航、短视频被暂停** ✗ | 各放各的 ✓ |
| 商家切到别的 App | 我们的声音会被对方抢焦点打断 ✗ | 继续放 ✓ |
| 音色试听 + 直播出声 | 靠「两个播放器实例」勉强避开 ✗ | 天然不冲突 ✓ |
| 锁屏 / 后台 | 保活服务在（`mediaPlayback` 前台服务 + PARTIAL_WAKE_LOCK）✓ | 保持 ✓ |

**「并行」与「后台」其实是同一件事的两面**：
我们拿了独占焦点，所以**只要我们在放，别的就得停**；
**在后台播放时这个副作用最刺眼** —— 用户看不到我们的界面，只看到自己的音乐莫名其妙停了 ✗。

---

## 4. 顺带发现的一个次要项

`stayAwake = false`（默认）—— 播放期间我们自己**不申请 WakeLock** ✓。
**目前不算问题**：保活服务 `AssistantKeepAliveService` 另有一把 `PARTIAL_WAKE_LOCK` ✓ 兜住了。
但如果哪天保活被关掉，播放期间 CPU 休眠可能让声音断续 ✗。

---

## 5. 修法（三个候选，**未执行**）

共同点：**一处设置、两个播放器全覆盖** —— 用全局 API

```dart
// audioplayers: AudioPlayer.global.setAudioContext(ctx)  ← 包已提供（audioplayer.dart:21）
```

| 方案 | 焦点取值 | 效果 | 代价 |
|---|---|---|---|
| **A（推荐）mixWithOthers** | `AudioContextConfigFocus.mixWithOthers` → 安卓映射为 `AndroidAudioFocus.none` | **完全不申请焦点 → 与任何音频并行** ✓ | 别人放音时我们也不会自动让路 ✗ |
| B duckOthers | `gainTransientMayDuck` | 短暂取得、允许对方压低音量 | 仍会打断对方的完整听感 ✗ |
| C 维持现状 | `gain` | 独占 | 正是用户投诉的行为 ✗ |

**推荐 A** —— 用户的原话就是「声音应该可以并行」✓。
另外建议一并考虑的两个字段（同一处设置）：
- `usageType`：`media` → 可考虑 `assistant`（安卓会把 AI 语音当助手类音频处理）
- `contentType`：`music` → 更合适的是 **`speech`**（影响系统的 EQ / 路由策略）

---

## 6. 需要拍板的点

❓ **D1 · 选 A（完全不申请焦点）还是 B（duck）？**
➡️ 推荐 **A** —— 与「并行」的诉求完全一致。

❓ **D2 · `usageType` / `contentType` 要不要一起改成 assistant / speech？**
➡️ 建议一起改（同一处设置、零额外成本），但**两者都会改变系统对我的路由行为**，需要真机听感验证。

❓ **D3 · 改了之后，「音色试听」与「助播出声」还需要两个播放器实例吗？**
➡️ 从「抢焦点」角度不再需要；但从「同时播两条会叠音」角度**仍然需要分离** ✓ —— 建议保留。

❓ **D4 · 要不要现在就做？**
➡️ 用户说「先定位不执行」，等拍板。