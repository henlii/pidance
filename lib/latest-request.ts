/**
 * 「只认最新一次请求」守卫：并发请求各自取号，迟到响应在写状态前用 isCurrent 丢弃。
 *
 * 同一资源被快速切换时（切文件、切 diff 目标、切会话），旧请求可能后返回并覆盖新结果。
 * 卸载时 invalidate 让在途请求全部作废，避免已卸载组件继续写状态。
 */
export interface LatestRequestGuard {
  /** 开一次新请求并返回序号；此前所有在途请求立即作废。 */
  next(): number;
  /** 该序号是否仍是最新；false = 迟到响应，不要写状态。 */
  isCurrent(requestId: number): boolean;
  /** 作废所有在途请求（组件卸载时用）。 */
  invalidate(): void;
}

export function createLatestRequestGuard(): LatestRequestGuard {
  let latest = 0;
  return {
    next: () => ++latest,
    isCurrent: (requestId) => requestId === latest,
    invalidate: () => {
      latest += 1;
    },
  };
}
