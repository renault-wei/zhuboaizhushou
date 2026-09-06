import 'dotenv/config';

// 环境变量集中读取与校验：所有密钥一律来自 .env / 环境变量，禁止硬编码

/** 读取必填环境变量，缺失直接抛错，避免服务带错配置启动 */
function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`缺少必需环境变量 ${name}，请复制 .env.example 为 .env 后填写`);
  }
  return value;
}

/** 读取可选环境变量，为空返回 undefined */
function optionalEnv(name: string): string | undefined {
  const value = process.env[name];
  return value !== undefined && value !== '' ? value : undefined;
}

/** 读取整数型环境变量（端口等） */
function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') {
    return fallback;
  }
  const num = Number(raw);
  if (!Number.isInteger(num)) {
    throw new Error(`环境变量 ${name} 必须是整数，当前值：${raw}`);
  }
  return num;
}

export const env = {
  // 服务基础
  NODE_ENV: process.env.NODE_ENV ?? 'development',
  HOST: process.env.HOST ?? '0.0.0.0',
  PORT: intEnv('PORT', 3000),
  LOG_LEVEL: process.env.LOG_LEVEL ?? 'info',
  // JWT：登录态签名密钥（必填；生产必须替换为强随机值，严禁硬编码）
  JWT_SECRET: requireEnv('JWT_SECRET'),

  // PostgreSQL（Drizzle ORM）
  DATABASE_URL: requireEnv('DATABASE_URL'),

  // DeepSeek：话术生成
  deepseek: {
    apiKey: optionalEnv('DEEPSEEK_API_KEY'),
    baseUrl: optionalEnv('DEEPSEEK_BASE_URL') ?? 'https://api.deepseek.com',
    // 话术生成模型：默认 deepseek-chat，可用 DEEPSEEK_MODEL 覆盖
    model: optionalEnv('DEEPSEEK_MODEL') ?? 'deepseek-chat',
  },

  // 阿里云 CosyVoice：声音克隆 + TTS
  cosyvoice: {
    apiKey: optionalEnv('COSYVOICE_API_KEY'),
    baseUrl: optionalEnv('COSYVOICE_BASE_URL'),
    model: optionalEnv('COSYVOICE_MODEL') ?? 'cosyvoice-v2',
    // MOCK_COSYVOICE=true：即使配置了真实 key 也强制走 mock（真实 CosyVoice 尚未接入，T5 仅 mock）
    forceMock: optionalEnv('MOCK_COSYVOICE') === 'true',
  },

  // G5 现场口播出口：临时用 Windows 本机语音出声（模式 B 现场互动），换商用/克隆音色只改这里
  liveSpeaker: {
    // 现场互动回复是否出声：默认开；非 Windows 平台自动不播（见 liveSpeaker.ts）
    enabled: optionalEnv('LIVE_SPEAKER_ENABLED') !== 'false',
    // Windows 本机音色名（可选）：不填用内置默认女声
    localTtsVoice: optionalEnv('LOCAL_TTS_VOICE'),
  },

  // 抖音开放平台：OAuth + 团购券 + 推流
  douyin: {
    clientKey: optionalEnv('DOUYIN_CLIENT_KEY'),
    clientSecret: optionalEnv('DOUYIN_CLIENT_SECRET'),
    redirectUri: optionalEnv('DOUYIN_REDIRECT_URI'),
    // MOCK_DOUYIN=true：即使配置了真实 client key 也强制走 mock（真实 key 下联调用）
    forceMock: optionalEnv('MOCK_DOUYIN') === 'true',
  },

  // 微信支付：订阅支付
  wxpay: {
    appId: optionalEnv('WXPAY_APPID'),
    mchId: optionalEnv('WXPAY_MCH_ID'),
    apiV3Key: optionalEnv('WXPAY_API_V3_KEY'),
    privateKeyPath: optionalEnv('WXPAY_PRIVATE_KEY_PATH'),
    certSerialNo: optionalEnv('WXPAY_CERT_SERIAL_NO'),
    notifyUrl: optionalEnv('WXPAY_NOTIFY_URL'),
  },
} as const;

export type Env = typeof env;
