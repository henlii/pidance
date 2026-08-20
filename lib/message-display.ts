import type { AssistantContentBlock, AssistantMessage, ThinkingContent, ToolCallContent } from "./types";
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

function isFinalAnswerBlock(block: AssistantContentBlock): boolean {
  return block.type === "text" || block.type === "image";
}

export function splitFinalAssistantBlocks(
  message: AssistantMessage,
  options: DisplayOptions = {},
): { answerBlocks: AssistantContentBlock[]; processBlocks: AssistantContentBlock[] } {
  const blocks = getDisplayableAssistantBlocks(message, options);
  const lastProcessIndex = blocks.findLastIndex((block) => !isFinalAnswerBlock(block));
  if (lastProcessIndex === -1) {
    return { answerBlocks: blocks, processBlocks: [] };
  }
  return {
    answerBlocks: blocks.slice(lastProcessIndex + 1),
    processBlocks: blocks.slice(0, lastProcessIndex + 1),
  };
}

export function countToolCallBlocks(blocks: AssistantContentBlock[]): number {
  return blocks.filter((block): block is ToolCallContent => block.type === "toolCall").length;
}

/**
 * 流式消息里只有最后一块仍在输出。思考/工具块应在本块不再是活跃输出时立刻收回，
 * 而不是等到整轮 agent 结束或下一次模型调用。
 */
export function isActiveStreamBlock(isStreaming: boolean | undefined, index: number, total: number): boolean {
  return Boolean(isStreaming) && total > 0 && index === total - 1;
}
