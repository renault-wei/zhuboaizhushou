import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { unlink } from 'node:fs/promises';
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

/** 合成器抽象：未来商用 / 克隆 TTS 只需实现同一接口 */
export interface LocalWavSynth {
  synthesize(text: string): Promise<{ wavPath: string }>;
}

/** Windows 本机语音合成实现（System.Speech）：把文字念成 PCM wav */
export class WindowsLocalSpeechSynth implements LocalWavSynth {
  private readonly voice: string;
  private readonly rate: number;

  constructor(options: { voice: string; rate: number }) {
    this.voice = options.voice;
    this.rate = options.rate;
  }

  async synthesize(text: string): Promise<{ wavPath: string }> {
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
  /** 播放一段 wav：播放权与文件清理权都移交给 sink，播完 / 跳过 / 失败都由 sink 收尾 */
  play(wavPath: string): Promise<PlayOutcome>;
  /** 清空未播队列并打断当前播放（真人接管 / 一键静音） */
  stop(): void;
  /** 尚未播出的排队条数 */
  pendingCount(): number;
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

  async play(wavPath: string): Promise<PlayOutcome> {
    try {
      return await this.player.enqueue(wavPath);
    } finally {
      // 无论 played / skipped / failed 都清理，避免临时 wav 堆积（远程 sink 改为收到回执后再删）
      await unlink(wavPath).catch(() => undefined);
    }
  }

  stop(): void {
    this.player.stop();
  }

  pendingCount(): number {
    return this.player.pendingCount();
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

export interface LiveSpeaker {
  /** 把一段口播文字合成语音并交给当前出声端播放；任何失败都不上抛，由调用方看结果决定是否告警 */
  speak(text: string): Promise<SpeakResult>;
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
}

/** 出口工厂：生产用真实本机合成 + 真实播放器；测试可注入替身 */
export function createLiveSpeaker(options: CreateLiveSpeakerOptions = {}): LiveSpeaker {
  const platform = options.platform ?? process.platform;
  const enabled = options.enabled ?? env.liveSpeaker.enabled;
  const voice = options.voice ?? env.liveSpeaker.localTtsVoice ?? DEFAULT_LOCAL_TTS_VOICE;
  const rate = options.rate ?? LOCAL_TTS_RATE;
  const synth = options.synth ?? new WindowsLocalSpeechSynth({ voice, rate });
  const sink = options.sink ?? getSharedSink();

  return {
    async speak(text: string): Promise<SpeakResult> {
      if (!enabled) {
        return { spoken: false, reason: 'disabled' };
      }
      // 远程出声端落地后，平台限制下放到各 sink 自判；本期仍按“本机出声”判断
      if (platform !== 'win32') {
        return { spoken: false, reason: 'unsupported' };
      }
      let sinkReached = false;
      try {
        const { wavPath } = await synth.synthesize(text);
        sinkReached = true;
        const outcome = await sink.play(wavPath);
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

// 全局单例：交互引擎 onReply 出口共用。
// LIVE_TTS_PROVIDER=volc 且火山 key 已配置时整体切到 volcTtsSynth（volcTTS.ts 内部自己读环境变量）；
// 其余情况（默认 local / 未配 key）回退本机 SAPI 音色。
export const liveSpeaker = createLiveSpeaker({
  synth:
    env.liveSpeaker.ttsProvider === 'volc' && env.volcTTS.apiKey
      ? volcTtsSynth
      : undefined,
  // 出声通道：LIVE_SPEAKER_OUTPUT=phone 时改交远程出声队列（助播机拉取）；默认 pc 保持本机播放
  sink: env.liveSpeaker.output === 'phone' ? createRemoteSpeechSink() : undefined,
});
