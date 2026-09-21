/**
 * 「回到前台只恢复一次」的激活合并器（纯状态机 + 可注入计时器的驱动器）。
 *
 * focus 与 visibilitychange 往往在同一批里一起到（切回标签页、解锁屏幕），对同一件事
 * 各触发一次会做重复工作：重连 SSE、对账、重拉消息、重拉列表——不但浪费，还会互相打断
 * （后一次 close→connect 把前一次刚要建立的流拆掉）。
 *
 * 语义：
 * - **同一批合并**：一次激活触发的执行被安排后，同批（合并窗口内）的其余激活直接吞掉。
 * - **在途则补跑一次**：执行期间又来的激活不会被丢掉，结束后补跑一次
 *   —— 宁可多恢复一次，也不能漏；漏掉会让界面停在过期状态且没有任何补救路径。
 * - **失败不卡死**：一次执行抛错不影响下一次激活。
 */

export interface ActivationRecoveryState {
  /** 已安排、还没开始执行 */
  scheduled: boolean;
  /** 正在执行 */
  inFlight: boolean;
  /** 执行期间又来了激活，结束后要补跑一次 */
  rerun: boolean;
}

export const ACTIVATION_COALESCE_MS = 200;

export function emptyActivationState(): ActivationRecoveryState {
  return { scheduled: false, inFlight: false, rerun: false };
}

export type ActivationNote = "schedule" | "coalesced" | "deferred";

/**
 * 一次激活到达（focus 或 visibilitychange(visible)）。
 * - `schedule`：这一批的第一次，调用方应安排执行
 * - `coalesced`：同批重复（focus + visibilitychange 一起到），吞掉
 * - `deferred`：正在执行，记一笔待补跑
 */
export function noteActivation(state: ActivationRecoveryState): { state: ActivationRecoveryState; note: ActivationNote } {
  if (state.inFlight) return { state: { ...state, rerun: true }, note: "deferred" };
  if (state.scheduled) return { state, note: "coalesced" };
  return { state: { ...state, scheduled: true }, note: "schedule" };
}

/** 执行开始（安排的那次落地）。 */
export function beginActivationRun(state: ActivationRecoveryState): ActivationRecoveryState {
  return { ...state, scheduled: false, inFlight: true };
}

/** 执行结束：是否需要补跑一次。 */
export function endActivationRun(state: ActivationRecoveryState): { state: ActivationRecoveryState; rerun: boolean } {
  const rerun = state.rerun;
  return { state: { ...state, inFlight: false, rerun: false }, rerun };
}

export interface ActivationRecoveryDriver {
  /** 记一次激活（focus / visibilitychange）。 */
  notify(): void;
  /** 当前状态（测试用）。 */
  snapshot(): ActivationRecoveryState;
  /** 卸载：清掉待执行的安排，之后 notify 不再触发执行。 */
  dispose(): void;
}

/**
 * 把状态机接到真实计时器上。`perform` 可以是同步或异步；期间到达的激活会补跑一次。
 */
export function createActivationRecovery(options: {
  perform: () => void | Promise<void>;
  /** 同批合并窗口；缺省 200ms（focus 与 visibilitychange 通常相差几毫秒）。 */
  coalesceMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}): ActivationRecoveryDriver {
  const coalesceMs = options.coalesceMs ?? ACTIVATION_COALESCE_MS;
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  let state = emptyActivationState();
  let timer: unknown = null;
  let disposed = false;

  const schedule = (delayMs: number): void => {
    if (disposed) return;
    if (timer !== null) clearTimer(timer);
    timer = setTimer(() => {
      timer = null;
      if (disposed) return;
      state = beginActivationRun(state);
      // 同步抛错也要走收尾：否则 inFlight 卡住，之后每次激活都被当成「在途」吞掉。
      let result: void | Promise<void>;
      try {
        result = options.perform();
      } catch {
        result = Promise.resolve();
      }
      void Promise.resolve(result).catch(() => undefined).then(() => {
        const ended = endActivationRun(state);
        state = ended.state;
        if (ended.rerun && !disposed) schedule(0);
      });
    }, delayMs);
  };

  return {
    notify() {
      if (disposed) return;
      const noted = noteActivation(state);
      state = noted.state;
      if (noted.note === "schedule") schedule(coalesceMs);
    },
    snapshot: () => state,
    dispose() {
      disposed = true;
      if (timer !== null) clearTimer(timer);
      timer = null;
      state = emptyActivationState();
    },
  };
}
