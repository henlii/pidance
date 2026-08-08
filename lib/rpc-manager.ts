import {
  ExternalRpcSession,
  getAgentRuntimeMode,
  type ExternalNavigationActions,
} from "./pi-runtime";
import { cacheSessionPath, invalidateSessionListCache } from "./session-reader";

// ============================================================================
// Types
// ============================================================================

export interface AgentEvent {
  type: string;
  [key: string]: unknown;
}

/** 分支书签 label 最大长度；超限拒绝，不静默截断。 */
export const BRANCH_LABEL_MAX_LENGTH = 120;

/**
 * 校验并规范化 navigate_tree 命令参数。
 * customInstructions 仅 trim 后透传（追加默认 prompt）；禁止客户端 replaceInstructions=true。
 */
export function parseNavigateTreeCommand(command: Record<string, unknown>): {
  targetId: string;
  summarize?: boolean;
  customInstructions?: string;
} {
  const rawTargetId = command.targetId;
  if (typeof rawTargetId !== "string" || rawTargetId.trim() === "") {
    throw new Error("targetId is required");
  }
  const targetId = rawTargetId.trim();
  if (command.replaceInstructions === true) {
    throw new Error("replaceInstructions is not allowed from client");
  }
  const result: {
    targetId: string;
    summarize?: boolean;
    customInstructions?: string;
  } = { targetId };

  if (command.summarize !== undefined) {
    if (typeof command.summarize !== "boolean") {
      throw new Error("summarize must be a boolean");
    }
    result.summarize = command.summarize;
  }

  if (command.customInstructions !== undefined) {
    if (typeof command.customInstructions !== "string") {
      throw new Error("customInstructions must be a string");
    }
    const trimmed = command.customInstructions.trim();
    if (trimmed) result.customInstructions = trimmed;
  }

  return result;
}

/**
 * 校验并规范化 set_branch_label 命令参数。
 * trim 后空字符串表示清除 label；超长拒绝。
 */
export function parseSetBranchLabelCommand(command: Record<string, unknown>): {
  targetId: string;
  label: string | undefined;
} {
  const rawTargetId = command.targetId;
  if (typeof rawTargetId !== "string" || rawTargetId.trim() === "") {
    throw new Error("targetId is required");
  }
  const targetId = rawTargetId.trim();
  if (!("label" in command)) {
    throw new Error("label is required");
  }
  if (command.label !== undefined && typeof command.label !== "string") {
    throw new Error("label must be a string or undefined");
  }
  const raw = command.label as string | undefined;
  if (raw === undefined) {
    return { targetId, label: undefined };
  }
  const trimmed = raw.trim();
  if (trimmed.length > BRANCH_LABEL_MAX_LENGTH) {
    throw new Error(`label exceeds maximum length of ${BRANCH_LABEL_MAX_LENGTH}`);
  }
  return { targetId, label: trimmed === "" ? undefined : trimmed };
}

/**
 * 分支树导航动作（select_leaf_exact / branch_from_assistant /
 * create_session_from_leaf 的落地实现）依赖注入 seam。
 *
 * 实现位于 session-service（避免 rpc-manager ↔ session-service 双向循环依赖），
 * 由创建 AgentSessionWrapper 的调用方注入；未注入时对应命令降级抛出明确错误。
 */
export type NavigationActions = {
  selectLeafExact(sessionId: string, entryId: string): Promise<{ cancelled: boolean }>;
  branchFromAssistant(sessionId: string, assistantEntryId: string): Promise<{ cancelled: boolean }>;
  createSessionFromLeaf(sessionId: string, entryId: string): Promise<{ cancelled: boolean; newSessionId: string }>;
};

// ============================================================================
// Session registry
// ============================================================================

/**
 * Live 会话公共面：仅外部 ExternalRpcSession。
 * 进程内 inprocess 已移除；产品只用外部 `pi --mode rpc`。
 */
export type LiveAgentSession = ExternalRpcSession;

declare global {
  var __piSessions: Map<string, LiveAgentSession> | undefined;
  var __piStartLocks: Map<string, Promise<{ session: LiveAgentSession; realSessionId: string }>> | undefined;
  var __piRunningListeners: Set<(ids: string[]) => void> | undefined;
}

/** 会话注册表（globalThis 持久，热重载存活）；进程内 wrapper 与外部 RPC 会话共用。 */
export function getRegistry(): Map<string, LiveAgentSession> {
  if (!globalThis.__piSessions) {
    globalThis.__piSessions = new Map();
    const cleanup = () => globalThis.__piSessions?.forEach((s) => s.destroy());
    process.once("exit", cleanup);
    process.once("SIGINT", cleanup);
    process.once("SIGTERM", cleanup);
  }
  return globalThis.__piSessions;
}

function getLocks(): Map<string, Promise<{ session: LiveAgentSession; realSessionId: string }>> {
  if (!globalThis.__piStartLocks) globalThis.__piStartLocks = new Map();
  return globalThis.__piStartLocks;
}

export function getRpcSession(sessionId: string): LiveAgentSession | undefined {
  return getRegistry().get(sessionId);
}

export function getRunningRpcSessionIds(): string[] {
  const ids = new Set<string>();
  for (const [sessionId, session] of getRegistry()) {
    if (session.isRunning()) ids.add(session.sessionId || sessionId);
  }
  return [...ids];
}

// ----------------------------------------------------------------------------
// Running-status broadcaster
//
// Pushes the current set of running session ids to subscribers whenever any
// session's running state may have changed. This lets the sidebar receive live
// updates over SSE instead of polling. Listeners live on globalThis so they
// survive Next.js hot-reload.
// ----------------------------------------------------------------------------

function getRunningListeners(): Set<(ids: string[]) => void> {
  if (!globalThis.__piRunningListeners) globalThis.__piRunningListeners = new Set();
  return globalThis.__piRunningListeners;
}

/** Subscribe to running-session-id changes. Returns an unsubscribe function. */
export function subscribeRunningSessions(listener: (ids: string[]) => void): () => void {
  const listeners = getRunningListeners();
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

let lastRunningSnapshot = "";

/**
 * Recompute the running-session-id set and, if it changed since the last
 * notification, broadcast it to subscribers. Cheap to call often.
 */
export function notifyRunningChange(): void {
  const ids = getRunningRpcSessionIds();
  const snapshot = JSON.stringify([...ids].sort());
  if (snapshot === lastRunningSnapshot) return;
  lastRunningSnapshot = snapshot;
  for (const listener of getRunningListeners()) {
    try { listener(ids); } catch { /* ignore listener errors */ }
  }
}

/**
 * Get or create an AgentSession for the given session.
 * For new sessions (sessionFile === ""), pi generates its own id.
 * Pass toolNames to pre-configure active tools (empty array = all tools disabled).
 *
 * 只用外部 `pi --mode rpc`。`PIDANCE_AGENT_RUNTIME=inprocess` 会抛错（已移除）。
 */
export async function startRpcSession(
  sessionId: string,
  sessionFile: string,
  cwd: string,
  toolNames?: string[],
  navigationActions?: NavigationActions,
): Promise<{ session: LiveAgentSession; realSessionId: string }> {
  const registry = getRegistry();
  const locks = getLocks();

  const existing = registry.get(sessionId);
  if (existing?.isAlive()) return { session: existing, realSessionId: sessionId };

  const inflight = locks.get(sessionId);
  if (inflight) return inflight;

  const starting = (async () => {
    // 产品只用外部 pi；inprocess 已移除，不再动态加载 SDK
    if (getAgentRuntimeMode() === "inprocess") {
      throw new Error(
        "PIDANCE_AGENT_RUNTIME=inprocess 已移除；请使用默认外部 pi（rpc）或取消该环境变量",
      );
    }
    return startExternalRpcSession(sessionId, sessionFile, cwd, toolNames, navigationActions);
  })().finally(() => locks.delete(sessionId));

  locks.set(sessionId, starting);
  return starting;
}

async function startExternalRpcSession(
  sessionId: string,
  sessionFile: string,
  cwd: string,
  toolNames?: string[],
  navigationActions?: NavigationActions,
): Promise<{ session: ExternalRpcSession; realSessionId: string }> {
  const registry = getRegistry();
  const external = new ExternalRpcSession({
    sessionId,
    sessionFile,
    cwd,
    toolNames,
    navigationActions: navigationActions as ExternalNavigationActions | undefined,
    onRunningChange: () => notifyRunningChange(),
    onSessionListInvalidate: () => invalidateSessionListCache(),
    cacheSessionPath: (id, file) => cacheSessionPath(id, file),
  });
  await external.start();
  const realSessionId = external.sessionId;
  const realSessionFile = external.sessionFile;
  if (realSessionFile) cacheSessionPath(realSessionId, realSessionFile);
  external.onDestroy(() => registry.delete(realSessionId));
  registry.set(realSessionId, external);
  external.beginExtensionBinding();
  return { session: external, realSessionId };
}
