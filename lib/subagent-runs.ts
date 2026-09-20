/**
 * 只读扫描 pi-subagents 异步 run 目录，投影为 UI 友好视图。
 * 不写盘、不 reconcile stale run；损坏条目跳过或字段降级。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  SubagentActivityState,
  SubagentRunEventView,
  SubagentRunMode,
  SubagentRunState,
  SubagentRunStepView,
  SubagentRunView,
  SubagentRunsResponse,
  SubagentTokenUsage,
} from "./subagent-run-types";

export type {
  SubagentActivityState,
  SubagentRunEventView,
  SubagentRunMode,
  SubagentRunState,
  SubagentRunStepView,
  SubagentRunView,
  SubagentRunsResponse,
  SubagentTokenUsage,
} from "./subagent-run-types";

// —— 安全与资源上限 ——
export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 50;
export const MAX_ENUMERATE = 256;
export const MAX_STATUS_BYTES = 2 * 1024 * 1024;
export const MAX_EVENTS_TAIL_BYTES = 64 * 1024;
export const MAX_EVENTS_PARSE = 20;
export const MAX_OUTPUT_TAIL_BYTES = 32 * 1024;
export const MAX_RECENT_OUTPUT_ITEMS = 8;
export const MAX_RECENT_OUTPUT_ITEM_CHARS = 200;
export const MAX_RUN_ID_LEN = 128;
/** 目录名：字母数字、下划线、连字符 */
export const RUN_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const OUTPUT_BASENAME_RE = /^output-\d+\.log$/;

const VALID_STATES = new Set<SubagentRunState>([
  "queued",
  "running",
  "complete",
  "failed",
  "paused",
  "stopped",
]);
const VALID_MODES = new Set<SubagentRunMode>(["single", "parallel", "chain"]);
const VALID_ACTIVITY = new Set<SubagentActivityState>([
  "active_long_running",
  "needs_attention",
]);

/** 可注入的文件系统依赖（测试 fixture） */
export interface SubagentRunsFs {
  readdirSync(dir: string): string[];
  lstatSync(p: string): fs.Stats;
  realpathSync(p: string): string;
  readFileSync(p: string, encoding: "utf8"): string;
  openSync(p: string, flags: number): number;
  readSync(fd: number, buffer: Buffer, offset: number, length: number, position: number): number;
  closeSync(fd: number): void;
  fstatSync?(fd: number): fs.Stats;
  constants: { O_RDONLY: number; O_NOFOLLOW?: number };
}

const defaultFs: SubagentRunsFs = {
  readdirSync: (dir) => fs.readdirSync(dir),
  lstatSync: (p) => fs.lstatSync(p),
  realpathSync: (p) => fs.realpathSync(p),
  readFileSync: (p, encoding) => fs.readFileSync(p, encoding),
  openSync: (p, flags) => fs.openSync(p, flags),
  readSync: (fd, buffer, offset, length, position) =>
    fs.readSync(fd, buffer, offset, length, position),
  closeSync: (fd) => fs.closeSync(fd),
  fstatSync: (fd) => fs.fstatSync(fd),
  constants: fs.constants,
};

export interface ResolveTempScopeOptions {
  env?: NodeJS.ProcessEnv;
  getuid?: (() => number) | undefined;
  userInfo?: (() => { username?: string | null }) | undefined;
  homedir?: (() => string) | undefined;
}

/**
 * 镜像 pi-subagents 的 resolveTempScopeId（不 import 扩展源码）。
 * Linux 有 getuid 时返回 `uid-<n>`。
 */
export function resolveTempScopeId(options?: ResolveTempScopeOptions): string {
  const env = options?.env ?? process.env;
  const getuid =
    options && Object.hasOwn(options, "getuid")
      ? options.getuid
      : process.getuid?.bind(process);
  if (typeof getuid === "function") {
    return `uid-${getuid()}`;
  }

  for (const key of ["USERNAME", "USER", "LOGNAME"] as const) {
    const value = env[key];
    if (value) return `user-${sanitizeTempScopeSegment(value)}`;
  }

  const userInfo =
    options && Object.hasOwn(options, "userInfo") ? options.userInfo : os.userInfo;
  try {
    const username = userInfo?.().username;
    if (username) return `user-${sanitizeTempScopeSegment(username)}`;
  } catch {
    // 回退到 home 作用域
  }

  const homedir = env.USERPROFILE ?? env.HOME;
  if (homedir) return `home-${sanitizeTempScopeSegment(homedir)}`;

  const resolveHomedir =
    options && Object.hasOwn(options, "homedir") ? options.homedir : os.homedir;
  try {
    const fallbackHomedir = resolveHomedir?.();
    if (fallbackHomedir) return `home-${sanitizeTempScopeSegment(fallbackHomedir)}`;
  } catch {
    // 最后共享作用域
  }

  return "shared";
}

function sanitizeTempScopeSegment(value: string): string {
  const sanitized = value
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return sanitized || "unknown";
}

/**
 * 当前用户异步 run 根目录：
 * `<tmpdir>/pi-subagents-<scope>/async-subagent-runs`
 */
export function resolveAsyncRunsRoot(
  options?: ResolveTempScopeOptions & { tmpdir?: () => string },
): string {
  const tmp = options?.tmpdir?.() ?? os.tmpdir();
  return path.join(tmp, `pi-subagents-${resolveTempScopeId(options)}`, "async-subagent-runs");
}

/**
 * 子代理 run 的「进行中」状态（与浏览器投影 lib/subagent-activity.ts 同一语义）。
 */
export const ACTIVE_SUBAGENT_RUN_STATES: ReadonlySet<SubagentRunState> = new Set(["running", "queued", "paused"]);

/**
 * 判定 run 仍活着的更新时间上限：run 记录长时间不更新（进程被杀、记录残留）时不再据此保活，
 * 避免宿主永不回收、一直占着 writer 租约。
 */
export const SUBAGENT_RUN_STALE_MS = 15 * 60_000;

/**
 * 该会话名下是否还有进行中的子代理 run。
 *
 * 归属判定用路径前缀：子代理会话文件都落在父会话路径旁
 * （`<父会话路径去 .jsonl>/<runId>/run-N/…`、`<…>/async-<uuid>/…`、`<…>/forks/…`），
 * 所以「run 的任一步骤 sessionFile 以 `<父会话路径去 .jsonl><分隔符>` 开头」即属本会话。
 * 供宿主在空闲回收前判断是否需要保活（保活才能让子代理完成时的 notify 唤起父会话）。
 */
export function hasActiveSubagentRunForSession(
  runs: readonly SubagentRunView[] | null | undefined,
  sessionFile: string | null | undefined,
  now = Date.now(),
  staleMs = SUBAGENT_RUN_STALE_MS,
): boolean {
  const file = typeof sessionFile === "string" ? sessionFile : "";
  if (!file.endsWith(".jsonl")) return false;
  const base = file.slice(0, -".jsonl".length);
  const isMine = (candidate: unknown): boolean => {
    if (typeof candidate !== "string" || !candidate) return false;
    if (!candidate.startsWith(base)) return false;
    const next = candidate.charAt(base.length);
    return next === "/" || next === "\\";
  };
  for (const run of runs ?? []) {
    if (!run || typeof run !== "object") continue;
    if (!ACTIVE_SUBAGENT_RUN_STATES.has(run.state)) continue;
    const updatedAt = run.lastUpdate ?? run.startedAt;
    if (typeof updatedAt === "number" && now - updatedAt > staleMs) continue;
    for (const step of run.steps ?? []) {
      if (isMine(step?.sessionFile)) return true;
    }
  }
  return false;
}

export interface ListSubagentRunsOptions {
  /** 可注入根（测试）；生产勿传 path 查询参数 */
  root?: string;
  limit?: number;
  fs?: SubagentRunsFs;
  now?: () => number;
  scope?: ResolveTempScopeOptions & { tmpdir?: () => string };
}

/**
 * 解析 limit 查询参数。默认 20，最大 50；非法返回 null（调用方应 400）。
 */
export function parseSubagentRunsLimit(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined || raw === "") return DEFAULT_LIMIT;
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > MAX_LIMIT) return null;
  return n;
}

/**
 * 枚举并投影异步 subagent runs（只读）。
 */
export function listSubagentRuns(options: ListSubagentRunsOptions = {}): SubagentRunsResponse {
  const io = options.fs ?? defaultFs;
  const limit = options.limit ?? DEFAULT_LIMIT;
  const now = options.now?.() ?? Date.now();
  const root = options.root ?? resolveAsyncRunsRoot(options.scope);

  let rootReal: string;
  try {
    const rootLstat = io.lstatSync(root);
    if (rootLstat.isSymbolicLink()) {
      return emptyResponse(now, false);
    }
    if (!rootLstat.isDirectory()) {
      return emptyResponse(now, false);
    }
    rootReal = io.realpathSync(root);
  } catch (err) {
    if (isNotFound(err)) return emptyResponse(now, false);
    return emptyResponse(now, false);
  }

  let entries: string[];
  try {
    entries = io.readdirSync(root);
  } catch (err) {
    if (isNotFound(err)) return emptyResponse(now, false);
    return emptyResponse(now, false);
  }

  // 枚举上限 256（先截断目录名列表，再安全过滤）
  if (entries.length > MAX_ENUMERATE) {
    entries = entries.slice(0, MAX_ENUMERATE);
  }

  const runs: SubagentRunView[] = [];
  for (const name of entries) {
    if (!RUN_ID_RE.test(name)) continue;
    try {
      const view = readOneRun(io, root, rootReal, name);
      if (view) runs.push(view);
    } catch {
      // 损坏 run 跳过，不影响其它
    }
  }

  const sorted = sortRunsActiveFirst(runs);
  return {
    runs: sorted.slice(0, Math.min(limit, MAX_LIMIT)),
    generatedAt: now,
    rootAvailable: true,
  };
}

function emptyResponse(generatedAt: number, rootAvailable: boolean): SubagentRunsResponse {
  return { runs: [], generatedAt, rootAvailable };
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

/** active-first，然后 lastUpdate/endedAt/startedAt 降序 */
export function sortRunsActiveFirst(runs: SubagentRunView[]): SubagentRunView[] {
  const rank = (state: SubagentRunState): number => {
    switch (state) {
      case "running":
        return 0;
      case "queued":
        return 1;
      case "failed":
      case "stopped":
      case "paused":
        return 2;
      case "complete":
        return 3;
      default:
        return 4;
    }
  };
  return [...runs].sort((a, b) => {
    const byState = rank(a.state) - rank(b.state);
    if (byState !== 0) return byState;
    const aTime = a.lastUpdate ?? a.endedAt ?? a.startedAt;
    const bTime = b.lastUpdate ?? b.endedAt ?? b.startedAt;
    return bTime - aTime;
  });
}

function isPathInsideRoot(candidate: string, rootReal: string): boolean {
  const resolved = path.resolve(candidate);
  const rootWithSep = rootReal.endsWith(path.sep) ? rootReal : rootReal + path.sep;
  return resolved === rootReal || resolved.startsWith(rootWithSep);
}

/**
 * 安全打开常规文件：lstat 拒绝 symlink，realpath 必须在根内。
 * 返回 null 表示拒绝读取。
 */
function openSafeFile(
  io: SubagentRunsFs,
  filePath: string,
  rootReal: string,
): { fd: number; size: number } | null {
  try {
    const lst = io.lstatSync(filePath);
    if (lst.isSymbolicLink()) return null;
    if (!lst.isFile()) return null;
    const real = io.realpathSync(filePath);
    if (!isPathInsideRoot(real, rootReal)) return null;
    const noFollow =
      typeof io.constants.O_NOFOLLOW === "number" ? io.constants.O_NOFOLLOW : 0;
    const fd = io.openSync(filePath, io.constants.O_RDONLY | noFollow);
    try {
      const st = io.fstatSync ? io.fstatSync(fd) : io.lstatSync(filePath);
      if (!st.isFile()) {
        io.closeSync(fd);
        return null;
      }
      return { fd, size: st.size };
    } catch {
      try {
        io.closeSync(fd);
      } catch {
        // ignore
      }
      return null;
    }
  } catch {
    return null;
  }
}

function readFileTailUtf8(
  io: SubagentRunsFs,
  filePath: string,
  rootReal: string,
  maxBytes: number,
): { text: string; truncated: boolean; size: number } | null {
  const opened = openSafeFile(io, filePath, rootReal);
  if (!opened) return null;
  const { fd, size } = opened;
  try {
    if (size === 0) return { text: "", truncated: false, size: 0 };
    const readLen = Math.min(maxBytes, size);
    const start = Math.max(0, size - readLen);
    const buf = Buffer.alloc(readLen);
    let offset = 0;
    while (offset < readLen) {
      const n = io.readSync(fd, buf, offset, readLen - offset, start + offset);
      if (n === 0) break;
      offset += n;
    }
    const text = buf.subarray(0, offset).toString("utf8");
    return { text, truncated: size > maxBytes, size };
  } finally {
    try {
      io.closeSync(fd);
    } catch {
      // ignore
    }
  }
}

function readStatusJson(
  io: SubagentRunsFs,
  statusPath: string,
  rootReal: string,
): Record<string, unknown> | null {
  const opened = openSafeFile(io, statusPath, rootReal);
  if (!opened) return null;
  const { fd, size } = opened;
  try {
    if (size <= 0 || size > MAX_STATUS_BYTES) return null;
    const buf = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const n = io.readSync(fd, buf, offset, size - offset, offset);
      if (n === 0) break;
      offset += n;
    }
    const raw = buf.subarray(0, offset).toString("utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  } finally {
    try {
      io.closeSync(fd);
    } catch {
      // ignore
    }
  }
}

function readOneRun(
  io: SubagentRunsFs,
  root: string,
  rootReal: string,
  name: string,
): SubagentRunView | null {
  const runDir = path.join(root, name);

  // run 目录：lstat 拒绝 symlink
  let runLstat: fs.Stats;
  try {
    runLstat = io.lstatSync(runDir);
  } catch {
    return null;
  }
  if (runLstat.isSymbolicLink()) return null;
  if (!runLstat.isDirectory()) return null;

  let runReal: string;
  try {
    runReal = io.realpathSync(runDir);
  } catch {
    return null;
  }
  if (!isPathInsideRoot(runReal, rootReal)) return null;

  const statusPath = path.join(runDir, "status.json");
  const status = readStatusJson(io, statusPath, rootReal);
  if (!status) return null;

  const state = asState(status.state);
  if (!state) return null;
  const mode = asMode(status.mode) ?? "single";
  const startedAt = asFiniteNumber(status.startedAt);
  if (startedAt === undefined) return null;

  const id =
    typeof status.runId === "string" && status.runId.trim()
      ? status.runId.trim()
      : name;

  const activityState = asActivity(status.activityState);
  const endedAt = asFiniteNumber(status.endedAt);
  const lastUpdate = asFiniteNumber(status.lastUpdate);
  const cwd = typeof status.cwd === "string" ? status.cwd : undefined;
  const error = typeof status.error === "string" ? status.error : undefined;
  const currentStep = asFiniteNumber(status.currentStep);
  const chainStepCount = asFiniteNumber(status.chainStepCount);
  const totalTokens = asTokens(status.totalTokens);
  const totalCostUsd = asCostUsd(status.totalCost);

  const steps = projectSteps(status.steps);
  const recentEvents = readRecentEvents(io, path.join(runDir, "events.jsonl"), rootReal);

  const outputMeta = resolveSafeOutputFile(status.outputFile, runDir);
  let outputTail: string | undefined;
  let outputTruncated: boolean | undefined;
  if (outputMeta) {
    const tail = readFileTailUtf8(io, outputMeta.absPath, rootReal, MAX_OUTPUT_TAIL_BYTES);
    if (tail) {
      // 若从中间截断，去掉首行半行，避免破损
      let text = tail.text;
      if (tail.truncated) {
        const nl = text.indexOf("\n");
        if (nl >= 0) text = text.slice(nl + 1);
      }
      outputTail = text;
      outputTruncated = tail.truncated;
    }
  }

  const view: SubagentRunView = {
    id,
    state,
    mode,
    startedAt,
    steps,
    recentEvents,
  };
  if (activityState) view.activityState = activityState;
  if (endedAt !== undefined) view.endedAt = endedAt;
  if (lastUpdate !== undefined) view.lastUpdate = lastUpdate;
  if (cwd !== undefined) view.cwd = cwd;
  if (error !== undefined) view.error = error;
  if (currentStep !== undefined) view.currentStep = currentStep;
  if (chainStepCount !== undefined) view.chainStepCount = chainStepCount;
  if (totalTokens) view.totalTokens = totalTokens;
  if (totalCostUsd !== undefined) view.totalCostUsd = totalCostUsd;
  if (outputTail !== undefined) view.outputTail = outputTail;
  if (outputTruncated !== undefined) view.outputTruncated = outputTruncated;
  return view;
}

/**
 * outputFile 只能读取当前 run 目录内 basename 匹配 `output-\\d+.log` 的文件。
 * 无论 status 写相对/绝对路径，一律强制为 `runDir/<basename>`，杜绝穿越。
 */
function resolveSafeOutputFile(
  outputFile: unknown,
  runDir: string,
): { absPath: string } | null {
  if (typeof outputFile !== "string" || !outputFile.trim()) return null;
  const base = path.basename(outputFile.trim());
  if (!OUTPUT_BASENAME_RE.test(base)) return null;
  return { absPath: path.join(runDir, base) };
}

function readRecentEvents(
  io: SubagentRunsFs,
  eventsPath: string,
  rootReal: string,
): SubagentRunEventView[] {
  const tail = readFileTailUtf8(io, eventsPath, rootReal, MAX_EVENTS_TAIL_BYTES);
  if (!tail || !tail.text) return [];

  let text = tail.text;
  if (tail.truncated) {
    const nl = text.indexOf("\n");
    if (nl >= 0) text = text.slice(nl + 1);
  }

  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  // 从尾部向前解析完整 JSON 行，最多 MAX_EVENTS_PARSE 条
  const events: SubagentRunEventView[] = [];
  for (let i = lines.length - 1; i >= 0 && events.length < MAX_EVENTS_PARSE; i -= 1) {
    try {
      const obj: unknown = JSON.parse(lines[i]!);
      if (!obj || typeof obj !== "object" || Array.isArray(obj)) continue;
      const rec = obj as Record<string, unknown>;
      const type = typeof rec.type === "string" ? rec.type : undefined;
      if (!type) continue;
      const ev: SubagentRunEventView = { type };
      const ts =
        asFiniteNumber(rec.timestamp) ??
        asFiniteNumber(rec.ts) ??
        asFiniteNumber(rec.time);
      if (ts !== undefined) ev.timestamp = ts;
      const msg =
        typeof rec.message === "string"
          ? rec.message
          : typeof rec.error === "string"
            ? rec.error
            : undefined;
      if (msg !== undefined) {
        ev.message =
          msg.length > MAX_RECENT_OUTPUT_ITEM_CHARS
            ? msg.slice(0, MAX_RECENT_OUTPUT_ITEM_CHARS)
            : msg;
      }
      events.push(ev);
    } catch {
      // 截断或不完整行跳过
    }
  }
  events.reverse();
  return events;
}

function projectSteps(raw: unknown): SubagentRunStepView[] {
  if (!Array.isArray(raw)) return [];
  const steps: SubagentRunStepView[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const item = raw[i];
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      steps.push({ index: i, agent: "unknown", status: "unknown" });
      continue;
    }
    const s = item as Record<string, unknown>;
    const agent = typeof s.agent === "string" && s.agent ? s.agent : "unknown";
    const status = typeof s.status === "string" && s.status ? s.status : "unknown";
    const step: SubagentRunStepView = { index: i, agent, status };
    if (typeof s.label === "string") step.label = s.label;
    if (typeof s.model === "string") step.model = s.model;
    if (typeof s.sessionFile === "string") step.sessionFile = s.sessionFile;
    if (typeof s.error === "string") step.error = s.error;
    const act = asActivity(s.activityState);
    if (act) step.activityState = act;
    if (typeof s.currentTool === "string") step.currentTool = s.currentTool;
    const tokens = asTokens(s.tokens);
    if (tokens) step.tokens = tokens;
    const cost = asCostUsd(s.totalCost) ?? asFiniteNumber(s.costUsd);
    if (cost !== undefined) step.costUsd = cost;
    const st = asFiniteNumber(s.startedAt);
    if (st !== undefined) step.startedAt = st;
    const en = asFiniteNumber(s.endedAt);
    if (en !== undefined) step.endedAt = en;
    if (Array.isArray(s.recentOutput)) {
      step.recentOutput = truncateRecentOutput(s.recentOutput);
    }
    steps.push(step);
  }
  return steps;
}

function truncateRecentOutput(items: unknown[]): string[] {
  const out: string[] = [];
  for (const item of items) {
    if (out.length >= MAX_RECENT_OUTPUT_ITEMS) break;
    if (typeof item !== "string") continue;
    out.push(
      item.length > MAX_RECENT_OUTPUT_ITEM_CHARS
        ? item.slice(0, MAX_RECENT_OUTPUT_ITEM_CHARS)
        : item,
    );
  }
  return out;
}

function asState(v: unknown): SubagentRunState | undefined {
  return typeof v === "string" && VALID_STATES.has(v as SubagentRunState)
    ? (v as SubagentRunState)
    : undefined;
}

function asMode(v: unknown): SubagentRunMode | undefined {
  return typeof v === "string" && VALID_MODES.has(v as SubagentRunMode)
    ? (v as SubagentRunMode)
    : undefined;
}

function asActivity(v: unknown): SubagentActivityState | undefined {
  return typeof v === "string" && VALID_ACTIVITY.has(v as SubagentActivityState)
    ? (v as SubagentActivityState)
    : undefined;
}

function asFiniteNumber(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function asTokens(v: unknown): SubagentTokenUsage | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const t = v as Record<string, unknown>;
  const input = asFiniteNumber(t.input);
  const output = asFiniteNumber(t.output);
  const total = asFiniteNumber(t.total);
  if (input === undefined || output === undefined || total === undefined) return undefined;
  return { input, output, total };
}

/** totalCost 可能是 CostSummary { costUsd } 或数字 */
function asCostUsd(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  return asFiniteNumber((v as Record<string, unknown>).costUsd);
}

// —— sessionFile → 已发现只读 child 的 sessionId 投影 ——

/** 会话列表最小形状（与 SessionInfo 的 id/path/readOnly 对齐） */
export interface SessionPathRef {
  id: string;
  path: string;
  readOnly?: boolean | true;
}

/**
 * 规范化会话文件路径以便比较：
 * - 统一分隔符、去掉多余 `.`/`..`（path.normalize）
 * - Windows 盘符路径转小写；POSIX 保持原样
 */
export function normalizeSessionFilePath(filePath: string): string {
  const trimmed = filePath.trim();
  if (!trimmed) return "";
  const isWin =
    /^[a-zA-Z]:[\\/]/.test(trimmed) ||
    trimmed.startsWith("\\\\") ||
    trimmed.startsWith("//");
  const resolver = isWin ? path.win32 : path.posix;
  // 统一为正斜杠再 normalize，避免混合分隔符
  const unified = isWin ? trimmed.replace(/\//g, "\\") : trimmed.replace(/\\/g, "/");
  const normalized = resolver.normalize(unified);
  return isWin ? normalized.toLowerCase() : normalized;
}

/**
 * 将已发现的只读 SessionInfo.path 与 step.sessionFile 匹配，附加 sessionId。
 * 不变异原 response / run / step；无匹配不写 sessionId。
 * 仅 `readOnly === true` 的会话可链接（D1 目标是只读 subagent child）。
 */
export function attachDiscoveredSessionIds(
  response: SubagentRunsResponse,
  sessions: ReadonlyArray<SessionPathRef>,
): SubagentRunsResponse {
  const pathToId = new Map<string, string>();
  for (const s of sessions) {
    if (s.readOnly !== true) continue;
    if (typeof s.id !== "string" || !s.id) continue;
    if (typeof s.path !== "string" || !s.path) continue;
    const key = normalizeSessionFilePath(s.path);
    if (!key) continue;
    // 先到先得，避免覆盖
    if (!pathToId.has(key)) pathToId.set(key, s.id);
  }

  const runs = response.runs.map((run) => {
    let stepsChanged = false;
    const steps = run.steps.map((step) => {
      if (!step.sessionFile) return step;
      const key = normalizeSessionFilePath(step.sessionFile);
      const sessionId = key ? pathToId.get(key) : undefined;
      if (!sessionId) {
        // 确保不保留任何误传的 sessionId
        if (step.sessionId === undefined) return step;
        const rest = { ...step };
        delete rest.sessionId;
        stepsChanged = true;
        return rest;
      }
      if (step.sessionId === sessionId) return step;
      stepsChanged = true;
      return { ...step, sessionId };
    });
    if (!stepsChanged) return run;
    return { ...run, steps };
  });

  // 若无任何变更，返回原对象引用（仍视为不可变消费）
  let anyChanged = false;
  for (let i = 0; i < runs.length; i += 1) {
    if (runs[i] !== response.runs[i]) {
      anyChanged = true;
      break;
    }
  }
  if (!anyChanged) return response;
  return { ...response, runs };
}
