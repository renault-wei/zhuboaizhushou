// 数据库核心表结构（S0 定稿，9 张表见 docs/DEV-SPRINTS.md 附录）
// 表结构变更须通过 server/drizzle 迁移文件落地，禁止直接改表
import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

// ---------- 公共枚举 ----------

// 用户订阅状态：free = 未付费（走免费额度），paid = 已订阅
export const subscriptionStatusEnum = pgEnum('subscription_status', ['free', 'paid']);

// 音色克隆状态：CosyVoice 克隆为异步任务
export const voiceStatusEnum = pgEnum('voice_status', ['pending', 'processing', 'ready', 'failed']);

// 话术状态：draft = 编辑中，ready = 可开播，blocked = 敏感词拦截
export const scriptStatusEnum = pgEnum('script_status', ['draft', 'ready', 'blocked']);

// 敏感词扫描结果：pass = 通过，blocked = 命中拦截级词
export const sensitiveCheckStatusEnum = pgEnum('sensitive_check_status', ['pass', 'blocked']);

// 直播状态：idle = 已创建，processing = 合成中，ready = 开播配置完成，live = 直播中，ended = 已结束，failed = 合成失败
export const liveStatusEnum = pgEnum('live_status', [
  'idle',
  'processing',
  'ready',
  'live',
  'ended',
  'failed',
]);

// 订单状态：pending = 待支付，paid = 已支付，refunded = 已退款，closed = 已关闭
export const orderStatusEnum = pgEnum('order_status', ['pending', 'paid', 'refunded', 'closed']);

// 用量流水类别：每次 AI 调用一条记录
export const usageCategoryEnum = pgEnum('usage_category', [
  'voice_clone',
  'tts',
  'script_generation',
  'sensitive_check',
]);

// 后台管理员角色
export const adminRoleEnum = pgEnum('admin_role', ['super_admin', 'operator']);

// 每张表调用一次，生成独立的时间戳列（列构建器不可跨表复用）
function timestamps() {
  return {
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  };
}

// ---------- users：用户（手机号 / 抖音绑定 / 订阅状态）----------
export const users = pgTable(
  'users',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    phone: varchar('phone', { length: 20 }).notNull(),
    nickname: varchar('nickname', { length: 50 }),
    avatarUrl: text('avatar_url'),
    // 抖音开放平台 OAuth 绑定信息
    douyinOpenId: text('douyin_open_id'),
    douyinAccessToken: text('douyin_access_token'),
    douyinRefreshToken: text('douyin_refresh_token'),
    douyinTokenExpiresAt: timestamp('douyin_token_expires_at', { withTimezone: true }),
    // 订阅状态与到期时间
    subscriptionStatus: subscriptionStatusEnum('subscription_status').notNull().default('free'),
    subscriptionExpiresAt: timestamp('subscription_expires_at', { withTimezone: true }),
    ...timestamps(),
  },
  (table) => [
    uniqueIndex('users_phone_unique').on(table.phone),
    uniqueIndex('users_douyin_open_id_unique').on(table.douyinOpenId),
  ],
);

// ---------- voices：音色（provider_voice_id / 授权协议存档 / 样本指纹）----------
export const voices = pgTable(
  'voices',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 50 }).notNull(),
    provider: varchar('provider', { length: 30 }).notNull().default('cosyvoice'),
    // CosyVoice 返回的 voice_id，克隆成功后写入
    providerVoiceId: text('provider_voice_id').notNull(),
    status: voiceStatusEnum('status').notNull().default('pending'),
    // 《声音授权协议》存档（合规红线：克隆前必须先签署并存档）
    agreementPdfPath: text('agreement_pdf_path'),
    agreementSignedAt: timestamp('agreement_signed_at', { withTimezone: true }),
    // 录音样本：原始文件、时长（应 >= 3 分钟）、内容指纹（用于去重与审计）
    sampleUrl: text('sample_url'),
    sampleDurationSeconds: integer('sample_duration_seconds'),
    sampleFingerprint: text('sample_fingerprint'),
    ...timestamps(),
  },
  (table) => [
    uniqueIndex('voices_provider_voice_id_unique').on(table.providerVoiceId),
    index('voices_user_id_idx').on(table.userId),
  ],
);

// ---------- voice_agreements：《声音授权协议》签署存档（合规红线：克隆前必须先签署并存档）----------
// MVP 存档口径：签署记录只落数据库（协议版本号 + 协议全文快照 + 签署时间 + IP + User-Agent），
// 供克隆/直播前校验与审计追溯；PDF 渲染导出推迟到 T19 后台存档列表，不在此阶段生成。
export const voiceAgreements = pgTable(
  'voice_agreements',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // 签署时展示并同意的协议版本，如 1.0
    agreementVersion: varchar('agreement_version', { length: 20 }).notNull(),
    // 签署时的协议全文快照，防止版本改版后产生争议
    contentSnapshot: text('content_snapshot').notNull(),
    signedAt: timestamp('signed_at', { withTimezone: true }).notNull(),
    // 来源 IP（兼容 IPv6 最长 45 字符）
    signedIp: varchar('signed_ip', { length: 45 }).notNull(),
    userAgent: text('user_agent').notNull(),
  },
  (table) => [
    // 同一用户同一版本仅保留一条记录，配合服务端先查后插实现重复签署幂等
    uniqueIndex('voice_agreements_user_version_unique').on(table.userId, table.agreementVersion),
    index('voice_agreements_user_id_idx').on(table.userId),
  ],
);

// ---------- scripts：话术（行业 / 商品快照 / 内容 / 敏感词扫描结果）----------
export const scripts = pgTable(
  'scripts',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    industry: varchar('industry', { length: 30 }).notNull(),
    title: varchar('title', { length: 100 }),
    // 商品快照：团购券名称 / 套餐 / 价格 / 卖点，生成话术时固化，避免券信息变更影响历史记录
    productSnapshot: jsonb('product_snapshot').notNull(),
    // 话术全文
    content: text('content').notNull(),
    status: scriptStatusEnum('status').notNull().default('draft'),
    // 敏感词扫描（合规红线：生成后、开播前必须扫描；命中拦截级词置 blocked）
    sensitiveCheckStatus: sensitiveCheckStatusEnum('sensitive_check_status'),
    sensitiveMatchedWords: jsonb('sensitive_matched_words'),
    sensitiveScannedAt: timestamp('sensitive_scanned_at', { withTimezone: true }),
    ...timestamps(),
  },
  (table) => [index('scripts_user_id_idx').on(table.userId)],
);

// ---------- lives：直播记录（画面源 / 券 ID / 音色 / 话术 / 开始结束 / 状态）----------
export const lives = pgTable(
  'lives',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // 直播名称，便于后台展示，如“火锅店午市循环直播”
    title: varchar('title', { length: 100 }),
    // 实景画面源（上传视频的存储地址）
    videoSourceUrl: text('video_source_url').notNull(),
    // 抖音团购券 ID（OAuth 拉取后绑定）
    couponId: text('coupon_id'),
    // 推流地址（抖音 RTMP，mock 阶段可为空，先本地合成）
    rtmpUrl: text('rtmp_url'),
    voiceId: uuid('voice_id').references(() => voices.id, { onDelete: 'set null' }),
    scriptId: uuid('script_id').references(() => scripts.id, { onDelete: 'set null' }),
    status: liveStatusEnum('status').notNull().default('idle'),
    // “AI 智能直播”角标已叠加记录（合规要求：强制叠加，不提供关闭入口，逻辑层禁止篡改）
    aiBadgeShown: boolean('ai_badge_shown').notNull().default(true),
    startedAt: timestamp('started_at', { withTimezone: true }),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    ...timestamps(),
  },
  (table) => [index('lives_user_id_idx').on(table.userId), index('lives_status_idx').on(table.status)],
);

// ---------- live_danmaku：直播弹幕日志（T13 只读，真实来源待抖音推流接入）----------
export const liveDanmaku = pgTable(
  'live_danmaku',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    liveId: uuid('live_id')
      .notNull()
      .references(() => lives.id, { onDelete: 'cascade' }),
    // 弹幕内容
    content: text('content').notNull(),
    // 发送者昵称（抖音观众，可空）
    senderNickname: varchar('sender_nickname', { length: 50 }),
    // 弹幕到达时间
    sentAt: timestamp('sent_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('live_danmaku_live_id_idx').on(table.liveId),
    index('live_danmaku_sent_at_idx').on(table.sentAt),
  ],
);

// ---------- orders：订单（微信支付单号 / 金额 / 状态）----------
export const orders = pgTable(
  'orders',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // 商户侧订单号（生成规则由支付模块定义）
    orderNo: varchar('order_no', { length: 64 }).notNull(),
    // 微信支付单号（回调返回后回填）
    wxTransactionId: varchar('wx_transaction_id', { length: 64 }),
    // 订阅档位
    plan: varchar('plan', { length: 20 }).notNull().default('monthly'),
    // 金额，单位：分（避免浮点误差）
    amountCents: integer('amount_cents').notNull(),
    status: orderStatusEnum('status').notNull().default('pending'),
    paidAt: timestamp('paid_at', { withTimezone: true }),
    ...timestamps(),
  },
  (table) => [
    uniqueIndex('orders_order_no_unique').on(table.orderNo),
    uniqueIndex('orders_wx_transaction_id_unique').on(table.wxTransactionId),
    index('orders_user_id_idx').on(table.userId),
  ],
);

// ---------- quotas：额度（TTS 字符 / 话术次数 / 直播分钟数，月度重置）----------
export const quotas = pgTable(
  'quotas',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // 月度周期，如 2026-09；每月重置时新起一行
    period: varchar('period', { length: 7 }).notNull(),
    // TTS 合成字符数（TTS + 克隆试听等）
    ttsCharsQuota: integer('tts_chars_quota').notNull().default(0),
    ttsCharsUsed: integer('tts_chars_used').notNull().default(0),
    // 话术生成次数
    scriptGenerationsQuota: integer('script_generations_quota').notNull().default(0),
    scriptGenerationsUsed: integer('script_generations_used').notNull().default(0),
    // 直播分钟数
    liveMinutesQuota: integer('live_minutes_quota').notNull().default(0),
    liveMinutesUsed: integer('live_minutes_used').notNull().default(0),
    ...timestamps(),
  },
  (table) => [uniqueIndex('quotas_user_period_unique').on(table.userId, table.period)],
);

// ---------- usage_logs：用量流水（每次 AI 调用一条，含成本）----------
export const usageLogs = pgTable(
  'usage_logs',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    category: usageCategoryEnum('category').notNull(),
    // 实际服务方：deepseek / cosyvoice / douyin（mock 阶段可记 local）
    provider: varchar('provider', { length: 30 }).notNull(),
    model: varchar('model', { length: 50 }),
    promptChars: integer('prompt_chars').notNull().default(0),
    outputChars: integer('output_chars').notNull().default(0),
    // 单次调用成本，单位：分；本地 mock 调用记 0
    costCents: integer('cost_cents').notNull().default(0),
    // 调用结果：success / error
    status: varchar('status', { length: 20 }).notNull().default('success'),
    errorMessage: text('error_message'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('usage_logs_user_id_idx').on(table.userId),
    index('usage_logs_created_at_idx').on(table.createdAt),
  ],
);

// ---------- admin_users：后台管理员 ----------
export const adminUsers = pgTable(
  'admin_users',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    username: varchar('username', { length: 50 }).notNull(),
    // 口令只存哈希（bcrypt 等），禁止明文
    passwordHash: text('password_hash').notNull(),
    role: adminRoleEnum('role').notNull().default('operator'),
    isActive: boolean('is_active').notNull().default(true),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    ...timestamps(),
  },
  (table) => [uniqueIndex('admin_users_username_unique').on(table.username)],
);

// ---------- audit_logs：审计日志（运营 / 合规操作留痕）----------
export const auditLogs = pgTable(
  'audit_logs',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    // 操作管理员（后台内置数据不开放注册，删除时保留日志）
    adminUserId: uuid('admin_user_id').references(() => adminUsers.id, { onDelete: 'set null' }),
    // 被操作的商家用户（可空：如系统级操作）
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    // 动作标识，如 voice_clone.approved / script.blocked / live.started
    action: varchar('action', { length: 100 }).notNull(),
    resourceType: varchar('resource_type', { length: 50 }),
    resourceId: text('resource_id'),
    // 操作上下文快照（请求摘要 / 变更前后值等）
    detail: jsonb('detail'),
    // 来源 IP（兼容 IPv6 最长 45 字符）
    ip: varchar('ip', { length: 45 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('audit_logs_created_at_idx').on(table.createdAt),
    index('audit_logs_admin_user_id_idx').on(table.adminUserId),
  ],
);
