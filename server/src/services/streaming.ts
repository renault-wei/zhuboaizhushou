import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import type { CosyVoiceService } from './voice';
import { cosyVoiceService, isCosyVoiceReal } from './voice';
import { locateFfmpeg } from './ffmpeg';

// ---------- 常量 ----------

// 角标默认文案：合规红线「AI 智能直播」，由服务端强制叠加、不提供关闭入口
export const DEFAULT_BADGE_TEXT = 'AI智能直播';
// 中文字体：Windows 系统自带黑体（ffmpeg drawtext 需 libfreetype 支持，路径内冒号须转义）
export const BADGE_FONT_PATH = 'C:/Windows/Fonts/simhei.ttf';

// ---------- 错误类型 ----------

export type StreamingErrorCode = 'FFMPEG_NOT_FOUND' | 'TTS_GENERATE_FAILED' | 'COMPOSE_FAILED';

/** 推流引擎（FFmpeg）业务错误：携带机器可读错误码，由路由层翻译成 HTTP 状态 */
export class StreamingError extends Error {
  readonly code: StreamingErrorCode;

  constructor(code: StreamingErrorCode, message: string) {
    super(message);
    this.name = 'StreamingError';
    this.code = code;
  }
}

// ---------- 接口定义 ----------

/** 合成入参：源视频 + 话术全文 + 输出路径 + 目标时长 + 角标文案 + 绑定音色 */
export interface ComposeInput {
  /** 商户上传的实景视频绝对路径 */
  sourceVideoPath: string;
  /** 话术全文：合成口播音轨的朗读文本 */
  scriptText: string;
  /** 合成产物绝对路径（如 uploads/lives/{liveId}.mp4） */
  outputPath: string;
  /** 目标直播时长（秒），路由层已 clamp 到 [10, 3600] */
  durationSeconds: number;
  /** 角标文字，缺省用合规默认文案 */
  badgeText?: string;
  /** 音色的 CosyVoice voice_id：真实模式据此合成口播音轨；缺省时回退占位音轨 */
  providerVoiceId?: string;
}

/** 合成结果：产物路径 + 时长 + 文件字节数 */
export interface ComposeResult {
  outputPath: string;
  durationSeconds: number;
  fileSizeBytes: number;
}

/**
 * 推流引擎服务接口（T11 只做本地合成，不推流 / 不接 RTMP）。
 * MVP 阶段用本地 FFmpeg 实现；未来接云端转码时保持该接口不变，仅在工厂函数中切换实现。
 */
export interface StreamingService {
  /** 合成直播视频：源视频循环 + 口播音轨（真实 TTS / 占位音轨）+ 合规角标 → 本地 mp4 文件 */
  composeLive(input: ComposeInput): Promise<ComposeResult>;
}

// ---------- mock 实现 ----------

/**
 * 本地 FFmpeg 合成实现：
 * - 口播音轨：绑定真实音色且开启真实 CosyVoice 时调 DashScope 合成并循环；
 *   否则（mock 模式 / 未绑定音色）用 ffmpeg sine 正弦音轨（440Hz）落盘占位；
 * - 合成：-stream_loop -1 循环源视频 + 音轨 + drawtext 中文角标 + -t 目标时长；
 * - Windows 路径转义：drawtext 的 fontfile 内冒号须写成 \:，字体路径用系统字体 simhei.ttf。
 */
export class MockStreamingService implements StreamingService {
  /** 真实 CosyVoice TTS 客户端；mock 模式为 null（合成回退 sine 占位音轨） */
  private readonly cosyVoice: CosyVoiceService | null;

  constructor(cosyVoice?: CosyVoiceService) {
    this.cosyVoice = cosyVoice ?? null;
  }

  /**
   * FFmpeg 定位三级规则：
   * 1. process.env.FFMPEG_PATH（显式指定，最优先）；
   * 2. path.resolve(process.cwd(), 'bin', 'ffmpeg.exe')（项目自带）；
   * 3. 系统 PATH 中的 ffmpeg（生产 / CI 环境）。
   * 三级都探测不到时抛 FFMPEG_NOT_FOUND。
   */
  resolveFfmpegPath(): string {
    try {
      return locateFfmpeg();
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new StreamingError('FFMPEG_NOT_FOUND', detail);
    }
  }

  /**
   * 占位音轨（mock 模式 / 未绑定真实音色时兜底）：
   * 用 ffmpeg sine 正弦音轨（440Hz，时长 = durationSeconds）生成音频文件。
   * scriptText 参数在真实 TTS 分支使用，此处不参与生成。
   */
  generateTtsTrack(_scriptText: string, outputPath: string, durationSeconds: number): void {
    mkdirSync(dirname(outputPath), { recursive: true });
    const args = [
      '-y',
      '-f',
      'lavfi',
      '-i',
      `sine=frequency=440:duration=${durationSeconds}`,
      '-c:a',
      'pcm_s16le',
      outputPath,
    ];
    this.runFfmpeg(args, 'TTS_GENERATE_FAILED', 'TTS 音轨生成');
    this.assertNonEmptyFile(outputPath, 'TTS_GENERATE_FAILED', 'TTS 音轨产物');
  }

  /** 合成直播视频：源视频循环 + 口播音轨 + 合规角标 → 本地 mp4（同步跑 FFmpeg） */
  async composeLive(input: ComposeInput): Promise<ComposeResult> {
    const ffmpegPath = this.resolveFfmpegPath();
    if (!existsSync(input.sourceVideoPath)) {
      throw new StreamingError('COMPOSE_FAILED', `源视频文件不存在：${input.sourceVideoPath}`);
    }
    mkdirSync(dirname(input.outputPath), { recursive: true });

    // 占位音轨路径（真实 TTS 分支不会用到，finally 兜底清理）
    const ttsTrackPath = join(
      dirname(input.outputPath),
      `${basename(input.outputPath, extname(input.outputPath))}-tts.wav`,
    );
    let cosyWavPath: string | undefined;
    try {
      if (input.providerVoiceId && this.cosyVoice) {
        try {
          const { wavPath } = await this.cosyVoice.synthesizeSpeech({
            text: input.scriptText,
            providerVoiceId: input.providerVoiceId,
          });
          cosyWavPath = wavPath;
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          throw new StreamingError('TTS_GENERATE_FAILED', `真实 TTS 合成失败：${detail}`);
        }
      } else {
        this.generateTtsTrack(input.scriptText, ttsTrackPath, input.durationSeconds);
      }
      const audioTrackPath = cosyWavPath ?? ttsTrackPath;

      // drawtext 角标：文字用单引号包裹；Windows 路径中的冒号转义成 \:，整体作为单个 filter 参数
      const badgeText = input.badgeText ?? DEFAULT_BADGE_TEXT;
      const escapedFont = BADGE_FONT_PATH.replace(/:/g, '\\:');
      const drawtextFilter =
        `drawtext=text='${badgeText}':fontfile='${escapedFont}':fontsize=28:fontcolor=white:` +
        'box=1:boxcolor=black@0.5:boxborderw=8:x=20:y=20';
      const args = [
        '-y',
        '-stream_loop',
        '-1',
        '-i',
        input.sourceVideoPath,
        '-stream_loop',
        '-1',
        '-i',
        audioTrackPath,
        '-t',
        String(input.durationSeconds),
        '-vf',
        drawtextFilter,
        '-map',
        '0:v',
        '-map',
        '1:a',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-shortest',
        '-y',
        input.outputPath,
      ];
      this.runFfmpeg(args, 'COMPOSE_FAILED', `视频合成（${ffmpegPath}）`);
      this.assertNonEmptyFile(input.outputPath, 'COMPOSE_FAILED', '合成产物');
      const stats = statSync(input.outputPath);
      return {
        outputPath: input.outputPath,
        durationSeconds: input.durationSeconds,
        fileSizeBytes: stats.size,
      };
    } finally {
      // 中间音轨（真实 TTS 临时 wav / sine 占位 wav）不入库，无论成败都清理
      if (cosyWavPath) {
        rmSync(cosyWavPath, { force: true });
      }
      rmSync(ttsTrackPath, { force: true });
    }
  }

  /** 同步跑 FFmpeg：非零退出 / spawn 异常统一抛带 stderr 摘要的 StreamingError */
  private runFfmpeg(
    args: string[],
    errorCode: StreamingErrorCode,
    context: string,
  ): void {
    const ffmpegPath = this.resolveFfmpegPath();
    const result = spawnSync(ffmpegPath, args, { encoding: 'utf8', windowsHide: true });
    if (result.error) {
      throw new StreamingError(errorCode, `${context}失败：${result.error.message}`);
    }
    if (result.status !== 0) {
      const stderr = (result.stderr ?? '').trim().slice(0, 500);
      throw new StreamingError(errorCode, `${context}失败${stderr ? `：${stderr}` : ''}`);
    }
  }

  /** 产物存在性 + 大小校验（>0 字节才算成功） */
  private assertNonEmptyFile(
    filePath: string,
    errorCode: StreamingErrorCode,
    label: string,
  ): void {
    const stats = statSync(filePath);
    if (!stats.isFile() || stats.size <= 0) {
      throw new StreamingError(errorCode, `${label}为空或不存在：${filePath}`);
    }
  }
}

/**
 * 推流引擎工厂：
 * - 真实 CosyVoice 模式（配置 key 且未开 mock）→ 注入真实 TTS 客户端，绑定音色时走真实合成；
 * - mock 模式 → 不注入 TTS 客户端，合成回退 sine 占位音轨。
 */
export function createStreamingService(): StreamingService {
  return new MockStreamingService(isCosyVoiceReal() ? cosyVoiceService : undefined);
}

// 全局单例：prepare 合成流程各处共用同一实现
export const streamingService = createStreamingService();
