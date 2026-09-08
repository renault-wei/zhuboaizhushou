// 内置模拟弹幕源（D2.2）：离线演示 / 测试用，不连真实平台，仅产生归一化统一事件。
// 行为：open 后按 fixture 脚本（可循环）逐条延时发 chat/gift/like/enter；
// 注入 sleep/now/heartbeatOk 便于测试假时钟与断线模拟；close 幂等并尽快停发。
import type { AdapterHooks, AdapterSession, CollectorAdapter, UnifiedDanmakuEvent, WatchTarget } from './types';

/** 一条模拟弹幕步骤（delayMs 相对上一步完成时刻，首步相对 open） */
export interface SimStep {
  delayMs: number;
  type: 'chat' | 'gift' | 'like' | 'enter';
  /** chat 必填；其余可空 */
  content?: string;
  nickname?: string;
}

/** 一次 watch 的模拟脚本：steps 播完后按 loop 决定是否从头再来 */
export interface SimulatedScript {
  steps: readonly SimStep[];
  /** 默认 true：演示需要持续有弹幕进来，直到 close */
  loop?: boolean;
}

/** 依赖全部可注入：生产默认（真实计时器），测试全替身 */
export interface SimulatorAdapterDeps {
  /** 自定义脚本；缺省返回内置「火锅店演示」会话（D4 本地演示用） */
  scriptFor?(target: WatchTarget): SimulatedScript | null;
  sleep?(ms: number): Promise<void>;
  now?(): Date;
  /** 模拟断线：某次 open 的会话序号返回 false → 首个 heartbeat 判死（断线重连用例） */
  heartbeatOk?(sessionSeq: number): boolean;
}

export type SimulatorAdapter = CollectorAdapter;

function sleepReal(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 内置演示会话：模拟「火锅店团购直播」被观众刷屏的节奏（与 seed 台本互补，不绑真实内容） */
const DEMO_SCRIPT: SimulatedScript = {
  loop: true,
  steps: [
    { delayMs: 400, type: 'chat', nickname: '干饭的猫', content: '主播，双人毛肚套餐多少钱？' },
    { delayMs: 1600, type: 'chat', nickname: '隔壁老王', content: '新来的，有团购优惠券吗？' },
    { delayMs: 1400, type: 'enter', nickname: '火锅爱好者' },
    { delayMs: 1200, type: 'like', nickname: '干饭的猫' },
    { delayMs: 1800, type: 'gift', nickname: '老板大气', content: '送出小心心 ×3' },
    { delayMs: 1500, type: 'chat', nickname: '团团转', content: '周末去要排队吗？' },
    { delayMs: 1700, type: 'chat', nickname: '干饭的猫', content: '支持到店核销吗？' },
  ],
};

export function createSimulatorAdapter(deps: SimulatorAdapterDeps = {}): SimulatorAdapter {
  const sleep = deps.sleep ?? sleepReal;
  const now = deps.now ?? (() => new Date());

  return {
    source: 'simulator',
    open(target: WatchTarget, hooks: AdapterHooks): Promise<AdapterSession> {
      return new Promise((resolve) => {
        // 会话序号：同一 target 重连后序号递增，供 heartbeatOk 模拟「某次连接必断」
        const sessionSeq = nextSessionSeq();
        let closed = false;
        let seq = 0;

        const emit = (step: SimStep): void => {
          if (closed) {
            return;
          }
          seq += 1;
          const event: UnifiedDanmakuEvent = {
            platform: target.platform,
            roomRef: target.roomRef,
            liveId: target.liveId,
            // 幂等键：roomRef + 会话 + 序号，重连/循环均不重复
            msgKey: `${target.roomRef}:sim-${sessionSeq}-${seq}`,
            msgType: step.type,
            happenedAt: now().toISOString(),
          };
          if (step.content?.trim()) {
            event.content = step.content.trim();
          }
          if (step.nickname?.trim()) {
            event.senderNickname = step.nickname.trim();
          }
          hooks.onEvent(event);
        };

        const script = deps.scriptFor ? deps.scriptFor(target) : DEMO_SCRIPT;
        const run = async (): Promise<void> => {
          const steps = script?.steps ?? [];
          if (!script || steps.length === 0) {
            // 无脚本：静默挂着，仅保留会话（心跳/关闭可测），不发事件
            while (!closed) {
              await sleep(60_000);
            }
            return;
          }
          hooks.onStateChange('connected');
          do {
            for (const step of steps) {
              await sleep(step.delayMs);
              if (closed) {
                return;
              }
              emit(step);
            }
          } while (!closed && (script.loop ?? true));
          if (!closed) {
            hooks.onStateChange('ended');
          }
        };
        void run();

        resolve({
          async heartbeat(): Promise<boolean> {
            return !closed && (deps.heartbeatOk ? deps.heartbeatOk(sessionSeq) : true);
          },
          async close(): Promise<void> {
            closed = true;
          },
        });
      });
    },
  };
}

let sessionCounter = 0;
function nextSessionSeq(): number {
  sessionCounter += 1;
  return sessionCounter;
}
