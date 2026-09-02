import type { AgentMessage, AssistantContentBlock, AssistantMessage } from "./types";
import { countToolCallBlocks, getDisplayableAssistantBlocks, splitFinalAssistantBlocks } from "./message-display";

export interface ChatCompositorInput {
  messages: AgentMessage[];
  isStreaming: boolean;
  agentOrBashRunning: boolean;
  /** live streaming slot：isActive 且有 message 时作为计划末尾的一个 message item；
   *  无 liveSlot 时行为与现有完全一致。 */
  liveSlot?: { message: Partial<AgentMessage> | null; isActive: boolean };
}

export interface ChatRenderItem {
  kind: "message";
  /** 磁盘消息索引；live 项为 null（组件侧据此关闭分支/新会话写入口） */
  messageIndex: number | null;
  /** 消息来源：disk 对应 messages[messageIndex]；live 由 messageOverride 承载流式消息 */
  source: "disk" | "live";
  messageOverride?: AgentMessage;
  showTimestamp?: boolean;
  keyPrefix: string;
  attachRef: boolean;
}

export interface ChatProcessGroup {
  kind: "processGroup";
  userIdx: number;
  finalAssistantIdx: number;
  messageCount: number;
  toolCallCount: number;
  children: ChatRenderItem[];
  attachRefMessageIndex?: number;
}

export type ChatRenderPlanItem = ChatRenderItem | ChatProcessGroup;

function hasFinalAssistantAnswer(message: AgentMessage): boolean {
  if (message.role !== "assistant") return false;
  return splitFinalAssistantBlocks(message as AssistantMessage).answerBlocks.some((block) => (
    block.type === "image" || (block.type === "text" && block.text.trim().length > 0)
  ));
}

function findFinalAssistantIndex(messages: AgentMessage[], userIdx: number, endIdx: number): number {
  for (let candidateIdx = endIdx - 1; candidateIdx > userIdx; candidateIdx--) {
    if (hasFinalAssistantAnswer(messages[candidateIdx])) return candidateIdx;
  }
  for (let candidateIdx = endIdx - 1; candidateIdx > userIdx; candidateIdx--) {
    if (messages[candidateIdx]?.role === "assistant") return candidateIdx;
  }
  return -1;
}

function hasAssistantErrorFeedback(message: AssistantMessage): boolean {
  const stop = message.stopReason;
  if (stop === "error" || stop === "aborted") return true;
  return typeof message.errorMessage === "string" && message.errorMessage.trim().length > 0;
}

function hasDisplayableProcessMessage(message: AgentMessage): boolean {
  if (message.role === "assistant") {
    const assistant = message as AssistantMessage;
    // 上游 API/中止错误常无 content，但仍须在会话中可见
    if (hasAssistantErrorFeedback(assistant)) return true;
    return getDisplayableAssistantBlocks(assistant).length > 0;
  }
  return message.role === "custom";
}

function withAssistantBlocks(message: AssistantMessage, content: AssistantContentBlock[], omitUsage = false): AssistantMessage {
  const next = { ...message, content };
  if (omitUsage) next.usage = undefined;
  return next;
}

function timestampFor(messages: AgentMessage[], idx: number, isStreaming: boolean): boolean | undefined {
  if (messages[idx]?.role !== "assistant") return undefined;
  let show = true;
  for (let j = idx + 1; j < messages.length; j++) {
    const role = messages[j].role;
    if (role === "user") break;
    if (role === "assistant") { show = false; break; }
  }
  if (show && isStreaming && idx === messages.length - 1) show = false;
  return show;
}

function messageItem(messages: AgentMessage[], idx: number, isStreaming: boolean, options: Partial<ChatRenderItem> = {}): ChatRenderItem {
  return {
    kind: "message",
    source: "disk",
    messageIndex: idx,
    keyPrefix: options.keyPrefix ?? "message",
    attachRef: options.attachRef ?? true,
    showTimestamp: options.showTimestamp ?? timestampFor(messages, idx, isStreaming),
    ...(options.messageOverride ? { messageOverride: options.messageOverride } : {}),
  };
}

export function composeChatPlan(input: ChatCompositorInput): ChatRenderPlanItem[] {
  const { messages, isStreaming, agentOrBashRunning, liveSlot } = input;
  const liveActive = Boolean(liveSlot?.isActive && liveSlot.message);
  const liveUserStart = trailingLiveUserStart(messages, liveActive);
  const lastUserIdx = messages.slice(0, liveUserStart).findLastIndex((message) => message.role === "user");
  const plan: ChatRenderPlanItem[] = [];

  for (let idx = 0; idx < liveUserStart;) {
    if (messages[idx].role !== "user") {
      plan.push(messageItem(messages, idx, isStreaming));
      idx++;
      continue;
    }
    const userIdx = idx;
    let endIdx = userIdx + 1;
    while (endIdx < messages.length && messages[endIdx].role !== "user") endIdx++;
    const finalAssistantIdx = findFinalAssistantIndex(messages, userIdx, endIdx);
    if (finalAssistantIdx === -1 || ((agentOrBashRunning || isStreaming) && endIdx === messages.length && userIdx === lastUserIdx)) {
      for (let renderIdx = userIdx; renderIdx < endIdx; renderIdx++) plan.push(messageItem(messages, renderIdx, isStreaming));
      idx = endIdx;
      continue;
    }

    plan.push(messageItem(messages, userIdx, isStreaming));
    const visibleProcessIndices: number[] = [];
    for (let processIdx = userIdx + 1; processIdx < finalAssistantIdx; processIdx++) {
      if (hasDisplayableProcessMessage(messages[processIdx])) visibleProcessIndices.push(processIdx);
    }
    const finalAssistant = messages[finalAssistantIdx] as AssistantMessage;
    const finalSplit = splitFinalAssistantBlocks(finalAssistant);
    const finalProcessMessage = finalSplit.processBlocks.length > 0
      ? withAssistantBlocks(finalAssistant, finalSplit.processBlocks, true)
      : undefined;
    const finalAnswerMessage = finalSplit.answerBlocks.length > 0
      ? withAssistantBlocks(finalAssistant, finalSplit.answerBlocks)
      : undefined;
    const processCount = visibleProcessIndices.length + (finalProcessMessage ? 1 : 0);
    if (processCount > 0) {
      const refTarget = visibleProcessIndices.find((processIdx) => messages[processIdx].role === "assistant" || messages[processIdx].role === "user")
        ?? (finalAnswerMessage ? undefined : finalAssistantIdx);
      plan.push({
        kind: "processGroup",
        userIdx,
        finalAssistantIdx,
        messageCount: processCount,
        toolCallCount: visibleProcessIndices.reduce((count, processIdx) => count + (messages[processIdx].role === "assistant" ? countToolCallBlocks(getDisplayableAssistantBlocks(messages[processIdx] as AssistantMessage)) : 0), 0) + countToolCallBlocks(finalSplit.processBlocks),
        children: [
          ...visibleProcessIndices.map((processIdx) => messageItem(messages, processIdx, isStreaming, { attachRef: false, keyPrefix: "process" })),
          ...(finalProcessMessage ? [messageItem(messages, finalAssistantIdx, isStreaming, { attachRef: false, keyPrefix: "process-final", messageOverride: finalProcessMessage, showTimestamp: false })] : []),
        ],
        ...(refTarget === undefined ? {} : { attachRefMessageIndex: refTarget }),
      });
    }
    if (finalAnswerMessage) {
      plan.push(messageItem(messages, finalAssistantIdx, isStreaming, { messageOverride: finalAnswerMessage }));
    } else if (hasAssistantErrorFeedback(finalAssistant) && !finalProcessMessage) {
      // 无 answer/process 块的 error/aborted 消息仍须单独入计划（MessageView 画错误横幅）
      plan.push(messageItem(messages, finalAssistantIdx, isStreaming));
    }
    for (let renderIdx = finalAssistantIdx + 1; renderIdx < endIdx; renderIdx++) plan.push(messageItem(messages, renderIdx, isStreaming));
    idx = endIdx;
  }
  // live streaming slot：本轮思考/工具先于末尾的引导 user 气泡出现。
  // timestamp 语义与当前 live tail 一致（不重复推导，显式隐藏）。
  if (liveSlot?.isActive && liveSlot.message) {
    plan.push({
      kind: "message",
      source: "live",
      messageIndex: null,
      messageOverride: liveSlot.message as AgentMessage,
      keyPrefix: "live",
      attachRef: false,
      showTimestamp: false,
    });
  }
  // trailing user（引导乐观气泡）：按原 index 单独渲染，不进入 process group。
  for (let idx = liveUserStart; idx < messages.length; idx++) {
    plan.push(messageItem(messages, idx, isStreaming));
  }
  return plan;
}

/**
 * live 激活时末尾可后置到 live 之后的连续 user 气泡起点。
 * 从末尾剥连续 role==="user"：仅当该条是引导乐观（_steerOptimistic）
 * 或前一条也是 user（连续引导）；前一条是 assistant 的新 prompt 不剥——
 * 那是新回合用户消息，应在 live 之前。live 未激活返回 messages.length。
 */
export function trailingLiveUserStart(
  messages: readonly AgentMessage[],
  liveActive: boolean,
): number {
  if (!liveActive) return messages.length;
  let split = messages.length;
  while (split > 0) {
    const message = messages[split - 1];
    if (message?.role !== "user") break;
    const isSteerOptimistic = (message as { _steerOptimistic?: boolean })._steerOptimistic === true;
    const prevIsUser = split - 2 >= 0 && messages[split - 2]?.role === "user";
    if (!isSteerOptimistic && !prevIsUser) break;
    split--;
  }
  return split;
}

/**
 * 从渲染计划中提取 live 消息投影。live 通常在计划末尾，但 trailing user（引导
 * 乐观气泡）会被后置到 live 之后——因此按计划位置查找，不假定一定是最后一项。
 * ChatMinimap 等消费同一计划时用此函数获取 live 消息，消除第二套 live 拼接。
 */
export function getChatPlanLiveMessage(plan: ChatRenderPlanItem[]): Partial<AgentMessage> | null {
  for (let idx = plan.length - 1; idx >= 0; idx--) {
    const item = plan[idx];
    if (item?.kind === "message" && item.source === "live") return item.messageOverride ?? null;
  }
  return null;
}
