/**
 * 工具渲染器的重渲调度（纯逻辑，无 React / 无 IO，node:test 可直接测）。
 *
 * 背景（issue #69）：SDK 的 `invalidate()` 语义是**重新调用 renderCall/renderResult**，
 * 插件据此做异步刷新（内置 edit 的 diff 预览算完再画、pi-advisor-flow 的 spinner 80ms 一帧）。
 * 宿主只重渲缓存组件会一直画旧内容；而这些刷新可能很密（≈12.5 次/秒），不限频就是拿重复帧
 * 打爆事件流。本模块只管调度，渲染与去重交给调用方：
 *
 * 1. **同键不并发**：渲染期间的 request 记 pending，本轮结束后补跑一次 —— 插件把重渲写进
 *    自己的 render 里不会变成无限递归，那次刷新也不会被丢掉。
 * 2. **限频 + 尾随**：距上次渲染不足 `minIntervalMs` 的 request 排队到尾随定时器；合并高频
 *    调用，但最后一次一定到（不会因为限频丢掉终态）。
 * 3. **时钟与定时器可注入**：生产用 `Date.now`/`setTimeout`，测试用假实现，不依赖真实等待。
 *
 * 补跑同样走限频，所以即使插件在自己的 render 里反复 invalidate，频率仍被钳住。
 */

export type ToolRenderTimerHandle = ReturnType<typeof setTimeout> | number;

/** 一次重算得到的槽（null 表示该槽这次没有产出）。 */
export interface RenderedSlots {
  callLines?: string[] | null;
  resultLines?: string[] | null;
}

/** 已推给前端的槽（undefined 表示该槽还没推过）。 */
export interface EmittedSlots {
  callLines?: string[];
  resultLines?: string[];
}

/** 行数组逐行相等。 */
export function sameRenderedLines(candidate: readonly string[], previous: readonly string[] | undefined): boolean {
  if (!previous || candidate.length !== previous.length) return false;
  for (let i = 0; i < candidate.length; i += 1) {
    if (candidate[i] !== previous[i]) return false;
  }
  return true;
}

/**
 * 「行内容未变不重复推事件」的判定：只保留相对上次推送**真的变了**的槽。
 * 都没变（或这次没产出）返回 null，调用方据此不推事件。
 */
export function pickChangedSlots(rendered: RenderedSlots, previous: EmittedSlots): { callLines?: string[]; resultLines?: string[] } | null {
  const changed: { callLines?: string[]; resultLines?: string[] } = {};
  if (rendered.callLines && !sameRenderedLines(rendered.callLines, previous.callLines)) {
    changed.callLines = rendered.callLines;
  }
  if (rendered.resultLines && !sameRenderedLines(rendered.resultLines, previous.resultLines)) {
    changed.resultLines = rendered.resultLines;
  }
  return changed.callLines || changed.resultLines ? changed : null;
}

export interface ToolRenderSchedulerOptions<TChange> {
  /** 同一键两次渲染之间的最短间隔（ms）。 */
  minIntervalMs: number;
  /** 重算该键：返回需要推送的变化；返回 null/undefined 表示没有变化（不推事件）。 */
  recompute: (key: string) => TChange | null | undefined;
  /** 推送变化（仅当 recompute 返回非空时调用）。 */
  emit: (key: string, change: TChange) => void;
  /** 重算/推送抛错时不打断事件流；调用方自行决定怎么记录。 */
  onError?: (error: unknown) => void;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => ToolRenderTimerHandle;
  clearTimer?: (handle: ToolRenderTimerHandle) => void;
}

export interface ToolRenderScheduler {
  /** 插件 `invalidate()`：按限频排队重渲（同键不并发，渲染期间的请求补跑一次）。 */
  request(key: string): void;
  /** 立即重渲（宽度变化这类低频路径）：清掉待执行定时器并直接渲染。 */
  flush(key: string): void;
  /** 立即重渲一组键（宽度变化）。 */
  flushAll(keys: Iterable<string>): void;
  /** 该键当前是否在渲染（测试与诊断用）。 */
  isRendering(key: string): boolean;
  /** 清掉所有待执行定时器（宿主 dispose 时调用：别让定时器在销毁后再推事件）。 */
  dispose(): void;
}

interface KeyState {
  rendering: boolean;
  pending: boolean;
  timer: ToolRenderTimerHandle | null;
  /** 上次真正渲染的时刻；undefined = 还没渲染过（首次请求立即渲染，不受限频影响）。 */
  lastRunAt: number | undefined;
}

export function createToolRenderScheduler<TChange>(
  options: ToolRenderSchedulerOptions<TChange>,
): ToolRenderScheduler {
  const now = options.now ?? (() => Date.now());
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = options.clearTimer ?? ((handle) => { clearTimeout(handle as ReturnType<typeof setTimeout>); });
  const states = new Map<string, KeyState>();

  const stateOf = (key: string): KeyState => {
    let state = states.get(key);
    if (!state) {
      state = { rendering: false, pending: false, timer: null, lastRunAt: undefined };
      states.set(key, state);
    }
    return state;
  };

  const run = (key: string, state: KeyState): void => {
    if (state.rendering) {
      state.pending = true;
      return;
    }
    state.rendering = true;
    state.lastRunAt = now();
    try {
      const change = options.recompute(key);
      if (change !== null && change !== undefined) options.emit(key, change);
    } catch (error) {
      options.onError?.(error);
    } finally {
      state.rendering = false;
      if (state.pending) {
        // 补跑也走限频：插件在自己的 render 里反复 invalidate 也不会打爆。
        state.pending = false;
        request(key);
      }
    }
  };

  const request = (key: string): void => {
    const state = stateOf(key);
    if (state.rendering) {
      state.pending = true;
      return;
    }
    const elapsed = state.lastRunAt === undefined ? Number.POSITIVE_INFINITY : now() - state.lastRunAt;
    if (elapsed < options.minIntervalMs) {
      if (state.timer !== null) return;
      state.timer = setTimer(() => {
        state.timer = null;
        run(key, state);
      }, options.minIntervalMs - elapsed);
      return;
    }
    run(key, state);
  };

  const flush = (key: string): void => {
    const state = stateOf(key);
    if (state.timer !== null) {
      clearTimer(state.timer);
      state.timer = null;
    }
    run(key, state);
  };

  return {
    request,
    flush,
    flushAll(keys) {
      for (const key of keys) flush(key);
    },
    isRendering(key) {
      return states.get(key)?.rendering === true;
    },
    dispose() {
      for (const state of states.values()) {
        if (state.timer !== null) {
          clearTimer(state.timer);
          state.timer = null;
        }
        state.pending = false;
      }
      states.clear();
    },
  };
}
