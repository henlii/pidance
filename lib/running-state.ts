/**
 * running session 的真实开始时间表（agent_start 记录）。
 *
 * 刷新后前端据此恢复运行计时（否则 first-seen 语义从 0 重算）；
 * 进程重启后运行态本就丢失，first-seen 兜底。独立模块避免
 * rpc-manager ↔ external-session 循环依赖。
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
  getTable().set(sessionId, startedAt);
}

export function clearRunningStartedAt(sessionId: string): void {
  getTable().delete(sessionId);
}

export function getRunningStartedAt(): ReadonlyMap<string, number> {
  return getTable();
}
