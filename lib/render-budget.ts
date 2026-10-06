/**
 * 工具渲染的**开销预算**：把「上一次渲染花了多久」换成「下一次至少等多久」。
 *
 * 为什么需要（2026-10-07 事故，见 docs/incidents/2026-10-07-31415-render-livelock.md）：
 * 工具渲染是**全量重渲染** —— 每拿到一次 partial 就把整段输出重新交给插件渲染器，开销随
 * **输出总长度**线性增长（实测 pi-tui 的 Markdown ≈ 0.5µs/字符：10 万字符 46ms、55 万字符
 * 262ms）。而两条限流路径限的是**频率**而不是开销，各放行 10 次/秒：单次渲染一旦超过限流
 * 间隔，事件循环就永久欠债 —— 定时器（租约心跳、SSE heartbeat）、HTTP、socket 读全部饿死。
 * 进程既没崩也没死锁，只是再也空不下来，看起来就是「卡死」。
 *
 * 这里按**占空比**限：渲染最多吃掉 `1 / dutyCycle` 的时间（默认 1/4），剩下的留给事件循环。
 * 开销小的时候不会变慢 —— 基础间隔更大时取基础间隔，所以正常情况下行为与之前完全一致。
 * 上限**有意不设**：宁可最坏情况下界面更新变慢，也不让事件循环被打满。
 */
export const RENDER_DUTY_CYCLE = 0.25;

export interface RenderBudget {
  /** 记一次渲染的实际开销（ms）。非有限值 / 负数忽略（量不出来就不改判定）。 */
  record(costMs: number): void;
  /** 下一次渲染至少要等多久（ms）：基础间隔与「上次开销 ÷ 占空比」取大者。 */
  minIntervalMs(): number;
  /** 上次开销是否已经超过基础间隔（诊断用；正常情况下一直是 false）。 */
  overloaded(): boolean;
}

export function createRenderBudget(options: {
  /** 调用点自己的基础间隔（ms），正常情况下就是这个值在起作用。 */
  baseMs: number;
  /** 渲染最多占用墙钟时间的比例，默认 {@link RENDER_DUTY_CYCLE}。 */
  dutyCycle?: number;
}): RenderBudget {
  const base = Number.isFinite(options.baseMs) && options.baseMs > 0 ? options.baseMs : 0;
  const duty = Number.isFinite(options.dutyCycle) && (options.dutyCycle ?? 0) > 0
    ? Math.min(1, options.dutyCycle as number)
    : RENDER_DUTY_CYCLE;
  let lastCostMs = 0;

  return {
    record(costMs) {
      if (!Number.isFinite(costMs) || costMs < 0) return;
      lastCostMs = costMs;
    },
    minIntervalMs() {
      return Math.max(base, lastCostMs / duty);
    },
    overloaded() {
      return lastCostMs > base;
    },
  };
}
