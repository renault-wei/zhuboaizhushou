import { unlink } from 'node:fs/promises';
import { env } from '../src/config/env';
import { SENSITIVE_GUARD_PROMPT } from '../src/services/sensitive';
import { createVoicePlayer } from '../src/services/voicePlayer';
import { createVolcTtsSynth } from '../src/services/volcTTS';

// 双人对谈台本 + 双音色语音输出冒烟：
// 1. 真调 DeepSeek 生成一集「火锅团购带货 × 双人一问一答」台本（角色 A / B，严格 JSON）；
// 2. 按角色用两个火山音色（女主播 / 男店长）逐句合成并播到系统默认播放设备。
// 用途：验证「AI 台本成熟度 + 双角色对谈 + 双音色连续出声」整条链路。
// 注意：只做链路验证，不入库、不重复跑敏感词扫描（提示词已带合规约束，尽量一次生成合规）。

/** 虚构演示门店（仅链路验证口径，不编造商品信息） */
const DEMO_CONTEXT = [
  '【门店背景】老灶火锅（社区店），主打牛油红汤锅底和当天鲜切牛肉。',
  '【团购套餐】双人火锅套餐 99 元：含 1 份牛油红汤锅底、鲜切牛肉拼盘、手打虾滑、鸭血毛肚拼盘、自助蘸料 2 份。',
  '【卖点口径】牛油锅底麻辣鲜香；牛肉当天现切；虾滑 Q 弹；毛肚涮十秒口感好。',
  '【直播节奏】开场欢迎 → 店长讲锅底和招牌菜 → 主播报团购价与内容 → 店长补体验 → 主播引导下单和收藏 → 收尾。',
].join('\n');

/** 双角色定义：谁在用哪个火山音色、以什么身份说话 */
const ROLES = {
  A: { name: '女主播', speaker: 'zh_female_vv_uranus_bigtts' },
  B: { name: '男店长', speaker: 'zh_male_m191_uranus_bigtts' },
} as const;

/** 语速档（火山 speech_rate：正值加快，实测 0→8040ms / +40→5928ms / -40→13368ms 同文 42 字） */
const LIVE_SPEECH_RATE = 15;
/** 句间停顿（ms）：原 700 偏拖沓，调小后更贴近真人一问一答 */
const TURN_PAUSE_MS = 350;

type RoleKey = keyof typeof ROLES;

interface Turn {
  role: RoleKey;
  text: string;
}

function buildSystemPrompt(): string {
  return (
    '你是一名本地餐饮直播间的对谈编排师，专门把一场带货拆成「双人一问一答」的口播台本。' +
    '本集主题：火锅店 99 元双人团购套餐带货。' +
    '角色：A = 女主播（负责开场欢迎、报福利、引导下单收藏）；B = 火锅店店长（负责讲锅底、菜品与真实体验）。' +
    '要求：' +
    '1. 一共 10 句左右，A、B 尽量交替出现，形成一问一答的自然对话感；' +
    '2. 每句 15-55 字，口语化、像真人主播在直播间说话，允许少量语气词（嗯、咱们、哎、是不是）；' +
    '3. 只使用【】里提供的套餐与卖点口径，不得编造价格、分量、功效等新信息；' +
    '4. 按直播节奏推进：欢迎 → 讲锅底和招牌菜 → 报团购价和内容 → 店长补体验 → 引导点击团购/收藏 → 收尾；' +
    '5. 只输出一个严格 JSON 数组，不要输出任何解释或代码块。数组元素格式：' +
    '{"role":"A 或 B","text":"这一句的台词"}' +
    '\n\n' +
    SENSITIVE_GUARD_PROMPT
  );
}

/** 真调 DeepSeek，最多试 2 次拿可用对谈台本 */
async function generateDuoScript(): Promise<Turn[]> {
  const { apiKey, baseUrl, model } = env.deepseek;
  if (!apiKey) {
    throw new Error('未配置 DEEPSEEK_API_KEY');
  }
  const messages = [
    { role: 'system', content: buildSystemPrompt() },
    { role: 'user', content: DEMO_CONTEXT },
  ];

  let lastError = '';
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    let response: Response;
    try {
      response = await fetch(baseUrl + '/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          messages,
          temperature: 0.9,
          max_tokens: 2048,
        }),
      });
    } catch (err) {
      throw new Error('调用 DeepSeek 失败：' + (err as Error).message);
    }
    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).trim().slice(0, 200);
      throw new Error('DeepSeek 返回异常状态 ' + response.status + (detail ? '：' + detail : ''));
    }
    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: unknown } }>;
    };
    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || content.trim().length === 0) {
      throw new Error('DeepSeek 未返回台本内容');
    }
    try {
      return parseTurns(content);
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      console.warn('第 ' + attempt + ' 次生成格式不可用（' + lastError + '），重试一次');
    }
  }
  throw new Error('DeepSeek 两次都未返回可用双人台本：' + lastError);
}

/** 宽容解析：去掉代码块围栏，只取第一个 [ 到最后一个 ] 的 JSON 数组 */
function parseTurns(raw: string): Turn[] {
  let text = raw.trim();
  const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)```\s*$/);
  if (fenced && fenced[1]) {
    text = fenced[1].trim();
  }
  const first = text.indexOf('[');
  const last = text.lastIndexOf(']');
  if (first === -1 || last === -1 || last <= first) {
    throw new Error('未找到 JSON 数组');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(first, last + 1));
  } catch {
    throw new Error('JSON 解析失败');
  }
  if (!Array.isArray(parsed) || parsed.length < 4 || parsed.length > 16) {
    throw new Error('句数需在 4-16 之间，实际 ' + (Array.isArray(parsed) ? parsed.length : '非数组'));
  }
  const turns: Turn[] = [];
  parsed.forEach((element, index) => {
    if (typeof element !== 'object' || element === null) {
      throw new Error('第 ' + (index + 1) + ' 句不是对象');
    }
    const record = element as Record<string, unknown>;
    const roleRaw = typeof record.role === 'string' ? record.role.trim().toUpperCase() : '';
    const role = roleRaw === 'A' || roleRaw === 'B' ? roleRaw : null;
    const textValue = typeof record.text === 'string' ? record.text.trim() : '';
    if (!role) {
      throw new Error('第 ' + (index + 1) + ' 句角色必须是 A 或 B，实际：' + String(record.role));
    }
    if (textValue.length < 2 || textValue.length > 120) {
      throw new Error('第 ' + (index + 1) + ' 句字数需在 2-120 之间');
    }
    turns.push({ role, text: textValue });
  });
  return turns;
}

async function main(): Promise<void> {
  console.log('步骤 1/2：DeepSeek 生成火锅团购双人对谈台本…');
  const turns = await generateDuoScript();
  console.log('生成成功，共 ' + turns.length + ' 句：');
  for (const turn of turns) {
    console.log('  [' + ROLES[turn.role].name + '] ' + turn.text);
  }

  const player = createVoicePlayer();
  const synths = {
    A: createVolcTtsSynth({ speaker: ROLES.A.speaker, speechRate: LIVE_SPEECH_RATE }),
    B: createVolcTtsSynth({ speaker: ROLES.B.speaker, speechRate: LIVE_SPEECH_RATE }),
  };

  console.log('步骤 2/2：逐句火山合成并出声…');
  let failedCount = 0;
  for (let i = 0; i < turns.length; i += 1) {
    const turn = turns[i];
    if (turn === undefined) {
      continue;
    }
    const roleInfo = ROLES[turn.role];
    const label = i + 1 + '/' + turns.length + ' [' + roleInfo.name + '·' + roleInfo.speaker + ']';
    try {
      const { wavPath } = await synths[turn.role].synthesize(turn.text);
      console.log(label + ' 合成完成，播放中：' + turn.text);
      const outcome = await player.enqueue(wavPath);
      if (outcome !== 'played') {
        failedCount += 1;
        console.warn(label + ' 未实际播出（' + outcome + '）');
      }
      await unlink(wavPath).catch(() => undefined);
    } catch (err) {
      failedCount += 1;
      console.error(label + ' 合成/播放失败：' + (err instanceof Error ? err.message : String(err)));
    }
    // 句间留一个自然停顿，形成对谈感
    if (i < turns.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, TURN_PAUSE_MS));
    }
  }

  if (failedCount > 0) {
    console.error('完成，但有 ' + failedCount + ' 句失败（详见上方）。');
    process.exitCode = 1;
  } else {
    console.log('全部完成：双人对谈台本已由 DeepSeek 生成，并用火山女/男双音色连续播出。');
  }
}

void main().catch((err: unknown) => {
  console.error('双人对谈语音冒烟失败：' + (err instanceof Error ? err.message : String(err)));
  process.exitCode = 1;
});
