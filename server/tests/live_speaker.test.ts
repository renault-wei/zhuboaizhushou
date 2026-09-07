import { randomUUID } from 'node:crypto';
import { access, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import {
  buildSapiSpeakCommand,
  createLiveSpeaker,
  createLocalDeviceSink,
  DEFAULT_LOCAL_TTS_VOICE,
  type LocalWavSynth,
  type SpeechSink,
} from '../src/services/liveSpeaker';
import type { PlayOutcome, VoicePlayer } from '../src/services/voicePlayer';

// G5/P1 现场口播出口单元测试：合成/出声端都用替身注入，不碰真实语音引擎与声卡。
// P1 手机线第一步：合成与播放分离 —— speak 只负责「合成 → 交给出声端」，出声端负责播放与文件收尾。

/** 造一个记录收到的 wav、固定返回 outcome 的假出声端 */
function makeFakeSink(outcome: PlayOutcome): SpeechSink & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    isMuted: () => false,
    setMuted: () => undefined,
    play: async (wavPath) => {
      calls.push(wavPath);
      return outcome;
    },
    stop: () => undefined,
    pendingCount: () => 0,
  };
}

/** 造一个固定返回指定 wav 路径的假合成器 */
function makeFakeSynth(): LocalWavSynth & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    synthesize: async (text) => {
      calls.push(text);
      return { wavPath: 'C:/tmp/fake-live.wav' };
    },
  };
}

/** 造一个固定返回 outcome 的假 Windows 播放器（给本地出声端包装用） */
function makeFakePlayer(outcome: PlayOutcome): VoicePlayer & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    isMuted: () => false,
    setMuted: () => undefined,
    enqueue: async (wavPath) => {
      calls.push(wavPath);
      return outcome;
    },
    stop: () => undefined,
    pendingCount: () => 0,
  };
}

it('PowerShell 合成命令包含音色、语速与目标文件', () => {
  const command = buildSapiSpeakCommand('你好，欢迎光临', 'C:/tmp/a b.wav', DEFAULT_LOCAL_TTS_VOICE, -1);
  expect(command).toContain(`$synth.SelectVoice('${DEFAULT_LOCAL_TTS_VOICE}')`);
  expect(command).toContain("$synth.Rate = -1");
  expect(command).toContain("$synth.SetOutputToWaveFile('C:/tmp/a b.wav')");
  expect(command).toContain("$synth.Speak('你好，欢迎光临')");
});

it('PowerShell 单引号转义：文案里的单引号翻倍，避免断串注入', () => {
  const command = buildSapiSpeakCommand("它说'你好'", 'C:/tmp/out.wav', 'Voice A', 0);
  expect(command).toContain("$synth.Speak('它说''你好''')");
});

it('配置关闭时直接返回 disabled，不调用合成器与出声端', async () => {
  const synth = makeFakeSynth();
  const sink = makeFakeSink('played');
  const speaker = createLiveSpeaker({
    platform: 'win32',
    enabled: false,
    synth,
    sink,
  });
  const result = await speaker.speak('测试');
  expect(result.spoken).toBe(false);
  expect(result.reason).toBe('disabled');
  expect(synth.calls).toEqual([]);
  expect(sink.calls).toEqual([]);
});

it('非 Windows 平台返回 unsupported，不调用合成器与出声端', async () => {
  const synth = makeFakeSynth();
  const sink = makeFakeSink('played');
  const speaker = createLiveSpeaker({
    platform: 'linux',
    enabled: true,
    synth,
    sink,
  });
  const result = await speaker.speak('测试');
  expect(result.spoken).toBe(false);
  expect(result.reason).toBe('unsupported');
  expect(synth.calls).toEqual([]);
  expect(sink.calls).toEqual([]);
});

it('合成并播放成功返回 spoken，出声端收到合成出的 wav', async () => {
  const synth = makeFakeSynth();
  const sink = makeFakeSink('played');
  const speaker = createLiveSpeaker({
    platform: 'win32',
    enabled: true,
    synth,
    sink,
  });
  const result = await speaker.speak('这份套餐很划算');
  expect(result.spoken).toBe(true);
  expect(result.reason).toBe('spoken');
  expect(synth.calls).toEqual(['这份套餐很划算']);
  expect(sink.calls).toEqual(['C:/tmp/fake-live.wav']);
});

it('合成失败返回 synthesize_failed 且不触发播放', async () => {
  const failingSynth: LocalWavSynth = {
    synthesize: async () => {
      throw new Error('语音引擎不可用');
    },
  };
  const sink = makeFakeSink('played');
  const speaker = createLiveSpeaker({
    platform: 'win32',
    enabled: true,
    synth: failingSynth,
    sink,
  });
  const result = await speaker.speak('测试');
  expect(result.spoken).toBe(false);
  expect(result.reason).toBe('synthesize_failed');
  expect(result.error).toContain('语音引擎不可用');
  expect(sink.calls).toEqual([]);
});

it('播放被打断/跳过返回 skipped', async () => {
  const speaker = createLiveSpeaker({
    platform: 'win32',
    enabled: true,
    synth: makeFakeSynth(),
    sink: makeFakeSink('skipped'),
  });
  const result = await speaker.speak('测试');
  expect(result.spoken).toBe(false);
  expect(result.reason).toBe('skipped');
});

it('出声端播放异常返回 play_failed 并带上原因', async () => {
  const failingSink: SpeechSink = {
    isMuted: () => false,
    setMuted: () => undefined,
    play: async () => {
      throw new Error('出声端已离线');
    },
    stop: () => undefined,
    pendingCount: () => 0,
  };
  const speaker = createLiveSpeaker({
    platform: 'win32',
    enabled: true,
    synth: makeFakeSynth(),
    sink: failingSink,
  });
  const result = await speaker.speak('测试');
  expect(result.spoken).toBe(false);
  expect(result.reason).toBe('play_failed');
  expect(result.error).toContain('出声端已离线');
});

it.each(['played', 'skipped', 'failed'] as const)(
  '本地出声端接管文件生命周期：%s 后临时 wav 被清理',
  async (outcome) => {
    const wavPath = join(tmpdir(), `starvoice-sink-${randomUUID()}.wav`);
    await writeFile(wavPath, 'fake-wav');
    const player = makeFakePlayer(outcome);
    const sink = createLocalDeviceSink(player);
    const result = await sink.play(wavPath);
    expect(result).toBe(outcome);
    expect(player.calls).toEqual([wavPath]);
    // 文件已由 sink 收尾删除：再次访问应失败
    await expect(access(wavPath)).rejects.toThrow();
  },
);
