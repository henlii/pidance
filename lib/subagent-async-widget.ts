/**
 * pi-subagents 异步状态 widget 的机器载荷解析（纯逻辑，浏览器与测试共用）。
 *
 * 背景：pi-subagents 在宿主报告 `mode === "rpc"` 时不发 TUI 组件，改发一行
 * `PI_SUBAGENT_ASYNC_JSON:{…}` 快照（其 `src/tui/render.ts` + `encodeAsyncStatusSnapshotWidget`）。
 * 终端里这个 widget 是 editor 上方的异步任务面板；Web 侧要把同一份数据按同样的行结构
 * 渲染出来（样式按 Web 调整），所以先在这里解析。
 *
 * 约定：**解析失败返回 null**，调用方不得把原始载荷当文本显示。
 */

export const ASYNC_STATUS_SNAPSHOT_PREFIX = "PI_SUBAGENT_ASYNC_JSON:";

export type SubagentAsyncState =
  | "queued"
  | "running"
  | "complete"
  | "failed"
  | "partial"
  | "paused"
  | "stopped"
  | "rejected";

export interface SubagentAsyncActivity {
  state?: string;
  currentTool?: string;
  lastActivityAt?: number;
  currentToolStartedAt?: number;
  turnCount?: number;
  toolCount?: number;
}

export interface SubagentAsyncNode {
  id: string;
  kind: string;
  label: string;
  state: SubagentAsyncState;
  startedAt?: number;
  updatedAt?: number;
  endedAt?: number;
  activity?: SubagentAsyncActivity;
  children?: SubagentAsyncNode[];
}

export interface SubagentAsyncSnapshot {
  kind: string;
  version: number;
  generatedAt: number;
  runs: SubagentAsyncNode[];
  /** 被上游截断的数量（超出 caps 的 run/child）。 */
  omittedRuns: number;
  byteLimitExceeded: boolean;
}

// ── pi-subagents 的 fleet-status 文本改写（belowEditor widget） ──────────────
//
// TUI 里那行是 `1 active agent · ↓ 0 tokens · ↓/← to inspect`：最后一段是**终端键位提示**，
// 浏览器里没有意义（Web 的子代理入口在顶栏谱系下拉）。这里只去掉键位提示段，保留有用信息
// （在跑的 agent 数、token 读数）；认不出形状时返回 null，调用方保持原样。

/** ANSI SGR / 光标序列（渲染桥转出来的行带颜色）。 */
const ANSI_PATTERN = /\u001b\[[0-9;?]*[A-Za-z]/g;

/** 键位提示段：带方向键字形且提到「查看/导航/选择」之类动作。 */
const TERMINAL_KEY_HINT_PATTERN = /[↓↑←→].*(?:inspect|查看|导航|选择|navigate|select)/i;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "");
}

/**
 * 改写 fleet-status 的行：去掉终端键位提示段。
 * - 返回 null：不是这个形状（没有键位提示可去），调用方原样渲染；
 * - 返回 []：去掉后没有内容了，调用方不要渲染这个 widget；
 * - 返回非空数组：改写后的行（纯文本，无 ANSI）。
 */
export function rewriteFleetStatusLines(lines: readonly string[] | null | undefined): string[] | null {
  if (!lines || lines.length === 0) return null;
  let sawHint = false;
  const out: string[] = [];
  for (const raw of lines) {
    if (typeof raw !== "string") continue;
    const plain = stripAnsi(raw);
    const segments = plain.split("·").map((segment) => segment.trim()).filter(Boolean);
    const kept = segments.filter((segment) => {
      if (!TERMINAL_KEY_HINT_PATTERN.test(segment)) return true;
      sawHint = true;
      return false;
    });
    if (kept.length > 0) out.push(kept.join(" · "));
  }
  if (!sawHint) return null;
  return out;
}

/** 侧栏/谱系里也在用的“进行中”状态集合语义。 */
export const SUBAGENT_ACTIVE_STATES: ReadonlySet<SubagentAsyncState> = new Set(["running", "queued", "paused"]);

const KNOWN_STATES: ReadonlySet<string> = new Set([
  "queued", "running", "complete", "failed", "partial", "paused", "stopped", "rejected",
]);

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function parseActivity(value: unknown): SubagentAsyncActivity | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const activity: SubagentAsyncActivity = {};
  const state = asString(record.state);
  const currentTool = asString(record.currentTool);
  const lastActivityAt = asNumber(record.lastActivityAt);
  const currentToolStartedAt = asNumber(record.currentToolStartedAt);
  const turnCount = asNumber(record.turnCount);
  const toolCount = asNumber(record.toolCount);
  if (state) activity.state = state;
  if (currentTool) activity.currentTool = currentTool;
  if (lastActivityAt !== undefined) activity.lastActivityAt = lastActivityAt;
  if (currentToolStartedAt !== undefined) activity.currentToolStartedAt = currentToolStartedAt;
  if (turnCount !== undefined) activity.turnCount = turnCount;
  if (toolCount !== undefined) activity.toolCount = toolCount;
  return activity;
}

/** 深度上限：面板只展示两层（run → step），更深的结构留着不影响。 */
const MAX_NODE_DEPTH = 2;

function parseNode(value: unknown, depth: number): SubagentAsyncNode | null {
  const record = asRecord(value);
  if (!record) return null;
  const state = asString(record.state);
  const id = asString(record.id);
  const label = asString(record.label);
  if (!state || !KNOWN_STATES.has(state as SubagentAsyncState) || !id || !label) return null;
  const children: SubagentAsyncNode[] = [];
  if (depth < MAX_NODE_DEPTH && Array.isArray(record.children)) {
    for (const child of record.children) {
      const parsed = parseNode(child, depth + 1);
      if (parsed) children.push(parsed);
    }
  }
  const node: SubagentAsyncNode = {
    id,
    kind: asString(record.kind) ?? "subagent",
    label,
    state: state as SubagentAsyncState,
  };
  const startedAt = asNumber(record.startedAt);
  const updatedAt = asNumber(record.updatedAt);
  const endedAt = asNumber(record.endedAt);
  if (startedAt !== undefined) node.startedAt = startedAt;
  if (updatedAt !== undefined) node.updatedAt = updatedAt;
  if (endedAt !== undefined) node.endedAt = endedAt;
  const activity = parseActivity(record.activity);
  if (activity) node.activity = activity;
  if (children.length > 0) node.children = children;
  return node;
}

/**
 * 从 widget 的文本行里解析快照。任一行以 `PI_SUBAGENT_ASYNC_JSON:` 开头即尝试解析，
 * 结构不合法一律返回 null（调用方据此不要显示原始载荷）。
 */
export function parseSubagentAsyncSnapshot(lines: readonly string[] | null | undefined): SubagentAsyncSnapshot | null {
  for (const line of lines ?? []) {
    if (typeof line !== "string" || !line.startsWith(ASYNC_STATUS_SNAPSHOT_PREFIX)) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line.slice(ASYNC_STATUS_SNAPSHOT_PREFIX.length));
    } catch {
      return null;
    }
    const record = asRecord(raw);
    if (!record || !Array.isArray(record.runs)) return null;
    const kind = asString(record.kind);
    if (kind !== "pi-subagents.async-status-snapshot") return null;
    const runs: SubagentAsyncNode[] = [];
    for (const item of record.runs) {
      const parsed = parseNode(item, 0);
      if (parsed) runs.push(parsed);
    }
    const omitted = asRecord(record.omitted);
    return {
      kind,
      version: asNumber(record.version) ?? 0,
      generatedAt: asNumber(record.generatedAt) ?? 0,
      runs,
      omittedRuns: asNumber(omitted?.runs) ?? 0,
      byteLimitExceeded: omitted?.byteLimitExceeded === true,
    };
  }
  return null;
}

/** 面板一行（run 或它的 step，缩进按 depth）。 */
export interface SubagentAsyncRow {
  id: string;
  label: string;
  state: SubagentAsyncState;
  depth: number;
  elapsedMs: number | null;
  /** 当前工具（运行中才有）。 */
  tool: string | null;
  /** 当前工具已用时长（毫秒）。 */
  toolMs: number | null;
  turns: number | null;
  tools: number | null;
}

export interface SubagentAsyncSummary {
  /** 面板里的行（已按上限裁剪，深度优先）。 */
  rows: SubagentAsyncRow[];
  running: number;
  queued: number;
  /** 顶层 run 总数（含未展示的）。 */
  total: number;
  /** 因为上限没展示的顶层 run 数（含上游截断）。 */
  hidden: number;
  byteLimitExceeded: boolean;
}

/**
 * 把快照压成面板要显示的行：运行中优先、其次排队、最后已结束（与 TUI widget 的顺序一致），
 * 每个 run 之后跟它的子步骤。超过 `maxRows` 的顶层 run 计入 `hidden`。
 */
/**
 * 面板标题信息（供**通用槽位外壳**渲染标题行用，纯数据、不做 i18n）。
 *
 * 为什么由外壳渲染标题：折叠开关属于「槽位」的职责（任何插件用这个槽位都该能折叠），
 * 所以标题行由外壳统一画；面板组件只负责正文（状态行）。这里给出外壳需要的那几个字段。
 */
export interface SubagentAsyncHeading {
  /** 只有一个 run 时它的 label（用于「异步子代理 <name>」），多个 run 时为 null。 */
  singleLabel: string | null;
  running: number;
  queued: number;
  /** 被上限截掉的行数（>0 时提示「另有 N 个」）。 */
  hidden: number;
  /** 上游因字节上限截断了载荷。 */
  byteLimitExceeded: boolean;
}

export function subagentAsyncHeading(snapshot: SubagentAsyncSnapshot): SubagentAsyncHeading {
  const summary = summarizeSubagentAsyncSnapshot(snapshot);
  const runs = Array.isArray(snapshot.runs) ? snapshot.runs : [];
  return {
    singleLabel: runs.length === 1 ? (runs[0]?.label ?? null) : null,
    running: summary.running,
    queued: summary.queued,
    hidden: summary.hidden,
    byteLimitExceeded: summary.byteLimitExceeded,
  };
}

export function summarizeSubagentAsyncSnapshot(
  snapshot: SubagentAsyncSnapshot,
  options: { now?: number; maxRows?: number } = {},
): SubagentAsyncSummary {
  const now = options.now ?? Date.now();
  const maxRows = Math.max(1, Math.floor(options.maxRows ?? 8));
  const rank = (state: SubagentAsyncState): number => (state === "running" ? 0 : state === "queued" ? 1 : 2);
  const ordered = [...snapshot.runs].sort((a, b) => rank(a.state) - rank(b.state));
  const rows: SubagentAsyncRow[] = [];
  let hidden = snapshot.omittedRuns;
  let shownRuns = 0;
  const elapsedOf = (node: SubagentAsyncNode): number | null => {
    if (node.startedAt === undefined) return null;
    const end = node.endedAt ?? node.updatedAt ?? now;
    return Math.max(0, end - node.startedAt);
  };
  const rowOf = (node: SubagentAsyncNode, depth: number): SubagentAsyncRow => ({
    id: node.id,
    label: node.label,
    state: node.state,
    depth,
    elapsedMs: elapsedOf(node),
    tool: node.state === "running" ? node.activity?.currentTool ?? null : null,
    toolMs: node.state === "running"
      && node.activity?.currentToolStartedAt !== undefined
      && node.activity?.lastActivityAt !== undefined
      ? Math.max(0, node.activity.lastActivityAt - node.activity.currentToolStartedAt)
      : null,
    turns: node.activity?.turnCount ?? null,
    tools: node.activity?.toolCount ?? null,
  });
  for (const run of ordered) {
    if (shownRuns >= maxRows) {
      hidden += 1;
      continue;
    }
    shownRuns += 1;
    rows.push(rowOf(run, 0));
    for (const child of run.children ?? []) {
      if (rows.length >= maxRows * 3) {
        hidden += 1;
        break;
      }
      rows.push(rowOf(child, 1));
    }
  }
  return {
    rows,
    running: snapshot.runs.filter((run) => run.state === "running").length,
    queued: snapshot.runs.filter((run) => run.state === "queued").length,
    total: snapshot.runs.length + snapshot.omittedRuns,
    hidden,
    byteLimitExceeded: snapshot.byteLimitExceeded,
  };
}
