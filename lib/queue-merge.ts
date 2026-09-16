/**
 * 本地 follow-up 队列 → 引导（steer）合并发送的纯逻辑。
 *
 * Pidance 产品级 follow-up 队列不复用 Pi 原生队列：
 * 引导发送 = 把队列（+ 输入框 extra）合并为一条 steer 消息。
 */

import { parseFollowUpQueue, type FollowUpItem } from "./session-queue";

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

/**
 * 从服务端偏好读取会话队列。
 *
 * 解码沿用 `lib/session-queue.ts` 的唯一实现：客户端与 Host、恢复扫描必须
 * 对同一份持久化格式得出同一结果。旧格式（纯数组）按确定性 id 解码，
 * 当前格式（{items: {id,text,state}[]}）保留条目身份与状态。
 */
export interface FollowUpQueuePreference {
  items: FollowUpItem[];
  /** Host 写入的单调版本号；旧数据（纯数组）为 null，表示无法判新旧。 */
  revision: number | null;
}

export function readFollowUpQueuePreference(prefs: unknown, sessionId: string): FollowUpQueuePreference | null {
  if (!sessionId || typeof prefs !== "object" || prefs === null || Array.isArray(prefs)) return null;
  const record = prefs as Record<string, unknown>;
  const nested = record.sessionQueue;
  const nestedValue = typeof nested === "object" && nested !== null && !Array.isArray(nested)
    ? (nested as Record<string, unknown>)[sessionId]
    : undefined;
  const value = nestedValue ?? record[`sessionQueue.${sessionId}`];
  if (value === undefined || value === null) return null;
  const legacy = Array.isArray(value);
  // 结构非法（有条目但 items 不是数组）：返回 null 而不是「权威空队列」，
  // 否则一次损坏的偏好就能把 UI 上合法的本地队列清成空。
  if (!legacy && !Array.isArray((value as { items?: unknown }).items)) return null;
  const state = parseFollowUpQueue(value);
  return {
    items: state.items,
    revision: legacy ? null : state.revision,
  };
}

/** 会话结束原因：只有正常完成才自动投递队列；中止/异常保留队列。 */
export type QueueAutoFlushReason = "completed" | "aborted" | "error";

export function shouldAutoFlushQueue(reason: QueueAutoFlushReason | null | undefined): boolean {
  return reason === "completed";
}

export function parseQueueAutoFlushReason(value: unknown): QueueAutoFlushReason | null {
  return value === "completed" || value === "aborted" || value === "error" ? value : null;
}
