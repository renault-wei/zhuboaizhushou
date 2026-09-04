import { createHash } from 'node:crypto';
import { env } from '../config/env';

// ---------- 类型 ----------

/** 抖音团购券（MVP 阶段 mock 数据；未来接真实抖音生活服务 API 时结构不变） */
export interface Coupon {
  /** 抖音侧券 ID */
  couponId: string;
  /** 券名，如「双人火锅套餐」 */
  name: string;
  /** 套餐内容 */
  package: string;
  /** 售价（元，整数） */
  price: number;
  /** 原价（元，整数） */
  originalPrice: number;
  /** 已售数量 */
  sales: number;
  /** 券图（mock 阶段为空，客户端用色块占位） */
  imageUrl: string;
}

// ---------- 接口 ----------

/**
 * 抖音团购券服务接口。
 * MVP 阶段用本地 mock 实现；未来接入真实抖音生活服务团购 API 时
 * 保持该接口不变，仅在工厂函数中切换实现。
 */
export interface DouyinCouponService {
  /** 拉取某抖音账号下的团购券列表 */
  getCoupons(openId: string): Promise<Coupon[]>;
}

// ---------- mock 实现 ----------

/**
 * 内存 mock 抖音团购券：返回固定的火锅店团购券，与 S1 话术验收场景呼应。
 * 券 ID 由 openId 确定性扰动（sha256 前 4 位），保证不同账号券 ID 隔离、便于测试断言。
 */
export class MockDouyinCouponService implements DouyinCouponService {
  async getCoupons(openId: string): Promise<Coupon[]> {
    const suffix = createHash('sha256').update(openId).digest('hex').slice(0, 4);
    return [
      {
        couponId: `c-001-${suffix}`,
        name: '双人火锅套餐',
        package: '锅底1份+肥牛1份+羊肉1份+蔬菜拼盘1份+饮料2杯',
        price: 128,
        originalPrice: 238,
        sales: 1200,
        imageUrl: '',
      },
      {
        couponId: `c-002-${suffix}`,
        name: '四人火锅套餐',
        package: '锅底2份+肥牛2份+羊肉2份+海鲜拼盘1份+蔬菜拼盘2份+饮料4杯',
        price: 268,
        originalPrice: 468,
        sales: 860,
        imageUrl: '',
      },
      {
        couponId: `c-003-${suffix}`,
        name: '招牌麻辣锅底',
        package: '牛油麻辣锅底1份（2-4人）',
        price: 68,
        originalPrice: 98,
        sales: 2300,
        imageUrl: '',
      },
      {
        couponId: `c-004-${suffix}`,
        name: '现切肥牛券',
        package: '现切鲜肥牛1份（约200g）',
        price: 39,
        originalPrice: 59,
        sales: 3100,
        imageUrl: '',
      },
      {
        couponId: `c-005-${suffix}`,
        name: '饮品畅饮券',
        package: '酸梅汤/柠檬茶任选2杯',
        price: 19,
        originalPrice: 28,
        sales: 1500,
        imageUrl: '',
      },
    ];
  }
}

/**
 * 抖音团购券服务工厂。
 * - DOUYIN_CLIENT_KEY 未配置 或 MOCK_DOUYIN=true → 走 mock；
 * - 配置了真实 key 且未开 mock → 真实团购 API 尚未接入（T9 仅 mock），启动即报错。
 */
export function createCouponService(): DouyinCouponService {
  const useMock = !env.douyin.clientKey || env.douyin.forceMock;
  if (!useMock) {
    throw new Error(
      '已配置 DOUYIN_CLIENT_KEY 且未开启 MOCK_DOUYIN：真实抖音团购 API 尚未接入（T9 仅 mock），请先设置 MOCK_DOUYIN=true',
    );
  }
  return new MockDouyinCouponService();
}

// 全局单例
export const couponService = createCouponService();
