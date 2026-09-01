/**
 * Live session registry：globalThis 注册表、启动锁、running 广播、idle 与 id 重键。
 * 主路径固定为同进程 SdkSessionHost。
 */
import { cacheSessionPath, invalidateSessionListCache, resolveSessionPath } from "./session-reader";
import { openSessionView } from "./pi-session-io";
import { getPidancePref, readPidancePrefs, type PidancePrefs } from "./pidance-prefs-file";
import { startSdkSessionHost, type SdkSessionHost } from "./sdk-session-host";
import {
  acquireRunningLease,
  heartbeatRunningLease,
  listFreshRunningLeaseSessionIds,
  releaseRunningLease,
  SESSION_RUNNING_LOCKED_MESSAGE,
} from "./session-running-lease";

export type AgentEvent = {
  type: string;
  [key: string]: unknown;
};

/** 分支书签 label 最大长度；超限拒绝，不静默截断。 */
export const BRANCH_LABEL_MAX_LENGTH = 120;

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

export type NavigationActions = {
  selectLeafExact(sessionId: string, entryId: string): Promise<{ cancelled: boolean }>;
  branchFromAssistant(
    sessionId: string,
    assistantEntryId: string,
  ): Promise<{ cancelled: boolean }>;
  createSessionFromLeaf(
    sessionId: string,
    entryId: string,
  ): Promise<{ cancelled: boolean; newSessionId: string }>;
};

/** Live 会话公共面：SdkSessionHost（同进程 SDK）。 */
export type LiveAgentSession = SdkSessionHost;

declare global {
  // eslint-disable-next-line no-var
  var __piSessions: Map<string, LiveAgentSession> | undefined;
  // eslint-disable-next-line no-var
  var __piStartLocks:
    | Map<string, Promise<{ session: LiveAgentSession; realSessionId: string }>>
    | undefined;
  // eslint-disable-next-line no-var
  var __piRunningListeners: Set<(ids: string[]) => void> | undefined;
}

export function getRegistry(): Map<string, LiveAgentSession> {
  if (!globalThis.__piSessions) {
    globalThis.__piSessions = new Map();
    const cleanup = () => {
      globalThis.__piSessions?.forEach((s) => s.destroy());
    };
    process.once("exit", cleanup);
    process.once("SIGINT", cleanup);
    process.once("SIGTERM", cleanup);
  }
  return globalThis.__piSessions;
}

function getLocks(): Map<
  string,
  Promise<{ session: LiveAgentSession; realSessionId: string }>
> {
  if (!globalThis.__piStartLocks) globalThis.__piStartLocks = new Map();
  return globalThis.__piStartLocks;
}


export function getRpcSession(sessionId: string): LiveAgentSession | undefined {
  return getRegistry().get(sessionId);
}

export function getLiveSession(sessionId: string): LiveAgentSession | undefined {
  return getRpcSession(sessionId);
}

export function getStartingSessionIds(): string[] {
  return [...getLocks().keys()];
}

function getLocalRunningAndStartingIds(): string[] {
  const ids = new Set<string>(getStartingSessionIds());
  for (const [sessionId, session] of getRegistry()) {
    if (session.isRunning()) ids.add(session.sessionId || sessionId);
  }
  return [...ids];
}

export function getRunningRpcSessionIds(): string[] {
  const ids = new Set(getLocalRunningAndStartingIds());
  for (const id of listFreshRunningLeaseSessionIds()) ids.add(id);
  return [...ids];
}

export function getRunningSessionIds(): string[] {
  return getRunningRpcSessionIds();
}

function getRunningListeners(): Set<(ids: string[]) => void> {
  if (!globalThis.__piRunningListeners) globalThis.__piRunningListeners = new Set();
  return globalThis.__piRunningListeners;
}

export function subscribeRunningSessions(
  listener: (ids: string[]) => void,
): () => void {
  const listeners = getRunningListeners();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export {
  recordRunningStartedAt,
  clearRunningStartedAt,
  getRunningStartedAt,
} from "./running-state";

export type PendingExtensionUi = {
  sessionId: string;
  requests: Record<string, unknown>[];
};

export function listPendingExtensionUi(): PendingExtensionUi[] {
  const out: PendingExtensionUi[] = [];
  for (const [key, host] of getRegistry()) {
    const requests = host.listPendingExtensionRequests();
    if (requests.length === 0) continue;
    out.push({ sessionId: host.sessionId || key, requests });
  }
  return out;
}

let lastRunningSnapshot = "";
const ownedRunningLeases = new Set<string>();
let runningLeaseHeartbeat: ReturnType<typeof setInterval> | null = null;
const RUNNING_LEASE_HEARTBEAT_MS = 8_000;

function syncOwnedRunningLeases(): void {
  const local = new Set(getLocalRunningAndStartingIds());
  for (const id of local) {
    heartbeatRunningLease(id);
    ownedRunningLeases.add(id);
  }
  for (const id of [...ownedRunningLeases]) {
    if (local.has(id)) continue;
    releaseRunningLease(id);
    ownedRunningLeases.delete(id);
  }
  if (local.size === 0) {
    if (runningLeaseHeartbeat) {
      clearInterval(runningLeaseHeartbeat);
      runningLeaseHeartbeat = null;
    }
    return;
  }
  if (!runningLeaseHeartbeat) {
    runningLeaseHeartbeat = setInterval(() => {
      syncOwnedRunningLeases();
    }, RUNNING_LEASE_HEARTBEAT_MS);
    runningLeaseHeartbeat.unref?.();
  }
}

export function notifyRunningChange(): void {
  syncOwnedRunningLeases();
  const ids = getRunningRpcSessionIds();
  const pending = listPendingExtensionUi();
  const snapshot = JSON.stringify({
    ids: [...ids].sort(),
    pending: pending.map((item) => ({
      sessionId: item.sessionId,
      ids: item.requests.map((req) => req.id ?? null),
    })),
  });
  if (snapshot === lastRunningSnapshot) return;
  lastRunningSnapshot = snapshot;
  for (const listener of getRunningListeners()) {
    try {
      listener(ids);
    } catch {
      /* ignore */
    }
  }
}

/**
 * 注册表重键：fork/new 后 session id 变化时原子替换 key。
 */
export function rekeyLiveSession(
  oldId: string,
  newId: string,
  session: LiveAgentSession,
): void {
  const registry = getRegistry();
  if (oldId !== newId) {
    registry.delete(oldId);
  }
  registry.set(newId, session);
}

/**
 * 启动或复用 live SDK host。
 * sessionFile === "" 时创建新会话。
 */
export async function startRpcSession(
  sessionId: string,
  sessionFile: string,
  cwd: string,
  toolNames?: string[],
  navigationActions?: NavigationActions,
): Promise<{ session: LiveAgentSession; realSessionId: string }> {
  return startLiveSession(sessionId, sessionFile, cwd, toolNames, navigationActions);
}

function hasQueuedText(value: unknown): boolean {
  return Array.isArray(value)
    && value.some((item) => typeof item === "string" && item.trim().length > 0);
}

/** 读取当前嵌套 prefs；同时兼容早期扁平 sessionQueue.<id> 键。 */
export function listRecoverableFollowUpSessionIds(prefs: PidancePrefs): string[] {
  const ids = new Set<string>();
  const nested = prefs.sessionQueue;
  if (typeof nested === "object" && nested !== null && !Array.isArray(nested)) {
    for (const [sessionId, queue] of Object.entries(nested as Record<string, unknown>)) {
      if (sessionId && hasQueuedText(queue)) ids.add(sessionId);
    }
  }
  for (const [key, queue] of Object.entries(prefs)) {
    if (!key.startsWith("sessionQueue.") || !hasQueuedText(queue)) continue;
    const sessionId = key.slice("sessionQueue.".length);
    if (sessionId) ids.add(sessionId);
  }
  return [...ids]
    .filter((sessionId) =>
      getPidancePref(prefs, `sessionQueueHold.${sessionId}`) !== true
      && prefs[`sessionQueueHold.${sessionId}`] !== true,
    )
    .sort();
}

/**
 * 服务端启动/热重载后恢复待投递的 follow-up 队列：
 * 扫描 prefs 中非空 sessionQueue.<id>，启动对应 live Host（Host 水合后会自动投递）。
 */
export async function recoverFollowUpQueues(): Promise<void> {
  const prefs = readPidancePrefs();
  for (const sessionId of listRecoverableFollowUpSessionIds(prefs)) {
    const existing = getRpcSession(sessionId);
    if (existing?.isAlive()) continue;
    const filePath = await resolveSessionPath(sessionId);
    if (!filePath) continue;
    let cwd = process.cwd();
    try {
      cwd = openSessionView(filePath).getHeader()?.cwd || process.cwd();
    } catch {
      // 保留默认 cwd；启动失败由 startRpcSession 抛错记录
    }
    try {
      await startRpcSession(sessionId, filePath, cwd);
    } catch (error) {
      console.error(`[pidance] recover follow-up queue failed for ${sessionId}:`, error);
    }
  }
}

export async function startLiveSession(
  sessionId: string,
  sessionFile: string,
  cwd: string,
  toolNames?: string[],
  navigationActions?: NavigationActions,
): Promise<{ session: LiveAgentSession; realSessionId: string }> {
  const registry = getRegistry();
  const locks = getLocks();

  const existing = registry.get(sessionId);
  if (existing?.isAlive()) {
    return { session: existing, realSessionId: sessionId };
  }

  const inflight = locks.get(sessionId);
  if (inflight) return inflight;

  if (!acquireRunningLease(sessionId)) {
    throw new Error(SESSION_RUNNING_LOCKED_MESSAGE);
  }
  notifyRunningChange();

  const starting = (async () => {
    try {
      const host = await startSdkSessionHost({
        sessionId,
        sessionFile,
        cwd,
        toolNames,
        navigationActions,
        onRunningChange: () => notifyRunningChange(),
        onSessionListInvalidate: () => invalidateSessionListCache(),
        cacheSessionPath: (id, file) => cacheSessionPath(id, file),
        onSessionRekeyed: (oldId, newId, rekeyed) => {
          rekeyLiveSession(oldId, newId, rekeyed);
          if (oldId !== newId) {
            acquireRunningLease(newId);
            releaseRunningLease(oldId);
          }
        },
      });
      const realSessionId = host.sessionId;
      const realSessionFile = host.sessionFile;
      if (realSessionFile) cacheSessionPath(realSessionId, realSessionFile);
      if (realSessionId !== sessionId) acquireRunningLease(realSessionId);
      host.onDestroy(() => {
        const current = registry.get(realSessionId);
        if (current === host) registry.delete(realSessionId);
        if (sessionId !== realSessionId) {
          const temp = registry.get(sessionId);
          if (temp === host) registry.delete(sessionId);
        }
        releaseRunningLease(realSessionId);
        if (sessionId !== realSessionId) releaseRunningLease(sessionId);
        notifyRunningChange();
      });
      registry.set(realSessionId, host);
      host.beginExtensionBinding();
      return { session: host, realSessionId };
    } catch (error) {
      releaseRunningLease(sessionId);
      notifyRunningChange();
      throw error;
    }
  })().finally(() => {
    locks.delete(sessionId);
    notifyRunningChange();
  });

  locks.set(sessionId, starting);
  return starting;
}
