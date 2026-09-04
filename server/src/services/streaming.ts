import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';

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

/** 合成入参：源视频 + 话术全文 + 输出路径 + 目标时长 + 角标文案 */
export interface ComposeInput {
  /** 商户上传的实景视频绝对路径 */
  sourceVideoPath: string;
  /** 话术全文（T11 仅作占位，真实 CosyVoice TTS 后续接入时使用） */
  scriptText: string;
  /** 合成产物绝对路径（如 uploads/lives/{liveId}.mp4） */
  outputPath: string;
  /** 目标直播时长（秒），路由层已 clamp 到 [10, 3600] */
  durationSeconds: number;
  /** 角标文字，缺省用合规默认文案 */
  badgeText?: string;
}

/** 合成结果：产物路径 + 时长 + 文件字节数 */
export interface ComposeResult {
  outputPath: string;
  durationSeconds: number;
  fileSizeBytes: number;
}

/**
 * 推流引擎服务接口（T11 只做本地合成，不推流 / 不接 RTMP）。
 * MVP 阶段用本地 FFmpeg mock 实现；未来接云端转码 / 真实 TTS 时保持该接口不变，
 * 仅在工厂函数中切换实现。
 */
export interface StreamingService {
  /** 合成直播视频：源视频循环 + TTS 音轨 + 合规角标 → 本地 mp4 文件 */
  composeLive(input: ComposeInput): Promise<ComposeResult>;
}

// ---------- mock 实现 ----------

/**
 * 本地 FFmpeg 合成实现：
 * - TTS mock：用 ffmpeg sine 正弦音轨（440Hz）落盘占位，真实 CosyVoice TTS 后续替换；
 * - 合成：-stream_loop -1 循环源视频 + sine 音轨 + drawtext 中文角标 + -t 目标时长；
 * - Windows 路径转义：drawtext 的 fontfile 内冒号须写成 \:，字体路径用系统字体 simhei.ttf。
 */
export class MockStreamingService implements StreamingService {
  /**
   * FFmpeg 定位三级规则：
   * 1. process.env.FFMPEG_PATH（显式指定，最优先）；
   * 2. path.resolve(process.cwd(), 'bin', 'ffmpeg.exe')（项目自带）；
   * 3. 系统 PATH 中的 ffmpeg（生产 / CI 环境）。
   * 三级都探测不到时抛 FFMPEG_NOT_FOUND。
   */
  resolveFfmpegPath(): string {
    const candidates: string[] = [];
    if (process.env.FFMPEG_PATH) {
      candidates.push(process.env.FFMPEG_PATH);
    }
    candidates.push(resolve(process.cwd(), 'bin', 'ffmpeg.exe'));
    const pathDirs = (process.env.PATH ?? '').split(';').filter((dir) => dir.length > 0);
    for (const dir of pathDirs) {
      candidates.push(join(dir, 'ffmpeg.exe'));
      candidates.push(join(dir, 'ffmpeg'));
    }
    for (const candidate of candidates) {
      if (existsSync(candidate)) {
        return candidate;
      }
    }
    throw new StreamingError(
      'FFMPEG_NOT_FOUND',
      '未找到 FFmpeg：请配置 FFMPEG_PATH，或确认 server/bin/ffmpeg.exe / 系统 PATH 可用',
    );
  }

  /**
   * TTS mock：用 ffmpeg sine 正弦音轨（440Hz，时长 = durationSeconds）生成占位音频文件。
   * scriptText 参数保留给未来真实 TTS 使用，mock 阶段不参与生成。
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

  /** 合成直播视频：源视频循环 + TTS 音轨 + 合规角标 → 本地 mp4（同步跑 FFmpeg） */
  async composeLive(input: ComposeInput): Promise<ComposeResult> {
    const ffmpegPath = this.resolveFfmpegPath();
    if (!existsSync(input.sourceVideoPath)) {
      throw new StreamingError('COMPOSE_FAILED', `源视频文件不存在：${input.sourceVideoPath}`);
    }
    mkdirSync(dirname(input.outputPath), { recursive: true });

    // TTS 音轨（mock sine 占位）：产物同目录落盘，合成完成后清理
    const ttsTrackPath = join(
      dirname(input.outputPath),
      `${basename(input.outputPath, extname(input.outputPath))}-tts.wav`,
    );
    try {
      this.generateTtsTrack(input.scriptText, ttsTrackPath, input.durationSeconds);

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
        '-i',
        ttsTrackPath,
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
      // 中间 TTS 占位音轨不入库，无论成败都清理，避免 uploads 目录堆积临时文件
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
 * 推流引擎工厂：T11 无第三方密钥依赖，恒返回本地 FFmpeg 实现；
 * 未来接入真实 CosyVoice TTS / 云端转码时在此切换 RealStreamingService。
 */
export function createStreamingService(): StreamingService {
  return new MockStreamingService();
}

// 全局单例：prepare 合成流程各处共用同一实现
export const streamingService = createStreamingService();
