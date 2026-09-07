// 商业化档位常量（自用阶段口径，数值可运营调整；后续迁配置表/后台配置页）
// - free：免费试用档，商家首次调用第三方 AI 时按此档自动建档（console-roadmap M4）
// - paid：付费订阅档（¥99/月），运营确权订单后刷新当月额度用（console-roadmap M2）
export const QUOTA_TIERS = {
  free: {
    ttsCharsQuota: 500_000,
    scriptGenerationsQuota: 300,
    liveMinutesQuota: 20_000,
  },
  paid: {
    ttsCharsQuota: 3_000_000,
    scriptGenerationsQuota: 2_000,
    liveMinutesQuota: 100_000,
  },
} as const;

// 订阅档位与续期口径：¥99/月=9900 分，确权后顺延天数
export const SUBSCRIPTION_PLAN = {
  plan: 'monthly',
  amountCents: 9900,
  renewDays: 30,
} as const;
