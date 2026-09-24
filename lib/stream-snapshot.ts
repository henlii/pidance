/**
 * 连接首帧快照缓存（纯逻辑，无 IO / 无 React，node:test 可直接测）。
 *
 * 背景：SSE 只从订阅那一刻起转发事件，中途接入的页面（新标签、刷新重连、冷挂载）
 * 看不到已经生成的部分回复和正在跑的工具输出，要等下一个 chunk 才出字。服务端因此
 * 在连接建立时回放「当前流式状态」：最近一条 message 事件 + 每个活跃工具的最新
 * start/update。
 *
 * 语义约定：
 * - 只缓存**已经投影、原本要下发**的事件对象（回放与实时路径同形，浏览器侧不需要
 *   第二条解释路径）；缓存的是引用，调用方不得改写。
 * - `message_start` / `message_update` 只缓存非 user 角色（与浏览器侧的过滤一致）。
 * - `agent_start` 清掉上一轮快照；`message_end` / `agent_end` / `prompt_done` /
 *   `agent_settled` 表示本轮结束，流式快照清空（否则重连的页面会把上一轮的文字
 *   当成还在生成）。
 * - 工具按 toolCallId 键控：**必须先有 start 才记 update**（浏览器工具缓冲会忽略
 *   未见 start 的 update，所以回放顺序必须是 start → update）；end 后条目移除，
 *   终态结果由消息历史负责，不在这里回放。
 * - 工具在跑但本轮没有流式消息（纯 bash 轮次）也算 isStreaming：连接方据此对齐
 *   运行态，否则回放的工具事件会被当过期帧丢掉。
 */

/** 快照事件：与 SSE 下发的事件同形（type + 任意字段）。 */
export type SnapshotEvent = { type: string; [key: string]: unknown };

export type StreamSnapshot = {
  /** 这条连接建立时，服务端是否正持有本轮的流式状态（消息或工具）。 */
  isStreaming: boolean;
  /** 回放顺序：流式消息 → 每个活跃工具的 start 与其最新 update。 */
  events: SnapshotEvent[];
};

export type StreamSnapshotCache = {
  remember(event: SnapshotEvent): void;
  snapshot(): StreamSnapshot;
  reset(): void;
};

function toolCallIdOf(event: SnapshotEvent): string | null {
  const value = event.toolCallId;
  return typeof value === "string" && value !== "" ? value : null;
}

function messageIdOf(event: SnapshotEvent): string | null {
  const message = event.message as { id?: unknown } | undefined;
  const value = message?.id ?? event.messageId;
  return typeof value === "string" && value !== "" ? value : null;
}

export function createStreamSnapshotCache(): StreamSnapshotCache {
  let streamingEvent: SnapshotEvent | null = null;
  const activeTools = new Map<string, { start: SnapshotEvent; update: SnapshotEvent | null }>();

  return {
    remember(event: SnapshotEvent): void {
      switch (event.type) {
        case "agent_start":
          streamingEvent = null;
          activeTools.clear();
          return;
        case "message_start":
        case "message_update": {
          const message = event.message as { role?: unknown } | undefined;
          if (!message || message.role === "user") return;
          streamingEvent = event;
          return;
        }
        case "message_end":
          streamingEvent = null;
          return;
        case "agent_end":
        case "prompt_done":
        case "agent_settled":
          streamingEvent = null;
          activeTools.clear();
          return;
        case "tool_execution_start": {
          const toolCallId = toolCallIdOf(event);
          if (!toolCallId) return;
          activeTools.set(toolCallId, { start: event, update: null });
          return;
        }
        case "tool_execution_update": {
          const toolCallId = toolCallIdOf(event);
          if (!toolCallId) return;
          const entry = activeTools.get(toolCallId);
          if (!entry) return;
          entry.update = event;
          return;
        }
        case "tool_execution_end": {
          const toolCallId = toolCallIdOf(event);
          if (!toolCallId) return;
          activeTools.delete(toolCallId);
          return;
        }
        default:
          return;
      }
    },
    snapshot(): StreamSnapshot {
      const events: SnapshotEvent[] = [];
      if (streamingEvent) events.push(streamingEvent);
      for (const entry of activeTools.values()) {
        events.push(entry.start);
        if (entry.update) events.push(entry.update);
      }
      return { isStreaming: streamingEvent !== null || activeTools.size > 0, events };
    },
    reset(): void {
      streamingEvent = null;
      activeTools.clear();
    },
  };
}

/**
 * 事件是否已经包含在快照里。
 *
 * 订阅与取快照之间没有 await（同一段同步代码），正常不会产生待回放缓冲；这条判定
 * 是兜底：真正被缓冲下来、且内容与快照重复的帧不再重复下发。只能在双方都带
 * messageId 时确认「同一条消息」——不能凭 type/role 猜，同一条流上多条消息是常态。
 */
export function isEventIncludedInSnapshot(event: SnapshotEvent, snapshot: StreamSnapshot): boolean {
  if (event.type === "message_start" || event.type === "message_update") {
    const messageId = messageIdOf(event);
    if (!messageId) return false;
    return snapshot.events.some((candidate) => {
      if (candidate.type !== "message_start" && candidate.type !== "message_update") return false;
      return messageIdOf(candidate) === messageId;
    });
  }
  if (event.type === "tool_execution_start" || event.type === "tool_execution_update") {
    const toolCallId = toolCallIdOf(event);
    if (!toolCallId) return false;
    return snapshot.events.some(
      (candidate) => candidate.type === event.type && toolCallIdOf(candidate) === toolCallId,
    );
  }
  return false;
}
