/**
 * 服务端 SSE 事件投影纯函数（无 IO、无 React，node:test 可直接测）。
 *
 * 语义：把 AgentSession 的原始事件投影为发送给客户端的 SSE 事件。瘦身/丢弃规则
 * 对齐上游 0.8.6 事件流，并 **透传 tool_execution_update**
 * （客户端工具块渲染的前提；投影层只透传不渲染）。
 *
 * 投影规则：
 * - turn_start / turn_end：客户端不消费，丢弃（返回 null）。
 * - tool_execution_update：原样保留（含 toolCallId / toolName / args / partialResult）。
 * - message_update：删除 assistantMessageEvent 大字段、保留其余字段；
 *   返回浅拷贝，不修改原事件对象（纯函数）。
 * - agent_end：瘦身为 { type: "agent_end" }。
 * - 其他带合法 type 的事件：原样保留（返回原对象，避免多余拷贝）。
 * - 无合法 type（缺 type / type 非非空字符串 / 非对象）：返回 null，不发送。
 */

/**
 * 投影单个原始事件为待发送事件。
 * @param event 来自 AgentSession 的原始事件（形状由 Pi SDK 决定，故用 unknown 入参）
 * @returns 应发送的事件；应丢弃时返回 null
 */
export function projectAgentEvent(event: unknown): Record<string, unknown> | null {
  if (typeof event !== "object" || event === null) return null;

  const record = event as Record<string, unknown>;
  const type = record.type;
  if (typeof type !== "string" || type.length === 0) return null;

  // turn_start / turn_end：客户端不消费，丢弃
  if (type === "turn_start" || type === "turn_end") return null;

  // message_update：去掉 assistantMessageEvent 大字段，保留其余字段（不改原对象）
  if (type === "message_update") {
    const slim = { ...record };
    delete slim.assistantMessageEvent;
    return slim;
  }

  // agent_end：瘦身为 { type: "agent_end" }
  if (type === "agent_end") {
    return { type: "agent_end" };
  }

  // tool_execution_update 及其他带合法 type 的事件：原样保留
  return record;
}
