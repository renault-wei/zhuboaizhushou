import { eq } from 'drizzle-orm';

import { db } from '../db/client';
import {
  lives as livesTable,
  loopScriptItems as loopScriptItemsTable,
} from '../db/schema';
import type { SpeechOverrides } from './liveSpeaker';
import { resolveLiveSynth } from './liveSpeaker';
import { loadLiveTtsCacheContext } from './liveVoice';
import { findCachedTtsAudio, storeCachedTtsAudio } from './ttsCache';

// R69：**开播前语音预生成**。
//
// 为什么需要（2026-09-22 凌晨实测）：
//   原先台本「说一句 → 实时合成一句」。火山一旦抽风（那次返回 45000030
//   requested resource not granted），**整晚 80 条全失败、直播零音频** ✗。
//   每念一句都是一次外部调用，也就每句都是一个失效点 ✗。
//
// 预生成把这件事挪到开播【之前】：
//   开播前把整本台本逐句合成好落缓存 ✓
//   开播后 speak 命中缓存 → **一次都不调火山** ✓
//   （缓存查询在阶段一已接好：liveSpeaker.speak 的 TtsCacheContext）

export interface PrewarmFailure {
  /** 台本里的序号，便于界面指给商家看 */
  seq: number;
  text: string;
  reason: string;
}

export interface PrewarmResult {
  total: number;
  /** 命中已有缓存（无需合成） */
  hit: number;
  /** 本次新合成 */
  generated: number;
  /** 失败的句子 —— **非空即代表开播前体检应拦截** */
  failed: PrewarmFailure[];
}

/** 取该场次绑定的循环台本条目（按 seq）。无台本 → 空数组。 */
async function loadLoopItems(
  loopScriptId: string | null,
): Promise<{ seq: number; text: string }[]> {
  if (!loopScriptId) {
    return [];
  }
  const rows = await db
    .select({
      seq: loopScriptItemsTable.seq,
      text: loopScriptItemsTable.text,
    })
    .from(loopScriptItemsTable)
    .where(eq(loopScriptItemsTable.loopScriptId, loopScriptId))
    .orderBy(loopScriptItemsTable.seq);
  return rows.map((row) => ({ seq: row.seq, text: row.text }));
}

/**
 * 预热一场直播的全部台本语音。
 *
 * 设计取舍：
 *   · **串行**合成，不并发 —— 火山有 QPS 限制，打爆了会把正常业务一起拖下水 ✗
 *   · 命中缓存即跳过 —— 所以**重复调用是廉价且幂等**的 ✓
 *     （这正是「保存台本时预热 + 开播前补漏」两次触发能共存的原因）
 *   · 单句失败不中断整轮 —— 要拿到**完整**的失败清单给商家看 ✓
 */
export async function prewarmLiveSpeech(
  liveId: string,
): Promise<PrewarmResult> {
  const rows = await db
    .select({
      loopScriptId: livesTable.loopScriptId,
      volcPresetId: livesTable.volcPresetId,
      speechRate: livesTable.speechRate,
    })
    .from(livesTable)
    .where(eq(livesTable.id, liveId))
    .limit(1);
  const live = rows[0];
  if (!live) {
    return { total: 0, hit: 0, generated: 0, failed: [] };
  }

  const items = await loadLoopItems(live.loopScriptId);
  const result: PrewarmResult = {
    total: items.length,
    hit: 0,
    generated: 0,
    failed: [],
  };
  if (items.length === 0) {
    // 未绑定台本：开播只回弹幕，没有可预生成的循环句（正常流程不出现）
    return result;
  }

  const context = await loadLiveTtsCacheContext(liveId);
  if (!context) {
    // 取不到上下文（场次刚被删 / 读库失败）→ 全部记为失败，让开播前体检拦住 ✗
    for (const item of items) {
      result.failed.push({
        seq: item.seq,
        text: item.text,
        reason: '无法解析本场音色与商家信息',
      });
    }
    return result;
  }

  const synth = resolveLiveSynth();
  const overrides: SpeechOverrides = {
    speaker: context.voiceKey === 'default' ? undefined : context.voiceKey,
    speechRate: context.rate,
  };

  for (const item of items) {
    const text = item.text.trim();
    if (text.length === 0) {
      continue;
    }
    try {
      const cached = await findCachedTtsAudio({ ...context, text }).catch(
        () => null,
      );
      if (cached) {
        result.hit += 1;
        continue;
      }
      const { wavPath } = await synth.synthesize(text, overrides);
      await storeCachedTtsAudio({ ...context, text }, wavPath).catch(
        () => null,
      );
      result.generated += 1;
    } catch (err) {
      result.failed.push({
        seq: item.seq,
        text: item.text,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return result;
}
