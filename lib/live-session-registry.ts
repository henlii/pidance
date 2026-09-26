/**
 * Live session registry：globalThis 注册表、启动锁、running 广播、idle 与 id 重键。
 * 主路径固定为同进程 SdkSessionHost。
 */
import { cacheSessionPath, invalidateSessionListCache, resolveSessionPath } from "./session-reader";
import { isPlaceholderSessionId } from "./session-id";
import { sweepStaleUnreadEntries } from "./unread-entry-sweep";
import { openSessionView } from "./pi-session-io";
import { getPidancePref, readPidancePrefs, updatePidancePref, type PidancePrefs } from "./pidance-prefs-file";
import { hasQueuedFollowUp } from "./session-queue";
import { startSdkSessionHost, type SdkSessionHost } from "./sdk-session-host";
import { getRunningStartedAt as getLocalRunningStartedAt } from "./running-state";
import type { TreeNavigationSessionManager } from "./session-tree-navigation";
import {
  acquireRunningLease,
  heartbeatRunningLease,
  isRunningLeaseHeldByOther,
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

/**
 * 导航命令把 writer 让给离线写的显式交接入口。
 *
 * 由发起该命令的 Host 提供：只有它知道「不能等自己结束」的是哪条命令。
 * Service 的离线写必须先 await 它，再打开磁盘 SessionManager。
 */
export type NavigationWriterHandoff = () => Promise<void>;

/** 树导航命令里 Service 写 leaf/sidecar 用的 writer（Host 的 live 会话）。 */
export type TreeNavigationSessionWriter = {
  sessionManager: TreeNavigationSessionManager;
  /** sidecar 写在这个文件旁。 */
  sessionFile: string;
};

export type TreeNavigationCallOptions = {
  /** 交出 writer：离线路径先用它释放 Host 的 writer，再开磁盘视图写。 */
  handoff: NavigationWriterHandoff;
  /**
   * Host 自己的 live writer。给了就用它写（不交接、不再开磁盘视图）——这是必须的：
   * （只有就地改 leaf 的两个命令会传它；`createSessionFromLeaf` 写的是新文件。）
   * `session_before_tree` / `session_tree` 只能由本会话的 extension runner 派发，
   * 而交接会 dispose Host，SDK 在 `AgentSession.dispose()` 里 invalidate 那个 runner。
   */
  liveWriter?: TreeNavigationSessionWriter;
};

export type NavigationActions = {
  selectLeafExact(
    sessionId: string,
    entryId: string,
    options: TreeNavigationCallOptions,
  ): Promise<{ cancelled: boolean }>;
  branchFromAssistant(
    sessionId: string,
    assistantEntryId: string,
    options: TreeNavigationCallOptions,
  ): Promise<{ cancelled: boolean }>;
  createSessionFromLeaf(
    sessionId: string,
    entryId: string,
    options: TreeNavigationCallOptions,
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

/** 删除前等待同一 session 的并发启动完成，避免 unlink 与 SessionManager 初始化竞态。 */
export async function waitForSessionStart(sessionId: string): Promise<string | null> {
  const pending = getLocks().get(sessionId);
  if (!pending) return null;
  try {
    const result = await pending;
    return result.realSessionId;
  } catch {
    // 启动失败时没有 live writer，删除流程仍可继续清理磁盘对象。
    return null;
  }
}

function getLocalRunningAndStartingIds(): string[] {
  const ids = new Set<string>(getStartingSessionIds());
  for (const [sessionId, session] of getRegistry()) {
    if (session.isRunning()) ids.add(session.sessionId || sessionId);
  }
  return [...ids];
}

/**
 * 「真的在跑」的会话：正在执行，或者本轮已经登记过 prompt 起始时刻（agent_end 才清）。
 *
 * `starting`（仅打开/唤起 host）不算 —— 见 `lastActuallyRunningIds` 的注释。
 */
function getLocalActuallyRunningIds(): string[] {
  const ids = new Set<string>(getLocalRunningStartedAt().keys());
  for (const [sessionId, session] of getRegistry()) {
    if (session.isRunning()) ids.add(session.sessionId || sessionId);
  }
  return [...ids];
}

/** lease 覆盖 live writer 窗口；正常 settled run 会立即 dispose host。 */
function getLocalWriterAndStartingIds(): string[] {
  const ids = new Set<string>(getStartingSessionIds());
  for (const [sessionId, session] of getRegistry()) {
    if (session.isAlive()) ids.add(session.sessionId || sessionId);
  }
  return [...ids];
}

export function getRunningRpcSessionIds(): string[] {
  // 侧栏 running/计时 = 本进程正在执行（starting ∪ isRunning）。
  // writer lease 只做跨进程互斥（lockedByOther），不等于「智能体在跑」——
  // 端点保活的 idle host 仍持 lease，若混进 running 集会话结束后仍计时。
  return getLocalRunningAndStartingIds();
}

const localStartingStartedAt = new Map<string, number>();

/** 运行 id → 本轮执行开始（prompt 发送）。不含 writer lease 的 host 存活时间。 */
export function getRunningStartedAtTable(
  _agentDir?: string,
  now = Date.now(),
): Record<string, number> {
  const table: Record<string, number> = {};
  const localStartedAt = getLocalRunningStartedAt();
  const localIds = getLocalRunningAndStartingIds();
  const localSet = new Set(localIds);
  for (const sessionId of localIds) {
    const startedAt = localStartedAt.get(sessionId)
      ?? localStartingStartedAt.get(sessionId)
      ?? now;
    localStartingStartedAt.set(sessionId, startedAt);
    table[sessionId] = startedAt;
  }
  for (const sessionId of [...localStartingStartedAt.keys()]) {
    if (!localSet.has(sessionId)) localStartingStartedAt.delete(sessionId);
  }
  return table;
}

/**
 * 侧栏「运行中」徽标 / 计时 / running SSE 的 id 集合。
 *
 * 与 {@link getRunningRpcSessionIds} 的区别：**只算「真的有一轮在跑」**，
 * 不含仅处于「host 启动中（starting）」的会话 —— 打开/唤起 host 不该让侧栏点亮运行中
 * （用户实测：点一个空闲会话会让它在运行集里待约 2.5 秒，正是 host 启动的时长）。
 * 发送侧的「冷启动窗口」由客户端自己的乐观标记（catalogStore.markStarting）负责，
 * 不依赖这里。
 */
export function getRunningSessionIds(): string[] {
  return getLocalActuallyRunningIds();
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
/**
 * 上一次「**真的在跑**」的集合（正在执行 prompt / bash / 流式 / 压缩，或本轮已登记过 prompt 起始时刻）。
 *
 * 不能拿运行集直接判未读：打开一个会话会让 host 进入 **starting**，稳定后离开运行集，
 * 那并不是「跑完了」。以前就是这么判的 —— 于是**只打开、没提问**也会写一条 completedAt，
 * 侧栏立刻多一个未读（实测：在另一个进程里打开用户的会话，对方的侧栏就多一条未读）。
 */
let lastActuallyRunningIds: string[] = [];

/**
 * 新会话启动期的临时 key 前缀（真正 id 由 Pi 生成，见 session-service 的 startLockedSession）。
 * 它只用于启动锁，会随 rekey 从运行集消失 —— 那不是「会话跑完了」，所以不能给它记完成时刻。
 * 常量本体在 `lib/session-id`（浏览器侧也要用，不能从服务端模块导入）。
 */
export { PLACEHOLDER_SESSION_ID_PREFIX, isPlaceholderSessionId } from "./session-id";
const ownedRunningLeases = new Set<string>();
let runningLeaseHeartbeat: ReturnType<typeof setInterval> | null = null;
const RUNNING_LEASE_HEARTBEAT_MS = 8_000;

function syncOwnedRunningLeases(): void {
  const local = new Set(getLocalWriterAndStartingIds());
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
  // 与侧栏同一套（不含仅 starting），见 getRunningSessionIds 的注释。
  const ids = getRunningSessionIds();
  const pending = listPendingExtensionUi();
  // 未读只看「真的在跑」的集合，不看含 starting 的运行集（只打开会话不该产生未读）。
  const actuallyRunning = getLocalActuallyRunningIds();
  const snapshot = JSON.stringify({
    ids: [...ids].sort(),
    pending: pending.map((item) => ({
      sessionId: item.sessionId,
      ids: item.requests.map((req) => req.id ?? null),
    })),
  });
  if (snapshot === lastRunningSnapshot) return;
  lastRunningSnapshot = snapshot;
  // 未读改跨端（#65）：run 结束由**服务端**记时刻，这样即使当时没有任何浏览器开着，
  // 未读也是准的；各端只负责写自己的 readAt（未读 ⟺ completedAt > readAt，两侧都是
  // 单调时间戳取并集，不需要 CAS）。写盘挪到事件回调之外，避免拖住运行集广播。
  // 这里**不为子代理子会话加过滤**：它们的会话是 readOnly，写入口（ensureLive/start/send
  // 都走 requireWritableSession）拦得住，正常路径下进不了这个集合；唯一窄缝是
  // recoverFollowUpQueues 在残留队列上绕过 readOnly，真绕过去也会被回收在宽限期后清掉。
  // 回收的判据就是「侧栏会不会显示它的未读」：见 lib/unread-entry-sweep.ts。
  const finished = lastActuallyRunningIds.filter((id) => !actuallyRunning.includes(id) && !isPlaceholderSessionId(id));
  lastActuallyRunningIds = [...actuallyRunning];
  if (finished.length > 0) {
    const at = new Date().toISOString();
    setTimeout(() => {
      for (const id of finished) {
        try {
          updatePidancePref(`unreadSessionState.completedAt.${id}`, at);
        } catch (error) {
          // 偏好文件写失败不该影响运行态；下一次 run 结束仍会尝试。
          console.error("[pidance] failed to record unread completedAt:", error);
        }
      }
      // 顺手回收不会再被显示的条目（被删的会话、子代理子会话）。内部按 10 分钟节流，
      // 所以这里 fire-and-forget 不会变成每次 run 结束都扫一遍目录；
      // 启动时还有一次（instrumentation.ts），覆盖「只是删了会话、之后没再跑过」的情况。
      void sweepStaleUnreadEntries()
        .then((result) => {
          if (result.swept.length > 0) {
            console.log(`[pidance] 已回收 ${result.swept.length} 条不会再显示的未读条目`);
          }
        })
        .catch(() => undefined);
    }, 0);
  }
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
  // 与写入方共用同一解码器：只认数组会让当前格式 {items, revision} 被判为空，
  // 重启后队列不会被恢复投递（A1/A2）。
  return hasQueuedFollowUp(value);
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
    // 恢复队列必须先尊重对端 writer lease；startLiveSession 仍会再次
    // acquire 作原子竞态保护，检查只是避免无意义地初始化 SDK。
    if (isRunningLeaseHeldByOther(sessionId)) continue;
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
