/**
 * 异步投影的归属判定：迟到的服务端响应只能作用于**它所属的会话**。
 *
 * 为什么单独成模块：这条规则在 `useAgentSession` 里被反复手写（队列投影、状态
 * 快照、吞吐读数、压缩态）。漏掉一处就出现跨会话串味——为 A 发起的 reconcile 在
 * 用户切到 B 之后返回，把 A 的压缩态/读数写进 B 的界面。集中一处并加测试，
 * 避免下次再漏（`lib/queue-state.ts` 的同类处理是既有先例）。
 */

/** 一次异步投影的目标。 */
export type ProjectionTarget = {
  /** 该响应属于哪个会话 */
  sessionId: string | null | undefined;
  /**
   * 请求发起时的读数代次（可选）。压缩等会改写 contextUsage 的路径用它判新旧：
   * 期间若有更新的本地读数，迟到响应不得覆盖。
   */
  generation?: number;
};

/** 当前视图归属。 */
export type ProjectionView = {
  sessionId: string | null | undefined;
  generation?: number;
};

/**
 * 该投影是否可以落到当前视图。
 *
 * - 目标 sessionId 缺失或与当前会话不同 → 不落（整份丢弃，不做「迁移到当前会话」）；
 * - 两侧都提供了代次且不一致 → 不落；
 * - 任一侧未提供代次 → 不因代次拒绝（保持既有「未提供即不判定」的兼容语义）。
 */
export function canApplyProjection(
  target: ProjectionTarget,
  view: ProjectionView,
): boolean {
  if (!target.sessionId || target.sessionId !== view.sessionId) return false;
  if (
    target.generation !== undefined
    && view.generation !== undefined
    && target.generation !== view.generation
  ) {
    return false;
  }
  return true;
}
