import type { AgentMessage, CustomMessage } from "./types";

/** custom 消息上的合法 ANSI 行（非 custom / 空 / 畸形 → null）。
 *
 * 主题刷新（issue #109）与磁盘重载合并共用这一条判据：两者都要回答
 * 「这条消息现在有没有可显示的行」，判据分叉会让其中一条路把另一条的覆盖层丢掉。
 */
export function validRenderedLines(message: AgentMessage): string[] | null {
  if (message.role !== "custom") return null;
  const lines = (message as CustomMessage).renderedLines;
  return Array.isArray(lines) && lines.length > 0 && lines.every((line) => typeof line === "string") ? lines : null;
}

function customIdentity(message: AgentMessage): string | null {
  if (message.role !== "custom") return null;
  const content = typeof message.content === "string" ? message.content : JSON.stringify(message.content);
  return `${message.customType}\u0000${message.display ? "1" : "0"}\u0000${content}`;
}

/**
 * 磁盘会话不保存 live ANSI 行。整体重载时先按 entryId、再按 custom 消息身份，
 * 将当前页面已收到的渲染覆盖层合并到新快照；不会修改或写回 Pi session schema。
 */
export function preserveCustomRenderedLines(
  previousMessages: readonly AgentMessage[],
  previousEntryIds: readonly string[],
  nextMessages: readonly AgentMessage[],
  nextEntryIds: readonly string[],
): AgentMessage[] {
  const byEntryId = new Map<string, string[]>();
  const byIdentity = new Map<string, string[][]>();

  previousMessages.forEach((message, index) => {
    const lines = validRenderedLines(message);
    if (!lines) return;
    const entryId = previousEntryIds[index];
    if (entryId) byEntryId.set(entryId, lines);
    // 已有 entryId 的磁盘消息只能精确匹配，不能把 ANSI 行误带到另一分支上
    // 内容相同的 custom 消息；身份回退仅服务于刚由 message_end 追加、尚无 id 的 live 项。
    if (entryId) return;
    const identity = customIdentity(message);
    if (!identity) return;
    const queue = byIdentity.get(identity) ?? [];
    queue.push(lines);
    byIdentity.set(identity, queue);
  });

  return nextMessages.map((message, index) => {
    if (message.role !== "custom" || validRenderedLines(message)) return message;
    const entryLines = nextEntryIds[index] ? byEntryId.get(nextEntryIds[index]) : undefined;
    const identity = entryLines ? null : customIdentity(message);
    const identityLines = identity ? byIdentity.get(identity)?.shift() : undefined;
    const renderedLines = entryLines ?? identityLines;
    return renderedLines ? { ...message, renderedLines: [...renderedLines] } : message;
  });
}

/**
 * 只为 custom 消息透传合法 ANSI 行；畸形载荷保持原消息以触发现有文本回退。
 */
export function attachCustomRenderedLines(message: AgentMessage, renderedLines: unknown): AgentMessage {
  if (
    message.role !== "custom"
    || !Array.isArray(renderedLines)
    || !renderedLines.every((line) => typeof line === "string")
  ) {
    return message;
  }
  return { ...message, renderedLines };
}
