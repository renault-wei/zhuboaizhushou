import { expect, it } from 'vitest';
import {
  buildSapiSpeakCommand,
  createLiveSpeaker,
  DEFAULT_LOCAL_TTS_VOICE,
  type LocalWavSynth,
} from '../src/services/liveSpeaker';
import type { PlayOutcome, VoicePlayer } from '../src/services/voicePlayer';

// G5 现场口播出口单元测试：合成/播放都用替身注入，不碰真实语音引擎与声卡。

/** 造一个记录入队路径、固定返回 outcome 的假播放器 */
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

it('配置关闭时直接返回 disabled，不调用合成器', async () => {
  const synth = makeFakeSynth();
  const speaker = createLiveSpeaker({
    platform: 'win32',
    enabled: false,
    synth,
    player: makeFakePlayer('played'),
  });
  const result = await speaker.speak('测试');
  expect(result.spoken).toBe(false);
  expect(result.reason).toBe('disabled');
  expect(synth.calls).toEqual([]);
});

it('非 Windows 平台返回 unsupported，不调用合成器', async () => {
  const synth = makeFakeSynth();
  const speaker = createLiveSpeaker({
    platform: 'linux',
    enabled: true,
    synth,
    player: makeFakePlayer('played'),
  });
  const result = await speaker.speak('测试');
  expect(result.spoken).toBe(false);
  expect(result.reason).toBe('unsupported');
  expect(synth.calls).toEqual([]);
});

it('合成并播放成功返回 spoken，播放器收到合成出的 wav', async () => {
  const synth = makeFakeSynth();
  const player = makeFakePlayer('played');
  const speaker = createLiveSpeaker({
    platform: 'win32',
    enabled: true,
    synth,
    player,
  });
  const result = await speaker.speak('这份套餐很划算');
  expect(result.spoken).toBe(true);
  expect(result.reason).toBe('spoken');
  expect(synth.calls).toEqual(['这份套餐很划算']);
  expect(player.calls).toEqual(['C:/tmp/fake-live.wav']);
});

it('合成失败返回 synthesize_failed 且不触发播放', async () => {
  const failingSynth: LocalWavSynth = {
    synthesize: async () => {
      throw new Error('语音引擎不可用');
    },
  };
  const player = makeFakePlayer('played');
  const speaker = createLiveSpeaker({
    platform: 'win32',
    enabled: true,
    synth: failingSynth,
    player,
  });
  const result = await speaker.speak('测试');
  expect(result.spoken).toBe(false);
  expect(result.reason).toBe('synthesize_failed');
  expect(result.error).toContain('语音引擎不可用');
  expect(player.calls).toEqual([]);
});

it('播放被打断/跳过返回 skipped', async () => {
  const speaker = createLiveSpeaker({
    platform: 'win32',
    enabled: true,
    synth: makeFakeSynth(),
    player: makeFakePlayer('skipped'),
  });
  const result = await speaker.speak('测试');
  expect(result.spoken).toBe(false);
  expect(result.reason).toBe('skipped');
});