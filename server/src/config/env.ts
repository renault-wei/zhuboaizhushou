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

// JWT 基础密钥（必填）：商家端默认命名空间使用
const jwtSecret = requireEnv('JWT_SECRET');
// 后台命名空间 JWT 独立密钥：生产建议显式配置 ADMIN_JWT_SECRET 强随机值；
// 未配置时用商家端密钥派生一个独立子串，保证两端 token 无法互相冒用
const adminJwtSecret = optionalEnv('ADMIN_JWT_SECRET') ?? `${jwtSecret}:admin`;

export const env = {
  // 服务基础
  NODE_ENV: process.env.NODE_ENV ?? 'development',
  HOST: process.env.HOST ?? '0.0.0.0',
  PORT: intEnv('PORT', 3000),
  LOG_LEVEL: process.env.LOG_LEVEL ?? 'info',
  // JWT：登录态签名密钥（必填；生产必须替换为强随机值，严禁硬编码）
  JWT_SECRET: jwtSecret,
  // 后台管理员命名空间 JWT 配置（内部运营工具，只允许预置账号登录）
  admin: {
    jwtSecret: adminJwtSecret,
    // 初始管理员账号（npm run admin:seed 使用；口令只从环境变量读取，不留默认值）
    initialUsername: optionalEnv('ADMIN_INITIAL_USERNAME'),
    initialPassword: optionalEnv('ADMIN_INITIAL_PASSWORD'),
  },

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
    // 出声通道：pc = 本机播放（默认，开发自测 / 音频转接线接开播手机）；phone = 交远程出声队列（助播机轮询拉取，需二期客户端配套）
    output: optionalEnv('LIVE_SPEAKER_OUTPUT') ?? 'pc',
    // Windows 本机音色名（可选）：不填用内置默认女声
    localTtsVoice: optionalEnv('LOCAL_TTS_VOICE'),
    // TTS 通道：local = Windows 本机 SAPI（默认，保出声）；volc = 火山豆包语音（需账号已开通模型服务）
    ttsProvider: optionalEnv('LIVE_TTS_PROVIDER') ?? 'local',
  },

  // 火山引擎（豆包语音）TTS：G5 商用音色旁路（CosyVoice 降为备选）
  // 适配器已落地（volcTTS.ts），key 已接线：liveSpeaker 在 LIVE_TTS_PROVIDER=volc 且 key 非空时切换，
  // 其余情况回退本机 SAPI 保出声（火山模型服务开通前请保持默认 local）。
  volcTTS: {
    // 火山语音控制台 API Key（https://console.volcengine.com/speech/new/setting/apikeys）
    apiKey: optionalEnv('VOLC_TTS_API_KEY'),
    // 服务基址：默认官方地址，测试 / 代理环境可覆盖
    baseUrl: optionalEnv('VOLC_TTS_BASE_URL') ?? 'https://openspeech.bytedance.com',
    // 合成资源 ID：豆包语音合成大模型 2.0
    resourceId: optionalEnv('VOLC_TTS_RESOURCE_ID') ?? 'seed-tts-2.0',
    // 默认音色（发音人 ID）：火山官方示例通用音色；正式使用前按音色列表替换（文档 6561/1257544）
    speaker: optionalEnv('VOLC_TTS_SPEAKER') ?? 'zh_female_vv_uranus_bigtts',
    // 采样率：官方可选 8000/16000/22050/24000/32000/44100/48000
    sampleRate: intEnv('VOLC_TTS_SAMPLE_RATE', 24000),
    // 语速：范围 [-50, 100]，0 为正常语速
    speechRate: intEnv('VOLC_TTS_SPEECH_RATE', 0),
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
