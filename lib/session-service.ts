import { existsSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { allowFileRoot } from "./file-access";
import { getAgentDir } from "./pi-paths";
import {
  openSessionView,
  openSessionManager,
  materializeSessionFile,
} from "./pi-session-io";
import { clearLeafSidecar, writeLeafSidecar } from "./session-leaf-sidecar";
import {
  getRpcSession,
  getRunningRpcSessionIds,
  listPendingExtensionUi,
  startRpcSession,
  subscribeRunningSessions,
  type LiveAgentSession,
  type NavigationActions,
  type PendingExtensionUi,
} from "./rpc-manager";
import {
  cacheSessionPath,
  invalidateSessionListCache,
  invalidateSessionPathCache,
  listAllSessions,
  readSessionHeader,
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
import { updatePidancePref } from "./pidance-prefs-file";
import { collectSubagentTree, deleteValidatedSubagents } from "./subagent-sessions";
import {
  archivedSessionIdsFor,
  createArchiveActions,
  listArchiveRecords,
  partitionSessionsByArchiveState,
  removeArchiveRecordAfterPermanentDelete,
  type ArchiveActionResult,
  type SessionArchiveFs,
  realArchiveFs,
} from "./session-archive";

export type SessionCommand = Record<string, unknown> & { type: string };

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
  return 500;
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

export type SessionServiceDeps = {
  listAllSessions: () => Promise<SessionInfo[]>;
  resolveSessionPath: (sessionId: string) => Promise<string | null>;
  getRpcSession: (sessionId: string) => LiveAgentSession | undefined;
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
  startRpcSession,
  getRunningRpcSessionIds,
  listPendingExtensionUi,
  subscribeRunningSessions,
  allowFileRoot,
  invalidateSessionListCache,
  openSessionCwd: (filePath) => openSessionView(filePath).getHeader()?.cwd ?? process.cwd(),
  // 磁盘 open 经 resolveSessionManagerForRead / openSessionView
  openSessionManager: (filePath) => resolveSessionManagerForRead({ filePath }),
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
  getRunningIds(): string[];
  listPendingExtensionUi(): PendingExtensionUi[];
  subscribeRunning(listener: (ids: string[]) => void): () => void;
  isReadOnly(sessionId: string): Promise<boolean>;
  /** 外进程占写锁：本进程可只读浏览，不得 ensureLive。本进程已 live 则 false。 */
  /** 精确 leaf 切换（user 叶也停在该 entry，不触发 Pi 的 user 编辑语义） */
  selectLeafExact(sessionId: string, entryId: string): Promise<{ cancelled: boolean }>;
  /** assistant 轮末分支：computeTurnEnd 后 navigateTree */
  branchFromAssistant(sessionId: string, assistantEntryId: string): Promise<{ cancelled: boolean }>;
  /** through-entry 线性新会话（assistant 锚点先 resolve 到 turnEnd） */
  createSessionFromLeaf(sessionId: string, entryId: string): Promise<{ cancelled: boolean; newSessionId: string }>;
};

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
      const live = service.getLive(sessionId);
      if (live) return live;

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

    async deleteSession(sessionId) {
      await requireWritableSession(sessionId, service.isReadOnly);
      const filePath = await deps.resolveSessionPath(sessionId);
      if (!filePath) throw new Error("Session not found");

      // 只读有界 header；删除前收集 subagent 树。
      const parentSessionPath = readSessionHeader(filePath)?.parentSession;
      const verifiedChildren = readSessionHeader(filePath)?.id === sessionId
        ? collectSubagentTree(filePath, sessionId)
        : [];

      // 1. running 先 abort（不 flush）；abort 失败只记录并继续删除。
      const live = deps.getRpcSession(sessionId);
      if (live?.isAlive?.() && deps.getRunningRpcSessionIds().includes(sessionId)) {
        try {
          await live.send({ type: "abort" });
        } catch (error) {
          console.error("[pidance] abort before delete failed:", error);
        }
      }

      // 2. 等待 abort 完成后 await destroy。
      await service.destroyAsync(sessionId);

      // 3. 子会话重挂到本会话的 parent（cascade re-parent）。
      const dir = filePath.replace(/\\/g, "/").split("/").slice(0, -1).join("/");
      try {
        const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl") && join(dir, f) !== filePath);
        for (const file of files) {
          const childPath = join(dir, file);
          try {
            const content = readFileSync(childPath, "utf8");
            const lines = content.split("\n");
            const header = JSON.parse(lines[0]) as { type?: string; parentSession?: string };
            if (header.type === "session" && header.parentSession === filePath) {
              header.parentSession = parentSessionPath;
              lines[0] = JSON.stringify(header);
              writeFileSync(childPath, lines.join("\n"));
            }
          } catch {
            /* skip malformed */
          }
        }
      } catch {
        /* skip if dir unreadable */
      }

      // 4. 删除会话文件与 sidecar；unlink 失败不清队列 prefs。
      unlinkSync(filePath);
      clearLeafSidecar(filePath);
      const parentRoot = resolve(filePath.slice(0, -6));
      const skippedSubagents = deleteValidatedSubagents(
        verifiedChildren,
        parentRoot,
        invalidateSessionPathCache,
      );

      // 5. 删除成功后才清队列/hold。
      try {
        updatePidancePref(`sessionQueue.${sessionId}`, null);
        updatePidancePref(`sessionQueueHold.${sessionId}`, null);
      } catch (error) {
        console.error("[pidance] failed to clear queue prefs after delete:", error);
      }

      invalidateSessionPathCache(sessionId);
      deps.invalidateSessionListCache();
      service.removeArchiveRecordAfterPermanentDelete(sessionId);
      return { skippedSubagents };
    },

    async start(sessionId, sessionFile, cwd, toolNames) {
      await requireWritableSession(sessionId, service.isReadOnly);
      return deps.startRpcSession(sessionId, sessionFile, cwd, toolNames, navigationActions);
    },

    async send(sessionId, command) {
      const session = await service.ensureLive(sessionId);
      return session.send(command);
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
      if (live?.isAlive()) {
        service.destroy(sessionId);
      }
      const filePath = await deps.resolveSessionPath(sessionId);
      if (!filePath) throw new Error("Session not found");
      const activity = normalizeActivityInput(input);
      const manager = openSessionView(filePath);
      const entryId = manager.appendCustomEntry(PIDANCE_ACTIVITY_CUSTOM_TYPE, activity);
      deps.invalidateSessionListCache();
      return { entryId, activity };
    },

    async appendCommandEntry(sessionId, input) {
      // 与 appendActivity 同一单写者模式：readOnly 拒绝、外部 RPC live 先停进程再写盘。
      await requireWritableSession(sessionId, service.isReadOnly);
      const live = service.getLive(sessionId);
      if (live?.isAlive()) {
        service.destroy(sessionId);
      }
      const filePath = await deps.resolveSessionPath(sessionId);
      if (!filePath) throw new Error("Session not found");
      const data = normalizeCommandEntryData(input);
      if (!data.command) throw new Error("command is required");
      const manager = openSessionView(filePath);
      const entryId = manager.appendCustomEntry(PIDANCE_COMMAND_CUSTOM_TYPE, data);
      deps.invalidateSessionListCache();
      return { entryId, data };
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

      // 临时 key 只用于启动锁，真正 id 由 pi 生成。
      const tempKey = `__new__${deps.now()}`;
      const { session, realSessionId } = await deps.startRpcSession(
        tempKey,
        "",
        cwd,
        toolNames,
        navigationActions,
      );

      deps.allowFileRoot(cwd);
      deps.invalidateSessionListCache();

      if (provider && modelId) {
        await session.send({ type: "set_model", provider, modelId });
      }
      if (thinkingLevel) {
        await session.send({ type: "set_thinking_level", level: thinkingLevel });
      }

      if (promptCommand.type === "ensure_session") {
        return { sessionId: realSessionId, data: null };
      }

      const data = await session.send(promptCommand as SessionCommand);
      return { sessionId: realSessionId, data };
    },

    getRunningIds() {
      return deps.getRunningRpcSessionIds();
    },

    listPendingExtensionUi() {
      return deps.listPendingExtensionUi();
    },

    subscribeRunning(listener) {
      return deps.subscribeRunningSessions(listener);
    },

    async selectLeafExact(sessionId, entryId) {
      if (typeof entryId !== "string" || entryId.trim() === "") {
        throw new Error("entryId is required");
      }
      const trimmedId = entryId.trim();

      // 磁盘 branch 前：任何仍存活的 live（含外部 RPC）必须先 destroy，保证单写者。
      // 外部 RPC 正常路径会在 send 内 quiesce 后 isAlive=false；此处是直连/竞态防护。
      const liveBefore = deps.getRpcSession(sessionId) as
        | { isAlive?: () => boolean; inner?: { isBashRunning?: boolean } }
        | undefined;
      if (liveBefore?.isAlive?.()) {
        if (liveBefore.inner?.isBashRunning) {
          throw new Error("Cannot switch branch while a shell command is running");
        }
        service.destroy(sessionId);
      }

      const filePath = await deps.resolveSessionPath(sessionId);
      if (!filePath) throw new Error("Session not found");
      const sessionManager = openSessionView(filePath);
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
    },

    async branchFromAssistant(sessionId, assistantEntryId) {
      if (typeof assistantEntryId !== "string" || assistantEntryId.trim() === "") {
        throw new Error("assistantEntryId is required");
      }
      const trimmedId = assistantEntryId.trim();

      // 磁盘 branch 前：存活 live 先 destroy（与 selectLeafExact 同一单写者护栏）
      const liveBefore = deps.getRpcSession(sessionId) as
        | { isAlive?: () => boolean; inner?: { isBashRunning?: boolean } }
        | undefined;
      if (liveBefore?.isAlive?.()) {
        if (liveBefore.inner?.isBashRunning) {
          throw new Error("Cannot branch while a shell command is running");
        }
        service.destroy(sessionId);
      }

      const filePath = await deps.resolveSessionPath(sessionId);
      if (!filePath) throw new Error("Session not found");
      const sessionManager = openSessionView(filePath);
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
    },

    async createSessionFromLeaf(sessionId, entryId) {
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

      // 统一磁盘 Pi SessionManager
      // 读/分叉源文件前先停 live，避免外部 pi 仍在 append 时读到半写状态
      if (deps.getRpcSession(sessionId)?.isAlive()) {
        service.destroy(sessionId);
      }
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
      deps.getRpcSession(sessionId)?.destroy();
      return { cancelled: false, newSessionId };
    },
  };

  // P1-4 环消除：三个分支导航动作的落地实现绑定到本 service 实例，随
  // startRpcSession 注入 wrapper（rpc-manager 不再 import 本模块）。
  // 动作在 wrapper.send 时执行，彼时 service 已完整初始化，无 TDZ 风险。
  const navigationActions: NavigationActions = {
    selectLeafExact: (sessionId, entryId) => service.selectLeafExact(sessionId, entryId),
    branchFromAssistant: (sessionId, assistantEntryId) =>
      service.branchFromAssistant(sessionId, assistantEntryId),
    createSessionFromLeaf: (sessionId, entryId) =>
      service.createSessionFromLeaf(sessionId, entryId),
  };

  return service;
}

export const sessionService = createSessionService();
