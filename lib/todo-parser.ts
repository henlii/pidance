import type { AgentMessage, AssistantMessage, ToolCallContent, ToolResultMessage } from "./types";

export type TodoStatus = "pending" | "in_progress" | "completed";
export type TodoPriority = "high" | "medium" | "low";

export interface TodoItem {
  readonly id: string;
  readonly content: string;
  readonly status: TodoStatus;
  /** todowrite 快照必有；rpiv-todo 任务没有优先级。 */
  readonly priority?: TodoPriority;
  /** rpiv-todo in_progress 任务的进行时文案。 */
  readonly activeForm?: string;
  /** 仍在阻塞本项的任务标签（subject，未知 id 回退 #id）。 */
  readonly blockedBy?: readonly string[];
}

const TODO_STATUSES: readonly TodoStatus[] = ["pending", "in_progress", "completed"];
const TODO_PRIORITIES: readonly TodoPriority[] = ["high", "medium", "low"];

/** rpiv-todo 的 TaskStatus 含 deleted 墓碑；deleted 校验后过滤，不进入渲染。 */
const TASK_STATUSES = ["pending", "in_progress", "completed", "deleted"] as const;
type TaskStatus = (typeof TASK_STATUSES)[number];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTodoStatus(value: unknown): value is TodoStatus {
  return typeof value === "string" && TODO_STATUSES.includes(value as TodoStatus);
}

function isTodoPriority(value: unknown): value is TodoPriority {
  return typeof value === "string" && TODO_PRIORITIES.includes(value as TodoPriority);
}

function isTaskStatus(value: unknown): value is TaskStatus {
  return typeof value === "string" && TASK_STATUSES.includes(value as TaskStatus);
}

function isTodoWrite(toolName: unknown): boolean {
  return typeof toolName === "string" && toolName.toLowerCase().replace(/[_-]/g, "") === "todowrite";
}

function readToolCall(block: unknown): ToolCallContent | null {
  if (!isRecord(block) || block.type !== "toolCall") return null;
  const input = isRecord(block.input)
    ? block.input
    : (isRecord(block.arguments) ? block.arguments : {});
  return {
    type: "toolCall",
    toolCallId: typeof block.toolCallId === "string" ? block.toolCallId : (typeof block.id === "string" ? block.id : ""),
    toolName: typeof block.toolName === "string" ? block.toolName : (typeof block.name === "string" ? block.name : ""),
    input,
  };
}

function stableHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function readSnapshot(block: ToolCallContent): readonly TodoItem[] | null {
  if (!isRecord(block.input) || !Array.isArray(block.input.todos)) return null;

  const todos: TodoItem[] = [];
  for (const [index, item] of block.input.todos.entries()) {
    if (!isRecord(item)
      || typeof item.content !== "string"
      || item.content.length === 0
      || !isTodoStatus(item.status)
      || !isTodoPriority(item.priority)) {
      return null;
    }
    todos.push({
      id: `todo-${index}-${stableHash(`${index}\u0000${item.content}\u0000${item.status}\u0000${item.priority}`)}`,
      content: item.content,
      status: item.status,
      priority: item.priority,
    });
  }
  return todos;
}

interface RpivTask {
  readonly id: number;
  readonly subject: string;
  readonly status: TaskStatus;
  readonly activeForm?: string;
  readonly blockedBy?: readonly number[];
}

/**
 * rpiv-todo 持久化契约（镜像其 state/replay.ts）：toolResult.toolName === "todo"
 * 且 details 形如 { tasks: Task[], nextId: number }。单个任务损坏拒绝整个快照，
 * 回退上一合法快照，与 todowrite 解析一致。
 */
function readTaskDetailsSnapshot(details: unknown): readonly TodoItem[] | null {
  if (!isRecord(details) || !Array.isArray(details.tasks) || typeof details.nextId !== "number") {
    return null;
  }

  const tasks: RpivTask[] = [];
  for (const item of details.tasks) {
    if (!isRecord(item)
      || typeof item.id !== "number"
      || typeof item.subject !== "string"
      || item.subject.length === 0
      || !isTaskStatus(item.status)
      || (item.activeForm !== undefined && typeof item.activeForm !== "string")
      || (item.blockedBy !== undefined
        && !(Array.isArray(item.blockedBy) && item.blockedBy.every((id) => typeof id === "number")))) {
      return null;
    }
    tasks.push({
      id: item.id,
      subject: item.subject,
      status: item.status,
      activeForm: typeof item.activeForm === "string" ? item.activeForm : undefined,
      blockedBy: Array.isArray(item.blockedBy) ? (item.blockedBy as number[]) : undefined,
    });
  }

  const byId = new Map(tasks.map((task) => [task.id, task]));
  const items: TodoItem[] = [];
  for (const task of tasks) {
    if (task.status === "deleted") continue;
    const openBlockers = (task.blockedBy ?? [])
      .filter((id) => {
        const blocker = byId.get(id);
        return blocker === undefined || blocker.status === "pending" || blocker.status === "in_progress";
      })
      .map((id) => byId.get(id)?.subject ?? `#${id}`);
    items.push({
      id: `todo-${task.id}`,
      content: task.subject,
      status: task.status,
      activeForm: task.activeForm,
      blockedBy: openBlockers.length > 0 ? openBlockers : undefined,
    });
  }
  return items;
}

function isTodoToolResult(message: AgentMessage): message is ToolResultMessage {
  return message.role === "toolResult" && (message as ToolResultMessage).toolName === "todo";
}

/**
 * 沿消息时间线提取最后一个合法待办快照。同时消费两种来源，后写覆盖：
 * - todowrite 工具调用（assistant 消息内 toolCall.input.todos）
 * - rpiv-todo 工具结果（toolResult.toolName === "todo" 的 details.tasks）
 */
/** 找到快照返回数组（可为空列表）；时间线上没有任何合法快照则 null。 */
export function parseLatestTodoSnapshot(messages: readonly AgentMessage[]): readonly TodoItem[] | null {
  let latest: readonly TodoItem[] = [];
  let snapshotFound = false;

  for (const message of messages) {
    if (message.role === "assistant") {
      const content = (message as AssistantMessage).content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        const toolCall = readToolCall(block);
        if (toolCall === null || !isTodoWrite(toolCall.toolName)) continue;
        const snapshot = readSnapshot(toolCall);
        if (snapshot === null) continue;
        latest = snapshot;
        snapshotFound = true;
      }
      continue;
    }

    if (isTodoToolResult(message)) {
      const snapshot = readTaskDetailsSnapshot(message.details);
      if (snapshot === null) continue;
      latest = snapshot;
      snapshotFound = true;
    }
  }

  return snapshotFound ? latest : null;
}

export function parseTodos(messages: readonly AgentMessage[]): readonly TodoItem[] {
  return parseLatestTodoSnapshot(messages) ?? [];
}
