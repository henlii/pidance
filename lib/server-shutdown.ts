/**
 * 退出收尾：先交出 writer，再硬断 SSE。
 *
 * 为什么顺序不能反：live host 是 JSONL 的 writer（租约覆盖写入窗口）。直接硬断 SSE
 * 会让 bin/pidance.js 的 server.close() 立刻完成、进程随即退出，正在写的一轮消息与
 * 租约释放都来不及（local-deploy.mjs 里那条「SSE/长连接可能让 server.close 等到
 * 超时」的注释就是现状）。所以顺序固定为：
 *
 *   1. await dispose 全部 live host（默认 3s 上限，超时即放弃并记日志）
 *   2. 硬断所有 SSE（`controller.error`；`close()` 会被 Next 管道吞掉，进程照样等）
 *
 * 之后 bin/pidance.js 保留的 8s 兜底强杀仍是最后一道网。
 *
 * 全局键用 Symbol 存放：Next 的 route 与 instrumentation 各自有模块实例，只有
 * globalThis 上才是同一份 closer 集合（同一原因见 lib/live-session-registry.ts）。
 */

const SHUTDOWN_STATE_KEY = Symbol.for("pidance/server-shutdown/v1");

/** dispose 阶段的时间上限：超过就放弃等待，交给 8s 兜底强杀。 */
export const SHUTDOWN_DISPOSE_CAP_MS = 3_000;

/** 可参与收尾的 live host 最小面。 */
export type ShutdownHost = {
  sessionId?: string;
  destroyAsync(): Promise<void>;
};

export type GracefulShutdownOptions = {
  capMs?: number;
  listHosts?: () => ShutdownHost[] | Promise<ShutdownHost[]>;
  log?: (message: string) => void;
};

type ShutdownState = {
  closers: Set<() => void>;
  hooksInstalled: boolean;
  pending: Promise<void> | null;
  signalHandler: ((signal: NodeJS.Signals) => void) | null;
};

function state(): ShutdownState {
  const existing = (globalThis as Record<symbol, ShutdownState | undefined>)[SHUTDOWN_STATE_KEY];
  if (existing) return existing;
  const created: ShutdownState = {
    closers: new Set(),
    hooksInstalled: false,
    pending: null,
    signalHandler: null,
  };
  (globalThis as Record<symbol, ShutdownState | undefined>)[SHUTDOWN_STATE_KEY] = created;
  return created;
}

/** 注册一条 SSE 连接的关闭函数（`controller.error` 形态），返回注销函数。 */
export function registerEventStreamCloser(closer: () => void): () => void {
  const closers = state().closers;
  closers.add(closer);
  return () => {
    closers.delete(closer);
  };
}

/** 硬断所有已注册的连接；返回实际调用的条数。单条抛错不影响其它连接。 */
export function closeAllEventStreams(): number {
  const closers = [...state().closers];
  for (const closer of closers) {
    try {
      closer();
    } catch (error) {
      console.error("[pidance] 关闭 SSE 连接失败（已忽略）:", error);
    }
  }
  return closers.length;
}

async function defaultListHosts(): Promise<ShutdownHost[]> {
  const { getRegistry } = await import("./live-session-registry");
  return [...getRegistry().values()];
}

/**
 * dispose 全部 live host，最多等 capMs。
 *
 * 单个 host 的失败不影响其它 host（`destroyAsync` 在 busy 时按 fail-closed 返回，
 * 这里不再重试——收尾阶段不允许无限等）。
 */
export async function disposeLiveHosts(
  options: GracefulShutdownOptions = {},
): Promise<{ total: number; settled: number; timedOut: boolean }> {
  const capMs = options.capMs ?? SHUTDOWN_DISPOSE_CAP_MS;
  const listHosts = options.listHosts ?? defaultListHosts;
  const hosts = await listHosts();
  let settled = 0;
  const disposals = hosts.map((host) =>
    Promise.resolve()
      .then(() => host.destroyAsync())
      .catch(() => {})
      .then(() => {
        settled += 1;
      }),
  );
  let timedOut = false;
  if (disposals.length > 0) {
    let capTimer: ReturnType<typeof setTimeout> | null = null;
    const cap = new Promise<void>((resolve) => {
      capTimer = setTimeout(() => {
        timedOut = true;
        resolve();
      }, capMs);
      if (typeof capTimer.unref === "function") capTimer.unref();
    });
    await Promise.race([Promise.allSettled(disposals).then(() => {}), cap]);
    if (capTimer) clearTimeout(capTimer);
  }
  return { total: hosts.length, settled, timedOut };
}

/**
 * 执行一次收尾（幂等：重复信号返回同一个 promise）。
 *
 * @returns 无返回；失败一律吞掉——收尾阶段不能因为异常跳过后面的断流。
 */
export function runGracefulShutdown(options: GracefulShutdownOptions = {}): Promise<void> {
  const current = state();
  if (current.pending) return current.pending;
  const log = options.log ?? ((message: string) => console.log(message));
  current.pending = (async () => {
    try {
      const result = await disposeLiveHosts(options);
      log(
        `[pidance] 收尾：dispose live host ${result.settled}/${result.total}`
        + (result.timedOut ? "（等待超时，未完成的交给 8s 兜底强杀）" : ""),
      );
    } catch (error) {
      console.error("[pidance] 收尾 dispose 阶段失败（继续断流）:", error);
    }
    try {
      const closed = closeAllEventStreams();
      if (closed > 0) log(`[pidance] 收尾：已硬断 ${closed} 条 SSE 连接`);
    } catch (error) {
      console.error("[pidance] 收尾断流阶段失败:", error);
    }
  })();
  return current.pending;
}

/**
 * 注册 SIGINT/SIGTERM 收尾钩子（幂等）。
 *
 * 只做「dispose → 断流」；关 listener 与兜底强杀仍由 bin/pidance.js 负责
 * （它先关 listener，不会反过来关掉连接，所以不破坏上面的顺序）。
 */
export function installShutdownHooks(options: GracefulShutdownOptions = {}): void {
  const current = state();
  if (current.hooksInstalled) return;
  current.hooksInstalled = true;
  const onSignal = (signal: NodeJS.Signals) => {
    const log = options.log ?? ((message: string) => console.log(message));
    log(`[pidance] 收到 ${signal}，开始收尾`);
    void runGracefulShutdown(options);
  };
  current.signalHandler = onSignal;
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
}

/** 失效入口：清空 closer、摘掉信号钩子与收尾状态（测试用）。 */
export function resetShutdownStateForTests(): void {
  const current = state();
  current.closers.clear();
  current.pending = null;
  current.hooksInstalled = false;
  if (current.signalHandler) {
    process.off("SIGINT", current.signalHandler);
    process.off("SIGTERM", current.signalHandler);
    current.signalHandler = null;
  }
}
