/**
 * 同进程 Pi SDK host：拥有 AgentSessionRuntime、事件投影、类型化 send 与 dispose/rebind。
 * 浏览器协议字段与外部 RPC 时代对齐，前端契约不变。
 */
import {
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  SessionManager,
  type AgentSession,
  type AgentSessionRuntime,
  type AgentSessionServices,
} from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "./pi-paths";
import {
  clearRunningStartedAt,
  recordRunningStartedAt,
} from "./running-state";
import {
  normalizeActivityInput,
  parseAppendActivityCommand,
  PIDANCE_ACTIVITY_CUSTOM_TYPE,
} from "./session-activity";
import {
  clearLeafSidecar,
  writeLeafSidecar,
} from "./session-leaf-sidecar";
import {
  tryAcquireSessionLock,
  type SessionLockHandle,
} from "./session-ownership-lock";
import {
  openSessionManager,
  createSessionManager,
  materializeSessionFile,
} from "./pi-session-io";
import {
  createWebExtensionUIAdapter,
  type WebExtensionUIAdapter,
} from "./web-extension-ui";
import type { NavigationActions } from "./live-session-registry";

export type SdkAgentEvent = {
  type: string;
  [key: string]: unknown;
};

export type SdkEventListener = (event: SdkAgentEvent) => void;

export type SdkSessionHostOptions = {
  sessionId: string;
  sessionFile: string;
  cwd: string;
  toolNames?: string[];
  navigationActions?: NavigationActions;
  idleTimeoutMs?: number;
  agentDir?: string;
  onRunningChange?: () => void;
  onSessionListInvalidate?: () => void;
  cacheSessionPath?: (sessionId: string, sessionFile: string) => void;
  /** registry rekey：fork/new 替换 session 后更新 key */
  onSessionRekeyed?: (oldId: string, newId: string, host: SdkSessionHost) => void;
};

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

/** 打开或创建 SessionManager，并在创建 AgentSession 前应用 leaf sidecar。 */
export function openSessionManagerForHost(
  sessionFile: string,
  cwd: string,
): SessionManager {
  if (sessionFile) return openSessionManager(sessionFile);
  return createSessionManager(cwd);
}

export class SdkSessionHost {
  private listeners: SdkEventListener[] = [];
  private runtime: AgentSessionRuntime | null = null;
  private unsubscribe: (() => void) | null = null;
  private extensionUi: WebExtensionUIAdapter | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private onDestroyCallback: (() => void) | null = null;
  private _alive = true;
  private promptRunning = false;
  private bashRunning = false;
  private bashCommand: {
    command: string;
    excludeFromContext: boolean;
    startedAt: number;
  } | null = null;
  private localQueue: { steering: string[]; followUp: string[] } = {
    steering: [],
    followUp: [],
  };
  private hasQueueSnapshot = false;
  private realSessionId: string;
  private realSessionFile: string;
  private readonly idleTimeoutMs: number;
  private readonly agentDir: string;
  private lock: SessionLockHandle | null = null;
  private activeToolNames: string[] | undefined;

  constructor(private readonly options: SdkSessionHostOptions) {
    this.realSessionId = options.sessionId;
    this.realSessionFile = options.sessionFile;
    this.idleTimeoutMs = options.idleTimeoutMs ?? 10 * 60 * 1000;
    this.agentDir = options.agentDir ?? getAgentDir();
    this.activeToolNames = options.toolNames;
  }

  get sessionId(): string {
    return this.realSessionId;
  }

  get sessionFile(): string {
    return this.realSessionFile;
  }

  /** 供 SessionService 识别 in-process 写路径 */
  get inner(): { sessionManager: SessionManager } | undefined {
    const session = this.runtime?.session;
    if (!session) return undefined;
    return { sessionManager: session.sessionManager };
  }

  isAlive(): boolean {
    return this._alive && this.runtime !== null;
  }

  isRunning(): boolean {
    if (!this._alive || !this.runtime) return false;
    const s = this.runtime.session;
    return (
      this.promptRunning ||
      this.bashRunning ||
      s.isStreaming ||
      s.isCompacting
    );
  }

  onDestroy(cb: () => void): void {
    this.onDestroyCallback = cb;
  }

  onEvent(listener: SdkEventListener): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  beginExtensionBinding(): void {
    /* start() 内 bind */
  }

  async waitForExtensionsBound(): Promise<void> {
    /* start 已 await bind */
  }

  private emit(event: SdkAgentEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        console.error("[pidance] sdk host listener error:", err);
      }
    }
  }

  private notifyRunning(): void {
    this.options.onRunningChange?.();
  }

  private resetIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (this.isRunning()) {
        this.resetIdleTimer();
        return;
      }
      void this.destroyAsync();
    }, this.idleTimeoutMs);
  }

  private get session(): AgentSession {
    if (!this.runtime) throw new Error("SDK session is not alive");
    return this.runtime.session;
  }

  private get services(): AgentSessionServices {
    if (!this.runtime) throw new Error("SDK session is not alive");
    return this.runtime.services;
  }

  private syncIdentityFromSession(): void {
    const session = this.session;
    const id = session.sessionId || this.realSessionId;
    const file = session.sessionFile || this.realSessionFile;
    const oldId = this.realSessionId;
    this.realSessionId = id;
    this.realSessionFile = file;
    if (file) this.options.cacheSessionPath?.(id, file);
    if (oldId !== id) {
      this.options.onSessionRekeyed?.(oldId, id, this);
    }
  }

  private async rebindSession(): Promise<void> {
    const session = this.session;
    this.extensionUi?.dispose();
    this.extensionUi = createWebExtensionUIAdapter((event) => {
      this.trackExtensionSideEffects(event);
      this.emit(event as SdkAgentEvent);
    });

    await session.bindExtensions({
      uiContext: this.extensionUi.uiContext,
      mode: "rpc",
      commandContextActions: {
        waitForIdle: () => session.waitForIdle(),
        newSession: async (opts) => {
          const result = await this.runtime!.newSession(opts);
          if (!result.cancelled) await this.rebindSession();
          return result;
        },
        fork: async (entryId, forkOptions) => {
          const result = await this.runtime!.fork(entryId, forkOptions);
          if (!result.cancelled) await this.rebindSession();
          return { cancelled: result.cancelled };
        },
        navigateTree: async (targetId, options) => {
          const result = await session.navigateTree(targetId, {
            summarize: options?.summarize,
            customInstructions: options?.customInstructions,
            replaceInstructions: options?.replaceInstructions,
            label: options?.label,
          });
          return { cancelled: result.cancelled };
        },
        switchSession: async (sessionPath, options) => {
          const result = await this.runtime!.switchSession(sessionPath, options);
          if (!result.cancelled) await this.rebindSession();
          return result;
        },
        reload: async () => {
          await session.reload();
        },
      },
      onError: (err) => {
        this.emit({
          type: "extension_error",
          extensionPath: err.extensionPath,
          event: err.event,
          error: err.error,
        });
      },
    });

    this.unsubscribe?.();
    this.unsubscribe = session.subscribe((event) => {
      this.resetIdleTimer();
      this.handleSessionEvent(event as SdkAgentEvent);
    });
    this.syncIdentityFromSession();
  }

  private trackExtensionSideEffects(event: Record<string, unknown>): void {
    if (event.type !== "extension_ui_request") return;
    const method = asString(event.method);
    if (method === "setStatus") {
      const key = asString(event.statusKey) ?? asString(event.key) ?? "default";
      const text = asString(event.statusText) ?? asString(event.text) ?? "";
      if (text) this.extensionUi?.statuses.set(key, text);
      else this.extensionUi?.statuses.delete(key);
    }
    if (method === "setWidget") {
      const key = asString(event.widgetKey) ?? asString(event.key) ?? "default";
      const lines = event.widgetLines ?? event.content;
      if (lines == null) this.extensionUi?.widgets.delete(key);
      else {
        this.extensionUi?.widgets.set(key, {
          lines,
          placement: event.widgetPlacement,
        });
      }
    }
  }

  private handleSessionEvent(event: SdkAgentEvent): void {
    switch (event.type) {
      case "agent_start":
        this.promptRunning = true;
        recordRunningStartedAt(this.realSessionId, Date.now());
        this.notifyRunning();
        break;
      case "agent_end":
        this.promptRunning = false;
        clearRunningStartedAt(this.realSessionId);
        this.options.onSessionListInvalidate?.();
        if (this.realSessionFile) clearLeafSidecar(this.realSessionFile);
        this.notifyRunning();
        this.emit({ type: "prompt_done" });
        break;
      case "agent_settled":
        this.promptRunning = false;
        this.notifyRunning();
        break;
      case "compaction_start":
      case "auto_compaction_start":
        this.notifyRunning();
        break;
      case "compaction_end":
      case "auto_compaction_end":
        this.notifyRunning();
        break;
      case "queue_update": {
        const steering = Array.isArray(event.steering)
          ? (event.steering as unknown[]).filter((t): t is string => typeof t === "string")
          : [];
        const followUp = Array.isArray(event.followUp)
          ? (event.followUp as unknown[]).filter((t): t is string => typeof t === "string")
          : [];
        this.localQueue = { steering, followUp };
        this.hasQueueSnapshot = true;
        break;
      }
      default:
        break;
    }
    this.emit(event);
  }

  async start(): Promise<void> {
    const lockKey = this.realSessionFile || this.realSessionId || this.options.cwd;
    this.lock = tryAcquireSessionLock(lockKey, this.agentDir);
    if (!this.lock) {
      throw new Error(
        "Session is locked by another Pidance process (writable host ownership)",
      );
    }

    const sessionManager = openSessionManagerForHost(
      this.realSessionFile,
      this.options.cwd,
    );
    const cwd = sessionManager.getCwd() || this.options.cwd;
    const agentDir = this.agentDir;
    const toolNames = this.activeToolNames;

    const createRuntime = async ({
      cwd: runtimeCwd,
      agentDir: runtimeAgentDir,
      sessionManager: sm,
      sessionStartEvent,
    }: {
      cwd: string;
      agentDir: string;
      sessionManager: SessionManager;
      sessionStartEvent?: unknown;
    }) => {
      const services = await createAgentSessionServices({
        cwd: runtimeCwd,
        agentDir: runtimeAgentDir,
      });
      const created = await createAgentSessionFromServices({
        services,
        sessionManager: sm,
        sessionStartEvent: sessionStartEvent as never,
        tools: toolNames && toolNames.length > 0 ? toolNames : undefined,
        noTools: toolNames && toolNames.length === 0 ? "all" : undefined,
      });
      return {
        ...created,
        services,
        diagnostics: services.diagnostics,
      };
    };

    this.runtime = await createAgentSessionRuntime(createRuntime, {
      cwd,
      agentDir,
      sessionManager,
    });
    this.runtime.setRebindSession(async () => {
      await this.rebindSession();
    });
    this.runtime.setBeforeSessionInvalidate(() => {
      this.extensionUi?.dispose();
      this.unsubscribe?.();
      this.unsubscribe = null;
    });

    await this.rebindSession();
    this.syncIdentityFromSession();
    // 新会话：用真实 id 重新拿锁
    if (this.realSessionId && this.realSessionId !== lockKey) {
      this.lock.release();
      this.lock = tryAcquireSessionLock(this.realSessionId, this.agentDir)
        ?? tryAcquireSessionLock(this.realSessionFile || this.realSessionId, this.agentDir);
      if (!this.lock) {
        await this.destroyAsync();
        throw new Error(
          "Session is locked by another Pidance process (writable host ownership)",
        );
      }
    }
    this.resetIdleTimer();
  }

  private projectState(): Record<string, unknown> {
    const session = this.session;
    const model = session.model;
    const projected: Record<string, unknown> = {
      stateSources: {
        rpcGetState: false,
        sdkSession: true,
        sessionStats: true,
        localQueue: this.hasQueueSnapshot,
        localExtensionUi: true,
      },
      sessionId: this.realSessionId,
      sessionFile: this.realSessionFile,
      sessionName: session.sessionName,
      isStreaming: session.isStreaming,
      isCompacting: session.isCompacting,
      isPromptRunning: this.promptRunning,
      isBashRunning: this.bashRunning,
      pendingBash: this.bashCommand,
      autoCompactionEnabled: session.autoCompactionEnabled,
      steeringMode: session.steeringMode,
      followUpMode: session.followUpMode,
      thinkingLevel: session.thinkingLevel,
      // SDK 同进程可直接投影完整 system prompt（RPC 时代协议不含该字段）
      systemPrompt: session.systemPrompt ?? "",
      model: model
        ? { id: model.id, provider: model.provider }
        : undefined,
      messageCount: session.messages.length,
      pendingMessageCount: session.pendingMessageCount,
      extensionStatuses: Array.from(
        this.extensionUi?.statuses.entries() ?? [],
        ([key, text]) => ({ key, text }),
      ),
      extensionWidgets: Array.from(
        this.extensionUi?.widgets.entries() ?? [],
        ([key, content]) => ({ key, content }),
      ),
      pendingExtensionRequests: Array.from(
        this.extensionUi?.pendingSnapshot.values() ?? [],
      ),
    };
    if (this.hasQueueSnapshot) {
      projected.queuedMessages = {
        steering: [...this.localQueue.steering],
        followUp: [...this.localQueue.followUp],
      };
    }
    try {
      const stats = session.getSessionStats() as {
        contextUsage?: {
          percent?: number;
          contextWindow?: number;
          tokens?: number;
        };
      };
      const u = stats?.contextUsage;
      if (u && typeof u.contextWindow === "number" && u.contextWindow > 0) {
        projected.contextUsage = {
          contextWindow: u.contextWindow,
          percent: typeof u.percent === "number" ? u.percent : null,
          tokens: typeof u.tokens === "number" ? u.tokens : null,
        };
      }
    } catch {
      /* stats 可选 */
    }
    return projected;
  }

  appendActivity(input: Record<string, unknown> | unknown): {
    entryId: string;
    activity: unknown;
  } {
    if (!this.runtime) throw new Error("Cannot append activity: session not alive");
    const activity =
      input &&
      typeof input === "object" &&
      "type" in (input as object) &&
      (input as { type?: string }).type === "append_activity"
        ? parseAppendActivityCommand(input as Record<string, unknown>)
        : normalizeActivityInput(input);
    const entryId = this.session.sessionManager.appendCustomEntry(
      PIDANCE_ACTIVITY_CUSTOM_TYPE,
      activity,
    );
    this.options.onSessionListInvalidate?.();
    return { entryId, activity };
  }

  async send(command: Record<string, unknown>): Promise<unknown> {
    this.resetIdleTimer();
    if (!this.runtime) throw new Error("SDK session is not alive");
    const type = command.type as string;
    const session = this.session;

    switch (type) {
      case "prompt": {
        if (this.bashRunning) {
          throw new Error("Cannot send a prompt while a shell command is running");
        }
        this.promptRunning = true;
        recordRunningStartedAt(this.realSessionId, Date.now());
        this.notifyRunning();
        try {
          await new Promise<void>((resolve, reject) => {
            let settled = false;
            void session
              .prompt(String(command.message ?? ""), {
                images: command.images as never,
                streamingBehavior: command.streamingBehavior as never,
                source: "rpc",
                preflightResult: (ok) => {
                  if (!ok) return;
                  settled = true;
                  // 首次用户消息已入内存：落盘 header+entries，侧栏才可见且非「空会话」
                  try {
                    materializeSessionFile(session.sessionManager);
                  } catch (err) {
                    console.error("[pidance] materialize after prompt failed:", err);
                  }
                  this.syncIdentityFromSession();
                  this.options.onSessionListInvalidate?.();
                  resolve();
                },
              })
              .then(() => {
                if (!settled) {
                  settled = true;
                  try {
                    materializeSessionFile(session.sessionManager);
                  } catch (err) {
                    console.error("[pidance] materialize after prompt failed:", err);
                  }
                  this.syncIdentityFromSession();
                  this.options.onSessionListInvalidate?.();
                  resolve();
                }
              })
              .catch((error) => {
                if (!settled) {
                  settled = true;
                  reject(error);
                }
              });
          });
          return null;
        } catch (error) {
          this.promptRunning = false;
          clearRunningStartedAt(this.realSessionId);
          this.notifyRunning();
          const errorMessage = error instanceof Error ? error.message : String(error);
          this.emit({ type: "prompt_error", errorMessage });
          this.emit({ type: "prompt_done" });
          throw error;
        }
      }

      case "abort": {
        this.promptRunning = false;
        this.notifyRunning();
        await session.abort();
        this.notifyRunning();
        return null;
      }

      case "get_state":
        return this.projectState();

      case "set_model": {
        const provider = String(command.provider ?? "");
        const modelId = String(command.modelId ?? "");
        const models = await session.modelRuntime.getAvailable();
        const model = models.find((m) => m.provider === provider && m.id === modelId);
        if (!model) throw new Error(`Model not found: ${provider}/${modelId}`);
        await session.setModel(model);
        this.options.onSessionListInvalidate?.();
        return model;
      }

      case "set_thinking_level": {
        session.setThinkingLevel(command.level as never);
        this.options.onSessionListInvalidate?.();
        return null;
      }

      case "compact": {
        const result = await session.compact(
          typeof command.customInstructions === "string"
            ? command.customInstructions
            : undefined,
        );
        this.options.onSessionListInvalidate?.();
        return result;
      }

      case "steer": {
        await session.steer(String(command.message ?? ""), command.images as never);
        return null;
      }

      case "follow_up": {
        await session.followUp(String(command.message ?? ""), command.images as never);
        return null;
      }

      case "set_session_name": {
        const name = String(command.name ?? "").trim();
        if (!name) throw new Error("Session name cannot be empty");
        session.setSessionName(name);
        this.options.onSessionListInvalidate?.();
        return null;
      }

      case "set_auto_compaction": {
        session.setAutoCompactionEnabled(Boolean(command.enabled));
        return null;
      }

      case "set_auto_retry": {
        session.setAutoRetryEnabled(Boolean(command.enabled));
        return null;
      }

      case "clear_queue": {
        return session.clearQueue();
      }

      case "get_tools": {
        const tools = session.getAllTools();
        const active = new Set(session.getActiveToolNames());
        return {
          source: "sdk",
          tools: tools.map((t) => ({
            name: t.name,
            description: t.description ?? "",
            active: active.has(t.name),
          })),
        };
      }

      case "set_tools": {
        const names = Array.isArray(command.tools)
          ? (command.tools as unknown[]).filter((n): n is string => typeof n === "string")
          : [];
        session.setActiveToolsByName(names);
        this.activeToolNames = names;
        return null;
      }

      case "get_commands": {
        const commands: Array<Record<string, unknown>> = [];
        for (const cmd of session.extensionRunner.getRegisteredCommands()) {
          commands.push({
            name: cmd.invocationName,
            description: cmd.description,
            source: "extension",
            sourceInfo: cmd.sourceInfo,
          });
        }
        for (const template of session.promptTemplates) {
          commands.push({
            name: template.name,
            description: template.description,
            source: "prompt_template",
          });
        }
        return { commands };
      }

      case "get_session_stats":
        return session.getSessionStats();

      case "bash": {
        if (session.isStreaming) {
          throw new Error("Cannot run bash while agent is streaming");
        }
        this.bashRunning = true;
        this.bashCommand = {
          command: String(command.command ?? ""),
          excludeFromContext: Boolean(command.excludeFromContext),
          startedAt: Date.now(),
        };
        this.notifyRunning();
        try {
          const result = await session.executeBash(
            String(command.command ?? ""),
            undefined,
            { excludeFromContext: Boolean(command.excludeFromContext) },
          );
          return result;
        } finally {
          this.bashRunning = false;
          this.bashCommand = null;
          this.notifyRunning();
        }
      }

      case "abort_bash": {
        session.abortBash();
        this.bashRunning = false;
        this.bashCommand = null;
        this.notifyRunning();
        return null;
      }

      case "abort_compaction": {
        session.abortCompaction();
        return null;
      }

      case "extension_ui_response": {
        const id = asString(command.id);
        if (!id) throw new Error("extension_ui_response requires id");
        const response = { ...command };
        delete response.type;
        delete response.id;
        if (!this.extensionUi?.respond(id, response)) {
          // 未知/过期 id：忽略，不抛
        }
        return null;
      }

      case "extension_ui_input": {
        // 0.83 SDK 无 progressive input；与 RPC 一致降级
        return null;
      }

      case "append_activity":
        return this.appendActivity(command);

      case "fork": {
        if (this.bashRunning) throw new Error("Cannot fork while a shell command is running");
        const entryId = String(command.entryId ?? "");
        if (!entryId) throw new Error("entryId is required");
        const result = await this.runtime.fork(entryId);
        if (!result.cancelled) {
          await this.rebindSession();
          this.syncIdentityFromSession();
          this.options.onSessionListInvalidate?.();
        }
        return {
          cancelled: result.cancelled,
          newSessionId: result.cancelled ? undefined : this.realSessionId,
          text: result.selectedText,
        };
      }

      case "navigate_tree": {
        if (this.bashRunning) {
          throw new Error("Cannot navigate while a shell command is running");
        }
        const targetId = asString(command.targetId);
        if (!targetId) throw new Error("targetId is required");
        const result = await session.navigateTree(targetId, {
          summarize: command.summarize as boolean | undefined,
          customInstructions: asString(command.customInstructions),
        });
        if (!result.cancelled && this.realSessionFile) {
          const last = session.sessionManager.getLeafId();
          // 非末尾：写 sidecar 供重启恢复
          if (last && last !== targetId) {
            // navigateTree 后 leaf 应是 target；若在末尾清 sidecar
          }
          const leaf = session.sessionManager.getLeafId();
          const entries = session.sessionManager.getEntries();
          const lastEntry = entries.at(-1)?.id;
          if (leaf && lastEntry && leaf !== lastEntry) {
            writeLeafSidecar(this.realSessionFile, leaf);
          } else if (this.realSessionFile) {
            clearLeafSidecar(this.realSessionFile);
          }
        }
        this.options.onSessionListInvalidate?.();
        return { cancelled: result.cancelled };
      }

      case "select_leaf_exact": {
        const entryId = asString(command.entryId);
        if (!entryId) throw new Error("entryId is required");
        if (this.options.navigationActions) {
          return this.options.navigationActions.selectLeafExact(this.sessionId, entryId);
        }
        // 无注入时直接 navigate
        const result = await session.navigateTree(entryId, { summarize: false });
        if (!result.cancelled && this.realSessionFile) {
          const leaf = session.sessionManager.getLeafId();
          const lastEntry = session.sessionManager.getEntries().at(-1)?.id;
          if (leaf && lastEntry && leaf !== lastEntry) {
            writeLeafSidecar(this.realSessionFile, leaf);
          } else {
            clearLeafSidecar(this.realSessionFile);
          }
        }
        return { cancelled: result.cancelled };
      }

      case "branch_from_assistant": {
        const assistantEntryId = asString(command.assistantEntryId);
        if (!assistantEntryId) throw new Error("assistantEntryId is required");
        if (this.options.navigationActions) {
          return this.options.navigationActions.branchFromAssistant(
            this.sessionId,
            assistantEntryId,
          );
        }
        throw new Error("branch_from_assistant is unavailable");
      }

      case "create_session_from_leaf": {
        const entryId = asString(command.entryId);
        if (!entryId) throw new Error("entryId is required");
        if (this.options.navigationActions) {
          return this.options.navigationActions.createSessionFromLeaf(
            this.sessionId,
            entryId,
          );
        }
        throw new Error("create_session_from_leaf is unavailable");
      }

      case "set_branch_label": {
        const targetId = asString(command.targetId);
        if (!targetId) throw new Error("targetId is required");
        const label =
          command.label === undefined || command.label === null
            ? undefined
            : String(command.label);
        session.sessionManager.appendLabelChange(targetId, label);
        this.options.onSessionListInvalidate?.();
        return null;
      }

      case "reload": {
        await session.reload();
        await this.rebindSession();
        return null;
      }

      case "get_last_assistant_text":
        return { text: session.getLastAssistantText() };

      case "ensure_session":
        return null;

      default:
        throw new Error(`Unsupported command: ${type}`);
    }
  }

  destroy(): void {
    void this.destroyAsync();
  }

  async destroyAsync(): Promise<void> {
    if (!this._alive && !this.runtime) return;
    this._alive = false;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.extensionUi?.dispose();
    this.extensionUi = null;
    const runtime = this.runtime;
    this.runtime = null;
    if (runtime) {
      try {
        await runtime.dispose();
      } catch (err) {
        console.error("[pidance] sdk runtime dispose error:", err);
      }
    }
    this.lock?.release();
    this.lock = null;
    this.promptRunning = false;
    this.bashRunning = false;
    this.bashCommand = null;
    clearRunningStartedAt(this.realSessionId);
    this.onDestroyCallback?.();
    this.notifyRunning();
  }
}

export async function startSdkSessionHost(
  options: SdkSessionHostOptions,
): Promise<SdkSessionHost> {
  const host = new SdkSessionHost(options);
  await host.start();
  return host;
}
