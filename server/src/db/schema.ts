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

// 订单类型（v0.3 商业化）：subscription = 订阅（历史），recharge = 充值（扫码直充 / 卡密核销）
export const orderKindEnum = pgEnum('order_kind', ['subscription', 'recharge']);

// 订单渠道（v0.3 商业化）：manual = 运营人工确权，alipay_scan = 服务端扫码直充，card = 卡密核销
export const orderChannelEnum = pgEnum('order_channel', ['manual', 'alipay_scan', 'card']);

// 卡密批次状态：active = 可核销，disabled = 停用（停用后存量卡密拒绝核销）
export const cardBatchStatusEnum = pgEnum('card_batch_status', ['active', 'disabled']);

// 卡密状态：unused = 未核销，redeemed = 已核销，revoked = 已作废
export const cardCodeStatusEnum = pgEnum('card_code_status', ['unused', 'redeemed', 'revoked']);

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
    // 录音样本：原始文件、时长（应 >= 1 分钟）、内容指纹（用于去重与审计）
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
    // 火山预设音色 id（可选）：与 voice_id 克隆音色互斥，选预设则不绑定克隆
    volcPresetId: varchar('volc_preset_id', { length: 64 }),
    voiceId: uuid('voice_id').references(() => voices.id, { onDelete: 'set null' }),
    scriptId: uuid('script_id').references(() => scripts.id, { onDelete: 'set null' }),
    // 绑定的循环台本（M1 起）：开播时读取一次快照驻内存，中途改台本库不影响进行中场次
    loopScriptId: uuid('loop_script_id').references(() => loopScripts.id, { onDelete: 'set null' }),
    status: liveStatusEnum('status').notNull().default('idle'),
    // “AI 智能直播”角标已叠加记录（合规要求：强制叠加，不提供关闭入口，逻辑层禁止篡改）
    aiBadgeShown: boolean('ai_badge_shown').notNull().default(true),
    startedAt: timestamp('started_at', { withTimezone: true }),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    ...timestamps(),
  },
  (table) => [index('lives_user_id_idx').on(table.userId), index('lives_status_idx').on(table.status)],
);

// ---------- loop_scripts：循环台本库（商家可复用；场次通过 lives.loopScriptId 引用）----------
export const loopScripts = pgTable(
  'loop_scripts',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    title: varchar('title', { length: 100 }).notNull(),
    // 生成来源话术（可选）：保留溯源；台本内容快照在 items，来源话术后续修改不影响台本
    sourceScriptId: uuid('source_script_id').references(() => scripts.id, { onDelete: 'set null' }),
    ...timestamps(),
  },
  (table) => [index('loop_scripts_user_id_idx').on(table.userId)],
);

// ---------- loop_script_items：台本条目（有序短台词，随台本级联删除）----------
export const loopScriptItems = pgTable(
  'loop_script_items',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    loopScriptId: uuid('loop_script_id')
      .notNull()
      .references(() => loopScripts.id, { onDelete: 'cascade' }),
    // 从 1 起的播放顺序（整体替换时按下标重建）
    seq: integer('seq').notNull(),
    // 段落类型：opening/product/coupon/warmup/closing/custom（宽松存储，未知一律存 null）
    kind: varchar('kind', { length: 20 }),
    text: text('text').notNull(),
    // 本条播完后的间隔秒数：null = 用全局默认（6s）
    gapAfterSeconds: integer('gap_after_seconds'),
    ...timestamps(),
  },
  (table) => [
    uniqueIndex('loop_script_items_script_seq_unique').on(table.loopScriptId, table.seq),
    index('loop_script_items_loop_script_idx').on(table.loopScriptId),
  ],
);

// ---------- atmosphere_templates：氛围台词库（竞品「氛围语」复刻：welcome/follow/thumb/clock/custom）----------
// 循环播报空档自动插播的短句（如欢迎、感谢关注、感谢点赞、整点报时、自定义暖场），
// 支持 {昵称} 占位（播报时按上下文替换）。入库前必过敏感词扫描，命中 400 不落库（合规红线）。
export const atmosphereTemplates = pgTable(
  'atmosphere_templates',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // 类别：welcome = 欢迎 / follow = 关注引导 / thumb = 点赞互动 / clock = 整点报时 / custom = 自定义
    category: varchar('category', { length: 20 }).notNull(),
    text: text('text').notNull(),
    // 开关：关掉后循环引擎跳过该句（保留内容，方便直播中临时停用）
    enabled: boolean('enabled').notNull().default(true),
    // 敏感词扫描留痕（合规红线：落库前必扫，命中拦截级词一律拒绝保存，故库内恒为 pass）
    sensitiveCheckStatus: sensitiveCheckStatusEnum('sensitive_check_status')
      .notNull()
      .default('pass'),
    sensitiveMatchedWords: jsonb('sensitive_matched_words').notNull().default([]),
    sensitiveScannedAt: timestamp('sensitive_scanned_at', { withTimezone: true }),
    ...timestamps(),
  },
  (table) => [index('atmosphere_templates_user_id_idx').on(table.userId)],
);
// ---------- live_danmaku：直播弹幕日志（T13 只读 + G3 弹幕网关写入）----------
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

// ---------- orders：订单（微信支付单号 / 金额 / 状态；v0.3 增 kind/channel/hours/minutes）----------
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
    // 订单类型：subscription = 订阅（历史），recharge = 充值（v0.3 起）
    kind: orderKindEnum('kind').notNull().default('subscription'),
    // 订单渠道：manual = 运营人工确权 / alipay_scan = 服务端扫码直充 / card = 卡密核销
    channel: orderChannelEnum('channel').notNull().default('manual'),
    // 订阅档位
    plan: varchar('plan', { length: 20 }).notNull().default('monthly'),
    // 充值档位展示小时数（kind=recharge；卡密不足 1 小时按 0 展示，精确入账看 minutes）
    hours: integer('hours'),
    // 精确充值分钟数（kind=recharge 入账依据：扫码单 = hours*60，卡密单 = 批次单张分钟）
    minutes: integer('minutes'),
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

// ---------- hour_balance_accounts：时长余额账户（v0.3：预充时长，跨月不清零）----------
// 每用户一行（懒创建：首次入账时建档）；按「AI 在线 / 轮播分钟」扣减，
// 余额耗尽后回落当月免费直播分钟（口径见 services/ledger.ts）
export const hourBalanceAccounts = pgTable(
  'hour_balance_accounts',
  {
    userId: uuid('user_id')
      .primaryKey()
      .references(() => users.id, { onDelete: 'cascade' }),
    // 剩余时长，单位：分钟
    balanceMinutes: integer('balance_minutes').notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
);

// ---------- hour_balance_ledger：时长余额流水（每次入账 / 扣减一条，含变动后余额）----------
export const hourBalanceLedger = pgTable(
  'hour_balance_ledger',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // 变动分钟数：正 = 入账，负 = 扣减
    deltaMinutes: integer('delta_minutes').notNull(),
    // 变动后余额（分钟），便于对账与审计
    balanceAfterMinutes: integer('balance_after_minutes').notNull(),
    // 来源：recharge_order = 充值单入账，card_redeem = 卡密核销，live_deduct = 直播扣减，admin_adjust = 运营调整
    sourceKind: varchar('source_kind', { length: 30 }).notNull(),
    // 来源对象 id（订单 / 卡密批次等）
    sourceId: text('source_id'),
    remark: varchar('remark', { length: 200 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('hour_balance_ledger_user_created_idx').on(table.userId, table.createdAt),
    index('hour_balance_ledger_source_idx').on(table.sourceKind, table.sourceId),
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

// ---------- tts_audio_cache：TTS 分句音频缓存（按 user 隔离；命中旁路真实合成）----------
// 键 = (userId, voiceKey, rate, textSha256)：voiceKey = 火山预设 id / 克隆 voiceId（互斥归一口径同 lives）；
// 命中不调供应商、不写 usage_logs、不扣 ttsCharsUsed；产物 wav 存 server/data/tts-cache，行内只存相对路径。
export const ttsAudioCache = pgTable(
  'tts_audio_cache',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // 音色键：火山预设 = volcPresetId；克隆 = voiceId（与 lives 归一取值一致）
    voiceKey: varchar('voice_key', { length: 64 }).notNull(),
    // 语速档：对齐火山 speech_rate [-50, 100]，0 为正常语速
    rate: integer('rate').notNull().default(0),
    // 台本条目文本 sha256（改一个字即 miss，天然处理改稿失效）
    textSha256: varchar('text_sha256', { length: 64 }).notNull(),
    // 原始文本快照（便于排查命中/失效）
    text: text('text').notNull(),
    // 缓存文件相对路径（相对 tts 缓存根目录，见 env.ttsCache.dir）
    audioPath: text('audio_path').notNull(),
    // 真实合成字符数（T5 计量口径：按行内字符核对 usage_logs）
    chars: integer('chars').notNull(),
    // 命中统计（懒清理兜底排序依据；不进实时展示）
    hitCount: integer('hit_count').notNull().default(0),
    lastHitAt: timestamp('last_hit_at', { withTimezone: true }),
    ...timestamps(),
  },
  (table) => [
    uniqueIndex('tts_audio_cache_voice_text_unique').on(
      table.userId,
      table.voiceKey,
      table.rate,
      table.textSha256,
    ),
    index('tts_audio_cache_user_idx').on(table.userId),
  ],
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

// ---------- card_batches：卡密批次（v0.3：线下 / 渠道分发，每张 = N 分钟时长）----------
export const cardBatches = pgTable(
  'card_batches',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    name: varchar('name', { length: 100 }).notNull(),
    // 本批次生成的卡密总张数（生成后不再变动）
    totalCount: integer('total_count').notNull(),
    // 单张卡密可核销的时长，单位：分钟
    minutesPerCard: integer('minutes_per_card').notNull(),
    status: cardBatchStatusEnum('status').notNull().default('active'),
    remark: varchar('remark', { length: 200 }),
    // 创建人（后台运营）；运营账号删除时保留批次
    createdBy: uuid('created_by').references(() => adminUsers.id, { onDelete: 'set null' }),
    ...timestamps(),
  },
  (table) => [index('card_batches_created_by_idx').on(table.createdBy)],
);

// ---------- card_codes：卡密（批次外键 / 唯一卡密 / 核销状态）----------
export const cardCodes = pgTable(
  'card_codes',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    batchId: uuid('batch_id')
      .notNull()
      .references(() => cardBatches.id, { onDelete: 'cascade' }),
    // 卡密原文（含分组短横线），核销时统一大写归一后比对
    code: varchar('code', { length: 40 }).notNull(),
    status: cardCodeStatusEnum('status').notNull().default('unused'),
    // 核销商家与时间（status=redeemed 时回填）
    redeemedByUserId: uuid('redeemed_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    redeemedAt: timestamp('redeemed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('card_codes_code_unique').on(table.code),
    index('card_codes_batch_id_idx').on(table.batchId),
    index('card_codes_status_idx').on(table.status),
  ],
);

// ---------- app_config：服务端开关（key→jsonb，v0.3：充值入口显隐 / 时长档位 / 公告 / 扣减优先级）----------
// 本期只做全局开关；Key 结构预留 merchant 维度（OEM 谈单后另立白标隔离）。
export const appConfig = pgTable(
  'app_config',
  {
    key: varchar('key', { length: 64 }).primaryKey(),
    value: jsonb('value').notNull(),
    updatedBy: uuid('updated_by').references(() => adminUsers.id, { onDelete: 'set null' }),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
);
