# T9 · 团购券列表页（抖音 OAuth 拉券，mock 假数据）

## 目标

进入 S2 直播核心的第一步：打通「拉取抖音团购券」能力。MVP 阶段抖音开放平台团购 API 未审核通过，用 mock 假数据；但接口契约按真实异步拉券设计，未来接真实抖音团购 API 只改实现不改路由。

## 现状（已就绪）

- `server/src/db/schema.ts` 的 `lives` 表已预留 `couponId`（团购券 ID，OAuth 拉取后绑定）
- `server/src/services/douyin.ts` 已有「接口 + mock 工厂 + 单例」范式（T2），`users` 表已存抖音 open_id / access_token
- `server/src/routes/douyin.ts` 已有 bind/unbind/bind-status，鉴权 `app.authenticate`
- 客户端已有抖音绑定页、首页卡片范式（T2）、ApiClient dio 模式
- 团购券目前**无任何实现**（无表、无 service、无接口）

## 服务端任务

### 1. 新建 `src/services/coupon.ts` — 抖音团购券服务

参照 `douyin.ts` 范式：

- **券类型 `Coupon`**：
  ```ts
  interface Coupon {
    couponId: string;      // 抖音侧券 ID
    name: string;          // 券名，如「双人火锅套餐」
    package: string;       // 套餐内容
    price: number;         // 售价（分 或 元，统一用元，保留整数）
    originalPrice: number; // 原价
    sales: number;         // 已售数量
    imageUrl: string;      // 券图（mock 可用占位）
  }
  ```
- **接口 `DouyinCouponService`**：`getCoupons(openId: string): Promise<Coupon[]>`
- **`MockDouyinCouponService`**：返回固定的 4-6 张火锅店团购券（与 S1 话术验收场景呼应，如「双人火锅套餐 128 元 / 四人火锅套餐 268 元 / 招牌麻辣锅底 68 元 / 现切肥牛券 39 元 / 饮品畅饮券 19 元」），每个含合理 package/原价/销量。**由 openId 做轻度确定性扰动**（如券 ID 后拼接 openId 哈希前 4 位，便于测试断言与隔离）。
- **工厂 `createCouponService()` + 单例 `couponService`**：`DOUYIN_CLIENT_KEY` 未配置或 `MOCK_DOUYIN=true` → mock；配置了真实 key 未开 mock → 抛错提示「真实抖音团购 API 尚未接入（T9 仅 mock）」。

### 2. `src/routes/douyin.ts` 新增券接口

**`GET /api/douyin/coupons`**
- `preHandler: app.authenticate`；查当前用户抖音绑定状态，**未绑定 → `403 { error: 'DOUYIN_NOT_BOUND', message: '请先绑定抖音号' }`**（先绑定才能拉券）
- 调用 `couponService.getCoupons(openId)` → 返回 `{ coupons: Coupon[] }`

### 3. 测试 `tests/coupons.test.ts`（或并入 douyin 测试）

- 未登录 401
- 未绑定抖音 403
- 已绑定 → 返回 4-6 张券，字段完整（couponId/name/price/sales 非空）
- 券数量 ≥ 4

## 客户端任务

### 1. `core/models/coupon.dart`

`Coupon` 类：`couponId/name/package/price/originalPrice/sales/imageUrl` + `fromJson`；`discountText`（如「5.4折」）等便捷 getter 可选。

### 2. `ApiClient` 新增 `fetchCoupons()`

`GET /api/douyin/coupons` → `List<Coupon>`，沿用 dio + ApiException。

### 3. 团购券列表页 `features/coupons/presentation/coupon_list_page.dart`

- AppBar「团购券」；进入时拉取券列表
- 券卡片：券名、套餐内容、价格（¥ 醒目）、原价（划线）、已售、折扣标签；图片用「券名首字 + 渐变色块」占位（避免 mock 网络图依赖）
- 支持**点击选中并返回**：点券卡片 → `context.pop(coupon)`（供 T10 挂券时调用）；从首页进入时为浏览模式，也保留选中返回能力
- 未绑定抖音：提示「请先绑定抖音号」+ 去绑定按钮（跳 `/douyin-bind`）
- 空态 / 加载态 / 错误重试

### 4. 首页入口 + 路由 + provider

- 首页 `home_page.dart`：抖音账号卡片内或下方新增「团购券」入口，`context.push('/coupons')`
- 路由 `app_router.dart`：`/coupons`
- `providers.dart`：新增 coupon controller provider（如需，简单拉取可放页面 StatefulWidget，参照抖音卡片模式）

### 5. 测试

- Coupon 模型、券列表页 widget 测试（沿用 `test/fake_backend.dart` fake 注入）
- ASCII 镜像跑 analyze/test，sync 回后删镜像

## 验收标准

- 服务端 typecheck/lint/test 全绿（47 + 新增）
- 客户端 analyze 零 error，测试全过（54 + 新增）
- 端到端：登录 → 未绑抖音拉券 403 → 绑抖音 → 拉券返回 mock 券列表

## 注意

- 遵循 AGENTS.md 与现有「接口+mock工厂+单例」范式
- 券不落库（来自抖音，本地 lives.couponId 只存引用，T10 挂券时再处理快照）
- mock 券数据与火锅店场景呼应
- 完成后不 commit，留主控验收
