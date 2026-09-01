/**
 * 本地 follow-up 队列 → 引导（steer）合并发送的纯逻辑。
 *
 * Pidance 产品级 follow-up 队列不复用 Pi 原生队列：
 * 引导发送 = 把队列（+ 输入框 extra）合并为一条 steer 消息。
 */

/** 队列条目合并为一条引导消息；extra 为输入框内容（并入队尾）。空条目忽略。 */
export function mergeFollowUpForSteer(items: readonly string[], extra?: string): string {
  const parts = [...items, ...(extra?.trim() ? [extra.trim()] : [])]
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return parts.join("\n");
}

/** 取回（recall）：队列内容回填编辑器草稿（块间空行分隔，对齐 TUI queue restore）。 */
export function joinQueueForRecall(items: readonly string[]): string {
  return items
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .join("\n\n");
}

/** 从服务端偏好读取会话队列；兼容早期扁平键。缺失返回 null，空队列返回 []。 */
export function readFollowUpQueuePreference(prefs: unknown, sessionId: string): string[] | null {
  if (!sessionId || typeof prefs !== "object" || prefs === null || Array.isArray(prefs)) return null;
  const record = prefs as Record<string, unknown>;
  const nested = record.sessionQueue;
  const nestedValue = typeof nested === "object" && nested !== null && !Array.isArray(nested)
    ? (nested as Record<string, unknown>)[sessionId]
    : undefined;
  const value = nestedValue ?? record[`sessionQueue.${sessionId}`];
  if (!Array.isArray(value)) return null;
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

/** 会话结束原因：只有正常完成才自动投递队列；中止/异常保留队列。 */
export type QueueAutoFlushReason = "completed" | "aborted" | "error";

export function shouldAutoFlushQueue(reason: QueueAutoFlushReason | null | undefined): boolean {
  return reason === "completed";
}

export function parseQueueAutoFlushReason(value: unknown): QueueAutoFlushReason | null {
  return value === "completed" || value === "aborted" || value === "error" ? value : null;
}
