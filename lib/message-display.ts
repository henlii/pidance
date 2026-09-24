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
 * 回复因模型输出上限被截断（`stopReason === "length"`）。
 *
 * 这类回复可能只烧在思考里、正文为空：必须给出显式反馈，不能整卡隐藏成「卡死」。
 */
export function isAssistantTruncated(message: Pick<AssistantMessage, "stopReason">): boolean {
  return message.stopReason === "length";
}

/**
 * 流式消息里只有最后一块仍在输出。思考/工具块应在本块不再是活跃输出时立刻收回，
 * 而不是等到整轮 agent 结束或下一次模型调用。
 */
export function isActiveStreamBlock(isStreaming: boolean | undefined, index: number, total: number): boolean {
  return Boolean(isStreaming) && total > 0 && index === total - 1;
}

/**
 * 折叠态那一行的统一口径（用户 2026-09-24 定）：
 *
 * - **流式中**取内容的末行，反映「现在在干什么」（跟随输出滚动）；
 * - **流式结束后**取首行，作为不随输出变化的稳定标识。
 *
 * 空白行不参与取值；没有可用内容时返回空串，由调用方决定回退文案（例如工具块回退命令行）。
 * 思考、工具、压缩、分支摘要、扩展自定义消息共用这一处，避免每个块各写一套首/末行规则。
 */
export function collapsedSummaryLine(
  text: string | null | undefined,
  options: { streaming?: boolean } = {},
): string {
  const lines = (text ?? "").split("\n").map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) return "";
  return options.streaming ? lines[lines.length - 1] : lines[0];
}

/**
 * 工具卡的「实时输出」段是否渲染。
 *
 * 背景：`tool_execution_end` 之后终态快照仍留在缓冲里（`applyToolExecutionEnd` 只钉状态、
 * 保留最终 output），所以「实时输出」段若只判 `expanded && snapshot`，同一份输出会和
 * 「配对结果」段同时上屏（展开已结束的工具卡就看到两遍）。
 *
 * 规则：运行中才用实时段；已结束但**没有**配对结果（结果事件迟到/缺失）时保留实时段 ——
 * 宁可显示一次，也不要丢内容。
 */
export function shouldRenderLiveToolOutput(input: {
  hasSnapshot: boolean;
  isRunning: boolean;
  hasResult: boolean;
}): boolean {
  return input.hasSnapshot && (input.isRunning || !input.hasResult);
}
