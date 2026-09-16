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

function createFakeAdapter(source: CollectorAdapter['source'] = 'douyin'): FakeAdapter {
  let hooks: AdapterHooks | null = null;
  let openedCount = 0;
  let closedFlag = false;
  const adapter: CollectorAdapter = {
    source,
    async open(_target: WatchTarget, h: AdapterHooks) {
      openedCount += 1;
      hooks = h;
      h.onStateChange('connected');
      return {
        async heartbeat() {
          return true;
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

dbIt('非直播中场次起采集返回 409 LIVE_NOT_LIVE', async () => {
  const token = await registerAndGetToken(PHONE_SRC);
  await resetUserData(PHONE_SRC);
  const liveId = await createLiveDraft(token);

  const res = await app.inject({
    method: 'POST',
    url: `/api/lives/${liveId}/danmaku-source`,
    headers: bearer(token),
    payload: { roomRef: '7123456789012345678' },
  });
  expect(res.statusCode).toBe(409);
  expect(res.json()).toMatchObject({ error: 'LIVE_NOT_LIVE' });
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
