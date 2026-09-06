import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createVoicePlayer } from '../src/services/voicePlayer';

// G5 本地出声冒烟：生成一段「叮咚」提示音并播到系统默认播放设备。
// 用途：
// 1. 默认设备验收：听到叮咚即证明「Windows 后台出声」链路通；
// 2. 声卡注入验收：把 VB-Cable（CABLE Input）设为默认播放设备后再跑一次，
//    抖音直播伴侣里把麦克风选成 CABLE Output，即可验证声音进直播间。
// 注意：这里是占位提示音，只验证音频通道，不是产品口播音色（真实口播走 CosyVoice）。

const CHIME_WAV_FILENAME = 'starvoice-audio-smoke.wav';

function resolveFfmpegPath(): string {
  const candidates: string[] = [];
  if (process.env.FFMPEG_PATH) {
    candidates.push(process.env.FFMPEG_PATH);
  }
  candidates.push(resolve(process.cwd(), 'bin', 'ffmpeg.exe'));
  for (const dir of (process.env.PATH ?? '').split(';')) {
    if (dir.length > 0) {
      candidates.push(join(dir, 'ffmpeg.exe'));
    }
  }
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error('未找到 FFmpeg：请配置 FFMPEG_PATH，或确认 server/bin/ffmpeg.exe 存在');
}

/** 用 ffmpeg 合成两段短音（先高后低，类似提示音），避免依赖任何外部素材 */
function createChimeWav(ffmpegPath: string, outputPath: string): void {
  const args = [
    '-y',
    '-f', 'lavfi', '-i', 'sine=frequency=880:duration=0.18',
    '-f', 'lavfi', '-i', 'sine=frequency=660:duration=0.28',
    '-filter_complex', '[0:a][1:a]concat=n=2:v=0:a=1,volume=0.25',
    '-ar', '22050', '-ac', '1',
    outputPath,
  ];
  const result = spawnSync(ffmpegPath, args, { encoding: 'utf8', windowsHide: true });
  if (result.error || result.status !== 0) {
    throw new Error(`生成提示音失败：${(result.stderr ?? '').slice(0, 300)}`);
  }
  if (!existsSync(outputPath)) {
    throw new Error('生成提示音失败：产物不存在');
  }
}

async function main(): Promise<void> {
  if (process.platform !== 'win32') {
    throw new Error('本冒烟只支持 Windows：真实出声在开发机本机验收');
  }
  const wavPath = join(tmpdir(), CHIME_WAV_FILENAME);
  createChimeWav(resolveFfmpegPath(), wavPath);
  console.log(`已生成提示音：${wavPath}`);

  const player = createVoicePlayer();
  const outcome = await player.enqueue(wavPath);
  console.log(`播放完成，结果：${outcome}`);
  if (outcome !== 'played') {
    process.exitCode = 1;
  }
}

void main().catch((err: unknown) => {
  console.error(`出声冒烟失败：${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
