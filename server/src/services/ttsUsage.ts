import { sql } from 'drizzle-orm';
import { db } from '../db/client';
import { ensureMonthlyQuotaRow, readCurrentPeriod } from './quota';

// T5 TTS 计量服务（只记真实新合成，缓存命中不扣不写）：
// - 口径：缓存 miss 触发真实合成 → 先原子守门扣 tts_chars_used（超配额拒绝），再写 usage_logs 一条；
// - 命中旁路（findCachedTtsAudio 直接返回）不进入本服务，因此 usage_logs 可反推每小时新合成量；
// - 单位：chars 为合成字符数，costCents 为单次成本（分）；本地/mock 阶段记 0，真实计费由调用方传入。

export interface RecordTtsUsageInput {
  userId: string;
  /** 本次真实合成字符数（与 ttsCache.countTtsChars 同口径） */
  chars: number;
  /** 计费服务方：默认 volc（火山豆包语音） */
  provider?: string;
  /** 模型 / 资源 ID：默认 seed-tts-2.0 */
  model?: string;
  /** 单次真实合成成本（分）：默认 0，真实计费接线后由成本核算传入 */
  costCents?: number;
}

export type RecordTtsUsageResult =
  | { ok: true; period: string }
  | { ok: false; reason: 'quota_exceeded' };

/**
 * 记录一次真实 TTS 合成：扣减当月字符额度并落 usage_logs（原子守门，超额不放行）。
 * 返回 false 语义与 bumpScriptGenerationUsed 对齐：该瞬间额度已耗尽，调用方应拒绝继续合成。
 */
export async function recordTtsUsage(
  input: RecordTtsUsageInput,
): Promise<RecordTtsUsageResult> {
  if (!Number.isInteger(input.chars) || input.chars <= 0) {
    throw new Error('tts 计量字符数必须为正整数');
  }
  const period = await readCurrentPeriod();
  await ensureMonthlyQuotaRow(input.userId, period);
  const provider = input.provider ?? 'volc';
  const model = input.model ?? 'seed-tts-2.0';
  const costCents = input.costCents ?? 0;

  const charged = await db.execute(sql`
    UPDATE quotas
    SET tts_chars_used = tts_chars_used + ${input.chars}, updated_at = now()
    WHERE user_id = ${input.userId} AND period = ${period}
      AND tts_chars_used + ${input.chars} <= tts_chars_quota
  `);
  if ((charged.rowCount ?? 0) === 0) {
    return { ok: false, reason: 'quota_exceeded' };
  }
  await db.execute(sql`
    INSERT INTO usage_logs (user_id, category, provider, model, output_chars, cost_cents, status)
    VALUES (${input.userId}, 'tts', ${provider}, ${model}, ${input.chars}, ${costCents}, 'success')
  `);
  return { ok: true, period };
}
