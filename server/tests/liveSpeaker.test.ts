import { describe, expect, it } from 'vitest';
import { createLiveSpeaker, type LocalWavSynth, type SpeechSink } from '../src/services/liveSpeaker';
import type { PlayOutcome } from '../src/services/voicePlayer';

// liveSpeaker 出声链路单元测试：平台门槛只约束「本机出声」，
// phone 远程出声队列在非 Windows 平台（云端 Linux）也应可入队。全程注入替身，不出真实声音。

function makeFakeSynth() {
  const spokenTexts: string[] = [];
  const synth: LocalWavSynth = {
    synthesize: async (text: string) => {
      spokenTexts.push(text);
      return { wavPath: `/tmp/fake-${spokenTexts.length}.wav` };
    },
  };
  return { spokenTexts, synth };
}

function makeFakeSink(outcome: PlayOutcome = 'played') {
  const playedPaths: string[] = [];
  const sink: SpeechSink = {
    isMuted: () => false,
    setMuted: () => undefined,
    play: async (wavPath: string) => {
      playedPaths.push(wavPath);
      return outcome;
    },
    stop: () => undefined,
    pendingCount: () => 0,
  };
  return { playedPaths, sink };
}

describe('liveSpeaker 出声链路（平台门槛下沉）', () => {
  it('本机出声在非 Windows 平台仍返回 unsupported', async () => {
    const { synth } = makeFakeSynth();
    const { sink } = makeFakeSink();
    const speaker = createLiveSpeaker({ platform: 'linux', synth, sink, remoteOutput: false });
    const result = await speaker.speak('本地模式不应在 Linux 出声');
    expect(result).toEqual({ spoken: false, reason: 'unsupported' });
  });

  it('本机出声在 Windows 平台走合成 → 播放', async () => {
    const { spokenTexts, synth } = makeFakeSynth();
    const { playedPaths, sink } = makeFakeSink();
    const speaker = createLiveSpeaker({ platform: 'win32', synth, sink, remoteOutput: false });
    const result = await speaker.speak('Windows 本机出声');
    expect(result).toEqual({ spoken: true, reason: 'spoken' });
    expect(spokenTexts).toEqual(['Windows 本机出声']);
    expect(playedPaths).toHaveLength(1);
  });

  it('phone 远程出声在 Linux（云端）可合成并入远程队列', async () => {
    const { spokenTexts, synth } = makeFakeSynth();
    const { playedPaths, sink } = makeFakeSink();
    const speaker = createLiveSpeaker({ platform: 'linux', synth, sink, remoteOutput: true });
    const result = await speaker.speak('助播机出声');
    expect(result).toEqual({ spoken: true, reason: 'spoken' });
    expect(spokenTexts).toEqual(['助播机出声']);
    expect(playedPaths).toEqual(['/tmp/fake-1.wav']);
  });
});
