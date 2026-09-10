import { and, eq } from 'drizzle-orm';
import { db } from '../db/client';
import {
  atmosphereSettings as atmosphereSettingsTable,
  atmosphereTemplates as atmosphereTemplatesTable,
  lives as livesTable,
} from '../db/schema';
import {
  ATMOSPHERE_FREQUENCY_RULES,
  ATMOSPHERE_INSERT_PRIORITY,
  type AtmosphereCategory,
  type AtmosphereInsertion,
  isAtmosphereCategory,
  pickAtmosphereText,
} from './atmosphere';

// 空档插播调度（M10-A2/A3）：开播时读一次「已启用氛围语 + 频率设置」快照，
// 循环台本引擎（services/loopCaster.ts）在台本句之间的空档调用 pickDue 取一条到期台词，
// 实际出声后由调用方 markSpoken 记账刷新该类别计时。
// 内存态与 loopCaster 同口径：进程重启不恢复，结束直播即停（唯一停止入口）。
// 口径见 docs/ATMOSPHERE-INTERACTION-PLAN.md §5/§6。

/** 单类别快照：候选文案（多行模板原样保留，渲染时再挑行）+ 间隔秒数 + 上次实际插播时间 */
interface CategorySnapshot {
  texts: string[];
  intervalSeconds: number;
  lastSpokenAtMs: number | null;
}

/** 单场次快照：仅保留「已启用且不在静音档」的类别 */
interface LiveSnapshot {
  categories: Map<AtmosphereCategory, CategorySnapshot>;
}

/** 调度器依赖：生产读真实 DB；测试注入替身快照，不碰库 */
export interface AtmosphereSchedulerOptions {
  /** 加载某场次的氛围语快照（null = 无可用氛围语） */
  loadSnapshot?(liveId: string): Promise<LiveSnapshotData | null>;
  /** 随机源（测试注入固定序列） */
  random?(): number;
  /** 时钟（测试注入假时钟） */
  now?(): number;
}

/** 快照数据（DB 行 → 内存结构的中间态，便于纯函数单测） */
export interface LiveSnapshotData {
  categories: SnapshotCategoryInput[];
}

/** 快照输入行：某类别的候选文案与频率（intervalSeconds = 0 表示该类静音，会被丢弃） */
export interface SnapshotCategoryInput {
  category: AtmosphereCategory;
  texts: string[];
  intervalSeconds: number;
}

export interface AtmosphereScheduler {
  /** 开播：异步加载快照（幂等，重复 start 忽略）；加载失败/无内容视为该类不可用 */
  start(liveId: string): void;
  /** 结束直播：清理快照与频控记账（幂等） */
  stop(liveId: string): void;
  /** 快照是否就绪（监控 / 测试用） */
  isReady(liveId: string): boolean;
  /** 取一条到期的插播台词：未就绪 / 无到期 / 无可渲染候选 → null */
  pickDue(liveId: string, nowMs: number): AtmosphereInsertion | null;
  /** 记账：一条插播实际出声后调用，按类别刷新计时 */
  markSpoken(liveId: string, category: AtmosphereCategory, atMs: number): void;
}

/** 把快照输入行收敛成内存结构：丢弃静音档（0 秒）、空文案、未知类别，重复类别后者覆盖前者 */
export function buildCategorySnapshots(
  categories: readonly SnapshotCategoryInput[],
): Map<AtmosphereCategory, CategorySnapshot> {
  const map = new Map<AtmosphereCategory, CategorySnapshot>();
  for (const entry of categories) {
    if (!isAtmosphereCategory(entry.category)) {
      continue;
    }
    if (!Number.isFinite(entry.intervalSeconds) || entry.intervalSeconds <= 0) {
      continue;
    }
    const texts = entry.texts.filter((text) => typeof text === 'string' && text.trim().length > 0);
    if (texts.length === 0) {
      continue;
    }
    map.set(entry.category, {
      texts,
      intervalSeconds: entry.intervalSeconds,
      lastSpokenAtMs: null,
    });
  }
  return map;
}

/**
 * 默认快照加载：liveId → 归属商家 → 已启用氛围语 + 频率设置。
 * 无频率行时回落该类默认档位；类别没有文案或频率为 0 的由 buildCategorySnapshots 丢弃。
 */
export async function loadLiveAtmosphereSnapshot(
  liveId: string,
): Promise<LiveSnapshotData | null> {
  const liveRows = await db
    .select({ userId: livesTable.userId })
    .from(livesTable)
    .where(eq(livesTable.id, liveId))
    .limit(1);
  const userId = liveRows[0]?.userId;
  if (!userId) {
    return null;
  }

  const templateRows = await db
    .select({ category: atmosphereTemplatesTable.category, text: atmosphereTemplatesTable.text })
    .from(atmosphereTemplatesTable)
    .where(
      and(
        eq(atmosphereTemplatesTable.userId, userId),
        eq(atmosphereTemplatesTable.enabled, true),
      ),
    );

  const settingRows = await db
    .select({
      category: atmosphereSettingsTable.category,
      intervalSeconds: atmosphereSettingsTable.intervalSeconds,
    })
    .from(atmosphereSettingsTable)
    .where(eq(atmosphereSettingsTable.userId, userId));

  if (templateRows.length === 0) {
    return null;
  }

  const intervalByCategory = new Map<string, number>();
  for (const row of settingRows) {
    intervalByCategory.set(row.category, row.intervalSeconds);
  }

  const textsByCategory = new Map<AtmosphereCategory, string[]>();
  for (const row of templateRows) {
    if (!isAtmosphereCategory(row.category)) {
      continue;
    }
    const bucket = textsByCategory.get(row.category) ?? [];
    bucket.push(row.text);
    textsByCategory.set(row.category, bucket);
  }

  const categories: SnapshotCategoryInput[] = [];
  for (const category of ATMOSPHERE_INSERT_PRIORITY) {
    const texts = textsByCategory.get(category);
    if (!texts || texts.length === 0) {
      continue;
    }
    categories.push({
      category,
      texts,
      intervalSeconds:
        intervalByCategory.get(category) ?? ATMOSPHERE_FREQUENCY_RULES[category].defaultSeconds,
    });
  }
  return { categories };
}

/** 引擎工厂：快照加载可注入；测试全替身，不碰 DB、不出真实声音 */
export function createAtmosphereScheduler(
  options: AtmosphereSchedulerOptions = {},
): AtmosphereScheduler {
  const loadSnapshot = options.loadSnapshot ?? loadLiveAtmosphereSnapshot;
  const random = options.random ?? Math.random;
  const now = options.now ?? (() => Date.now());

  const snapshots = new Map<string, LiveSnapshot>();

  function start(liveId: string): void {
    // 幂等：同一场次已有快照（加载中/已就绪）一律忽略
    if (snapshots.has(liveId)) {
      return;
    }
    const placeholder: LiveSnapshot = { categories: new Map() };
    snapshots.set(liveId, placeholder);
    void (async () => {
      try {
        const data = await loadSnapshot(liveId);
        // 加载期间被 stop（快照已被清掉）→ 丢弃结果，避免「停播后又冒出来」
        if (snapshots.get(liveId) !== placeholder) {
          return;
        }
        if (!data) {
          return;
        }
        const categories = buildCategorySnapshots(data.categories);
        // 首插也要等满一个间隔：以开播时刻为计时起点
        const startedAtMs = now();
        for (const entry of categories.values()) {
          entry.lastSpokenAtMs = startedAtMs;
        }
        placeholder.categories = categories;
      } catch (err) {
        console.warn(
          `[atmosphere] 场次 ${liveId} 氛围语快照加载失败，本场不插播：${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    })();
  }

  function stop(liveId: string): void {
    snapshots.delete(liveId);
  }

  function isReady(liveId: string): boolean {
    return (snapshots.get(liveId)?.categories.size ?? 0) > 0;
  }

  function pickDue(liveId: string, nowMs: number): AtmosphereInsertion | null {
    const snapshot = snapshots.get(liveId);
    if (!snapshot) {
      return null;
    }
    for (const category of ATMOSPHERE_INSERT_PRIORITY) {
      const entry = snapshot.categories.get(category);
      if (!entry) {
        continue;
      }
      // 频控：未满间隔的机会直接跳过，但继续尝试更低优先级类别（不同类别各自计时）
      if (
        entry.lastSpokenAtMs !== null &&
        nowMs - entry.lastSpokenAtMs < entry.intervalSeconds * 1000
      ) {
        continue;
      }
      const text = pickAtmosphereText(entry.texts.join('\n'), { nowMs }, random);
      if (text === null) {
        continue;
      }
      return { category, text };
    }
    return null;
  }

  function markSpoken(liveId: string, category: AtmosphereCategory, atMs: number): void {
    const entry = snapshots.get(liveId)?.categories.get(category);
    if (!entry) {
      return;
    }
    entry.lastSpokenAtMs = atMs;
  }

  return { start, stop, isReady, pickDue, markSpoken };
}

/** 全局单例：routes/lives 开播启停 + loopCaster 空档取词共用 */
export const atmosphereScheduler = createAtmosphereScheduler();
