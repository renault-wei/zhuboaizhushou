import { sql } from 'drizzle-orm';
import { db } from '../db/client';

// app_config（服务端开关）读取与归一化（console-roadmap v0.3 M5）
// 白名单 Key + 默认值：无行时用默认；管理端写只允许白名单 Key，读做类型归一避免脏数据进业务。

export interface PricePack {
  /** 档位时长（小时，正整数） */
  hours: number;
  /** 档位价格，单位：分 */
  amountCents: number;
}

export interface PublicAppConfig {
  /** 商家端是否展示充值入口 */
  showCharge: boolean;
  /** 服务端下发的时长档位（扫码直充可选档） */
  pricePacks: PricePack[];
  /** 公告弹窗文案（空串 = 不弹） */
  notice: string;
  /** 直播分钟扣减优先级（默认先时长余额后免费直播分钟） */
  quotaPriority: Array<'balance' | 'quota'>;
}

export const APP_CONFIG_DEFAULTS: PublicAppConfig = {
  showCharge: true,
  // 占位档位（本地自用验收用；金额可在后台改，运营拍板前不代表真实售价）
  pricePacks: [
    { hours: 1, amountCents: 990 },
    { hours: 10, amountCents: 8990 },
  ],
  notice: '',
  quotaPriority: ['balance', 'quota'],
};

export const APP_CONFIG_KEYS = [
  'showCharge',
  'pricePacks',
  'notice',
  'quotaPriority',
] as const;

export type AppConfigKey = (typeof APP_CONFIG_KEYS)[number];

export type ConfigNormalizeResult = { error: string } | { value: unknown };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 白名单校验 + 类型归一：非法值返回错误码（管理端写 400），合法值转成规范结构 */
export function normalizeConfigValue(key: AppConfigKey, raw: unknown): ConfigNormalizeResult {
  if (key === 'showCharge') {
    return typeof raw === 'boolean' ? { value: raw } : { error: 'CONFIG_VALUE_INVALID' };
  }
  if (key === 'notice') {
    return typeof raw === 'string' && raw.trim().length <= 500
      ? { value: raw.trim() }
      : { error: 'CONFIG_VALUE_INVALID' };
  }
  if (key === 'pricePacks') {
    if (!Array.isArray(raw) || raw.length === 0 || raw.length > 20) {
      return { error: 'CONFIG_VALUE_INVALID' };
    }
    const packs: PricePack[] = [];
    for (const item of raw) {
      if (!isRecord(item)) {
        return { error: 'CONFIG_VALUE_INVALID' };
      }
      const hours = item.hours;
      const amountCents = item.amountCents;
      if (
        !Number.isInteger(hours) ||
        (hours as number) <= 0 ||
        !Number.isInteger(amountCents) ||
        (amountCents as number) <= 0
      ) {
        return { error: 'CONFIG_VALUE_INVALID' };
      }
      packs.push({ hours: hours as number, amountCents: amountCents as number });
    }
    return { value: packs };
  }
  if (key === 'quotaPriority') {
    if (!Array.isArray(raw) || raw.length === 0 || raw.length > 2) {
      return { error: 'CONFIG_VALUE_INVALID' };
    }
    const order = new Set(raw);
    if (
      order.size !== raw.length ||
      raw.some((item) => item !== 'balance' && item !== 'quota')
    ) {
      return { error: 'CONFIG_VALUE_INVALID' };
    }
    return { value: raw as Array<'balance' | 'quota'> };
  }
  return { error: 'CONFIG_KEY_INVALID' };
}

/** 读全量开关：默认值 + 库内白名单覆盖（读时再做一次归一，脏数据自动回落默认） */
export async function readAppConfig(): Promise<PublicAppConfig> {
  const rows = await db.execute(sql`SELECT key, value FROM app_config`);
  const byKey = new Map<string, unknown>();
  for (const row of rows.rows) {
    byKey.set(row.key as string, row.value);
  }
  const out = { ...APP_CONFIG_DEFAULTS } as Record<string, unknown>;
  for (const key of APP_CONFIG_KEYS) {
    const raw = byKey.get(key);
    if (raw === undefined) {
      continue;
    }
    const normalized = normalizeConfigValue(key, raw);
    if (!('error' in normalized)) {
      out[key] = normalized.value;
    }
  }
  return out as unknown as PublicAppConfig;
}

/** 商家端读到的配置（未来可在此做字段裁剪 / 白标维度扩展） */
export async function readPublicAppConfig(): Promise<PublicAppConfig> {
  return readAppConfig();
}
