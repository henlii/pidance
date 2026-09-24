/**
 * 页面内长期 EventSource 的登记，以及「文档卸载时一起让出连接」（issue #91）。
 *
 * 为什么需要（#91 的实测证据）：
 * - 浏览器对同一个源（HTTP/1.1）只有 6 条并发连接，而 SSE 是长期占用；
 * - 进入 bfcache 的**旧文档会继续占着那些连接**，于是同一标签页里连续导航时，新文档的
 *   普通请求被挤在队里 —— 实测 `/api/sessions` 的 duration 恰好等于它自己的超时
 *   （10000ms）、`transferSize` 为 0、`responseStatus` 为空，界面停在半初始化状态；
 *   `location.reload()` 立刻恢复，因为它不复用那个旧文档；
 * - `pagehide` 是可靠的「文档即将离开」时机。**不能挂在 `unload` 上**：进入 bfcache
 *   时 `unload` 根本不触发。
 *
 * 与 #86「隐藏标签关流」的分界（语义不同，互不替代）：
 * - 本模块管**文档生命周期**：pagehide = 这个文档要走了/进 bfcache → 关掉即可，因为文档
 *   不再运行；本模块**不写**任何可见性状态。
 * - #86 管**可见性**：文档还在跑但切到后台 → 按阈值收流、回前台重连
 *   （见 `lib/browser-session-runtime-registry.ts` 的 `setTabVisibility` / `connectEvents`）。
 *
 * bfcache 恢复：`pageshow` 且 `event.persisted === true` 时通知已注册的恢复回调，由各自
 * 的所有者重建连接（会话事件流、应用级流、文件监听）。
 *
 * 外部关流后的自洽性：调用方自己持有的引用可能在这次关闭后变成「已关闭」。EventSource 的
 * `close()` 会把 `readyState` 置为 2（CLOSED），而会话事件流的重连判断就是
 * `readyState !== 2`（`browser-session-runtime-registry` 的 connectEvents），因此回前台
 * 仍会正确重建，不需要额外握手。
 *
 * 测试：`handlePageHide()` / `handlePageShow(persisted)` 是对外入口，测试直接调用即可，
 * 不需要假 DOM（本模块在没有 `window` 的环境里静默不装监听）。
 */

/** 只要求 `close()`：与 EventSourceLike 结构兼容，测试的假实现也能登记。 */
export type TrackedEventSource = { close(): void };

const tracked = new Set<TrackedEventSource>();
const restoreListeners = new Set<() => void>();
let installed = false;

function onPageHide(): void {
  handlePageHide();
}

function onPageShow(event: PageTransitionEvent): void {
  handlePageShow(event.persisted === true);
}

/**
 * 登记一条长期连接；返回注销函数（调用方在**自己 close 之后**调用）。
 * 未安装监听时顺带安装（幂等）。
 */
export function trackLiveEventSource(source: TrackedEventSource): () => void {
  tracked.add(source);
  installLifecycleHandlers();
  return () => {
    tracked.delete(source);
  };
}

/** 当前登记的连接数（调试与测试用）。 */
export function liveEventSourceCount(): number {
  return tracked.size;
}

/**
 * 关闭并清空所有已登记的连接，返回实际关闭条数。
 * 不触发恢复回调：恢复发生在 `pageshow`（文档真的回来了），不是在这里。
 */
export function closeAllLiveEventSources(): number {
  const count = tracked.size;
  for (const source of tracked) {
    try {
      source.close();
    } catch {
      // 单条关闭失败不影响其它连接
    }
  }
  tracked.clear();
  return count;
}

/**
 * 所有者自己关闭一条登记过的连接：关闭 + 注销（幂等；未登记过也可安全调用）。
 * 清理路径统一用它，避免「close 了但登记表里还留着」这种半状态。
 */
export function closeTrackedEventSource(source: TrackedEventSource): void {
  tracked.delete(source);
  try {
    source.close();
  } catch {
    // 关闭失败不抛出：调用方通常在 effect 清理里，不该因此打断卸载
  }
}

/** 注册「文档从 bfcache 回来」时的重建回调；返回退订函数。 */
export function subscribeLiveStreamRestore(listener: () => void): () => void {
  restoreListeners.add(listener);
  installLifecycleHandlers();
  return () => {
    restoreListeners.delete(listener);
  };
}

/** pagehide：文档要走了（含进 bfcache）→ 把它占的连接让出来。 */
export function handlePageHide(): void {
  closeAllLiveEventSources();
}

/** pageshow：`persisted` 为真表示文档是从 bfcache 恢复的，需要重建连接。 */
export function handlePageShow(persisted: boolean): void {
  if (!persisted) return;
  for (const listener of [...restoreListeners]) {
    try {
      listener();
    } catch {
      // 单个所有者的重建失败不影响其它所有者
    }
  }
}

/** 测试用：清空登记与恢复回调。 */
export function resetLiveEventSourcesForTests(): void {
  tracked.clear();
  restoreListeners.clear();
}

/**
 * 安装 pagehide/pageshow 监听（幂等）。
 * 没有 `window` 的环境（Node 单测、SSR）静默跳过；调用方不必关心安装时机。
 * 只装一次：本模块在浏览器里是每文档一个实例。
 */
export function installLifecycleHandlers(): void {
  if (installed) return;
  if (typeof window === "undefined" || typeof window.addEventListener !== "function") return;
  window.addEventListener("pagehide", onPageHide);
  window.addEventListener("pageshow", onPageShow);
  installed = true;
}
