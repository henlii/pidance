/**
 * P4a 实时工具执行缓冲（纯逻辑，无 React / 无 IO，node:test 可直接测）。
 *
 * 背景：服务端已原样透传 tool_execution_update（lib/agent-event-stream.ts），但
 * 客户端 hook 只消费 tool_execution_start / tool_execution_end 更新 agentPhase，
 * 没有 update 消费。本模块以 toolCallId 为 key 维护工具执行快照状态机
 * （running → success / error），hook 消费 start / update / end 驱动它，
 * 并经 getToolExecutionSnapshots 对外暴露数组；UI（MessageView 实时工具视图）
 * 由后续任务实现，本模块不涉及任何渲染。
 *
 * 语义约定：
 * - **update 按 replace 处理**：上游透传的 partialResult 视为「该工具当前时刻的
 *   完整输出快照」，直接整体替换 output，而非增量拼接。若后续确认为增量（delta）
 *   语义，只在本模块改为 append 即可——不要在 UI 层猜测（UI 只读 output）。
 * - **output 上限**：64KB 字符，超出截断并置 truncated（UI 据此显示截断提示）。
 * - **late/stale 防护**：已终态（end 之后）迟到的 update 安全忽略；未见 start 就
 *   update 安全忽略；toolCallId 缺失/非法、非对象输入一律忽略并返回原状态，不抛错。
 * - **不可变**：所有 apply 返回新 Map（仅实际变更时）；非法输入返回原引用，调用方
 *   setState 可借此 bail out。
 * - **终态保留**：end 只固定 status/endedAt，不移除条目——run 结束后 UI 仍可展示
 *   「最近一次工具执行结果」，下一个 run 由 clearToolExecutions 统一清空。
 */

/** output 字符上限（64KB）。 */
export const TOOL_EXECUTION_OUTPUT_MAX_CHARS = 64 * 1024;

/** 工具执行状态：running 执行中；success/error 由 end 事件固定；cancelled 预留给中止场景。 */
export type ToolExecutionStatus = "running" | "success" | "error" | "cancelled";

/** 单个工具执行的快照（按 toolCallId 键控）。 */
export interface ToolExecutionSnapshot {
  /** Pi 工具调用 id（8hex，事件携带） */
  toolCallId: string;
  /** 工具名（bash / read_file / grep ...），事件缺失时为空串 */
  toolName: string;
  /** 命令摘要：start.args.command（对象时取其内部）→ args 摘要字段 → undefined */
  command?: string;
  /** 插件 renderCall 的 ANSI 行；仅在工具块展开时展示。 */
  renderedCallLines?: string[];
  /** 插件运行中 renderResult 的 ANSI 行；存在时优先于 output。 */
  renderedLines?: string[];
  /** 插件最终 renderResult 的 ANSI 行；存在时优先于结构化/文本结果。 */
  renderedResultLines?: string[];
  /** 实时输出（partialResult replace 语义；end 兜底时来自 result 摘要） */
  output: string;
  /** 开始时间戳（ms）；无 start 记录由 end 兜底时与 endedAt 相同 */
  startedAt: number;
  /** 结束时间戳（ms），running 时缺省 */
  endedAt?: number;
  /** 执行状态 */
  status: ToolExecutionStatus;
  /** output 是否因超限被截断 */
  truncated?: boolean;
}

/** 缓冲状态：toolCallId → 快照 的有序 Map（插入序 = 工具启动顺序）。 */
export type ToolExecutionBufferState = ReadonlyMap<string, ToolExecutionSnapshot>;

/** start 事件宽松输入：SDK 字段以 unknown 呈现，本模块负责校验。 */
export interface ToolExecutionStartInput {
  toolCallId?: unknown;
  toolName?: unknown;
  args?: unknown;
  renderedCallLines?: unknown;
}

/** update 事件宽松输入。 */
export interface ToolExecutionUpdateInput {
  toolCallId?: unknown;
  toolName?: unknown;
  args?: unknown;
  partialResult?: unknown;
  renderedLines?: unknown;
}

/** end 事件宽松输入。 */
export interface ToolExecutionEndInput {
  toolCallId?: unknown;
  toolName?: unknown;
  result?: unknown;
  isError?: unknown;
  renderedResultLines?: unknown;
}

/** command 摘要回退字段：args.command 缺失/非字符串时按此顺序取第一个字符串值。 */
const COMMAND_SUMMARY_KEYS = ["cmd", "path", "pattern", "query", "file", "name"] as const;

/** 校验 toolCallId 是否为非空字符串；非法返回 null（调用方据此忽略）。 */
function validToolCallId(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** 校验字符串字段（toolName 等）；非法返回 undefined。 */
function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** tool_result 事件只补最终插件渲染，不提前固定 execution 状态。 */
export interface ToolExecutionResultRenderInput {
  toolCallId?: unknown;
  renderedResultLines?: unknown;
}

/** ANSI 行只接受非空字符串数组；空数组或畸形载荷视为缺失，UI 继续走原回退。 */
function optionalRenderedLines(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || !value.every((line) => typeof line === "string")) {
    return undefined;
  }
  return [...value];
}

/**
 * 把任意 partialResult / result 序列化为展示文本。
 * - 字符串原样保留（\r 去掉，保留真实换行）；
 * - AgentToolResult 形 `{ content: [{ type:"text", text }] }` 提取 text 拼接
 *   （bash 实时 update 即此形状；切勿 JSON.stringify，否则 \n 变成字面量、换行全坏）；
 * - 其它对象/数组 JSON 序列化；失败降级 String()。
 */
function stringifyPartial(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.replace(/\r/g, "");
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (Array.isArray(record.content)) {
      const texts: string[] = [];
      for (const block of record.content) {
        if (typeof block === "string") {
          texts.push(block.replace(/\r/g, ""));
          continue;
        }
        if (typeof block !== "object" || block === null) continue;
        const item = block as Record<string, unknown>;
        if (item.type === "text" && typeof item.text === "string") {
          texts.push(item.text.replace(/\r/g, ""));
        }
      }
      // 有 text 块或 content 为空数组时都走文本路径，避免回落成 "{}" / "[]"。
      if (texts.length > 0 || record.content.length === 0) {
        return texts.join("\n");
      }
    }
    if (typeof record.text === "string") return record.text.replace(/\r/g, "");
  }
  try {
    const json = JSON.stringify(value);
    return json === undefined ? String(value) : json;
  } catch {
    // 循环引用等无法序列化的场景：降级为 String()，绝不抛错。
    return String(value);
  }
}

/** 超限截断：返回截断后的文本与截断标记。 */
function clampOutput(text: string): { text: string; truncated: boolean } {
  if (text.length <= TOOL_EXECUTION_OUTPUT_MAX_CHARS) return { text, truncated: false };
  return { text: text.slice(0, TOOL_EXECUTION_OUTPUT_MAX_CHARS), truncated: true };
}

/**
 * command 提取优先级（任务约定）：
 * 1. args.command 为字符串 → 直接使用；
 * 2. args.command 为对象 → 取其内部 command / cmd 字符串字段；
 * 3. args 中 cmd/path/pattern/query/file/name 等摘要字段 → 取第一个字符串值；
 * 4. 均无 → undefined。
 */
function extractToolCommand(args: unknown): string | undefined {
  if (typeof args !== "object" || args === null) return undefined;
  const record = args as Record<string, unknown>;
  const command = record.command;
  if (typeof command === "string") return command;
  if (typeof command === "object" && command !== null) {
    const nested = command as Record<string, unknown>;
    const inner = typeof nested.command === "string" ? nested.command : nested.cmd;
    if (typeof inner === "string") return inner;
  }
  for (const key of COMMAND_SUMMARY_KEYS) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

/**
 * tool_execution_start：以 toolCallId 为 key 创建 running 快照并提取 command。
 * 同一 id 重复 start（罕见）：已 running 则仅补齐 toolName/command（保留 output/
 * startedAt）；已终态则重建为新的 running 项（视为重跑）。
 */
export function applyToolExecutionStart(state: ToolExecutionBufferState, event: ToolExecutionStartInput): ToolExecutionBufferState {
  if (typeof event !== "object" || event === null) return state; // 非对象输入安全忽略
  const id = validToolCallId(event.toolCallId);
  if (!id) return state;
  const existing = state.get(id);
  const toolName = optionalString(event.toolName) ?? existing?.toolName ?? "";
  const command = extractToolCommand(event.args) ?? existing?.command;
  const renderedCallLines = optionalRenderedLines(event.renderedCallLines) ?? existing?.renderedCallLines;
  if (existing?.status === "running") {
    // 重复 start 且仍运行中：不动 output/startedAt，只补齐缺失的展示字段。
    if (toolName === existing.toolName && command === existing.command && renderedCallLines === existing.renderedCallLines) return state;
    return new Map(state).set(id, { ...existing, toolName, command, renderedCallLines });
  }
  const snapshot: ToolExecutionSnapshot = {
    toolCallId: id,
    toolName,
    command,
    renderedCallLines,
    output: "",
    startedAt: Date.now(),
    status: "running",
  };
  return new Map(state).set(id, snapshot);
}

/**
 * tool_execution_update：**replace 语义**——partialResult 视为完整输出快照，
 * 整体替换 output（不做增量拼接；若上游确为增量，改本函数为 append）。
 * late/stale 防护：未见 start 或已终态（end 后迟到）的 update 安全忽略。
 * 快照缺失 command 时用本次 args 补填（end 事件不带 args，只能在此补）。
 */
export function applyToolExecutionUpdate(state: ToolExecutionBufferState, event: ToolExecutionUpdateInput): ToolExecutionBufferState {
  if (typeof event !== "object" || event === null) return state; // 非对象输入安全忽略
  const id = validToolCallId(event.toolCallId);
  if (!id) return state;
  const existing = state.get(id);
  if (!existing || existing.status !== "running") return state;
  const { text, truncated } = clampOutput(stringifyPartial(event.partialResult));
  const command = existing.command ?? extractToolCommand(event.args);
  const renderedLines = optionalRenderedLines(event.renderedLines);
  if (text === existing.output && truncated === (existing.truncated ?? false) && command === existing.command && renderedLines === existing.renderedLines) {
    return state;
  }
  return new Map(state).set(id, { ...existing, output: text, truncated: truncated || undefined, command, renderedLines });
}

/**
 * tool_execution_end：固定 status（isError ? error : success）与 endedAt。
 * 快照 output 为空且 result 有值时用 result 摘要兜底（无 update 流的工具也有内容）。
 * 无 start 记录（SSE 中途重连丢了 start）时创建终态兜底项，startedAt 以 endedAt
 * 近似——保证 UI 至少能看到已结束的工具名与结果，不抛错。
 */
export function applyToolExecutionEnd(state: ToolExecutionBufferState, event: ToolExecutionEndInput): ToolExecutionBufferState {
  if (typeof event !== "object" || event === null) return state; // 非对象输入安全忽略
  const id = validToolCallId(event.toolCallId);
  if (!id) return state;
  const now = Date.now();
  const existing = state.get(id);
  const toolName = optionalString(event.toolName) ?? existing?.toolName ?? "";
  const status: ToolExecutionStatus = event.isError === true ? "error" : "success";
  const renderedResultLines = optionalRenderedLines(event.renderedResultLines) ?? existing?.renderedResultLines;
  if (!existing) {
    const { text, truncated } = clampOutput(stringifyPartial(event.result));
    const snapshot: ToolExecutionSnapshot = {
      toolCallId: id,
      toolName,
      output: text,
      startedAt: now,
      endedAt: now,
      status,
      renderedResultLines,
      truncated: truncated || undefined,
    };
    return new Map(state).set(id, snapshot);
  }
  if (existing.status !== "running") {
    // tool_execution_end 可能先于 tool_result 到达；终态保持不变，只允许后到的
    // 插件最终渲染补齐快照。
    if (!renderedResultLines || renderedResultLines === existing.renderedResultLines) return state;
    return new Map(state).set(id, { ...existing, renderedResultLines });
  }
  let { output, truncated } = existing;
  if (output.length === 0 && event.result !== null && event.result !== undefined) {
    const clamped = clampOutput(stringifyPartial(event.result));
    output = clamped.text;
    truncated = clamped.truncated;
  }
  return new Map(state).set(id, { ...existing, toolName, output, truncated, renderedResultLines, endedAt: now, status });
}

/**
 * tool_result：只把 renderedResultLines 合并进已有快照。执行终态仍由
 * tool_execution_end 单一负责，避免 tool_result 事件顺序变化导致运行状态提前结束。
 */
export function applyToolExecutionResultRender(state: ToolExecutionBufferState, event: ToolExecutionResultRenderInput): ToolExecutionBufferState {
  if (typeof event !== "object" || event === null) return state;
  const id = validToolCallId(event.toolCallId);
  if (!id) return state;
  const existing = state.get(id);
  const renderedResultLines = optionalRenderedLines(event.renderedResultLines);
  if (!existing || !renderedResultLines) return state;
  return new Map(state).set(id, { ...existing, renderedResultLines });
}

/**
 * 清空缓冲（新 run 开始时由 hook 调用）。已空时返回原引用（调用方 setState 可
 * bail out）；否则返回新的空 Map，与原状态共享无关。
 */
export function clearToolExecutions(state: ToolExecutionBufferState): ToolExecutionBufferState {
  if (state.size === 0) return state;
  return new Map();
}

/**
 * 将仍 running 的快照收成 cancelled。agent 整轮结束后立刻收回工具块，
 * 不要等到下一次 agent_start 才 clear。
 */
export function finalizeRunningToolExecutions(
  state: ToolExecutionBufferState,
  now = Date.now(),
): ToolExecutionBufferState {
  let changed = false;
  const next = new Map(state);
  for (const [id, snap] of next) {
    if (snap.status !== "running") continue;
    next.set(id, { ...snap, status: "cancelled", endedAt: snap.endedAt ?? now });
    changed = true;
  }
  return changed ? next : state;
}

/**
 * 导出快照数组（插入序 = 工具启动顺序）。每次返回新数组，调用方可直接 setState。
 */
export function getToolExecutionSnapshots(state: ToolExecutionBufferState): ToolExecutionSnapshot[] {
  return Array.from(state.values());
}
