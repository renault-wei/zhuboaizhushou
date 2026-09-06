import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { env } from '../config/env';
import { createVoicePlayer, type VoicePlayer } from './voicePlayer';
import { volcTtsSynth } from './volcTTS';

// G5 现场口播出口：TTS 合成 → 播放队列 → 默认播放设备。
// 本模块是 G4 `onReply` 的消费方：引擎产出的回复文字进来 → 合成本机女声 wav → 排队出声；
// 系统默认播放设备指向 VB-Cable 虚拟声卡时，这段声音会像麦克风一样进入抖音直播伴侣。
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

// ---------- 出口门面 ----------

/** 播放器全局单例：多个场次共用同一条出声队列（排队 / 打断语义在 voicePlayer） */
let sharedPlayer: VoicePlayer | null = null;

function getSharedPlayer(): VoicePlayer {
  if (!sharedPlayer) {
    sharedPlayer = createVoicePlayer();
  }
  return sharedPlayer;
}

export interface LiveSpeaker {
  /** 把一段口播文字合成本机语音并播放；任何失败都不上抛，由调用方看结果决定是否告警 */
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
  /** 测试注入播放器 */
  player?: VoicePlayer;
}

/** 出口工厂：生产用真实本机合成 + 真实播放器；测试可注入替身 */
export function createLiveSpeaker(options: CreateLiveSpeakerOptions = {}): LiveSpeaker {
  const platform = options.platform ?? process.platform;
  const enabled = options.enabled ?? env.liveSpeaker.enabled;
  const voice = options.voice ?? env.liveSpeaker.localTtsVoice ?? DEFAULT_LOCAL_TTS_VOICE;
  const rate = options.rate ?? LOCAL_TTS_RATE;
  const injectedSynth = options.synth;
  const injectedPlayer = options.player;

  return {
    async speak(text: string): Promise<SpeakResult> {
      if (!enabled) {
        return { spoken: false, reason: 'disabled' };
      }
      if (platform !== 'win32') {
        return { spoken: false, reason: 'unsupported' };
      }
      const synth = injectedSynth ?? new WindowsLocalSpeechSynth({ voice, rate });
      let wavPath: string | null = null;
      try {
        const synthesized = await synth.synthesize(text);
        wavPath = synthesized.wavPath;
        const outcome = await (injectedPlayer ?? getSharedPlayer()).enqueue(wavPath);
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
          reason: wavPath === null ? 'synthesize_failed' : 'play_failed',
          error,
        };
      } finally {
        // 播放完毕（或被跳过 / 打断）后清理临时 wav，失败不阻塞主线
        if (wavPath !== null) {
          void unlink(wavPath).catch(() => undefined);
        }
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
});
