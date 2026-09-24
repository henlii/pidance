/**
 * 连接首帧快照缓存（纯逻辑，无 IO / 无 React，node:test 可直接测）。
 *
 * 背景：SSE 只从订阅那一刻起转发事件，中途接入的页面（新标签、刷新重连、冷挂载）
 * 看不到已经生成的部分回复和正在跑的工具输出，要等下一个 chunk 才出字。服务端因此
 * 在连接建立时回放「当前流式状态」：最近一条 message 事件 + 每个活跃工具的最新
 * start/update。
 *
 * 语义约定：
 * - 只缓存**宿主 emit 的事件对象**（回放时要和实时路径一样过 `projectAgentEvent`；缓存的是
 *   引用，调用方不得改写）。
 * - `message_start` / `message_update` 只缓存非 user 角色（与浏览器侧的过滤一致）。
 * - `agent_start` 清掉上一轮快照；`message_end` / `agent_end` / `prompt_done` /
 *   `agent_settled` 表示本轮结束，流式快照清空（否则重连的页面会把上一轮的文字
 *   当成还在生成）。
 * - 工具按 toolCallId 键控：**必须先有 start 才记 update**（浏览器工具缓冲会忽略
 *   未见 start 的 update，所以回放顺序必须是 start → update）；update 另外记一份
 *   「最近一条带渲染行」的（服务端按 toolCallId 节流渲染，被节流的那帧没有
 *   `renderedLines`），回放时补上，否则重连页面从 ANSI 渲染降级成原始文本；
 *   end 后条目移除，终态结果由消息历史负责，不在这里回放。
 * - 工具在跑但本轮没有流式消息（纯 bash 轮次）也算 isStreaming：连接方据此对齐
 *   运行态，否则回放的工具事件会被当过期帧丢掉。
 */

/** 快照事件：与 SSE 下发的事件同形（type + 任意字段）。 */
export type SnapshotEvent = { type: string; [key: string]: unknown };

export type StreamSnapshot = {
  /** 这条连接建立时，服务端是否正持有本轮的流式状态（消息或工具）。 */
  isStreaming: boolean;
  /** 当前 SDK run 序号（宿主自己的计数器，0 表示还没跑过）；首帧回放没有
   *  `agent_start`，客户端靠它对齐上一轮的序号。 */
  streamRunSeq?: number;
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

/** 该事件是否带可用的插件渲染行（ANSI）。被节流的那帧不带。 */
function hasRenderedLines(event: SnapshotEvent): boolean {
  const lines = event.renderedLines;
  return Array.isArray(lines) && lines.length > 0;
}

export function createStreamSnapshotCache(): StreamSnapshotCache {
  let streamingEvent: SnapshotEvent | null = null;
  const activeTools = new Map<
    string,
    { start: SnapshotEvent; update: SnapshotEvent | null; renderedUpdate: SnapshotEvent | null }
  >();

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
          activeTools.set(toolCallId, { start: event, update: null, renderedUpdate: null });
          return;
        }
        case "tool_execution_update": {
          const toolCallId = toolCallIdOf(event);
          if (!toolCallId) return;
          const entry = activeTools.get(toolCallId);
          if (!entry) return;
          entry.update = event;
          if (hasRenderedLines(event)) entry.renderedUpdate = event;
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
        const update = entry.update ?? entry.renderedUpdate;
        if (!update) continue;
        // 最新一帧被节流（**没有** `renderedLines` 字段）时，带上最近一次渲染过的行：
        // 否则重连页面只能看到原始文本，要等下一个渲染帧才恢复 ANSI。
        // 显式给了字段（含空数组）就按它来，不能用旧行盖掉插件的「这一帧没渲染」。
        const carriesRenderedLines = Object.prototype.hasOwnProperty.call(update, "renderedLines");
        if (!carriesRenderedLines && entry.renderedUpdate) {
          events.push({ ...update, renderedLines: entry.renderedUpdate.renderedLines });
        } else {
          events.push(update);
        }
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
 * 订阅与取快照之间没有 `await`（同一段同步代码），正常不会产生待回放缓冲；这条判定
 * 是兜底：真正被缓冲下来、且内容已在快照里的帧不再重复下发。
 *
 * 判定按「重复下发无害、漏发有害」取舍：
 * - `message_start`：同一条消息只要有更晚的事件（含 update）进了快照，start 就被
 *   取代，按 messageId 丢弃。
 * - `message_update`：只认**同一个事件对象**。同 id 的 update 内容可能更新，按 id
 *   一律丢弃会让用户停在旧 partial 上，而重复下发只是整条替换（幂等）。
 */
export function isEventIncludedInSnapshot(event: SnapshotEvent, snapshot: StreamSnapshot): boolean {
  if (event.type === "message_start") {
    const messageId = messageIdOf(event);
    if (!messageId) return false;
    return snapshot.events.some((candidate) => {
      if (candidate.type !== "message_start" && candidate.type !== "message_update") return false;
      return messageIdOf(candidate) === messageId;
    });
  }
  if (event.type === "message_update") {
    return snapshot.events.some((candidate) => candidate === event);
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
