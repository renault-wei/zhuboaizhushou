import { access, copyFile, mkdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { VOLC_PRESET_VOICES } from '../src/services/volcPresets';
import { createVolcTtsSynth } from '../src/services/volcTTS';
import {
  resolveVoicePreviewDir,
  VOICE_PREVIEW_TEXT,
  voicePreviewFileName,
} from '../src/services/voicePreview';

// 预设音色试听音频预生成（试听方案 A · 构建脚本）：
// - 目的：把预设音色的固定演示句一次性合成落盘，App 试听直接播静态 URL，不再每次点都真合成；
// - 默认 dry-run：只打印将生成的清单，不调火山（不花钱）；确认后加 `--write` 才真合成；
// - 语速取合成器默认档（VOLC_TTS_SPEECH_RATE，默认 -10 ≈ 接近真人主播），与场次默认口径一致；
// - 已存在文件默认跳过（断点续跑），`--force` 覆盖重生成；`--only=id1,id2` 只补指定音色；
// - 计费：按合成字符计（约 44 条 × 30 字 ≈ 1320 字符），一次性成本极低。

interface BuildOptions {
  /** 真合成并落盘（缺省只 dry-run） */
  write: boolean;
  /** 覆盖已存在文件（缺省跳过） */
  force: boolean;
  /** 只生成指定音色 id（空集 = 全部） */
  only: Set<string>;
}

function addOnly(only: Set<string>, raw: string): void {
  for (const id of raw.split(',')) {
    const trimmed = id.trim();
    if (trimmed.length > 0) {
      only.add(trimmed);
    }
  }
}

function parseArgs(argv: string[]): BuildOptions {
  const options: BuildOptions = { write: false, force: false, only: new Set<string>() };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';
    if (arg === '--write') {
      options.write = true;
    } else if (arg === '--force') {
      options.force = true;
    } else if (arg.startsWith('--only=')) {
      addOnly(options.only, arg.slice('--only='.length));
    } else if (arg === '--only') {
      addOnly(options.only, argv[i + 1] ?? '');
    } else if (arg.length > 0) {
      console.warn(`忽略未知参数：${arg}`);
    }
  }
  return options;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const dir = resolveVoicePreviewDir();
  const targets = VOLC_PRESET_VOICES.filter(
    (preset) => options.only.size === 0 || options.only.has(preset.id),
  );

  if (options.only.size > 0) {
    const known = new Set(VOLC_PRESET_VOICES.map((preset) => preset.id));
    const missing = [...options.only].filter((id) => !known.has(id));
    if (missing.length > 0) {
      console.warn(`--only 中有未知音色 id：${missing.join(', ')}`);
    }
  }

  console.log(`试听产物目录：${dir}`);
  console.log(`音色条数：${targets.length}（演示句 ${VOICE_PREVIEW_TEXT.length} 字）`);

  if (!options.write) {
    for (const preset of targets) {
      console.log(`  · ${preset.id} → ${voicePreviewFileName(preset.id)}`);
    }
    console.log('dry-run 结束（未调火山、未写文件）。确认后重跑：npm run preview:build -- --write');
    return;
  }

  const synth = createVolcTtsSynth();
  await mkdir(dir, { recursive: true });
  let generated = 0;
  let skipped = 0;
  let failed = 0;

  for (const preset of targets) {
    const target = join(dir, voicePreviewFileName(preset.id));
    if (!options.force && (await exists(target))) {
      skipped += 1;
      continue;
    }
    try {
      const { wavPath } = await synth.synthesize(VOICE_PREVIEW_TEXT, { speaker: preset.id });
      try {
        await copyFile(wavPath, target);
      } finally {
        await unlink(wavPath).catch(() => undefined);
      }
      generated += 1;
      console.log(`  ✓ ${preset.name}（${preset.id}）`);
    } catch (err) {
      failed += 1;
      console.error(`  ✗ ${preset.id}：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log(`完成：生成 ${generated} / 跳过 ${skipped} / 失败 ${failed}`);
  if (failed > 0) {
    process.exitCode = 1;
  }
}

void main().catch((err: unknown) => {
  console.error(`试听产物生成失败：${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
