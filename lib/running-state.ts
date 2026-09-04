/**
 * 本轮执行开始时间表（prompt 发送记录，agent_end 清除）。
 *
 * 与 writer lease / host 保活无关。刷新后前端据此恢复运行计时；
 * 进程重启后运行态丢失，first-seen 兜底。
 */

const GLOBAL_KEY = "__piRunningStartedAt";

function getTable(): Map<string, number> {
  const g = globalThis as Record<string, unknown>;
  if (!(GLOBAL_KEY in g) || !(g[GLOBAL_KEY] instanceof Map)) {
    g[GLOBAL_KEY] = new Map<string, number>();
  }
  return g[GLOBAL_KEY] as Map<string, number>;
}

export function recordRunningStartedAt(sessionId: string, startedAt: number): void {
  // 本轮首次写入胜：prompt 发送时间不被后续 agent_start 覆盖。
  const table = getTable();
  if (table.has(sessionId)) return;
  table.set(sessionId, startedAt);
}

export function clearRunningStartedAt(sessionId: string): void {
  getTable().delete(sessionId);
}

export function getRunningStartedAt(): ReadonlyMap<string, number> {
  return getTable();
}
