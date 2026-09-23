import type { AgentMessage } from "./types";

export interface ChatCompositorInput {
  messages: AgentMessage[];
  isStreaming: boolean;
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

/**
 * 渲染计划项 = 一条消息一项。
 *
 * 过程不再折叠（2026-09-23）：折叠会让同一段内容在不同时刻呈现不同形态 ——
 * 窗口边界一变（懒加载补齐了一轮的起始 user 消息），原本平铺的过程就被收成一行
 * 摘要，用户看到「内容突然折叠」；折叠态的离屏占位又要靠估算高度，挂载时高度
 * 一变就是滚动抖动。顺序只由消息在会话里的位置决定，就没有这些状态。
 * 保留这个类型别名是因为导航条与 minimap 消费同一投影。
 */
export type ChatRenderPlanItem = ChatRenderItem;

/** 同一轮里只在最后一条 assistant 上显示时间戳（后面还有 assistant 就不显示）。 */
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
  const { messages, isStreaming, liveSlot } = input;
  const liveActive = Boolean(liveSlot?.isActive && liveSlot.message);
  const liveUserStart = trailingLiveUserStart(messages, liveActive);
  const plan: ChatRenderPlanItem[] = [];
  for (let idx = 0; idx < liveUserStart; idx++) {
    plan.push(messageItem(messages, idx, isStreaming));
  }
  // live streaming slot：插在末尾；末尾的引导乐观气泡按 trailingLiveUserStart 后置到它之后。
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
  for (let idx = liveUserStart; idx < messages.length; idx++) {
    plan.push(messageItem(messages, idx, isStreaming));
  }
  return plan;
}

/**
 * live 激活时末尾可后置到 live 之后的连续 user 气泡起点。
 * 从末尾剥连续 role==="user"：仅当该条是「本步运行期间发出的引导」
 * （_duringStreamingStep，由 registry 的 appendLocal 按 agentRunning 打标）
 * 或前一条也是 user（连续引导）；前一条是 assistant 的新 prompt 不剥——
 * 那是新回合用户消息，应在 live 之前。live 未激活返回 messages.length。
 *
 * 判据必须与 registry 的 insertRecordBeforePendingSteers 一致：那里决定本步记录
 * 落盘时插在引导前面还是后面。两边用同一个字段，位置就不会先下后上地跳。
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
    const duringRunningStep = (message as { _duringStreamingStep?: boolean })._duringStreamingStep === true;
    const prevIsUser = split - 2 >= 0 && messages[split - 2]?.role === "user";
    if (!duringRunningStep && !prevIsUser) break;
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
