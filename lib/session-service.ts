import { existsSync, readdirSync, unlinkSync } from "fs";
import { randomUUID } from "node:crypto";
import { join, resolve } from "path";
import { allowFileRoot } from "./file-access";
import { sweepUnreferencedAttachments } from "./attachment-gc";
import { getAgentDir } from "./pi-paths";
import {
  openSessionView,
  openSessionManager,
  materializeSessionFile,
  reparentSessionFile,
  type SessionHeader,
} from "./pi-session-io";
import { classifyPromptRejection, parsePromptCommand, type PromptCommand, type PromptReceipt } from "./agent-commands";
import {
  generateSessionTitleFromMessages,
  resolveTitleModelConfig,
} from "./session-title";
import { type ExportFormat } from "./session-export";
import { buildSessionExport, type SessionExportPayload } from "./session-html-export";
import { parseContextLimitParam, sliceContextBefore, sliceContextTail, DEFAULT_SESSION_HISTORY_PAGE, DEFAULT_SESSION_TAIL_LIMIT } from "./session-context-window";
import { getThinkingText, isThinkingLikeType } from "./thinking-content";
import { clearLeafSidecar, writeLeafSidecar } from "./session-leaf-sidecar";
import { invalidateSessionReadCache } from "./session-read-manager-cache";
import {
  getRpcSession,
  waitForSessionStart,
  getRunningRpcSessionIds,
  listPendingExtensionUi,
  startRpcSession,
  subscribeRunningSessions,
  type LiveAgentSession,
  type NavigationActions,
  type NavigationWriterHandoff,
  type PendingExtensionUi,
} from "./rpc-manager";
import {
  buildSessionContext,
  buildSessionPathLocal,
  resolveNavigationLeafId,
  buildSessionNavigationSnapshot,
  cacheSessionPath,
  invalidateSessionListCache,
  invalidateSessionPathCache,
  listAllSessions,
  readSessionHeader,
  resolveSessionIdByPath,
  resolveSessionPath,
  resolveSessionManagerForRead,
  type SessionManagerReadView,
} from "./session-reader";
import {
  normalizeActivityInput,
  PIDANCE_ACTIVITY_CUSTOM_TYPE,
  type SessionActivity,
  type SessionActivityInput,
} from "./session-activity";
import {
  normalizeCommandEntryData,
  PIDANCE_COMMAND_CUSTOM_TYPE,
} from "./session-command-entry";
import { computeTurnEnd } from "./turn-end";
import type { SessionInfo } from "./types";
import { shouldInheritModel } from "./model-selection";
import { readPidancePrefs, updatePidancePref } from "./pidance-prefs-file";
import {
  acquireRunningLease,
  isRunningLeaseHeldByOther,
  isSessionRunningLockedError,
  releaseRunningLease,
  SESSION_RUNNING_LOCKED_MESSAGE,
} from "./session-running-lease";
import { collectSubagentTree, deleteValidatedSubagents } from "./subagent-sessions";
import {
  archivedSessionIdsFor,
  createArchiveActions,
  filterSessionIdsByArchiveScope,
  listArchiveRecords,
  partitionSessionsByArchiveState,
  removeArchiveRecordAfterPermanentDelete,
  type ArchiveActionResult,
  type SessionArchiveFs,
  realArchiveFs,
} from "./session-archive";
import { getRunningStartedAt as readRunningStartedAt } from "./running-state";
import { buildUserMessageOutline, type UserMessageOutlineItem } from "./session-outline";
import { sliceContextAfter, sliceContextAround } from "./session-context-window";
import { getRunningStartedAtTable, PLACEHOLDER_SESSION_ID_PREFIX } from "./live-session-registry";
import { SESSION_WRITER_BUSY_MESSAGE } from "./sdk-session-host";
import { searchSessionsFulltext, type SessionSearchResult } from "./session-fulltext-search";

export type SessionCommand = Record<string, unknown> & { type: string };

export type SessionOutlineItem = UserMessageOutlineItem;

export const READ_ONLY_SUBAGENT_ERROR = "Subagent sessions are read-only";
export class ReadOnlySubagentError extends Error {
  constructor() { super(READ_ONLY_SUBAGENT_ERROR); }
  override toString() { return this.message; }
}

export async function requireWritableSession(
  sessionId: string,
  isReadOnly: (id: string) => Promise<boolean>,
): Promise<void> {
  if (await isReadOnly(sessionId)) throw new ReadOnlySubagentError();
}

/** Route 层：只读 403、缺失 404，其余 500。 */
export function httpStatusForSessionError(error: unknown): number {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof ReadOnlySubagentError || message === READ_ONLY_SUBAGENT_ERROR) return 403;
  if (message.includes("Session not found")) return 404;
  if (isSessionRunningLockedError(error) || message === SESSION_RUNNING_LOCKED_MESSAGE) return 409;
  // 命令仍在进行、writer 无法交出：离线写不允许并发，fail closed 成冲突。
  if (message === SESSION_WRITER_BUSY_MESSAGE) return 409;
  if (message === "Session is being deleted" || message.includes("closed while its title")) return 409;
  return 500;
}

/**
 * /api/agent/new 的状态码映射：输入错误 400，否则交给通用映射。
 *
 * 存在的理由：Route 曾用 `String(error)` 与原文字符串比较，而 `String(new Error("cwd is required"))`
 * 是 `"Error: cwd is required"`，两个 400 分支永远不会命中 —— 缺参数被当成 500。
 * 判定放在 Service 层，Route 保持薄，且可直接单测。
 */
export function httpStatusForNewSessionError(error: unknown): number {
  const message = error instanceof Error ? error.message : String(error);
  if (message === "cwd is required") return 400;
  if (message.startsWith("Directory does not exist:")) return 400;
  return httpStatusForSessionError(error);
}

export type CreateNewSessionOptions = {
  cwd: string;
  command: SessionCommand & {
    provider?: string;
    modelId?: string;
    toolNames?: string[];
    thinkingLevel?: string;
  };
};

export type CreateNewSessionResult = {
  sessionId: string;
  data: unknown;
};

/** 只读会话视图：live leaf 优先，否则磁盘 open；不启动 AgentSession。 */
export type SessionReadView = {
  source: "live" | "disk";
  filePath: string;
  manager: SessionManagerReadView;
};

/**
 * 新建会话的提交事务状态。
 *
 * 存在的理由：真实 sessionId 只有 startRpcSession 返回后才拿得到，而用户可能
 * 在那之前按 Stop。没有服务端可查询的身份，取消就只能取消浏览器自己的 fetch，
 * 后端仍在跑。
 */
export type SubmissionStatus =
  | "pending"
  | "starting"
  | "accepted"
  | "running"
  | "completed"
  | "cancelled"
  | "conflict"
  | "unknown";

export type SubmissionInfo = {
  submissionId: string;
  status: SubmissionStatus;
  sessionId?: string;
  /** 提交时的内容指纹（同 id 不同内容要冲突） */
  fingerprint?: string;
  error?: string;
};

export type CancelResult = {
  submissionId: string;
  /**
   * pending=已登记（提交尚未落地或尚不存在），并未确认停掉任何东西；
   * confirmed=已对原运行发出 abort。永不冒充「已停止」。
   */
  status: "pending" | "confirmed";
};

export const SUBMISSION_ID_CONFLICT_MESSAGE =
  "Submission conflict: this submissionId was already used with different content";

export const SESSION_SUBMISSION_CANCELLED_MESSAGE = "Submission was cancelled";

/** 终态/取消 tombstone 保留上限（本进程内存，不声称跨重启 exactly-once）。 */
const SUBMISSION_MAX_RECORDS = 500;

/** 会话产品用例：新增提交事务查询/取消。 */
export type SessionServiceSubmissionApi = {
  getSubmission(submissionId: string): SubmissionInfo | null;
  cancelSubmission(submissionId: string): Promise<CancelResult>;
};

export type SessionServiceDeps = {
  /** allowStale 只给「目录扫描就够」的调用方（搜索范围过滤）；存在性/权限判定不得用。 */
  listAllSessions: (options?: { allowStale?: boolean }) => Promise<SessionInfo[]>;
  resolveSessionPath: (sessionId: string) => Promise<string | null>;
  getRpcSession: (sessionId: string) => LiveAgentSession | undefined;
  waitForSessionStart?: (sessionId: string) => Promise<string | null>;
  startRpcSession: (
    sessionId: string,
    sessionFile: string,
    cwd: string,
    toolNames?: string[],
    navigationActions?: NavigationActions,
  ) => Promise<{ session: LiveAgentSession; realSessionId: string }>;
  getRunningRpcSessionIds: () => string[];
  listPendingExtensionUi: () => PendingExtensionUi[];
  subscribeRunningSessions: (listener: (ids: string[]) => void) => () => void;
  allowFileRoot: (root: string) => void;
  invalidateSessionListCache: () => void;
  openSessionCwd: (filePath: string) => string;
  openSessionManager: (filePath: string) => SessionManagerReadView;
  openSessionView: (filePath: string) => ReturnType<typeof openSessionView>;
  reparentSessionFile: (filePath: string, parentSession: string | undefined) => void;
  existsSync: (path: string) => boolean;
  now: () => number;
  /** 归档 sidecar Fs（测试注入 fake fs；缺省真实 fs） */
  archiveFs?: SessionArchiveFs;
  /** 归档 sidecar 根目录（测试注入 tmpdir；缺省 ~/.pi/agent） */
  archiveAgentDir?: () => string;
};

const defaultDeps: SessionServiceDeps = {
  listAllSessions,
  resolveSessionPath,
  getRpcSession,
  waitForSessionStart,
  startRpcSession,
  getRunningRpcSessionIds,
  listPendingExtensionUi,
  subscribeRunningSessions,
  allowFileRoot,
  invalidateSessionListCache,
  openSessionCwd: (filePath) => openSessionView(filePath).getHeader()?.cwd ?? process.cwd(),
  // 磁盘 open 经 resolveSessionManagerForRead / openSessionView
  openSessionManager: (filePath) => resolveSessionManagerForRead({ filePath }),
  openSessionView,
  reparentSessionFile,
  existsSync,
  now: () => Date.now(),
  archiveFs: realArchiveFs,
};

export type SessionService = {
  /** active 投影（默认）；archivedSessions/archivedCount 随附供 Archive 页与 badge 使用。 */
  listSessions(): Promise<{
    sessions: SessionInfo[];
    archivedSessions: SessionInfo[];
    archivedCount: number;
    runningSessionIds: string[];
  }>;
  /** 仅归档会话投影（Archive 页面数据源）。 */
  listArchivedSessions(): Promise<SessionInfo[]>;
  /** 仅 active 会话投影（scope=active）。 */
  listActiveSessions(): Promise<SessionInfo[]>;
  /** 全部真实会话（scope=all，含归档）。 */
  listAllSessions(): Promise<SessionInfo[]>;
  /** 会话是否已归档（服务端权威：按 (id, path) 判定，与列表投影一致）。 */
  isArchived(sessionId: string): Promise<boolean>;
  archiveSession(sessionId: string): Promise<string>;
  restoreSession(sessionId: string): Promise<SessionInfo | null>;
  archiveSessions(sessionIds: string[]): Promise<ArchiveActionResult>;
  restoreSessions(sessionIds: string[]): Promise<ArchiveActionResult>;
  removeArchiveRecordAfterPermanentDelete(sessionId: string): void;
  resolvePath(sessionId: string): Promise<string | null>;
  /**
   * 按 id 只读取单条 SessionInfo（列表投影子集）；不启动 AgentSession。
   * 底层可能枚举磁盘/缓存，但只返回目标条目；不存在 → null。
   */
  getSessionInfo(sessionId: string): Promise<SessionInfo | null>;
  /** 只读，不启动，不套 readOnly 门禁；readOnly subagent 仍可浏览 */
  getReadView(sessionId: string): Promise<SessionReadView | null>;
  /** 只取 alive wrapper，绝不启动 */
  getLive(sessionId: string): LiveAgentSession | undefined;
  /** @deprecated 使用 getLive；保留兼容 agent GET 等调用方 */
  getLiveSession(sessionId: string): LiveAgentSession | undefined;
  isLive(sessionId: string): boolean;
  /** 复用或启动；启动前必须 readOnly 门禁 */
  ensureLive(sessionId: string): Promise<LiveAgentSession>;
  /** 销毁 alive/dead wrapper；不存在 no-op；不走 readOnly 门禁 */
  destroy(sessionId: string): void;
  /** 可等待销毁：DELETE running 等需要先 abort 再等 runtime dispose 完成。 */
  destroyAsync(sessionId: string): Promise<void>;
  /** 永久删除会话（Service 编排：abort → destroy → 重挂子会话 → unlink → 清队列）。 */
  deleteSession(sessionId: string): Promise<{ skippedSubagents: number }>;
  start(
    sessionId: string,
    sessionFile: string,
    cwd: string,
    toolNames?: string[],
  ): Promise<{ session: LiveAgentSession; realSessionId: string }>;
  send(sessionId: string, command: SessionCommand): Promise<unknown>;
  submitPrompt(
    sessionId: string,
    command: PromptCommand,
  ): Promise<PromptReceipt>;
  /**
   * `light` 省略体积大且很少变化的字段（systemPrompt）。轮询（run/bash 对账）
   * 只需要运行标志；systemPrompt 由 loadSession 的 includeState 路径权威提供。
   */
  getAgentState(sessionId: string, options?: { light?: boolean }): Promise<{
    live: boolean;
    activeRun: boolean;
    lockedByOther?: boolean;
    readOnly?: boolean;
    state?: unknown;
  }>;
  renameSession(sessionId: string, name: string): Promise<void>;
  autoNameSession(sessionId: string): Promise<{ title: string; usage: unknown }>;
  exportSession(
    sessionId: string,
    options: { format: ExportFormat; leafId?: string },
  ): Promise<SessionExportPayload>;
  getNavigationSnapshot(
    sessionId: string,
    options?: { deferThinking?: boolean; deferToolResultImages?: boolean },
  ): Promise<{
    filePath: string;
    leafId: string | null;
    tree: unknown;
    context: unknown;
    header: { id?: string; cwd?: string; timestamp?: string; parentSession?: string } | null | undefined;
    sessionName: string | undefined;
    parentSessionId?: string;
    info: SessionInfo | null;
  } | null>;
  getContextPage(
    sessionId: string,
    options: {
      leafId?: string;
      before?: string;
      /** 按 entryId 定位窗口（跳转到历史某条）；与 before/after 互斥，优先 around */
      around?: string;
      /** 取 after 之后的更新窗口（定位到历史后继续向下加载） */
      after?: string;
      /** around 窗口是否一直取到最新（跳转历史时保留尾部流式段） */
      aroundToEnd?: boolean;
      limit: number | null;
      deferThinking?: boolean;
      deferToolResultImages?: boolean;
    },
  ): Promise<unknown>;
  /**
   * 只读：会话全部用户消息大纲（左侧导航条列出所有提问）。
   * 直接读完整 entry 列表（live 内存视图或磁盘），不唤醒 writer、不写状态。
   */
  getUserMessageOutline(sessionId: string): Promise<SessionOutlineItem[]>;
  /** 只读：assistant entry 的 thinking 块文本；非 assistant/无该块返回 null。 */
  getEntryThinking(
    sessionId: string,
    entryId: string,
    blockIndex: number,
  ): Promise<{ thinking: string } | null>;
  /** 只读：toolResult entry 的 details/content；未命中返回 null。 */
  getToolResultDetails(sessionId: string, toolCallId: string): Promise<{ details: unknown; content?: unknown[] } | null>;
  /**
   * 类型安全的持久活动写入。
   * 单写者：仅当 live 暴露 in-process SessionManager（inner.sessionManager）时走 live.appendActivity；
   * 外部 RPC 等无 inner 的 live 必须先 destroy 再磁盘写，不得与外部 pi 并发写同一 JSONL。
   * 不得绕过 readOnly；customType 固定为 pidance.activity。
   */
  appendActivity(
    sessionId: string,
    input: SessionActivityInput,
  ): Promise<{ entryId: string; activity: SessionActivity }>;

  /**
   * 命令条目写入（pidance.command）：斜杠命令执行成功后追加到会话时间线。
   * 与 appendActivity 同一单写者保护；type:"custom" 不进入 LLM 上下文。
   */
  appendCommandEntry(
    sessionId: string,
    input: { command: string; ok?: boolean; result?: string },
  ): Promise<{ entryId: string; data: { command: string; ok: boolean; result?: string; version?: number } }>;
  createNew(options: CreateNewSessionOptions): Promise<CreateNewSessionResult>;
  getSubmission(submissionId: string): SubmissionInfo | null;
  /** 取消：await 到 abort 已发出（或已登记 tombstone）才返回。 */
  cancelSubmission(submissionId: string): Promise<CancelResult>;
  getRunningIds(): string[];
  getRunningStartedAt(): Record<string, number>;
  searchFulltext(
    query: string,
    options?: { maxHits?: number; scope?: "active" | "archived" | "all" },
  ): Promise<SessionSearchResult>;
  listPendingExtensionUi(): PendingExtensionUi[];
  subscribeRunning(listener: (ids: string[]) => void): () => void;
  isReadOnly(sessionId: string): Promise<boolean>;
  /** 外进程占写锁：本进程可只读浏览，不得 ensureLive。本进程已 live 则 false。 */
  /** 精确 leaf 切换（user 叶也停在该 entry，不触发 Pi 的 user 编辑语义） */
  selectLeafExact(
    sessionId: string,
    entryId: string,
    handoff?: NavigationWriterHandoff,
  ): Promise<{ cancelled: boolean }>;
  /** assistant 轮末分支：computeTurnEnd 后 navigateTree */
  branchFromAssistant(
    sessionId: string,
    assistantEntryId: string,
    handoff?: NavigationWriterHandoff,
  ): Promise<{ cancelled: boolean }>;
  /** through-entry 线性新会话（assistant 锚点先 resolve 到 turnEnd） */
  createSessionFromLeaf(
    sessionId: string,
    entryId: string,
    handoff?: NavigationWriterHandoff,
  ): Promise<{ cancelled: boolean; newSessionId: string }>;
};

/**
 * 轻量投影：剥离体积大、变化少的字段。
 * 只删键不改语义——消费方一律按 `field !== undefined` 判断「有无更新」，
 * 省略即表示本次不更新，不会把已有值清掉。
 */
const LIGHT_STATE_OMIT = ["systemPrompt"] as const;

export function projectAgentState(
  state: unknown,
  options?: { light?: boolean },
): unknown {
  if (!options?.light || !state || typeof state !== "object" || Array.isArray(state)) return state;
  const projected = { ...(state as Record<string, unknown>) };
  for (const key of LIGHT_STATE_OMIT) delete projected[key];
  return projected;
}

/**
 * 会话删除后清掉它留在偏好文件里的按会话分桶数据：队列、hold、**未读时钟**（#65 —— 服务端
 * 现在会在 run 结束时写 `unreadSessionState.completedAt.<id>`，不清就会给已删除会话留死条目）。
 */
function clearDeletedSessionPrefs(sessionId: string): void {
  updatePidancePref(`sessionQueue.${sessionId}`, null);
  updatePidancePref(`sessionQueueHold.${sessionId}`, null);
  const prefs = readPidancePrefs();
  const bucket = prefs.unreadSessionState;
  if (bucket && typeof bucket === "object" && !Array.isArray(bucket)) {
    const record = bucket as Record<string, unknown>;
    if (record.completedAt && typeof record.completedAt === "object") {
      updatePidancePref(`unreadSessionState.completedAt.${sessionId}`, null);
    }
    if (record.readAt && typeof record.readAt === "object") {
      updatePidancePref(`unreadSessionState.readAt.${sessionId}`, null);
    }
  }
}

export function createSessionService(overrides: Partial<SessionServiceDeps> = {}): SessionService {
  const deps: SessionServiceDeps = { ...defaultDeps, ...overrides };

  const archiveActions = createArchiveActions({
    fs: deps.archiveFs,
    agentDir: deps.archiveAgentDir,
    resolveSessionPath: deps.resolveSessionPath,
    readSessionHeader,
    isReadOnly: async (id) => {
      const session = (await deps.listAllSessions()).find((item) => item.id === id);
      return session?.readOnly === true;
    },
    isRunning: (id) => deps.getRunningRpcSessionIds().includes(id),
    getSessionInfo: async (id) => {
      const sessions = await deps.listAllSessions();
      return sessions.find((item) => item.id === id) ?? null;
    },
    invalidateSessionListCache: deps.invalidateSessionListCache,
    now: () => new Date(deps.now()).toISOString(),
  });

  /** 当前 sidecar 目录下的全部合法记录（带短 TTL 缓存）。 */
  const currentArchiveRecords = () =>
    listArchiveRecords(deps.archiveFs ?? realArchiveFs, deps.archiveAgentDir?.() ?? getAgentDir());

  /**
   * 同一会话的删除单飞，避免两个 DELETE 竞态 unlink 同一个 JSONL。
   */
  const deletionFlights = new Map<string, Promise<{ skippedSubagents: number }>>();

  /**
   * 提交事务表（进程内）。
   *
   * 目标：真实 sessionId 未知时也能按 submissionId 查询/取消。
   * 边界：只保证本进程有效，不声称跨重启 exactly-once；终态有界保留，
   * 取消 tombstone 同样有界（避免为早已消失的提交永久占内存）。
   */
  const submissions = new Map<string, {
    info: SubmissionInfo;
    /** 取消请求是否已到达 */
    cancelRequested: boolean;
    /** 取消是否已作用于原运行 */
    cancelApplied: boolean;
  }>();

  const rememberSubmission = (info: SubmissionInfo): void => {
    submissions.set(info.submissionId, {
      info,
      cancelRequested: false,
      cancelApplied: false,
    });
    if (submissions.size <= SUBMISSION_MAX_RECORDS) return;
    // 有界：先淘汰已到终态的最旧记录（保留取消 tombstone）。
    for (const [key, record] of submissions) {
      if (submissions.size <= SUBMISSION_MAX_RECORDS) break;
      if (key === info.submissionId) continue;
      if (record.info.status === "completed") submissions.delete(key);
    }
  };

  /** 同 id 是否已用于不同内容（冲突防护）。 */
  const submissionFingerprint = (cwd: string, command: SessionCommand): string => {
    const message = typeof command.message === "string" ? command.message : "";
    return `${cwd}\u0000${message}`;
  };

  const awaitWriterReleased = async (sessionId: string): Promise<void> => {
    const session = deps.getRpcSession(sessionId);
    if (!session) return;
    if (typeof (session as { destroyAsync?: unknown }).destroyAsync === "function") {
      await (session as { destroyAsync: () => Promise<void> }).destroyAsync();
      return;
    }
    if (session.isAlive()) session.destroy();
  };

  const withHeldWriter = async <T>(sessionId: string, action: () => Promise<T> | T): Promise<T> => {
    if (!acquireRunningLease(sessionId)) {
      throw new Error(SESSION_RUNNING_LOCKED_MESSAGE);
    }
    try {
      return await action();
    } finally {
      releaseRunningLease(sessionId);
    }
  };

  /** 离线写入也临时持有 writer lease，避免检查远端后到 openSessionView 前被抢占。 */
  const withOfflineWriter = async <T>(
    sessionId: string,
    action: () => Promise<T> | T,
    handoff?: NavigationWriterHandoff,
  ): Promise<T> => {
    // 从导航命令内部发起时，由发起方（Host）显式交接：它不能等自己结束。
    if (handoff) await handoff();
    else await awaitWriterReleased(sessionId);
    return withHeldWriter(sessionId, action);
  };

  const service: SessionService = {
    async listSessions() {
      const all = await deps.listAllSessions();
      const { active, archived } = partitionSessionsByArchiveState(all, currentArchiveRecords());
      return {
        sessions: active,
        archivedSessions: archived,
        archivedCount: archived.length,
        runningSessionIds: deps.getRunningRpcSessionIds(),
      };
    },

    async listArchivedSessions() {
      const all = await deps.listAllSessions();
      return partitionSessionsByArchiveState(all, currentArchiveRecords()).archived;
    },

    async listActiveSessions() {
      const all = await deps.listAllSessions();
      return partitionSessionsByArchiveState(all, currentArchiveRecords()).active;
    },

    async listAllSessions() {
      return deps.listAllSessions();
    },

    async isArchived(sessionId) {
      const sessions = await deps.listAllSessions();
      return archivedSessionIdsFor(sessions, currentArchiveRecords()).has(sessionId);
    },

    async archiveSession(sessionId) {
      return archiveActions.archiveSession(sessionId);
    },

    async restoreSession(sessionId) {
      return archiveActions.restoreSession(sessionId);
    },

    async archiveSessions(sessionIds) {
      return archiveActions.archiveSessions(sessionIds);
    },

    async restoreSessions(sessionIds) {
      return archiveActions.restoreSessions(sessionIds);
    },

    removeArchiveRecordAfterPermanentDelete(sessionId) {
      removeArchiveRecordAfterPermanentDelete(
        deps.archiveFs ?? realArchiveFs,
        deps.archiveAgentDir?.() ?? getAgentDir(),
        sessionId,
      );
    },

    resolvePath(sessionId) {
      return deps.resolveSessionPath(sessionId);
    },

    async getSessionInfo(sessionId) {
      if (!sessionId || typeof sessionId !== "string") return null;
      const sessions = await deps.listAllSessions();
      return sessions.find((item) => item.id === sessionId) ?? null;
    },

    async isReadOnly(sessionId) {
      const session = (await deps.listAllSessions()).find((item) => item.id === sessionId);
      return session?.readOnly === true;
    },

    async getReadView(sessionId) {
      const filePath = await deps.resolveSessionPath(sessionId);
      if (!filePath) return null;

      // 外部 RPC 无 inner.sessionManager；迁移规格：只读以磁盘为准。
      // 进程内路径仍优先 live 内存视图（与历史行为一致）。
      const wrapper = deps.getRpcSession(sessionId);
      const inner = (wrapper as { inner?: { sessionManager?: SessionManagerReadView } } | undefined)?.inner;
      if (wrapper?.isAlive() && inner?.sessionManager) {
        return {
          source: "live",
          filePath,
          manager: inner.sessionManager,
        };
      }

      return {
        source: "disk",
        filePath,
        manager: deps.openSessionManager(filePath),
      };
    },

    getLive(sessionId) {
      const session = deps.getRpcSession(sessionId);
      return session?.isAlive() ? session : undefined;
    },

    getLiveSession(sessionId) {
      return service.getLive(sessionId);
    },

    isLive(sessionId) {
      return Boolean(service.getLive(sessionId));
    },

    async ensureLive(sessionId) {
      await requireWritableSession(sessionId, service.isReadOnly);
      if (deletionFlights.has(sessionId)) throw new Error("Session is being deleted");
      const live = service.getLive(sessionId);
      if (live) return live;
      if (isRunningLeaseHeldByOther(sessionId)) {
        throw new Error(SESSION_RUNNING_LOCKED_MESSAGE);
      }

      const filePath = await deps.resolveSessionPath(sessionId);
      if (!filePath) {
        throw new Error("Session not found");
      }

      const cwd = deps.openSessionCwd(filePath);
      const { session } = await deps.startRpcSession(sessionId, filePath, cwd, undefined, navigationActions);
      return session;
    },

    destroy(sessionId) {
      // 含 dead wrapper；不存在 no-op；不走 readOnly
      deps.getRpcSession(sessionId)?.destroy();
    },

    async destroyAsync(sessionId) {
      const session = deps.getRpcSession(sessionId);
      if (!session) return;
      if (typeof (session as { destroyAsync?: unknown }).destroyAsync === "function") {
        await (session as { destroyAsync: () => Promise<void> }).destroyAsync();
      } else {
        session.destroy();
      }
    },

    deleteSession(sessionId) {
      const existing = deletionFlights.get(sessionId);
      if (existing) return existing;
      const flight = (async () => {
        await requireWritableSession(sessionId, service.isReadOnly);
        // 删除与并发 ensureLive/start 串行：先等已经开始的 host 启动完成，
        // 后续 ensureLive 会看到 deletionFlights 并拒绝，不会在 unlink 后继续打开 JSONL。
        const startedSessionId = await deps.waitForSessionStart?.(sessionId);
        const liveSessionId = startedSessionId ?? sessionId;
        const filePath = await deps.resolveSessionPath(sessionId);
        if (!filePath) {
          // 删除是幂等操作：对象已不存在时仍清理残留偏好/缓存，不把 ENOENT
          // 变成 500 或让客户端误以为服务进程失效。
          try {
            clearDeletedSessionPrefs(sessionId);
          } catch (error) {
            console.error("[pidance] failed to clear queue prefs after missing delete:", error);
          }
          invalidateSessionPathCache(sessionId);
          deps.invalidateSessionListCache();
          service.removeArchiveRecordAfterPermanentDelete(sessionId);
          return { skippedSubagents: 0 };
        }

        // 只读有界 header；删除前收集 subagent 树。
        // 远端进程持有 writer lease 时，本进程无法发送 abort；拒绝删除，
        // 否则对端仍会向已 unlink 的 JSONL 写入并可能使服务崩溃。
        if (isRunningLeaseHeldByOther(sessionId) || isRunningLeaseHeldByOther(liveSessionId)) {
          throw new Error(SESSION_RUNNING_LOCKED_MESSAGE);
        }
        const parentSessionPath = readSessionHeader(filePath)?.parentSession;
        const verifiedChildren = readSessionHeader(filePath)?.id === sessionId
          ? collectSubagentTree(filePath, sessionId)
          : [];

        // 1. running 先 abort（不 flush）；abort 失败只记录并继续删除。
        const live = deps.getRpcSession(liveSessionId) ?? deps.getRpcSession(sessionId);
        const runningIds = deps.getRunningRpcSessionIds();
        if (live?.isAlive?.() && (runningIds.includes(sessionId) || runningIds.includes(liveSessionId))) {
          try {
            await live.send({ type: "abort" });
          } catch (error) {
            console.error("[pidance] abort before delete failed:", error);
          }
        }

        // 2. 等待 abort 完成后 await destroy。rekey 期间 registry 可能只保留
        // host 的真实 id；优先使用 host 自身 id，避免 destroy 误命中空 key。
        await service.destroyAsync(live?.sessionId ?? liveSessionId);

        return withHeldWriter(live?.sessionId ?? liveSessionId, async () => {
          // 3. 子会话重挂到本会话的 parent（cascade re-parent via SessionManager）。
          const dir = filePath.replace(/\\/g, "/").split("/").slice(0, -1).join("/");
        try {
          const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl") && join(dir, f) !== filePath);
          for (const file of files) {
            const childPath = join(dir, file);
            try {
              const header = readSessionHeader(childPath);
              if (header?.type === "session" && header.parentSession === filePath) {
                if (header.id) {
                  await deps.waitForSessionStart?.(header.id);
                  await withOfflineWriter(header.id, () => {
                    deps.reparentSessionFile(childPath, parentSessionPath);
                  });
                } else {
                  deps.reparentSessionFile(childPath, parentSessionPath);
                }
              }
            } catch {
              /* skip malformed */
            }
          }
        } catch {
          /* skip if dir unreadable */
        }

        // 4. 删除会话文件与 sidecar；外部并发删除视为已完成。
        try {
          unlinkSync(filePath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        clearLeafSidecar(filePath);
        // 只读视图缓存按指纹自动失效；这里显式释放，不留已删会话的解析结果
        invalidateSessionReadCache(filePath);
        const parentRoot = resolve(filePath.slice(0, -6));
        const skippedSubagents = deleteValidatedSubagents(
          verifiedChildren,
          parentRoot,
          invalidateSessionPathCache,
          invalidateSessionReadCache,
        );

        // 5. 删除成功后才清队列/hold/未读时钟。
        try {
          clearDeletedSessionPrefs(sessionId);
        } catch (error) {
          console.error("[pidance] failed to clear queue prefs after delete:", error);
        }
        // 会话删除后，它引用过的附件可能没人再引用：跑一次兜底回收（引用集合
        // 不完整时该函数自身会放弃，不会误删其他会话的文件）；失败只告警，
        // 不影响删除结果。
        try {
          sweepUnreferencedAttachments();
        } catch (error) {
          console.error("[pidance] failed to sweep attachments:", error);
        }

        invalidateSessionPathCache(sessionId);
        deps.invalidateSessionListCache();
          service.removeArchiveRecordAfterPermanentDelete(sessionId);
          return { skippedSubagents };
        });
      })();
      deletionFlights.set(sessionId, flight);
      return flight.finally(() => {
        if (deletionFlights.get(sessionId) === flight) deletionFlights.delete(sessionId);
      });
    },

    async start(sessionId, sessionFile, cwd, toolNames) {
      await requireWritableSession(sessionId, service.isReadOnly);
      if (deletionFlights.has(sessionId)) throw new Error("Session is being deleted");
      return deps.startRpcSession(sessionId, sessionFile, cwd, toolNames, navigationActions);
    },

    async send(sessionId, command) {
      const session = await service.ensureLive(sessionId);
      return session.send(command);
    },

    async submitPrompt(sessionId, command) {
      await requireWritableSession(sessionId, service.isReadOnly);
      const parsed = parsePromptCommand(command);
      try {
        const data = await service.send(sessionId, parsed);
        if (data && typeof data === "object" && (data as PromptReceipt).status) {
          return data as PromptReceipt;
        }
        // 没有回执就是没有回执：不能静默升级成「已接受」，
        // 否则客户端会把根本没受理的消息当成已发送。
        return { submissionId: parsed.submissionId, sessionId, status: "rejected", reason: "error" };
      } catch (error) {
        if (isSessionRunningLockedError(error)) throw error;
        // 只做保守归类：不认识的错误一律 error，客户端不得据此自动重发。
        return {
          submissionId: parsed.submissionId,
          sessionId,
          status: "rejected",
          reason: classifyPromptRejection(error),
        };
      }
    },

    async getAgentState(sessionId, options) {
      if (await service.isReadOnly(sessionId)) {
        return { live: false, activeRun: false, readOnly: true };
      }
      const session = service.getLive(sessionId);
      if (!session) {
        return {
          live: false,
          activeRun: false,
          ...(isRunningLeaseHeldByOther(sessionId) ? { lockedByOther: true } : {}),
        };
      }
      const state = await session.send({ type: "get_state" });
      const activeRun = typeof (session as { isRunning?: () => boolean }).isRunning === "function"
        ? Boolean((session as { isRunning: () => boolean }).isRunning())
        : Boolean(
          (state as { isStreaming?: boolean; isPromptRunning?: boolean; isCompacting?: boolean; isBashRunning?: boolean } | null)
            && (
              (state as { isStreaming?: boolean }).isStreaming
              || (state as { isPromptRunning?: boolean }).isPromptRunning
              || (state as { isCompacting?: boolean }).isCompacting
              || (state as { isBashRunning?: boolean }).isBashRunning
            ),
        );
      return { live: true, activeRun, lockedByOther: false, state: projectAgentState(state, options) };
    },

    async renameSession(sessionId, name) {
      await requireWritableSession(sessionId, service.isReadOnly);
      const trimmed = name.trim();
      if (!trimmed) throw new Error("name is required");
      const live = service.getLive(sessionId);
      if (live?.isAlive()) {
        await live.send({ type: "set_session_name", name: trimmed });
        deps.invalidateSessionListCache();
        return;
      }
      const filePath = await deps.resolveSessionPath(sessionId);
      if (!filePath) throw new Error("Session not found");
      await withOfflineWriter(sessionId, () => {
        deps.openSessionView(filePath).appendSessionInfo(trimmed);
        deps.invalidateSessionListCache();
      });
    },

    async autoNameSession(sessionId) {
      await requireWritableSession(sessionId, service.isReadOnly);
      const session = await service.ensureLive(sessionId);
      await (session as { waitUntilReady?: () => Promise<void> }).waitUntilReady?.();
      const snapshot = await service.getNavigationSnapshot(sessionId);
      if (!snapshot) throw new Error("Session not found");
      const messages = (snapshot.context as { messages?: Array<{ role: string; content: unknown }> }).messages ?? [];
      const config = resolveTitleModelConfig();
      const result = await generateSessionTitleFromMessages({
        messages,
        provider: config.provider,
        modelId: config.modelId,
        baseUrl: config.baseUrl,
        api: config.api,
        apiKey: config.apiKey,
        headers: config.headers,
      });
      if (!session.isAlive()) {
        throw new Error("The session was closed while its title was being generated. Please try again.");
      }
      try {
        await session.send({ type: "set_session_name", name: result.title });
      } catch {
        await service.destroyAsync(sessionId);
        await service.renameSession(sessionId, result.title);
      }
      return { title: result.title, usage: result.usage ?? null };
    },

    async exportSession(sessionId, options) {
      const filePath = await deps.resolveSessionPath(sessionId);
      if (!filePath) throw new Error("Session not found");
      return buildSessionExport(filePath, options);
    },

    async getNavigationSnapshot(sessionId, options = {}) {
      const view = await service.getReadView(sessionId);
      if (!view) return null;
      const { filePath, manager: sm } = view;
      const { leafId, tree, context, header, sessionName } = buildSessionNavigationSnapshot(sm, options);
      const parentSessionId = header?.parentSession
        ? await resolveSessionIdByPath(header.parentSession)
        : undefined;
      const relation = (await deps.listAllSessions()).find((session) => session.id === sessionId);
      const info = header ? {
        path: filePath,
        id: header.id,
        cwd: header.cwd ?? "",
        name: sessionName,
        created: header.timestamp,
        modified: header.timestamp,
        messageCount: (context as { totalMessageCount?: number; messages: unknown[] }).totalMessageCount
          ?? (context as { messages: unknown[] }).messages.length,
        firstMessage: relation?.firstMessage ?? "(no messages)",
        parentSessionId,
        ...(relation?.subagent ? { subagent: relation.subagent, readOnly: true as const } : {}),
      } : null;
      return {
        filePath,
        leafId,
        tree,
        context,
        header,
        sessionName,
        parentSessionId,
        info,
      };
    },

    async getUserMessageOutline(sessionId) {
      const view = await service.getReadView(sessionId);
      if (!view) return [];
      // 与 buildSessionContext 同口径：只取当前 leaf 路径上的 entries，
      // 避免列出其它分支的提问（那些条 around 定位不到）。
      const sm = view.manager as SessionManagerReadView;
      const entries = (sm.getEntries?.() ?? []) as Parameters<typeof buildSessionPathLocal>[0];
      const leafId = resolveNavigationLeafId(
        entries as Array<{ id: string; type: string; parentId: string | null }>,
        sm.getLeafId(),
      );
      return buildUserMessageOutline(buildSessionPathLocal(entries, leafId));
    },

    async getContextPage(sessionId, options) {
      const view = await service.getReadView(sessionId);
      if (!view) return { context: null };
      const sm = view.manager as { getEntries?: () => Parameters<typeof buildSessionContext>[0] };
      const entries = (sm.getEntries?.() ?? []) as Parameters<typeof buildSessionContext>[0];
      const full = buildSessionContext(entries, options.leafId, {
        deferThinking: options.deferThinking,
        deferToolResultImages: options.deferToolResultImages,
      });
      const limit = options.limit;
      let context;
      if (options.around) {
        const aroundWindow = sliceContextAround(
          full,
          options.around,
          limit ?? DEFAULT_SESSION_HISTORY_PAGE,
          { toEnd: options.aroundToEnd === true },
        );
        // anchor 不在当前 leaf 路径上：显式未命中，不回退尾页（否则会把「没找到」
        // 当成命中，界面停在别处却报告成功）。
        if (!aroundWindow) return { context: null, notFound: options.around };
        context = aroundWindow;
      } else if (options.after) {
        context = sliceContextAfter(full, options.after, limit ?? DEFAULT_SESSION_HISTORY_PAGE);
      } else if (options.before) {
        context = sliceContextBefore(full, options.before, limit ?? DEFAULT_SESSION_HISTORY_PAGE);
      } else if (limit !== null) {
        context = sliceContextTail(full, limit);
      } else {
        context = {
          ...full,
          hasMoreBefore: false,
          totalMessageCount: full.messages.length,
        };
      }
      return { context };
    },

    async getEntryThinking(sessionId, entryId, blockIndex) {
      const view = await service.getReadView(sessionId);
      if (!view) return null;
      const entry = (view.manager.getEntries() as Array<{ id?: string; type?: string; message?: { role?: string; content?: unknown[] } }>)
        .find((candidate) => candidate.id === entryId);
      if (!entry || entry.type !== "message" || entry.message?.role !== "assistant") {
        return null;
      }
      const block = entry.message.content?.[blockIndex] as { type?: string } | undefined;
      if (!block || !isThinkingLikeType(block.type)) {
        return null;
      }
      return { thinking: getThinkingText(block) };
    },

    async getToolResultDetails(sessionId, toolCallId) {
      const view = await service.getReadView(sessionId);
      if (!view) return null;
      const entry = (view.manager.getEntries() as Array<{ type?: string; message?: { role?: string; toolCallId?: string; details?: unknown; content?: unknown[] } }>)
        .find((candidate) =>
          candidate.type === "message"
          && candidate.message?.role === "toolResult"
          && candidate.message.toolCallId === toolCallId,
        );
      if (!entry) return null;
      return {
        details: entry.message?.details ?? null,
        content: Array.isArray(entry.message?.content) ? entry.message.content : [],
      };
    },

    async appendActivity(sessionId, input) {
      // readOnly（subagent 持久化）拒绝写，且不启动任何会话
      await requireWritableSession(sessionId, service.isReadOnly);
      // 单写者：
      // - 仅 in-process live（暴露 inner.sessionManager）可直接 appendActivity（SDK SessionManager 写）
      // - 无 inner 的 live 不得直接磁盘写，须先 destroy
      // - 无 inner 时必须先 destroy live，再离线写盘
      const live = service.getLive(sessionId) as
        | {
            isAlive: () => boolean;
            appendActivity?: (i: SessionActivityInput) =>
              | { entryId: string; activity: SessionActivity }
              | Promise<{ entryId: string; activity: SessionActivity }>;
            inner?: { sessionManager?: unknown };
          }
        | undefined;
      const hasInProcessManager = Boolean(live?.inner?.sessionManager);
      const appendOnWrapper = live?.appendActivity;
      if (live?.isAlive() && hasInProcessManager && typeof appendOnWrapper === "function") {
        return await appendOnWrapper.call(live, input);
      }
      const result = await withOfflineWriter(sessionId, async () => {
        const filePath = await deps.resolveSessionPath(sessionId);
        if (!filePath) throw new Error("Session not found");
        const activity = normalizeActivityInput(input);
        const manager = deps.openSessionView(filePath);
        const entryId = manager.appendCustomEntry(PIDANCE_ACTIVITY_CUSTOM_TYPE, activity);
        deps.invalidateSessionListCache();
        return { entryId, activity };
      });
      return result;
    },

    async appendCommandEntry(sessionId, input) {
      // 与 appendActivity 同一单写者模式：readOnly 拒绝、外部 RPC live 先停进程再写盘。
      await requireWritableSession(sessionId, service.isReadOnly);
      const result = await withOfflineWriter(sessionId, async () => {
        const filePath = await deps.resolveSessionPath(sessionId);
        if (!filePath) throw new Error("Session not found");
        const data = normalizeCommandEntryData(input);
        if (!data.command) throw new Error("command is required");
        const manager = deps.openSessionView(filePath);
        const entryId = manager.appendCustomEntry(PIDANCE_COMMAND_CUSTOM_TYPE, data);
        deps.invalidateSessionListCache();
        return { entryId, data };
      });
      return result;
    },

    async createNew({ cwd, command }) {
      if (!cwd || typeof cwd !== "string") {
        throw new Error("cwd is required");
      }
      if (!deps.existsSync(cwd)) {
        throw new Error(`Directory does not exist: ${cwd}`);
      }

      const {
        provider,
        modelId,
        toolNames,
        thinkingLevel,
        ...promptCommand
      } = command;

      // 提交事务：在第一个异步启动步骤之前登记，使取消能先于创建到达。
      const submissionId = typeof promptCommand.submissionId === "string"
        ? promptCommand.submissionId
        : undefined;
      const fingerprint = submissionFingerprint(cwd, promptCommand as SessionCommand);
      if (submissionId) {
        const existing = submissions.get(submissionId);
        if (existing) {
          if (existing.info.fingerprint && existing.info.fingerprint !== fingerprint) {
            existing.info.status = "conflict";
            throw new Error(SUBMISSION_ID_CONFLICT_MESSAGE);
          }
          // 同 id 且已被取消（含「取消先到」的 tombstone）：晚到的创建不得启动 prompt。
          if (existing.cancelRequested) {
            existing.info.status = "cancelled";
            throw new Error(SESSION_SUBMISSION_CANCELLED_MESSAGE);
          }
          // 同 id 同内容且已有真实会话：复用已有事务（不重复启动/投递）。
          if (existing.info.sessionId) {
            return { sessionId: existing.info.sessionId, data: null };
          }
        }
        rememberSubmission({
          submissionId,
          status: "pending",
          fingerprint,
        });
      }

      // 临时 key 只用于启动锁，真正 id 由 pi 生成。
      // 必须唯一：毫秒时间戳会在同毫秒的并发新建中碰撞，导致两个请求
      // 合并到同一个 host（cwd/配置混用）。
      const tempKey = `${PLACEHOLDER_SESSION_ID_PREFIX}${randomUUID()}`;
      const { session, realSessionId } = await deps.startRpcSession(
        tempKey,
        "",
        cwd,
        toolNames,
        navigationActions,
      );

      const record = submissionId ? submissions.get(submissionId) : undefined;
      /** 取消是否在启动完成后到达：此时不能再投递，并应中止已启动的运行。 */
      const cancelledAfterStart = record?.cancelRequested === true;
      if (record) {
        record.info.sessionId = realSessionId;
        record.info.status = cancelledAfterStart ? "cancelled" : "starting";
      }

      deps.allowFileRoot(cwd);
      deps.invalidateSessionListCache();

      try {
        if (cancelledAfterStart) {
          // 启动阶段被取消：不发 prompt，直接释放刚创建的 host。
          await service.destroyAsync(realSessionId);
          throw new Error(SESSION_SUBMISSION_CANCELLED_MESSAGE);
        }

        if (provider && modelId) {
          await session.send({ type: "set_model", provider, modelId });
        }
        if (thinkingLevel) {
          await session.send({ type: "set_thinking_level", level: thinkingLevel });
        }
        // 模型/思考档设置后再次校验：取消可能发生在这两步之间。
        if (submissionId && submissions.get(submissionId)?.cancelRequested) {
          await service.destroyAsync(realSessionId);
          throw new Error(SESSION_SUBMISSION_CANCELLED_MESSAGE);
        }
      } catch (error) {
        if (record) record.info.error = error instanceof Error ? error.message : String(error);
        throw error;
      }

      if (promptCommand.type === "ensure_session") {
        // 落盘 header：新会话占位期文件即存在，之后任何 wake/ensureLive/prompt
        // 都走磁盘路径（host 空闲 dispose 后也能重开），不再因「无文件」404
        // 导致首次发送被拒、刷新后会话消失。
        try {
          const inner = (session as {
              inner?: { sessionManager?: { getSessionFile?: () => string | null; sessionId?: string } };
            }).inner;
          const manager = inner?.sessionManager;
          if (manager && typeof manager.getSessionFile === "function") {
            materializeSessionFile(manager as never);
          }
        } catch (error) {
          console.error("[pidance] materialize ensure_session failed:", error);
        }
        return { sessionId: realSessionId, data: null };
      }

      const data = await session.send(promptCommand as SessionCommand);
      if (record) {
        record.info.status = "accepted";
        record.info.sessionId = realSessionId;
      }
      return { sessionId: realSessionId, data };
    },

    getSubmission(submissionId) {
      const record = submissions.get(submissionId);
      return record ? { ...record.info } : null;
    },

    cancelSubmission(submissionId) {
      const record = submissions.get(submissionId);
      if (!record) {
        // 未知提交：登记有界 tombstone，使晚到的同 id 创建不得启动 prompt。
        // 返回 pending 而不冒充 confirmed：我们确实没有停止任何东西。
        rememberSubmission({ submissionId, status: "cancelled" });
        submissions.get(submissionId)!.cancelRequested = true;
        return Promise.resolve({ submissionId, status: "pending" as const });
      }
      record.cancelRequested = true;
      const sessionId = record.info.sessionId;
      if (!sessionId) {
        // 创建尚未完成：由 createNew 在拿到 host 前后自行中止。
        record.info.status = "cancelled";
        return Promise.resolve({ submissionId, status: "pending" as const });
      }
      if (record.cancelApplied) return Promise.resolve({ submissionId, status: "confirmed" as const });
      record.cancelApplied = true;
      record.info.status = "cancelled";
      // 只 abort 该提交所属的**原运行**：不自动 wake/新建 host（取消不应有副作用），
      // 也不影响同会话后来的新一轮。
      const live = deps.getRpcSession(sessionId);
      if (!live?.isAlive()) return Promise.resolve({ submissionId, status: "confirmed" as const });
      return (async (): Promise<CancelResult> => {
        try {
          await live.send({ type: "abort" });
        } catch (error) {
          console.error("[pidance] cancel submission abort failed:", error);
        }
        return { submissionId, status: "confirmed" };
      })();
    },

    getRunningIds() {
      return deps.getRunningRpcSessionIds();
    },

    getRunningStartedAt() {
      // 仅本轮正在执行的会话：running-state（发送时间）优先，starting 补齐。
      const runningIds = new Set(deps.getRunningRpcSessionIds());
      const merged: Record<string, number> = {};
      for (const [id, startedAt] of readRunningStartedAt()) {
        if (runningIds.has(id)) merged[id] = startedAt;
      }
      for (const [id, startedAt] of Object.entries(getRunningStartedAtTable())) {
        if (runningIds.has(id) && !(id in merged)) merged[id] = startedAt;
      }
      return merged;
    },

    async searchFulltext(query, options = {}) {
      const result = await searchSessionsFulltext(query, {
        limits: options.maxHits !== undefined ? { maxHits: options.maxHits } : undefined,
      });
      const scope = options.scope ?? "active";
      if (scope === "all") return result;
      // 这里只用目录做归档范围过滤：agent 活动会不停作废列表缓存，
      // 而同步重建要重读每个 fork/subagent 会话（数百 ms），输入会卡。
      const allSessions = await deps.listAllSessions({ allowStale: true });
      const records = listArchiveRecords(
        deps.archiveFs ?? realArchiveFs,
        deps.archiveAgentDir?.() ?? getAgentDir(),
      );
      const kept = filterSessionIdsByArchiveScope(result.sessionIds, allSessions, records, scope);
      return {
        ...result,
        sessionIds: result.sessionIds.filter((id) => kept.has(id)),
        hits: result.hits.filter((hit) => kept.has(hit.sessionId)),
      };
    },

    listPendingExtensionUi() {
      return deps.listPendingExtensionUi();
    },

    subscribeRunning(listener) {
      return deps.subscribeRunningSessions(listener);
    },

    async selectLeafExact(sessionId, entryId, handoff) {
      if (typeof entryId !== "string" || entryId.trim() === "") {
        throw new Error("entryId is required");
      }
      const trimmedId = entryId.trim();

      // 磁盘 branch 前：任何仍存活的 live（含外部 RPC）必须先 destroy，保证单写者。
      // 外部 RPC 正常路径会在 send 内 quiesce 后 isAlive=false；此处是直连/竞态防护。
      const liveBefore = deps.getRpcSession(sessionId) as
        | { isAlive?: () => boolean; inner?: { isBashRunning?: boolean } }
        | undefined;
      if (liveBefore?.isAlive?.() && liveBefore.inner?.isBashRunning) {
        throw new Error("Cannot switch branch while a shell command is running");
      }
      // 由发起命令的 Host 提供 writer 交接：它自己不能等自己结束。
      const writeOffline = <T>(action: () => Promise<T>) =>
        withOfflineWriter(sessionId, action, handoff);
      return writeOffline(async () => {
        const filePath = await deps.resolveSessionPath(sessionId);
        if (!filePath) throw new Error("Session not found");
        const sessionManager = deps.openSessionView(filePath);
        const oldLeafId = sessionManager.getLeafId();
        // 目标 = 当前 leaf：无导航语义，不写 sidecar（避免固化无变化值）
        if (trimmedId === oldLeafId) return { cancelled: false };
        // 目标 = 文件末尾（外部 pi 默认 leaf）：清除过期 sidecar。
        // 只跳过写入会残留旧分支指针，下次磁盘 open 恢复旧 leaf，
        // 导航到最新分支的意图丢失（UI 弹回旧分支）。
        if (trimmedId === sessionManager.getLastEntryId()) {
          clearLeafSidecar(filePath);
          return { cancelled: false };
        }
        if (!sessionManager.getEntry(trimmedId)) throw new Error(`Entry ${trimmedId} not found`);
        try {
          sessionManager.branch(trimmedId);
          // Pi branch 仅改内存 leaf；非末尾须写 sidecar 供重启恢复
          writeLeafSidecar(filePath, trimmedId);
          return { cancelled: false };
        } finally {
          deps.invalidateSessionListCache();
        }
      });
    },

    async branchFromAssistant(sessionId, assistantEntryId, handoff) {
      if (typeof assistantEntryId !== "string" || assistantEntryId.trim() === "") {
        throw new Error("assistantEntryId is required");
      }
      const trimmedId = assistantEntryId.trim();

      // 磁盘 branch 前：存活 live 先 destroy（与 selectLeafExact 同一单写者护栏）
      const liveBefore = deps.getRpcSession(sessionId) as
        | { isAlive?: () => boolean; inner?: { isBashRunning?: boolean } }
        | undefined;
      if (liveBefore?.isAlive?.() && liveBefore.inner?.isBashRunning) {
        throw new Error("Cannot branch while a shell command is running");
      }
      // 由发起命令的 Host 提供 writer 交接：它自己不能等自己结束。
      const writeOffline = <T>(action: () => Promise<T>) =>
        withOfflineWriter(sessionId, action, handoff);
      return writeOffline(async () => {
        const filePath = await deps.resolveSessionPath(sessionId);
        if (!filePath) throw new Error("Session not found");
        const sessionManager = deps.openSessionView(filePath);
        const leafId = sessionManager.getLeafId();
        if (!leafId) throw new Error("Session has no leaf");
        const path = sessionManager.getBranch(leafId);
        const targetEntry = sessionManager.getEntry(trimmedId);
        if (!targetEntry) throw new Error("Entry not found");
        if (
          targetEntry.type !== "message" ||
          (targetEntry as { message?: { role?: string } }).message?.role !== "assistant"
        ) {
          throw new Error("Only assistant messages can be branched from");
        }
        const turnEnd = computeTurnEnd(path as never, trimmedId);
        try {
          sessionManager.branch(turnEnd);
          if (turnEnd === sessionManager.getLastEntryId()) {
            clearLeafSidecar(filePath);
          } else {
            writeLeafSidecar(filePath, turnEnd);
          }
          return { cancelled: false };
        } finally {
          deps.invalidateSessionListCache();
        }
      });
    },

    async createSessionFromLeaf(sessionId, entryId, handoff) {
      if (typeof entryId !== "string" || entryId.trim() === "") {
        throw new Error("entryId is required");
      }
      const trimmedId = entryId.trim();
      const wrapper = deps.getRpcSession(sessionId) as
        | {
            inner?: {
              sessionManager: {
                getLeafId: () => string | null;
                getBranch: (id: string) => Array<{ id: string; type?: string; message?: { role?: string } }>;
                getEntry: (id: string) => { type?: string; message?: { role?: string } } | undefined;
                getSessionDir: () => string;
              };
              sessionFile?: string;
              model?: { provider: string; id: string } | null;
            };
            sessionFile?: string;
          }
        | undefined;
      const inner = wrapper?.inner;

      // 由发起命令的 Host 提供 writer 交接：它自己不能等自己结束。
      const writeOffline = <T>(action: () => Promise<T>) =>
        withOfflineWriter(sessionId, action, handoff);
      return writeOffline(async () => {
        // 统一磁盘 Pi SessionManager；lease 覆盖整个 fork 读/写窗口。
        const filePath =
          (inner?.sessionFile || wrapper?.sessionFile) ??
          (await deps.resolveSessionPath(sessionId));
      if (!filePath) throw new Error("Session not found");
      const currentSessionFile = filePath;
      const sessionManager = openSessionView(currentSessionFile);
      const entry = sessionManager.getEntry(trimmedId);
      if (!entry) throw new Error("Invalid entry ID");

      // assistant 锚点：与 branch_from_assistant 对称，先 resolve 到 turnEnd
      let branchLeafId = trimmedId;
      if (
        entry.type === "message" &&
        (entry as { message?: { role?: string } }).message?.role === "assistant"
      ) {
        const leafId = sessionManager.getLeafId();
        if (!leafId) throw new Error("Session has no leaf");
        const path = sessionManager.getBranch(leafId);
        branchLeafId = computeTurnEnd(path as never, trimmedId);
      }

      const sessionDir = sessionManager.getSessionDir();
      const sourceManager = openSessionManager(currentSessionFile, sessionDir);
      const newSessionFile = sourceManager.createBranchedSession(branchLeafId);
      if (!newSessionFile) throw new Error("Failed to create session");
      // createBranchedSession 可能尚未落盘（无 assistant 时）；强制写出
      materializeSessionFile(sourceManager);
      const newManager = openSessionView(newSessionFile, sessionDir);
      const newSessionId = newManager.getSessionId();
      cacheSessionPath(newSessionId, newSessionFile);
      deps.invalidateSessionListCache();
      const sourceModel = inner?.model;
      if (sourceModel && shouldInheritModel(
        newManager.getEntries().some((e) => (e as { type?: string }).type === "model_change"),
        { provider: sourceModel.provider, modelId: sourceModel.id },
      )) {
        newManager.appendModelChange(sourceModel.provider, sourceModel.id);
      }
        return { cancelled: false, newSessionId };
      });
    },
  };

  // P1-4 环消除：三个分支导航动作的落地实现绑定到本 service 实例，随
  // startRpcSession 注入 wrapper（rpc-manager 不再 import 本模块）。
  // 动作在 wrapper.send 时执行，彼时 service 已完整初始化，无 TDZ 风险。
  const navigationActions: NavigationActions = {
    selectLeafExact: (sessionId, entryId, handoff) =>
      service.selectLeafExact(sessionId, entryId, handoff),
    branchFromAssistant: (sessionId, assistantEntryId, handoff) =>
      service.branchFromAssistant(sessionId, assistantEntryId, handoff),
    createSessionFromLeaf: (sessionId, entryId, handoff) =>
      service.createSessionFromLeaf(sessionId, entryId, handoff),
  };

  return service;
}

export const sessionService = createSessionService();
