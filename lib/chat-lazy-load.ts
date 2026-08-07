export const VISIBLE_PAGE_SIZE = 50;

export function getVisibleRenderWindow(totalCount: number, visibleCount: number): {
  startIndex: number;
  hasMore: boolean;
} {
  const clampedVisibleCount = Math.min(Math.max(visibleCount, 0), Math.max(totalCount, 0));
  const startIndex = Math.max(0, totalCount - clampedVisibleCount);
  return { startIndex, hasMore: startIndex > 0 };
}

export function getNextVisibleCount(currentVisibleCount: number, pageSize = VISIBLE_PAGE_SIZE): number {
  return currentVisibleCount + pageSize;
}

/**
 * 顶部哨兵是否应挂载：本地还有未渲染条，或服务端还有更旧页。
 * 仅看 localHasMore 会在 visibleCount ≥ 已加载条数时卸掉哨兵，导致第二次起无法再拉历史。
 */
export function shouldShowHistorySentinel(localHasMore: boolean, hasMoreBefore: boolean): boolean {
  return localHasMore || hasMoreBefore;
}

/**
 * 哨兵进入视口时的动作：先扩本地窗口，到头再请求服务端更旧页。
 */
export function resolveHistoryLoadAction(options: {
  visibleCount: number;
  messagesLength: number;
  hasMoreBefore: boolean;
  historyLoading: boolean;
}): "expand-local" | "load-server" | "none" {
  if (options.historyLoading) return "none";
  if (options.visibleCount < options.messagesLength) return "expand-local";
  if (options.hasMoreBefore) return "load-server";
  return "none";
}

export function captureScrollDistance(scrollHeight: number, scrollTop: number): number {
  return scrollHeight - scrollTop;
}

export function restoreScrollTop(scrollHeight: number, savedDistance: number): number {
  return Math.max(0, scrollHeight - savedDistance);
}
