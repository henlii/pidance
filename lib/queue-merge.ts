/**
 * 本地 follow-up 队列 → 引导（steer）合并发送的纯逻辑。
 *
 * 外部 Pi 0.83 无 clear_queue RPC：follow-up 队列由 Pidance 本地自管，
 * 引导发送 = 把队列（+ 输入框 extra）合并为一条 steer 消息（公开命令）。
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
