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
 * 渲染列表尾部追加时同步增大 visibleCount。
 * 固定窗口在自动跟随时会随 total 增长把 startIndex 前移，卸载更早消息；
 * 用户只能滚到顶再加载，且继续跟随会再次把它们挤出窗口。
 * 追加时把增量补进 visibleCount，保持 startIndex 不因尾部增长而前移。
 */
export function growVisibleCountOnAppend(
  visibleCount: number,
  previousTotal: number,
  nextTotal: number,
): number {
  if (!Number.isFinite(visibleCount) || !Number.isFinite(previousTotal) || !Number.isFinite(nextTotal)) {
    return visibleCount;
  }
  if (nextTotal <= previousTotal) return visibleCount;
  const safeVisible = Math.max(0, visibleCount);
  return safeVisible + (nextTotal - previousTotal);
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
