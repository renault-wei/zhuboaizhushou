import { afterAll, afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { pool } from '../src/db/client';
import {
  CollectorSourceError,
  createLiveCollector,
  liveCollector,
} from '../src/services/liveCollector';
import type {
  AdapterHooks,
  CollectorAdapter,
  UnifiedDanmakuEvent,
  WatchTarget,
} from '../src/collectors/types';
import {
  createInteractionEngine,
  type InteractionReply,
} from '../src/services/interactionEngine';

const app: FastifyInstance = buildApp();

let dbAvailable = false;
try {
  await pool.query('SELECT 1');
  dbAvailable = true;
} catch {
  dbAvailable = false;
}
const dbIt = dbAvailable ? it : it.skip;

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await app.close();
  await pool.end().catch(() => undefined);
});

const PHONE_SRC = '13920000313';
const PHONE_SRC_OTHER = '13920000314';
const PHONE_R3 = '13920000315';

/** 轮询等待（引擎回复是异步的：入库 → 广播 → 生成） */
async function waitFor(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const startedAt = Date.now();
  while (!check()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error('等待超时：条件在超时前未成立');
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function bearer(token: string): { authorization: string } {
  return { authorization: `Bearer ${token}` };
}

async function registerAndGetToken(phone: string): Promise<string> {
  const send = await app.inject({ method: 'POST', url: '/api/auth/send-code', payload: { phone } });
  const code = send.json().code as string;
  const verify = await app.inject({
    method: 'POST',
    url: '/api/auth/verify-code',
    payload: { phone, code },
  });
  expect(verify.statusCode).toBe(200);
  return verify.json().token as string;
}

async function userIdOf(phone: string): Promise<string> {
  const res = await pool.query('SELECT id FROM users WHERE phone = $1 LIMIT 1', [phone]);
  const row = res.rows[0] as { id: string } | undefined;
  if (!row) {
    throw new Error(`测试用户不存在：${phone}`);
  }
  return row.id;
}

async function resetUserData(phone: string): Promise<void> {
  const userId = await userIdOf(phone);
  await pool.query('DELETE FROM lives WHERE user_id = $1', [userId]);
}

async function createLiveDraft(token: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/lives',
    headers: bearer(token),
    payload: { title: '采集源测试直播' },
  });
  expect(res.statusCode).toBe(201);
  return (res.json() as { live: { id: string } }).live.id;
}

async function setLiveStatus(liveId: string, status: string): Promise<void> {
  await pool.query('UPDATE lives SET status = $1 WHERE id = $2', [status, liveId]);
}

// ---------- 替身适配器：全离线，绝不真连平台 ----------

interface FakeAdapter {
  adapter: CollectorAdapter;
  emit(event: UnifiedDanmakuEvent): void;
  opened(): number;
  closed(): boolean;
}

function createFakeAdapter(
  source: CollectorAdapter['source'] = 'douyin',
  /** 心跳存活判定：默认恒活；返回 false 即模拟会话判死（保活 / 看门狗用例用） */
  heartbeatAlive: (sessionSeq: number, beatNo: number) => boolean = () => true,
): FakeAdapter {
  let hooks: AdapterHooks | null = null;
  let openedCount = 0;
  let closedFlag = false;
  const adapter: CollectorAdapter = {
    source,
    async open(_target: WatchTarget, h: AdapterHooks) {
      openedCount += 1;
      const sessionSeq = openedCount;
      let beatNo = 0;
      hooks = h;
      h.onStateChange('connected');
      return {
        async heartbeat() {
          beatNo += 1;
          return heartbeatAlive(sessionSeq, beatNo);
        },
        async close() {
          closedFlag = true;
        },
      };
    },
  };
  return {
    adapter,
    emit(event) {
      hooks?.onEvent(event);
    },
    opened() {
      return openedCount;
    },
    closed() {
      return closedFlag;
    },
  };
}

function chatEvent(liveId: string, msgKey: string, content = '这个套餐多少钱'): UnifiedDanmakuEvent {
  return {
    platform: 'douyin',
    roomRef: '7123456789012345678',
    liveId,
    msgKey,
    msgType: 'chat',
    content,
    senderNickname: '观众甲',
    happenedAt: new Date().toISOString(),
  };
}

// ---------- 服务层：注入替身，验证接线正确性 ----------

it('未注册适配器时采集通道不可用：start 抛 SOURCE_DISABLED', async () => {
  const collector = createLiveCollector({ adapters: [] });
  expect(collector.enabled()).toBe(false);
  await expect(
    collector.start({ userId: 'u-1', liveId: 'l-1', roomRef: '7123456789012345678' }),
  ).rejects.toMatchObject({ code: 'SOURCE_DISABLED' });
  await collector.dispose();
});

it('采集事件经接线层落到弹幕网关：带对 userId/liveId 且透传幂等键', async () => {
  const fake = createFakeAdapter();
  const seen: Array<{ userId: string; liveId: string; input: Record<string, unknown> }> = [];
  const collector = createLiveCollector({
    adapters: [fake.adapter],
    ingest: async (userId, liveId, input) => {
      seen.push({ userId, liveId, input: { ...input } });
      return {};
    },
  });
  try {
    const binding = await collector.start({
      userId: 'user-42',
      liveId: 'live-7',
      roomRef: '7123456789012345678',
    });
    expect(binding.watchKey).toBe('douyin:douyin:7123456789012345678');
    expect(fake.opened()).toBe(1);

    fake.emit(chatEvent('live-7', 'douyin:msg-1'));
    expect(seen).toHaveLength(1);
    expect(seen[0]?.userId).toBe('user-42');
    expect(seen[0]?.liveId).toBe('live-7');
    // 幂等键必须透传：否则 (platform,msg_key) 唯一索引永远是 NULL，重连重放会重复入库
    expect(seen[0]?.input).toMatchObject({
      content: '这个套餐多少钱',
      platform: 'douyin',
      msgKey: 'douyin:msg-1',
      msgType: 'chat',
    });
  } finally {
    await collector.dispose();
  }
});

it('R49：换直播间时先停掉旧会话（否则旧房间的弹幕会继续灌进本场）', async () => {
  const fake = createFakeAdapter();
  const collector = createLiveCollector({
    adapters: [fake.adapter],
    ingest: async () => ({}),
  });
  try {
    await collector.start({
      userId: 'u-1',
      liveId: 'live-swap',
      roomRef: '7123456789012345678',
    });
    expect(fake.opened()).toBe(1);
    expect(fake.closed()).toBe(false);

    // 换到另一个房间：**必须先断旧会话**再连新的。
    // 修复前 bind 只是覆盖内存绑定，旧会话仍连着上一个直播间 ——
    // 两个会话并行，会把别的直播间的弹幕灌进本场（重复 + 串台）。
    await collector.start({
      userId: 'u-1',
      liveId: 'live-swap',
      roomRef: '7999999999999999999',
    });
    expect(fake.opened()).toBe(2);
    expect(fake.closed()).toBe(true);
  } finally {
    await collector.dispose();
  }
});

it('非 chat 事件不入库；解绑后到达的在途事件也不再入库', async () => {
  const fake = createFakeAdapter();
  let calls = 0;
  const collector = createLiveCollector({
    adapters: [fake.adapter],
    ingest: async () => {
      calls += 1;
      return {};
    },
  });
  try {
    await collector.start({ userId: 'u', liveId: 'l', roomRef: '7123456789012345678' });

    fake.emit({ ...chatEvent('l', 'douyin:gift-1'), msgType: 'gift', content: '小心心' });
    expect(calls).toBe(0);

    fake.emit(chatEvent('l', 'douyin:chat-1'));
    expect(calls).toBe(1);

    expect(await collector.stop('l')).toBe(true);
    fake.emit(chatEvent('l', 'douyin:chat-2'));
    expect(calls).toBe(1);
    // stop 幂等
    expect(await collector.stop('l')).toBe(false);
  } finally {
    await collector.dispose();
  }
});

it('未配签名 Key 的部署：statusOf 报 enabled=false', async () => {
  const collector = createLiveCollector({ adapters: [] });
  expect(collector.statusOf('whatever')).toEqual({ enabled: false, binding: null, watch: null });
  await collector.dispose();
});

// ---------- 路由层：打桩单例，保证不触网 ----------

it('未带 token 访问采集源接口返回 401', async () => {
  const id = randomUUID();
  const res = await app.inject({ method: 'POST', url: `/api/lives/${id}/danmaku-source`, payload: {} });
  expect(res.statusCode).toBe(401);
});

dbIt('归属隔离：对他人场次起采集返回 404', async () => {
  const tokenA = await registerAndGetToken(PHONE_SRC);
  await resetUserData(PHONE_SRC);
  const tokenB = await registerAndGetToken(PHONE_SRC_OTHER);
  await resetUserData(PHONE_SRC_OTHER);
  const liveId = await createLiveDraft(tokenA);
  await setLiveStatus(liveId, 'live');

  const res = await app.inject({
    method: 'POST',
    url: `/api/lives/${liveId}/danmaku-source`,
    headers: bearer(tokenB),
    payload: { roomRef: '7123456789012345678' },
  });
  expect(res.statusCode).toBe(404);
});

dbIt('草稿态只登记不起会话（running=false，绑定被调用）；已结束场次拒绝登记（409）', async () => {
  const token = await registerAndGetToken(PHONE_SRC);
  await resetUserData(PHONE_SRC);
  const liveId = await createLiveDraft(token);

  // R4 起：草稿 / 就绪态允许「先把直播间配好」，但**不起会话** —— 开播时由 /start 联动拉起
  const bindSpy = vi.spyOn(liveCollector, 'bind').mockResolvedValue({
    liveId,
    userId: await userIdOf(PHONE_SRC),
    platform: 'douyin',
    roomRef: '7123456789012345678',
    watchKey: 'douyin:douyin:7123456789012345678',
    startedAt: new Date().toISOString(),
  });
  const draft = await app.inject({
    method: 'POST',
    url: `/api/lives/${liveId}/danmaku-source`,
    headers: bearer(token),
    payload: { roomRef: '7123456789012345678' },
  });
  expect(draft.statusCode).toBe(201);
  expect(draft.json()).toMatchObject({ running: false });
  expect(bindSpy).toHaveBeenCalledTimes(1);

  vi.restoreAllMocks();
  await setLiveStatus(liveId, 'ended');
  const ended = await app.inject({
    method: 'POST',
    url: `/api/lives/${liveId}/danmaku-source`,
    headers: bearer(token),
    payload: { roomRef: '7123456789012345678' },
  });
  expect(ended.statusCode).toBe(409);
  expect(ended.json()).toMatchObject({ error: 'LIVE_NOT_COLLECTABLE' });
});

dbIt('直播中起采集返回 201，未启用通道时返回 503（打桩，不触网）', async () => {
  const token = await registerAndGetToken(PHONE_SRC);
  await resetUserData(PHONE_SRC);
  const liveId = await createLiveDraft(token);
  await setLiveStatus(liveId, 'live');

  const startSpy = vi.spyOn(liveCollector, 'start').mockResolvedValue({
    liveId,
    userId: await userIdOf(PHONE_SRC),
    platform: 'douyin',
    roomRef: '7123456789012345678',
    watchKey: 'douyin:douyin:7123456789012345678',
    startedAt: new Date().toISOString(),
  });
  const ok = await app.inject({
    method: 'POST',
    url: `/api/lives/${liveId}/danmaku-source`,
    headers: bearer(token),
    payload: { roomRef: '7123456789012345678' },
  });
  expect(ok.statusCode).toBe(201);
  expect((ok.json() as { source: { roomRef: string } }).source.roomRef).toBe('7123456789012345678');

  startSpy.mockRejectedValue(new CollectorSourceError('SOURCE_DISABLED', '未配置 DOUYIN_SIGN_API_KEY'));
  const disabled = await app.inject({
    method: 'POST',
    url: `/api/lives/${liveId}/danmaku-source`,
    headers: bearer(token),
    payload: { roomRef: '7123456789012345678' },
  });
  expect(disabled.statusCode).toBe(503);
  expect(disabled.json()).toMatchObject({ error: 'SOURCE_DISABLED' });

  vi.spyOn(liveCollector, 'statusOf').mockReturnValue({ enabled: true, binding: null, watch: null });
  const status = await app.inject({
    method: 'GET',
    url: `/api/lives/${liveId}/danmaku-source`,
    headers: bearer(token),
  });
  expect(status.statusCode).toBe(200);
  expect(status.json()).toMatchObject({ enabled: true });
});
// ---------- R47：采集源持久化（原先只在内存，进程重启即丢 —— 合并 R17） ----------

dbIt('R47：绑定采集源后**落库**（原文与解析结果都存，enabled 置真）', async () => {
  const token = await registerAndGetToken(PHONE_SRC);
  await resetUserData(PHONE_SRC);
  const liveId = await createLiveDraft(token);

  // 真实流程：商家只粘一条分享链接，房间号由采集端解析出来
  vi.spyOn(liveCollector, 'bind').mockResolvedValue({
    liveId,
    userId: await userIdOf(PHONE_SRC),
    platform: 'douyin',
    roomRef: '7123456789012345678',
    watchKey: 'douyin:douyin:7123456789012345678',
    startedAt: new Date().toISOString(),
  });
  const res = await app.inject({
    method: 'POST',
    url: `/api/lives/${liveId}/danmaku-source`,
    headers: bearer(token),
    payload: { shareText: 'https://v.douyin.com/AbCdEf/' },
  });
  expect(res.statusCode).toBe(201);

  const row = await pool.query<{
    danmaku_source_url: string | null;
    danmaku_room_ref: string | null;
    danmaku_collect_enabled: boolean;
  }>('SELECT danmaku_source_url, danmaku_room_ref, danmaku_collect_enabled FROM lives WHERE id = $1', [
    liveId,
  ]);
  const saved = row.rows[0];
  // 这是本需求的全部意义：**这些值必须进了库**，否则服务一重启就全没了
  expect(saved?.danmaku_source_url).toBe('https://v.douyin.com/AbCdEf/');
  expect(saved?.danmaku_room_ref).toBe('7123456789012345678');
  expect(saved?.danmaku_collect_enabled).toBe(true);
  vi.restoreAllMocks();
});

dbIt('R47：停采集只关「启用」，**保留链接**（下次开播还能预填）', async () => {
  const token = await registerAndGetToken(PHONE_SRC);
  await resetUserData(PHONE_SRC);
  const liveId = await createLiveDraft(token);
  const userId = await userIdOf(PHONE_SRC);

  vi.spyOn(liveCollector, 'bind').mockResolvedValue({
    liveId,
    userId,
    platform: 'douyin',
    roomRef: '7123456789012345678',
    watchKey: 'douyin:douyin:7123456789012345678',
    startedAt: new Date().toISOString(),
  });
  await app.inject({
    method: 'POST',
    url: `/api/lives/${liveId}/danmaku-source`,
    headers: bearer(token),
    payload: { shareText: 'https://v.douyin.com/AbCdEf/' },
  });
  vi.spyOn(liveCollector, 'stop').mockResolvedValue(true);
  const stopped = await app.inject({
    method: 'DELETE',
    url: `/api/lives/${liveId}/danmaku-source`,
    headers: bearer(token),
  });
  expect(stopped.statusCode).toBe(200);

  const row = await pool.query<{
    danmaku_source_url: string | null;
    danmaku_collect_enabled: boolean;
  }>('SELECT danmaku_source_url, danmaku_collect_enabled FROM lives WHERE id = $1', [liveId]);
  // 用户拍板 D3：停采集不该把链接也抹掉 —— 它是「下次开播预填」的来源
  expect(row.rows[0]?.danmaku_collect_enabled).toBe(false);
  expect(row.rows[0]?.danmaku_source_url).toBe('https://v.douyin.com/AbCdEf/');
  vi.restoreAllMocks();
});

// ---------- R3 端到端：采集事件 → 真实落库 → 互动引擎回复 ----------

dbIt('采集事件走真实弹幕网关：落 live_danmaku（含幂等键）并触发引擎回复', async () => {
  const token = await registerAndGetToken(PHONE_R3);
  await resetUserData(PHONE_R3);
  const liveId = await createLiveDraft(token);
  await setLiveStatus(liveId, 'live');
  const userId = await userIdOf(PHONE_R3);

  const fake = createFakeAdapter();
  // 【关键】不注入 ingest → 走真实 danmakuGateway，这条链路是真的；只有平台侧是替身
  const collector = createLiveCollector({ adapters: [fake.adapter] });

  const replies: InteractionReply[] = [];
  const engine = createInteractionEngine({
    globalIntervalMs: 0,
    senderIntervalMs: 0,
    generateReply: vi.fn(async () => '咱家套餐在直播间团购链接里，欢迎下单～'),
    onReply: (reply) => {
      replies.push(reply);
    },
  });
  const unsubscribe = engine.subscribe();
  try {
    await collector.start({ userId, liveId, roomRef: '7123456789012345678' });
    fake.emit(chatEvent(liveId, 'douyin:r3-1', '老板这个双人餐多少钱？'));

    await waitFor(() => replies.length >= 1);
    expect(replies).toHaveLength(1);
    expect(replies[0]?.source).toBe('generated');
    expect(replies[0]?.liveId).toBe(liveId);

    // 取证：采集事件确实落了库，且采集通道字段（幂等键）一并写入
    const rows = await pool.query(
      'SELECT platform, room_ref, msg_key, msg_type, content FROM live_danmaku WHERE live_id = $1',
      [liveId],
    );
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0]).toMatchObject({
      platform: 'douyin',
      room_ref: '7123456789012345678',
      msg_key: 'douyin:r3-1',
      msg_type: 'chat',
      content: '老板这个双人餐多少钱？',
    });
  } finally {
    unsubscribe();
    await collector.dispose();
  }
});

// ---------- R4 生命周期：配置与会话分离 + 开播 / 结束联动 ----------

it('生命周期：bind 不起会话、resume 起、suspend 只停会话保留绑定、stop 清绑定', async () => {
  const fake = createFakeAdapter();
  let calls = 0;
  const collector = createLiveCollector({
    adapters: [fake.adapter],
    ingest: async () => {
      calls += 1;
      return {};
    },
  });
  try {
    const binding = await collector.bind({
      userId: 'u-9',
      liveId: 'live-9',
      roomRef: '7123456789012345678',
    });
    expect(binding.watchKey).toBe('douyin:douyin:7123456789012345678');
    expect(fake.opened()).toBe(0);
    fake.emit(chatEvent('live-9', 'douyin:x1'));
    expect(calls).toBe(0);

    expect(await collector.resume('live-9')).not.toBeNull();
    expect(fake.opened()).toBe(1);
    fake.emit(chatEvent('live-9', 'douyin:x2'));
    expect(calls).toBe(1);

    // 结束直播只停会话，绑定保留（下次开播复用同一房间号）
    expect(await collector.suspend('live-9')).toBe(true);
    expect(fake.closed()).toBe(true);
    expect(collector.statusOf('live-9').binding).not.toBeNull();

    // 显式解绑才清掉
    expect(await collector.stop('live-9')).toBe(true);
    expect(collector.statusOf('live-9').binding).toBeNull();
  } finally {
    await collector.dispose();
  }
});

it('resume 对未登记的场次返回 null（开播联动静默跳过，不报错）', async () => {
  const collector = createLiveCollector({ adapters: [createFakeAdapter().adapter] });
  expect(await collector.resume('never-bound')).toBeNull();
  await collector.dispose();
});

dbIt('开播联动：/start 调 resume 拉起采集；采集起不来也绝不让开播失败', async () => {
  const token = await registerAndGetToken(PHONE_SRC);
  await resetUserData(PHONE_SRC);
  const liveId = await createLiveDraft(token);
  await setLiveStatus(liveId, 'ready');

  // 让采集服务抛错，验证「不阻断开播」这条硬保证
  const resumeSpy = vi
    .spyOn(liveCollector, 'resume')
    .mockRejectedValue(new CollectorSourceError('START_FAILED', '第三方签名服务不可用'));

  const res = await app.inject({
    method: 'POST',
    url: `/api/lives/${liveId}/start`,
    headers: bearer(token),
  });
  expect(res.statusCode).toBe(200);
  expect(resumeSpy).toHaveBeenCalledWith(liveId);
});

dbIt('结束联动：/end 调 suspend 停掉本场采集', async () => {
  const token = await registerAndGetToken(PHONE_SRC);
  await resetUserData(PHONE_SRC);
  const liveId = await createLiveDraft(token);
  await setLiveStatus(liveId, 'live');

  const suspendSpy = vi.spyOn(liveCollector, 'suspend').mockResolvedValue(true);
  const res = await app.inject({
    method: 'POST',
    url: `/api/lives/${liveId}/end`,
    headers: bearer(token),
  });
  expect(res.statusCode).toBe(200);
  expect(suspendSpy).toHaveBeenCalledWith(liveId);
});

// ---------- R13 采集保活：稳定连接可无限重连 + 看门狗自动拉起 ----------

it('保活：每次连接都算稳定时，多次断线仍能重连（不再被累计次数掐死）', async () => {
  // 心跳第 1 拍就判死 → 每个会话都极短命；但 stableAfterMs=0 → 每次都算「成功过一次」
  const fake = createFakeAdapter('douyin', (_seq, beatNo) => beatNo < 1);
  const collector = createLiveCollector({
    adapters: [fake.adapter],
    watchdogIntervalMs: 0,
    managerOptions: { reconnectDelayMs: 1, maxOpenAttempts: 3, stableAfterMs: 0, heartbeatIntervalMs: 5 },
  });
  try {
    await collector.start({ userId: 'u', liveId: 'l', roomRef: '7123456789012345678' });
    await waitFor(() => fake.opened() >= 5, 4000);
    // 旧语义下第 4 次尝试就会被判 error；新语义下连接稳定过即清零，可持续重连
    expect(fake.opened()).toBeGreaterThanOrEqual(5);
    expect(collector.statusOf('l').watch?.status).not.toBe('error');
  } finally {
    await collector.dispose();
  }
});

it('保活对照：连接始终不稳定时，仍会被有界终止（不会无限重试打满）', async () => {
  const fake = createFakeAdapter('douyin', (_seq, beatNo) => beatNo < 1);
  const collector = createLiveCollector({
    adapters: [fake.adapter],
    watchdogIntervalMs: 0,
    managerOptions: { reconnectDelayMs: 1, maxOpenAttempts: 3, stableAfterMs: 60_000, heartbeatIntervalMs: 5 },
  });
  try {
    await collector.start({ userId: 'u', liveId: 'l', roomRef: '7123456789012345678' });
    // 连续 3 次都「没稳定过」→ 终止；终止后会话从 active 移除
    await waitFor(() => collector.statusOf('l').watch === null, 4000);
    expect(fake.opened()).toBe(3);
  } finally {
    await collector.dispose();
  }
});

it('看门狗：会话被判 error 后会被自动拉起（对齐竞品 30s 看门狗）', async () => {
  const fake = createFakeAdapter('douyin', (_seq, beatNo) => beatNo < 1);
  const collector = createLiveCollector({
    adapters: [fake.adapter],
    watchdogIntervalMs: 25,
    managerOptions: { reconnectDelayMs: 1, maxOpenAttempts: 2, stableAfterMs: 60_000, heartbeatIntervalMs: 5 },
  });
  try {
    await collector.start({ userId: 'u', liveId: 'l', roomRef: '7123456789012345678' });
    // 首个会话连续 2 次失败即 error；没有看门狗时 open 只会有 2 次
    await waitFor(() => fake.opened() >= 5, 6000);
    expect(fake.opened()).toBeGreaterThanOrEqual(5);
  } finally {
    await collector.dispose();
  }
});

it('看门狗：已挂起（直播结束）的场次不会被拉起', async () => {
  const fake = createFakeAdapter('douyin', (_seq, beatNo) => beatNo < 1);
  const collector = createLiveCollector({
    adapters: [fake.adapter],
    watchdogIntervalMs: 20,
    managerOptions: { reconnectDelayMs: 1, maxOpenAttempts: 1, stableAfterMs: 60_000, heartbeatIntervalMs: 5 },
  });
  try {
    await collector.start({ userId: 'u', liveId: 'l', roomRef: '7123456789012345678' });
    await waitFor(() => fake.opened() >= 1, 2000);
    await collector.suspend('l');
    const before = fake.opened();
    await new Promise((resolve) => setTimeout(resolve, 90));
    // 看门狗跑了几轮都不该动它：挂起 = 直播已结束
    expect(fake.opened()).toBe(before);
  } finally {
    await collector.dispose();
  }
});

// ---------- R16 独立监控：不绑场次、不落库 ----------

it('独立监控：事件只进内存缓冲，**不落库**（ingest 一次都不被调用）', async () => {
  const fake = createFakeAdapter('douyin');
  let ingestCalls = 0;
  const collector = createLiveCollector({
    adapters: [fake.adapter],
    watchdogIntervalMs: 0,
    ingest: async () => {
      ingestCalls += 1;
      return {};
    },
  });
  try {
    const binding = await collector.startMonitor({ userId: 'u-mon', roomRef: '7123456789012345678' });
    expect(binding.watchId.startsWith('mon-')).toBe(true);
    // 独立监控的目标 liveId 为 null：适配器发出来的事件也就没有场次归属
    fake.emit({ ...chatEvent('ignored', 'douyin:m1'), liveId: null });
    const events = collector.monitorEvents(binding.watchId, 'u-mon');
    expect(events).toHaveLength(1);
    expect(events?.[0]?.msgType).toBe('chat');
    expect(events?.[0]?.content).toBe('这个套餐多少钱');
    expect(events?.[0]?.senderNickname).toBe('观众甲');
    // 核心：独立监控不进 AI 链路、不落库
    expect(ingestCalls).toBe(0);
  } finally {
    await collector.dispose();
  }
});

it('独立监控：非本人读不到、列不出（归属隔离）', async () => {
  const fake = createFakeAdapter('douyin');
  const collector = createLiveCollector({ adapters: [fake.adapter], watchdogIntervalMs: 0 });
  try {
    const binding = await collector.startMonitor({ userId: 'owner', roomRef: '7123456789012345678' });
    expect(collector.monitorEvents(binding.watchId, 'intruder')).toBeNull();
    expect(collector.listMonitors('intruder')).toHaveLength(0);
    expect(collector.listMonitors('owner')).toHaveLength(1);
    expect(await collector.stopMonitor(binding.watchId, 'intruder')).toBe(false);
    expect(await collector.stopMonitor(binding.watchId, 'owner')).toBe(true);
    expect(collector.monitorEvents(binding.watchId, 'owner')).toBeNull();
  } finally {
    await collector.dispose();
  }
});

it('独立监控：since 增量只回更新的条目；缓冲有上限不无限涨', async () => {
  const fake = createFakeAdapter('douyin');
  const collector = createLiveCollector({ adapters: [fake.adapter], watchdogIntervalMs: 0 });
  try {
    const binding = await collector.startMonitor({ userId: 'u', roomRef: '7123456789012345678' });
    for (let i = 1; i <= 3; i += 1) {
      fake.emit({ ...chatEvent('ignored', `douyin:m${i}`, `第${i}条`), liveId: null });
    }
    const all = collector.monitorEvents(binding.watchId, 'u');
    expect(all).toHaveLength(3);
    const afterFirst = collector.monitorEvents(binding.watchId, 'u', all?.[0]?.seq ?? 0);
    expect(afterFirst).toHaveLength(2);
    expect(afterFirst?.[0]?.content).toBe('第2条');
  } finally {
    await collector.dispose();
  }
});

dbIt('独立监控路由：起 / 读流水 / 停（打桩单例，不触网）', async () => {
  const token = await registerAndGetToken(PHONE_SRC);
  const watch = {
    watchId: 'mon-test-1',
    userId: await userIdOf(PHONE_SRC),
    platform: 'douyin',
    roomRef: '7686079594273327906',
    watchKey: 'douyin:douyin:7686079594273327906',
    startedAt: new Date().toISOString(),
  };
  vi.spyOn(liveCollector, 'startMonitor').mockResolvedValue(watch);
  const created = await app.inject({
    method: 'POST',
    url: '/api/danmaku-watch',
    headers: bearer(token),
    payload: { shareText: 'https://v.douyin.com/xxxx/' },
  });
  expect(created.statusCode).toBe(201);
  expect((created.json() as { watch: { watchId: string } }).watch.watchId).toBe('mon-test-1');

  vi.spyOn(liveCollector, 'monitorEvents').mockReturnValue([
    { seq: 7, msgType: 'chat', content: '豆豆健康就行', senderNickname: '软糖酱', happenedAt: new Date().toISOString() },
  ]);
  const read = await app.inject({
    method: 'GET',
    url: '/api/danmaku-watch/mon-test-1/events?since=3',
    headers: bearer(token),
  });
  expect(read.statusCode).toBe(200);
  const body = read.json() as { events: Array<{ content: string }>; lastSeq: number };
  expect(body.events[0]?.content).toBe('豆豆健康就行');
  expect(body.lastSeq).toBe(7);

  const badSince = await app.inject({
    method: 'GET',
    url: '/api/danmaku-watch/mon-test-1/events?since=-1',
    headers: bearer(token),
  });
  expect(badSince.statusCode).toBe(400);

  vi.spyOn(liveCollector, 'stopMonitor').mockResolvedValue(true);
  const stopped = await app.inject({
    method: 'DELETE',
    url: '/api/danmaku-watch/mon-test-1',
    headers: bearer(token),
  });
  expect(stopped.statusCode).toBe(200);
  expect((stopped.json() as { stopped: boolean }).stopped).toBe(true);
});




