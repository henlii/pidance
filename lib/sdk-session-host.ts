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
  SESSION_LOCKED_MESSAGE,
  releaseUnwantedLockKeys,
  tryAcquireSessionOwnership,
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
import { resolveSessionModel } from "./resolve-session-model";
import {
  applyPassThroughExtendedThinkingInPlace,
  withPassThroughExtendedThinking,
} from "./thinking-levels";
import {
  loadPiTheme,
  renderCustomMessageLines,
  renderToolCallLines,
  renderToolResultLines,
  renderWidgetFactoryLines,
  type Theme,
} from "./tui-render-bridge";

export type SdkAgentEvent = {
  type: string;
  [key: string]: unknown;
};

export type SdkEventListener = (event: SdkAgentEvent) => void;

/** 单个 toolCallId 的渲染上下文状态（跨事件保持：call → update → result）。 */
type ToolRenderStateEntry = {
  /** 渲染器共享状态对象（插件读写 subagentResultAnimationTimer 等）。 */
  state: Record<string, unknown>;
  /** renderCall 槽「上一组件」。 */
  lastCallComponent: unknown;
  /** renderResult 槽「上一组件」。 */
  lastResultComponent: unknown;
  /** tool_execution_update 上次渲染时间戳（节流用）。 */
  lastPartialRenderAt: number | undefined;
};

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

/** 自动命名用：从消息 content 提取首条用户输入（string 或 text 块），折叠空白并截断。 */
const AUTO_NAME_MAX_LENGTH = 60;
function firstUserText(content: unknown): string | undefined {
  let text = "";
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    text = content
      .filter(
        (block): block is { type?: string; text?: string } =>
          typeof block === "object" && block !== null && block.type === "text" && typeof block.text === "string",
      )
      .map((block) => block.text)
      .join("\n");
  }
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return undefined;
  return normalized.length > AUTO_NAME_MAX_LENGTH
    ? `${normalized.slice(0, AUTO_NAME_MAX_LENGTH)}…`
    : normalized;
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
  /** 渲染桥主题（模块级缓存）；加载失败为 null → 跳过渲染。 */
  private readonly renderBridgeTheme: Theme | null = loadPiTheme();
  /** toolCallId → 渲染状态（跨 tool_call → update → result 共享）。 */
  private readonly toolRenderStates = new Map<string, ToolRenderStateEntry>();
  /** tool_execution_update 渲染最短间隔（ms），防高频 partial 阻塞事件循环。 */
  private static readonly PARTIAL_RENDER_MIN_INTERVAL_MS = 100;

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

  /** 当前未完成的 Extension UI 请求（多客户端恢复弹窗）。 */
  listPendingExtensionRequests(): Record<string, unknown>[] {
    return Array.from(this.extensionUi?.pendingSnapshot.values() ?? []);
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

  private ownershipKeys(): string[] {
    const keys: string[] = [];
    for (const key of [this.realSessionId, this.realSessionFile]) {
      if (key && !keys.includes(key)) keys.push(key);
    }
    return keys;
  }

  /** 身份变化时先抢新钥匙再放旧钥匙，始终同时持有 id 与文件路径。 */
  private relockToIdentity(): void {
    const keys = this.ownershipKeys();
    if (keys.length === 0) return;
    const current = this.lock?.keys ?? [];
    if (current.length === keys.length && keys.every((key) => current.includes(key))) return;
    const next = tryAcquireSessionOwnership(keys, this.agentDir, this.lock);
    if (!next) {
      throw new Error(SESSION_LOCKED_MESSAGE);
    }
    releaseUnwantedLockKeys(this.lock, keys);
    this.lock = next;
  }

  private syncIdentityFromSession(): void {
    const session = this.session;
    const id = session.sessionId || this.realSessionId;
    const file = session.sessionFile || this.realSessionFile;
    const oldId = this.realSessionId;
    this.realSessionId = id;
    this.realSessionFile = file;
    if (file) this.options.cacheSessionPath?.(id, file);
    this.relockToIdentity();
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
    this.notifyRunning();
  }

  /**
   * 自动命名：会话尚无名字（session_info）时，用第一条用户输入作为会话名。
   * 思维锚（flash-anchor 等 custom 预热条目）不进入 buildSessionContext 的
   * messages（role 非 user），天然被跳过，不会被当成用户输入。
   * 仅在 agent_end 时对无名会话执行一次；命名失败不阻断运行。
   */
  private maybeAutoNameSession(): void {
    try {
      const manager = this.session?.sessionManager;
      if (!manager) return;
      if (manager.getSessionName()) return;
      const context = manager.buildSessionContext() as {
        messages?: Array<{ role?: string; content?: unknown }>;
      };
      const firstUser = (context.messages ?? []).find((message) => message.role === "user");
      const text = firstUserText(firstUser?.content);
      if (text) manager.appendSessionInfo(text);
    } catch {
      /* 自动命名失败不阻断 */
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
        this.maybeAutoNameSession();
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
      case "message_end": {
        // user 消息确认：SDK 在订阅者回调返回后才执行 sessionManager.appendMessage，
        // 延后一帧再 materialize，确保 header+user 一同落盘（避免列表只见空会话/消失）。
        const msg = (event as { message?: { role?: string } }).message;
        if (msg?.role === "user") {
          setImmediate(() => {
            try {
              materializeSessionFile(this.session.sessionManager);
              this.syncIdentityFromSession();
              this.options.onSessionListInvalidate?.();
            } catch (err) {
              console.error("[pidance] materialize after user message failed:", err);
            }
          });
        }
        break;
      }
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
    this.emit(this.withRenderedToolLines(event));
  }

  /**
   * 渲染桥（SDK 切换后接回）：headless 调用插件工具 renderCall/renderResult 与
   * 自定义消息渲染器，产出 ANSI 行附加到事件；任何异常/缺失一律回退原事件，
   * 绝不阻断事件流。
   */
  private withRenderedToolLines(event: SdkAgentEvent): SdkAgentEvent {
    try {
      if (!this.renderBridgeTheme) return event;
      switch (event.type) {
        case "tool_execution_update": {
          // 高频 partial：按 toolCallId 节流，防事件循环阻塞。
          if (!this.shouldRenderPartialUpdate(event.toolCallId)) return event;
          const def = this.getToolRenderDefinition(event.toolName);
          if (!def) return event;
          const context = this.buildToolRenderContext(
            event.toolCallId,
            event.args ?? event.input,
            { isPartial: true, expanded: true, isError: event.isError === true, resultSlot: true },
          );
          if (!context) return event;
          const lines = renderToolResultLines(
            def,
            event.partialResult,
            { expanded: true, isPartial: true },
            context,
            (component) => this.updateToolRenderLastComponent(event.toolCallId, true, component),
          );
          return lines ? { ...event, renderedLines: lines } : event;
        }
        case "tool_call": {
          const def = this.getToolRenderDefinition(event.toolName);
          if (!def) return event;
          const context = this.buildToolRenderContext(
            event.toolCallId,
            event.input,
            { isPartial: false, expanded: true, isError: false, resultSlot: false },
          );
          if (!context) return event;
          const lines = renderToolCallLines(
            def,
            event.input,
            context,
            (component) => this.updateToolRenderLastComponent(event.toolCallId, false, component),
          );
          return lines ? { ...event, renderedCallLines: lines } : event;
        }
        case "tool_result": {
          const def = this.getToolRenderDefinition(event.toolName);
          if (!def) return event;
          const context = this.buildToolRenderContext(
            event.toolCallId,
            event.args ?? event.input,
            { isPartial: false, expanded: true, isError: event.isError === true, resultSlot: true },
          );
          if (!context) return event;
          // 结果对象补 isError（AgentToolResult 契约）。
          const lines = renderToolResultLines(
            def,
            {
              content: event.content,
              details: event.details,
              isError: event.isError === true,
              ...(event.usage !== undefined ? { usage: event.usage } : {}),
            },
            { expanded: true, isPartial: false },
            context,
            (component) => this.updateToolRenderLastComponent(event.toolCallId, true, component),
          );
          return lines ? { ...event, renderedResultLines: lines } : event;
        }
        case "message_start":
        case "message_end": {
          // 自定义消息渲染器（如 pi-subagents 的 subagent-notify）：role=custom 且
          // 带 customType 时取注册的 MessageRenderer headless 渲染；失败回退原文。
          const msg = event.message as { role?: string; customType?: string } | undefined;
          if (msg?.role !== "custom" || typeof msg.customType !== "string" || msg.customType === "") {
            return event;
          }
          const runner = this.session.extensionRunner as
            | { getMessageRenderer?: (customType: string) => unknown }
            | undefined;
          const renderer =
            typeof runner?.getMessageRenderer === "function"
              ? runner.getMessageRenderer(msg.customType)
              : undefined;
          const lines = renderCustomMessageLines(renderer, event.message, this.renderBridgeTheme);
          return lines ? { ...event, renderedLines: lines } : event;
        }
        default:
          return event;
      }
    } catch {
      // 渲染桥绝不允许阻断事件流：任何异常回退原事件。
      return event;
    }
  }

  /** 取原始 ToolDefinition（绕过 wrapToolDefinition 的渲染器剥离）。 */
  private getToolRenderDefinition(toolName: unknown): unknown {
    if (typeof toolName !== "string" || toolName === "") return undefined;
    try {
      return this.session.getToolDefinition(toolName);
    } catch {
      return undefined;
    }
  }

  /**
   * 构造 ToolRenderContext 兼容对象（对齐 pi tool-renderer）：state/lastComponent
   * 取自 toolCallId 的稳定入口，跨事件共享；invalidate no-op（web 端无需重渲染）。
   */
  private buildToolRenderContext(
    toolCallId: unknown,
    args: unknown,
    opts: { isPartial: boolean; expanded: boolean; isError: boolean; resultSlot: boolean },
  ): Record<string, unknown> | null {
    const entry = this.getOrCreateToolRenderState(toolCallId);
    if (!entry) return null;
    return {
      args,
      toolCallId,
      invalidate: () => {},
      lastComponent: opts.resultSlot ? entry.lastResultComponent : entry.lastCallComponent,
      state: entry.state,
      cwd: this.realCwd,
      executionStarted: true,
      argsComplete: true,
      isPartial: opts.isPartial,
      expanded: opts.expanded,
      showImages: false,
      isError: opts.isError,
    };
  }

  /** 取（或懒创建）toolCallId 的渲染状态入口；非法 toolCallId → null。 */
  private getOrCreateToolRenderState(toolCallId: unknown): ToolRenderStateEntry | null {
    if (typeof toolCallId !== "string" || toolCallId === "") return null;
    let entry = this.toolRenderStates.get(toolCallId);
    if (!entry) {
      entry = {
        state: {},
        lastCallComponent: undefined,
        lastResultComponent: undefined,
        lastPartialRenderAt: undefined,
      };
      this.toolRenderStates.set(toolCallId, entry);
    }
    return entry;
  }

  /** 渲染后记录「上一组件」：resultSlot=true → renderResult 槽，否则 renderCall 槽。 */
  private updateToolRenderLastComponent(toolCallId: unknown, resultSlot: boolean, component: unknown): void {
    if (typeof toolCallId !== "string" || toolCallId === "") return;
    const entry = this.toolRenderStates.get(toolCallId);
    if (!entry) return;
    if (resultSlot) entry.lastResultComponent = component;
    else entry.lastCallComponent = component;
  }

  /** tool_execution_update 节流：同一 toolCallId 最短间隔内跳过渲染。 */
  private shouldRenderPartialUpdate(toolCallId: unknown): boolean {
    if (typeof toolCallId !== "string" || toolCallId === "") return true;
    const now = Date.now();
    const entry = this.getOrCreateToolRenderState(toolCallId);
    if (!entry) return true;
    if (
      entry.lastPartialRenderAt !== undefined
      && now - entry.lastPartialRenderAt < SdkSessionHost.PARTIAL_RENDER_MIN_INTERVAL_MS
    ) {
      return false;
    }
    entry.lastPartialRenderAt = now;
    return true;
  }

  /** 会话真实项目 cwd（header.cwd 是项目目录）。 */
  private get realCwd(): string {
    try {
      return this.session.sessionManager.getHeader()?.cwd || this.options.cwd;
    } catch {
      return this.options.cwd;
    }
  }

  async start(): Promise<void> {
    const initialKeys = this.ownershipKeys();
    this.lock = tryAcquireSessionOwnership(initialKeys, this.agentDir);
    if (!this.lock) {
      throw new Error(SESSION_LOCKED_MESSAGE);
    }

    try {
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
        // 省略的 xhigh/max 补恒等，让 settings 默认 xhigh 在建 session 时不被 Pi 钳成 high
        for (const m of services.modelRuntime.getModels()) {
          applyPassThroughExtendedThinkingInPlace(m);
        }
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
      this.resetIdleTimer();
    } catch (error) {
      await this.destroyAsync();
      throw error;
    }
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
        ([key, content]) => {
          // 热 state 投影与 SSE setWidget 事件对齐（{key, lines, placement}）；
          // adapter 内部 Map value 为 {lines, placement}，含未知类型，逐字段窄化。
          const widget = content as { lines?: unknown; placement?: string } | null;
          return {
            key,
            lines: Array.isArray(widget?.lines) ? (widget.lines as string[]) : [],
            placement: widget?.placement === "belowEditor" ? "belowEditor" : "aboveEditor",
          };
        },
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
                  // 注意：此时 user 消息尚未 append 到 sessionManager（SDK 在预检后
                  // 才把消息交给 agent 事件流），materialize 只会写出 header-only；
                  // 真正的落盘在 message_end(user) 处理后的 setImmediate 中完成。
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
        // 先查静态目录，避免 getAvailable() 全量刷新偶发失败（旧会话更常见）
        let model = resolveSessionModel(session.modelRuntime, provider, modelId);
        if (!model) {
          try {
            const available = await session.modelRuntime.getAvailable();
            model = available.find((m) => m.provider === provider && m.id === modelId);
          } catch {
            model = undefined;
          }
        }
        if (!model) throw new Error(`Model not found: ${provider}/${modelId}`);
        await session.setModel(withPassThroughExtendedThinking(model));
        this.options.onSessionListInvalidate?.();
        return model;
      }

      case "set_thinking_level": {
        if (session.model) applyPassThroughExtendedThinkingInPlace(session.model);
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
        this.notifyRunning();
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
