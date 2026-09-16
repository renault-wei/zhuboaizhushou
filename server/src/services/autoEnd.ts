// 定时关播（R26）：开播时若场次设了 auto_end_minutes，到点自动收尾。
//
// 收尾语义（用户 2026-09-17 拍板 D2 = **优雅收尾**）：**不硬切**。
//   * loopCaster.stop() 本身就是「当前句播完即止」（见 loopCaster 主循环的 cancelled 检查），不打断半句；
//   * 已经排进出声队列的音频**不清队列**，让它自然播完；
//   * 停采集 → 不再产生新回复；
//   * 最后走与手动 /end **完全同一条路径**（含结算）。
//
// 已知债：定时器是**进程内内存态**，服务重启即丢（与 liveCollector 的绑定表同源，见 R17）。
// 一台机器的当前部署下不痛；将来要多实例或要「重启后仍生效」时，得与 R17 一起改成持久化。

export interface AutoEndRegistration {
  liveId: string;
  minutes: number;
  /** 预计关播时刻（ISO8601），供接口展示倒计时 */
  endsAt: string;
}

export interface AutoEndScheduler {
  /** 登记定时关播：同场次重复登记**覆盖**旧的（改配置后重开播就是这条路径） */
  schedule(input: {
    liveId: string;
    minutes: number;
    onFire: (liveId: string) => Promise<void>;
  }): AutoEndRegistration;
  /** 取消（手动 /end、改配置、场次删除时调用）；返回是否确实有在跑的定时器 */
  cancel(liveId: string): boolean;
  /** 查某场次的登记（无则 null） */
  pending(liveId: string): AutoEndRegistration | null;
  /** 全部在跑的登记（监控/排障用） */
  list(): AutoEndRegistration[];
  /** 全部取消（服务关停 / 测试收尾） */
  dispose(): void;
}

export interface AutoEndSchedulerDeps {
  now?: () => number;
  /** 定时器注入（测试用假计时器）；返回带 cancel 的句柄 */
  setTimer?: (fn: () => void, ms: number) => { cancel: () => void };
  warn?: (message: string) => void;
}

export function createAutoEndScheduler(deps: AutoEndSchedulerDeps = {}): AutoEndScheduler {
  const now = deps.now ?? (() => Date.now());
  const warn = deps.warn ?? ((message: string) => console.warn(message));
  const setTimer =
    deps.setTimer ??
    ((fn: () => void, ms: number): { cancel: () => void } => {
      const handle = setTimeout(fn, ms);
      // unref：常驻定时器不应阻止进程退出（Node 语义；测试环境无此方法则跳过）
      (handle as unknown as { unref?: () => void }).unref?.();
      return { cancel: () => clearTimeout(handle) };
    });

  const entries = new Map<string, { cancel: () => void; registration: AutoEndRegistration }>();

  return {
    schedule(input) {
      this.cancel(input.liveId);
      const registration: AutoEndRegistration = {
        liveId: input.liveId,
        minutes: input.minutes,
        endsAt: new Date(now() + input.minutes * 60_000).toISOString(),
      };
      const timer = setTimer(() => {
        entries.delete(input.liveId);
        void input.onFire(input.liveId).catch((err: unknown) => {
          warn(
            `[autoEnd] 场次 ${input.liveId} 定时关播失败：${err instanceof Error ? err.message : String(err)}`,
          );
        });
      }, input.minutes * 60_000);
      entries.set(input.liveId, { cancel: timer.cancel, registration });
      return registration;
    },

    cancel(liveId) {
      const entry = entries.get(liveId);
      if (!entry) {
        return false;
      }
      entry.cancel();
      entries.delete(liveId);
      return true;
    },

    pending(liveId) {
      return entries.get(liveId)?.registration ?? null;
    },

    list() {
      return [...entries.values()].map((entry) => entry.registration);
    },

    dispose() {
      for (const entry of entries.values()) {
        entry.cancel();
      }
      entries.clear();
    },
  };
}

/** 全局单例：开播联动登记，结束联动取消 */
export const autoEndScheduler = createAutoEndScheduler();
