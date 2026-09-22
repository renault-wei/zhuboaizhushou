import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { unlink } from 'node:fs/promises';

import { findCachedTtsAudio, storeCachedTtsAudio } from './ttsCache';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { env } from '../config/env';
import { createVoicePlayer, type PlayOutcome, type VoicePlayer } from './voicePlayer';
import { volcTtsSynth } from './volcTTS';
import { createRemoteSpeechSink } from './remoteSpeechSink';

// G5/P1 现场口播出口：TTS 合成 → 出声端（SpeechSink）→ 播放。
// 本模块是 G4 `onReply` 的消费方：引擎产出的回复文字进来 → 合成 wav → 交给当前出声端排队播放；
// 默认出声端 = 本机播放（默认播放设备指向 VB-Cable 虚拟声卡时，声音会像麦克风一样进入抖音直播伴侣）；
// P1 手机线将新增远程出声端（助播机出声），同接口换实现，合成器与引擎接线不变。
// 音色策略：LIVE_TTS_PROVIDER=volc 且已配置 VOLC_TTS_API_KEY（火山豆包语音，商用音色）时走火山 provider；
// 默认 local = Windows 本机 SAPI（火山账号开通模型服务前先保住出声，避免直播演示无声）；
// 火山真连验证通过后，把 .env 的 LIVE_TTS_PROVIDER 改为 volc 即可整体切换，播放队列与引擎接线不变。

// ---------- 常量 ----------

/** 本机语音默认音色（控制面板「语音」可查），可用 .env 的 LOCAL_TTS_VOICE 覆盖 */
export const DEFAULT_LOCAL_TTS_VOICE = 'Microsoft Huihui Desktop';

/** 合成语速：-1 略慢，接近门店口播节奏（System.Speech Rate 范围 -10 ~ 10） */
export const LOCAL_TTS_RATE = -1;

// ---------- 类型定义 ----------

export type SpeakReason =
  | 'spoken'
  | 'disabled'
  | 'unsupported'
  | 'synthesize_failed'
  | 'play_failed'
  | 'skipped';

export interface SpeakResult {
  spoken: boolean;
  reason: SpeakReason;
  error?: string;
}

/**
 * 单次合成的音色覆盖项（可选）：缺省时合成器回落自身构造 / 环境变量默认值。
 * speaker = 火山发音人 ID（预设音色）；克隆音色档 A 未接入真复刻，不走这里。
 */
export interface SpeechOverrides {
  /** 本次合成音色（火山发音人 ID） */
  speaker?: string;
  /** 本次合成语速 [-50, 100]，0 为正常语速 */
  speechRate?: number;
}

/**
 * R69：合成缓存上下文。
 *
 * 为什么由调用方传、而不是 liveSpeaker 自己查：
 *   缓存键是「商家 + 音色 + 语速 + 文本」，而 liveSpeaker 只拿得到文本 ✗。
 *   用户与音色档只有上层（loopCaster，握有场次）知道，所以由它提供。
 * 为什么是可选的：
 *   不传就退回「每次都实时合成」的旧行为 —— 弹幕回复等旁路调用可以不动 ✓。
 */
export interface TtsCacheContext {
  userId: string;
  /** 音色键：与看板/试听缓存共用同一口径（火山发音人 ID） */
  voiceKey: string;
  rate: number;
}

/** 合成器抽象：未来商用 / 克隆 TTS 只需实现同一接口 */
export interface LocalWavSynth {
  synthesize(text: string, overrides?: SpeechOverrides): Promise<{ wavPath: string }>;
}

/**
 * Windows 本机语音合成实现（System.Speech）：把文字念成 PCM wav。
 * 本机 SAPI 音色名与火山发音人 ID 不同源，档 A 忽略 overrides（保持 .env LOCAL_TTS_VOICE）。
 */
export class WindowsLocalSpeechSynth implements LocalWavSynth {
  private readonly voice: string;
  private readonly rate: number;

  constructor(options: { voice: string; rate: number }) {
    this.voice = options.voice;
    this.rate = options.rate;
  }

  async synthesize(text: string, _overrides?: SpeechOverrides): Promise<{ wavPath: string }> {
    const wavPath = join(tmpdir(), `starvoice-live-${randomUUID()}.wav`);
    const command = buildSapiSpeakCommand(text, wavPath, this.voice, this.rate);
    const result = await runHiddenPowerShell(command);
    if (result.code !== 0) {
      const detail = (result.stderr.trim() || '未知原因').slice(0, 300);
      throw new Error(`本机语音合成失败（退出码 ${result.code ?? '无'}）：${detail}`);
    }
    return { wavPath };
  }
}

// ---------- PowerShell 封装 ----------

/** PowerShell 单引号字符串转义：内部单引号翻倍，避免命令注入与断串 */
function psQuote(value: string): string {
  return value.replace(/'/g, "''");
}

/**
 * 组装 System.Speech 合成命令（纯函数，便于单测）：
 * 选音色 → 输出到 wav → 设定语速 → 朗读。全部成功才退出 0。
 */
export function buildSapiSpeakCommand(
  text: string,
  wavPath: string,
  voice: string,
  rate: number,
): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    'Add-Type -AssemblyName System.Speech',
    '$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer',
    `$synth.SelectVoice('${psQuote(voice)}')`,
    `$synth.SetOutputToWaveFile('${psQuote(wavPath)}')`,
    `$synth.Rate = ${rate}`,
    `$synth.Speak('${psQuote(text)}')`,
    '$synth.Dispose()',
  ].join('; ');
}

/** 起一个隐藏的 powershell 进程执行脚本，等进程退出后返回退出码与 stderr */
function runHiddenPowerShell(command: string): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-STA', '-Command', command],
      { windowsHide: true },
    );
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (err) => {
      reject(err);
    });
    child.on('close', (code) => {
      resolve({ code, stderr });
    });
  });
}

// ---------- 出声端抽象（P1 手机线：合成与播放分离） ----------

/** 出声端（SpeechSink）：一段合成好的 wav 交给谁播、由谁负责收尾清理。
 *  - 本地实现（默认）：本机默认播放设备 / 虚拟声卡，播完即删临时文件（本期行为不变）；
 *  - 未来远程实现：助播机出声端（双手机线）——同接口换实现，liveSpeaker 与引擎零改动。
 *  说明：远程出声端落地前，speak 的 win32 门槛仍代表「本机出声」；
 *  换远程 sink 后再把平台限制下放到各 sink 自身判断。
 */
export interface SpeechSink {
  /** 当前是否静音（静音只拦新播放，播到一半让其自然播完） */
  isMuted(): boolean;
  setMuted(muted: boolean): void;
  /**
   * 播放一段 wav：播放权与文件清理权都移交给 sink，播完 / 跳过 / 失败都由 sink 收尾。
   * ★R77：gapAfterSeconds = 这条**播完之后**的间隔（远程 sink 会把它随条目下发给助播机，
   * 由播放端等待；本地 sink 忽略它 —— 本机链路里间隔本来就由 loopCaster 的 sleep 承担）。
   */
  play(wavPath: string, liveId?: string, gapAfterSeconds?: number): Promise<PlayOutcome>;
  /** 清空未播队列并打断当前播放（真人接管 / 一键静音） */
  stop(): void;
  /** 尚未播出的排队条数；带 liveId 时只数该场次的积压（多场隔离口径） */
  pendingCount(liveId?: string): number;
}

/** 本地出声端：包装现有 Windows 播放队列（voicePlayer），并接管临时 wav 的文件生命周期 */
class LocalDeviceSink implements SpeechSink {
  constructor(private readonly player: VoicePlayer) {}

  isMuted(): boolean {
    return this.player.isMuted();
  }

  setMuted(muted: boolean): void {
    this.player.setMuted(muted);
  }

  async play(wavPath: string, liveId?: string): Promise<PlayOutcome> {
    try {
      // R61：把场次透传给播放器（原先丢掉 → pendingCount 只能数全局）
      return await this.player.enqueue(wavPath, liveId);
    } finally {
      // 无论 played / skipped / failed 都清理，避免临时 wav 堆积（远程 sink 改为收到回执后再删）
      await unlink(wavPath).catch(() => undefined);
    }
  }

  stop(): void {
    this.player.stop();
  }

  pendingCount(liveId?: string): number {
    // R61：透传场次 —— 原先忽略它，导致**别场次的积压把本场台本卡死**。
    // （注释一直写着「带 liveId 时只算本场」，但实现从来没做。）
    return this.player.pendingCount(liveId);
  }
}

/** 本地出声端工厂：生产默认使用；测试可用假播放器包装后验证清理职责 */
export function createLocalDeviceSink(player: VoicePlayer): SpeechSink {
  return new LocalDeviceSink(player);
}

// ---------- 出口门面 ----------

/** 出声端全局单例：多个场次共用同一条出声链路（排队 / 打断语义在 voicePlayer，sink 只换“谁播放”） */
let sharedSink: SpeechSink | null = null;

function getSharedSink(): SpeechSink {
  if (!sharedSink) {
    sharedSink = createLocalDeviceSink(createVoicePlayer());
  }
  return sharedSink;
}

// ---------- 出声链路单例：liveSpeaker 出声与 loopCaster 查忙共用同一路 ----------

/** 当前出声链路单例：谁出声（pc 本机播放 / phone 助播机远程队列）只解析一次 */
let lineSink: SpeechSink | null = null;

/** 解析并缓存当前出声链路：pc = 本机播放（默认播放设备指向虚拟声卡时进直播伴侣）；phone = 远程出声队列 */
function getLineSink(): SpeechSink {
  if (!lineSink) {
    lineSink =
      env.liveSpeaker.output === 'phone' ? createRemoteSpeechSink() : getSharedSink();
  }
  return lineSink;
}

/** 统一忙闲出口：当前出声链路尚未播出的排队条数；带 liveId 时只算本场（弹幕回复 / 循环口播共用一条链路） */
export function speechLinePendingCount(liveId?: string): number {
  return getLineSink().pendingCount(liveId);
}

export interface LiveSpeaker {
  /**
   * 把一段口播文字合成语音并交给当前出声端播放；任何失败都不上抛，由调用方看结果决定是否告警。
   * overrides 指定本场音色（火山预设）；不传则用合成器默认音色，既有调用行为不变。
   * liveId 标记音频归属场次：远程队列按场隔离，避免多场并发时音色 / 台词交错。
   */
  speak(
    text: string,
    overrides?: SpeechOverrides,
    liveId?: string,
    cache?: TtsCacheContext,
    gapAfterSeconds?: number,
  ): Promise<SpeakResult>;
}

export interface CreateLiveSpeakerOptions {
  /** 测试注入平台；生产默认 process.platform */
  platform?: NodeJS.Platform;
  /** 是否允许出声（LIVE_SPEAKER_ENABLED=false 可一键关） */
  enabled?: boolean;
  /** 本机音色名；不传用 LOCAL_TTS_VOICE / 内置默认 */
  voice?: string;
  /** 语速；不传用 LOCAL_TTS_RATE */
  rate?: number;
  /** 测试注入合成器 */
  synth?: LocalWavSynth;
  /** 测试注入出声端；不传用本地默认（Windows 播放队列） */
  sink?: SpeechSink;
  /** phone 远程出声模式：任意平台可把合成 wav 入远程队列；不传按 LIVE_SPEAKER_OUTPUT=phone 判定 */
  remoteOutput?: boolean;
}

/**
 * ★C：**只合成并落盘**，不入队、不播放 —— 供「按序号取音频」按需取货 ✓
 *
 * 与 createLiveSpeaker 的合成段**完全同源**（查缓存 → 合成 → 落缓存），
 * 抽出来是为了让 C（客户端持游标、按序号要货）复用同一条合成路径 ——
 * 于是 R69 的防线**依然成立**：命中缓存时这里一次都不碰火山 ✓
 * （开播前已预生成整本台本，直播期间按序号取到的全是缓存命中 ✓）
 *
 * **失败时上抛**（不吞）—— 让 speak 原有的 catch 继续把原因带出来、
 * 让路由各自翻译成 500，两边语义都不用改 ✓
 */
export async function synthesizeSpeechFile(
  text: string,
  overrides?: SpeechOverrides,
  cache?: TtsCacheContext,
  synth: LocalWavSynth = resolveLiveSynth(),
): Promise<string> {
  if (cache) {
    const hit = await findCachedTtsAudio({ ...cache, text }).catch(() => null);
    if (hit) {
      return hit.audioPath;
    }
  }
  const synthesized = await synth.synthesize(text, overrides);
  // miss 合成成功后落缓存；写失败只告警，不阻断本次取货 ✓
  if (cache) {
    await storeCachedTtsAudio({ ...cache, text }, synthesized.wavPath).catch(
      () => null,
    );
  }
  return synthesized.wavPath;
}

/** 出口工厂：生产用真实本机合成 + 真实播放器；测试可注入替身 */
export function createLiveSpeaker(options: CreateLiveSpeakerOptions = {}): LiveSpeaker {
  const platform = options.platform ?? process.platform;
  const enabled = options.enabled ?? env.liveSpeaker.enabled;
  const voice = options.voice ?? env.liveSpeaker.localTtsVoice ?? DEFAULT_LOCAL_TTS_VOICE;
  const rate = options.rate ?? LOCAL_TTS_RATE;
  const synth = options.synth ?? new WindowsLocalSpeechSynth({ voice, rate });
  // ★R61 修复：这里原先写的是 `getSharedSink()`（**本机**播放器），于是
  //   phone 模式下合成的 wav 全进了「本机播放队列」—— 而本机是云端服务器，
  //   没有声卡；同时 speechLinePendingCount / App 拉取读的都是**远程队列**。
  //   一边入本机、一边读远程 → **助播机永远拉到 0 条，一个音都出不来**。
  //   正确做法：与读写忙闲走**同一条链路**（谁出声只解析一次，见 getLineSink）。
  const sink = options.sink ?? getLineSink();
  // 平台限制只约束「本机出声」（Windows SAPI / 本机播放器）；phone 远程出声队列任意平台可入队
  const remoteOutput = options.remoteOutput ?? env.liveSpeaker.output === 'phone';

  return {
    async speak(
      text: string,
      overrides?: SpeechOverrides,
      liveId?: string,
      cache?: TtsCacheContext,
      gapAfterSeconds?: number,
    ): Promise<SpeakResult> {
      if (!enabled) {
        return { spoken: false, reason: 'disabled' };
      }
      // 平台限制只约束「本机出声」；phone 远程出声队列任意平台可入队（见 remoteOutput 判定）
      if (!remoteOutput && platform !== 'win32') {
        return { spoken: false, reason: 'unsupported' };
      }
      let sinkReached = false;
      try {
        // ★R69：先查缓存，命中就【完全不碰火山】✓
        //   这是「开播前预生成」能生效的前提：预热跑过之后，
        //   开播期间一次都不调外部 TTS —— 火山抽风 / 额度用尽都伤不到直播 ✓
        //   （2026-09-22 凌晨那次 80 条 45000030、整晚零音频，正是缺了这一步 ✗）
        // ★C：合成段抽成 synthesizeSpeechFile —— 「按序号取音频」复用同一条路径 ✓
        //   缓存语义完全不变：命中就一次都不碰火山 ✓（R69 的预生成防线仍然成立）
        // 失败会抛 → 落到下面的 catch，reason=synthesize_failed 且带上原因 ✓
        const wavPath = await synthesizeSpeechFile(text, overrides, cache, synth);
        sinkReached = true;
        const outcome = await sink.play(wavPath, liveId, gapAfterSeconds);
        if (outcome === 'played') {
          return { spoken: true, reason: 'spoken' };
        }
        if (outcome === 'skipped') {
          return { spoken: false, reason: 'skipped' };
        }
        return { spoken: false, reason: 'play_failed' };
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        console.warn(`[liveSpeaker] 现场口播出口失败：${error}`);
        return {
          spoken: false,
          reason: sinkReached ? 'play_failed' : 'synthesize_failed',
          error,
        };
      }
    },
  };
}

/**
 * R69：解析本次部署实际使用的合成器。
 *
 * 为什么要把这段抽出来：**预生成必须与开播用同一个合成器** ✗ ——
 * 若预生成走了 A 引擎、开播走 B 引擎，缓存永远不命中，白预热一场 ✓
 * （缓存键里有音色与语速，但没有「哪个引擎」，所以引擎必须全局唯一。）
 */
export function resolveLiveSynth(): LocalWavSynth {
  if (env.liveSpeaker.ttsProvider === 'volc' && env.volcTTS.apiKey) {
    return volcTtsSynth;
  }
  // 回落本机 SAPI 音色：与 createLiveSpeaker 的默认取值同源，避免两处漂移
  return new WindowsLocalSpeechSynth({
    voice: env.liveSpeaker.localTtsVoice ?? DEFAULT_LOCAL_TTS_VOICE,
    rate: LOCAL_TTS_RATE,
  });
}

// 全局单例：交互引擎 onReply 出口共用。
// LIVE_TTS_PROVIDER=volc 且火山 key 已配置时整体切到 volcTtsSynth（volcTTS.ts 内部自己读环境变量）；
// 其余情况（默认 local / 未配 key）回退本机 SAPI 音色。
export const liveSpeaker = createLiveSpeaker({
  synth:
    env.liveSpeaker.ttsProvider === 'volc' && env.volcTTS.apiKey
      ? volcTtsSynth
      : undefined,
  // 出声通道：LIVE_SPEAKER_OUTPUT=phone 时改交远程出声队列（助播机拉取）；默认 pc 保持本机播放
  sink: getLineSink(),
});
