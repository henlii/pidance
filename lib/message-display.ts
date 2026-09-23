import type { AssistantContentBlock, AssistantMessage, ThinkingContent } from "./types";
import { getThinkingText } from "./thinking-content";

interface DisplayOptions {
  isStreaming?: boolean;
}

export function isEmptyThinkingBlock(block: AssistantContentBlock, options: DisplayOptions = {}): block is ThinkingContent {
  return block.type === "thinking" && !block.deferred && !options.isStreaming && getThinkingText(block).trim() === "";
}

export function getDisplayableAssistantBlocks(
  message: AssistantMessage,
  options: DisplayOptions = {},
): AssistantContentBlock[] {
  return (message.content ?? []).filter((block) => !isEmptyThinkingBlock(block, options));
}

/**
 * 流式消息里只有最后一块仍在输出。思考/工具块应在本块不再是活跃输出时立刻收回，
 * 而不是等到整轮 agent 结束或下一次模型调用。
 */
export function isActiveStreamBlock(isStreaming: boolean | undefined, index: number, total: number): boolean {
  return Boolean(isStreaming) && total > 0 && index === total - 1;
}
