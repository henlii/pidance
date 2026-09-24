import type { AgentMessage, AssistantMessage, ToolCallContent } from "./types";
import { isThinkingLikeType, toThinkingBlock } from "./thinking-content";

function isObject(val: unknown): val is Record<string, unknown> {
  return typeof val === "object" && val !== null && !Array.isArray(val);
}

function normalizeToolCallBlock(block: unknown): ToolCallContent | null {
  if (!isObject(block) || block.type !== "toolCall") return null;
  const normalized: ToolCallContent = {
    type: "toolCall",
    toolCallId: typeof block.toolCallId === "string" ? block.toolCallId : (typeof block.id === "string" ? block.id : ""),
    toolName: typeof block.toolName === "string" ? block.toolName : (typeof block.name === "string" ? block.name : ""),
    input: typeof block.input === "object" && block.input !== null && !Array.isArray(block.input)
      ? block.input as Record<string, unknown>
      : (typeof block.arguments === "object" && block.arguments !== null && !Array.isArray(block.arguments)
        ? block.arguments as Record<string, unknown>
        : {}),
  };
  if (Array.isArray(block.renderedCallLines) && block.renderedCallLines.every((line) => typeof line === "string")) {
    normalized.renderedCallLines = [...block.renderedCallLines] as string[];
  }
  // 工具定义的显示元数据（issue #75）：本函数重建块对象，不透传就会在归一这一步丢掉。
  if (typeof block.toolLabel === "string" && block.toolLabel.trim() !== "") {
    normalized.toolLabel = block.toolLabel;
  }
  if (block.toolShell === "self") {
    normalized.toolShell = "self";
  }
  return normalized;
}

export function normalizeToolCalls(msg: AgentMessage): AgentMessage {
  // Non-assistant roles (user, toolResult, bashExecution, custom) are returned
  // unchanged — only assistant messages go through tool-call field normalization.
  if (msg.role !== "assistant") return msg;
  const content = (msg as AssistantMessage).content;
  if (!Array.isArray(content)) return msg;
  const normalized = content.map((block) => {
    const tool = normalizeToolCallBlock(block);
    if (tool) return tool;
    if (isObject(block) && isThinkingLikeType(block.type)) {
      return toThinkingBlock(block) as typeof block;
    }
    return block;
  });
  return { ...msg, content: normalized } as AgentMessage;
}
