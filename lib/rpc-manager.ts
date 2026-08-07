import { createAgentSessionFromServices, createAgentSessionServices, getAgentDir, initTheme, SessionManager, SettingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { resolveProjectTrustedForSession } from "./project-trust";
import { KeybindingsManager as TuiKeybindingsManager, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import { randomUUID } from "crypto";
import { existsSync, writeFileSync } from "fs";
import { loadPiTheme, renderCustomMessageLines, renderToolCallLines, renderToolResultLines, renderWidgetFactoryLines } from "./tui-render-bridge";
import { invalidateModelsCache } from "./models-cache";
import { cacheSessionPath, invalidateSessionListCache } from "./session-reader";
import type { SlashCommandInfo } from "@earendil-works/pi-coding-agent";
import type { AgentSessionLike, ExtensionUiContextLike, ToolInfo } from "./pi-types";
import type { ExtensionUiRequest, ExtensionUiResponse, ExtensionWidgetItem } from "./types";
import { createHeadlessCustomUiTui, DEFAULT_CUSTOM_UI_COLUMNS } from "./custom-ui-terminal";
import {
  PIDANCE_ACTIVITY_CUSTOM_TYPE,
  normalizeActivityInput,
  parseAppendActivityCommand,
  type SessionActivity,
  type SessionActivityInput,
} from "./session-activity";
import {
  createNotifyPersistState,
  mapExtensionErrorToActivity,
  mapPromptErrorToActivity,
  persistExtensionNotify,
  tryAppendActivityBestEffort,
  type NotifyPersistState,
} from "./session-activity-events";
import { shouldInheritModel } from "./model-selection";

// ============================================================================
// Types
// ============================================================================

export interface AgentEvent {
  type: string;
  [key: string]: unknown;
}

type EventListener = (event: AgentEvent) => void;

type PendingUiResponse = {
  resolve: (response: ExtensionUiResponse) => void;
  cancel: () => void;
};

type CustomUiComponent = {
  render: (width: number) => string[];
  handleInput?: (data: string) => void;
  dispose?: () => void;
  invalidate?: () => void;
};

type ActiveCustomUi = {
  component: CustomUiComponent;
  width: number;
  resolve: (value: unknown) => void;
  settled: boolean;
};

type ExtensionUiRequestBody = Record<string, unknown> & {
  method: ExtensionUiRequest["method"];
  timeout?: number;
  expiresAt?: number;
};

type ExtensionCommandContextActionsLike = {
  waitForIdle: () => Promise<void>;
  newSession: () => Promise<{ cancelled: boolean }>;
  fork: () => Promise<{ cancelled: boolean }>;
  navigateTree: (
    targetId: string,
    options?: { summarize?: boolean; customInstructions?: string },
  ) => Promise<{ cancelled: boolean }>;
  switchSession: () => Promise<{ cancelled: boolean }>;
  reload: () => Promise<void>;
};

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

type ExtensionBindingOptions = {
  forceEmptySystemPrompt?: boolean;
};

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

const CODING_TOOL_NAMES = ["read", "bash", "edit", "write", "grep", "find", "ls"];

// Extensions require a complete Theme, while the web UI applies its own styling.
class PlainTextTheme extends Theme {
  constructor() {
    super(
      { thinkingXhigh: "" } as ConstructorParameters<typeof Theme>[0],
      {} as ConstructorParameters<typeof Theme>[1],
      "truecolor",
    );
  }

  override fg(...[, text]: Parameters<Theme["fg"]>): string { return text; }
  override bg(...[, text]: Parameters<Theme["bg"]>): string { return text; }
  override bold(text: string): string { return text; }
  override italic(text: string): string { return text; }
  override underline(text: string): string { return text; }
  override inverse(text: string): string { return text; }
  override strikethrough(text: string): string { return text; }
  override getFgAnsi(): string { return ""; }
  override getBgAnsi(): string { return ""; }
  override getThinkingBorderColor(): (text: string) => string {
    return (text) => text;
  }
  override getBashModeBorderColor(): (text: string) => string { return (text) => text; }
}

const PLAIN_TEXT_THEME = new PlainTextTheme();
const CUSTOM_UI_KEYBINDINGS = new TuiKeybindingsManager(TUI_KEYBINDINGS);

/**
 * 单个 toolCallId 的渲染上下文状态（P0-1，跨事件保持：
 * tool_call → tool_execution_update → tool_result 共享同一入口）。
 * 生命周期：首次渲染懒创建；tool_execution_end / agent_end / destroy 释放。
 */
type ToolRenderStateEntry = {
  /** 渲染器共享状态对象（pi-subagents 读写 subagentResultAnimationTimer 等）。 */
  state: Record<string, unknown>;
  /** renderCall 槽「上一组件」（镜像 pi 的 renderedCallComponents）。 */
  lastCallComponent: unknown;
  /** renderResult 槽「上一组件」（镜像 pi 的 renderedResultComponents）。 */
  lastResultComponent: unknown;
  /** tool_execution_update 上次渲染时间戳（P1-6 节流用）。 */
  lastPartialRenderAt: number | undefined;
};

/** P1-6：tool_execution_update 同一 toolCallId 渲染最短间隔（毫秒）。 */
export const PARTIAL_RENDER_MIN_INTERVAL_MS = 100;

function withExtensionTools(session: AgentSessionLike, toolNames: string[]): string[] {
  if (toolNames.length === 0) return [];

  const codingToolNames = new Set(CODING_TOOL_NAMES);
  const extensionToolNames = session
    .getAllTools()
    .map((t) => t.name)
    .filter((name) => !codingToolNames.has(name));

  return [...new Set([...toolNames, ...extensionToolNames])];
}

// ============================================================================
// AgentSessionWrapper
// Wraps AgentSession with the same interface the rest of the app expects
// ============================================================================

export class AgentSessionWrapper {
  private listeners: EventListener[] = [];
  private pendingUiResponses = new Map<string, PendingUiResponse>();
  private pendingUiRequests = new Map<string, AgentEvent>();
  private activeCustomUis = new Map<string, ActiveCustomUi>();
  private extensionStatuses = new Map<string, string>();
  private extensionWidgets = new Map<string, ExtensionWidgetItem>();
  private promptRunning = false;
  private extensionsBound = false;
  private extensionBindingPromise: Promise<void> | null = null;
  private extensionBindingError: unknown = null;
  private forceEmptySystemPrompt = false;
  private unsubscribe: (() => void) | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private onDestroyCallback: (() => void) | null = null;
  private _alive = true;
  /**
   * TUI 渲染桥主题（wrapper 创建时加载一次，失败 null）。
   * null 时不尝试任何渲染，工具事件保持原样（前端回退纯文本逻辑）。
   */
  private renderBridgeTheme: Theme | null = loadPiTheme();
  /**
   * TUI 渲染桥工具渲染上下文状态（P0-1）：按 toolCallId 保持
   * state/lastComponent 跨事件共享；随 wrapper 生命周期释放（见 destroy）。
   * 放实例字段而非 globalThis：wrapper 有明确 destroy 生命周期，无需跨热重载。
   */
  private toolRenderStates = new Map<string, ToolRenderStateEntry>();
  /**
   * notify 自动持久化去重状态（有界 FIFO）。
   * 生产路径每次 notify 现场 randomUUID，同 id 二次通常不发生；
   * 状态仍保证可测的「同 id 只写一次」与失败不 remember。
   * 不入 globalThis；wrapper 销毁后随实例释放。
   */
  private notifyPersistState: NotifyPersistState = createNotifyPersistState();

  constructor(
    public readonly inner: AgentSessionLike,
    /** 导航动作注入 seam（P1-4 环消除）：缺省时三个导航命令降级抛错。 */
    private readonly navigationActions?: NavigationActions,
  ) {}

  /** 取注入的导航动作；未注入时抛明确错误（降级语义，与缺省状态可观测）。 */
  private navigationActionsOrThrow(commandType: string): NavigationActions {
    if (!this.navigationActions) {
      throw new Error(`${commandType} is unavailable: navigation actions were not injected`);
    }
    return this.navigationActions;
  }

  get sessionId(): string {
    return this.inner.sessionId;
  }

  get sessionFile(): string {
    return this.inner.sessionFile ?? "";
  }

  isAlive(): boolean {
    return this._alive;
  }

  isRunning(): boolean {
    return this._alive && (this.promptRunning || this.inner.isStreaming || this.inner.isCompacting || this.inner.isBashRunning);
  }

  start(): void {
    this.unsubscribe = this.inner.subscribe((event: AgentEvent) => {
      this.resetIdleTimer();
      if (event.type === "agent_end") {
        invalidateSessionListCache();
        // P0-1：运行结束，释放全部工具渲染上下文状态，防泄漏。
        this.toolRenderStates.clear();
      } else if (event.type === "tool_execution_end") {
        // P0-1：单个工具执行结束，释放对应 toolCallId 状态。
        this.releaseToolRenderState(event.toolCallId);
      }
      this.emit(this.withRenderedToolLines(event));
      // Streaming / compaction / tool events flow through here; re-broadcast
      // the running-status snapshot so the sidebar can update live.
      notifyRunningChange();
    });
    this.resetIdleTimer();
    notifyRunningChange();
  }

  /**
   * TUI 渲染桥：对工具相关事件与自定义消息事件在 emit 之前附加渲染行。
   * 浅拷贝事件对象附加字段，不修改原对象；theme 加载失败 / 无渲染器 /
   * 渲染失败时不附加字段，事件保持原样，前端回退现有纯文本逻辑。
   *
   * 防御性红线：渲染桥是附加能力，任何异常（含扩展对象结构异常、渲染器抛错、
   * runner 内部错误）都必须吞掉并返回原事件——pi 的 _emit 对 listener 无
   * try/catch 保护，此处抛错会中断整个事件广播循环，导致 SSE 断流。
   */
  private withRenderedToolLines(event: AgentEvent): AgentEvent {
    try {
      if (!this.renderBridgeTheme) return event;
      switch (event.type) {
        case "tool_execution_update": {
          // P1-6：高频 partial 更新按 toolCallId 节流，防事件循环阻塞。
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
          // P1-3：结果对象补 isError（AgentToolResult 契约，tool-renderer.js:83-89）。
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
          // 自定义消息渲染器桥接（阶段 C）：role=custom 且带 customType 时，取
          // extensionRunner 注册的 MessageRenderer，headless 渲染出 ANSI 行附到
          // 事件上；无渲染器 / 失败 / theme 为 null 时事件原样（前端回退现有
          // CustomMessageView 文本逻辑）。
          const msg = event.message as
            | { role?: string; customType?: string }
            | undefined;
          if (msg?.role !== "custom" || typeof msg.customType !== "string" || msg.customType === "") {
            return event;
          }
          const runner = this.inner.extensionRunner as
            | { getMessageRenderer?: (customType: string) => unknown }
            | undefined;
          const renderer =
            typeof runner?.getMessageRenderer === "function"
              ? runner.getMessageRenderer(msg.customType)
              : undefined;
          const lines = renderCustomMessageLines(
            renderer,
            event.message,
            this.renderBridgeTheme,
          );
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
    const runner = this.inner.extensionRunner as
      | { getToolDefinition?: (name: string) => unknown }
      | undefined;
    return typeof runner?.getToolDefinition === "function"
      ? runner.getToolDefinition(toolName)
      : undefined;
  }

  /**
   * P0-1：构造 ToolRenderContext 兼容对象（对齐 pi tool-renderer.js:41-56 /
   * tool-execution.js:87-104）。state/lastComponent 取自 toolCallId 的稳定入口，
   * 跨事件共享；invalidate no-op（web 端无需重渲染请求）。
   * toolCallId 缺失/非法 → null（上层按无渲染器回退）。
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
      cwd: this.getSessionCwd(),
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

  /** 运行结束（tool_execution_end / agent_end / destroy）时释放对应 toolCallId 状态。 */
  private releaseToolRenderState(toolCallId: unknown): void {
    if (typeof toolCallId === "string" && toolCallId !== "") {
      this.toolRenderStates.delete(toolCallId);
    }
  }

  /**
   * P1-6：tool_execution_update 节流——同一 toolCallId 最短间隔内跳过渲染。
   * 首次 update 也记录时间戳（否则前两次快速更新都逃过节流）。
   */
  private shouldRenderPartialUpdate(toolCallId: unknown): boolean {
    if (typeof toolCallId !== "string" || toolCallId === "") return true;
    const now = Date.now();
    const entry = this.getOrCreateToolRenderState(toolCallId);
    if (!entry) return true;
    if (entry.lastPartialRenderAt !== undefined && now - entry.lastPartialRenderAt < PARTIAL_RENDER_MIN_INTERVAL_MS) {
      return false;
    }
    entry.lastPartialRenderAt = now;
    return true;
  }

  /**
   * P1-2：会话真实项目 cwd——从会话 header 取（header.cwd 是项目目录；
   * sessionFile 的 dirname 只是 ~/.pi/agent/sessions/<encoded>/ 不是项目目录）。
   * 无 header / 缺字段 / 异常 → 回退 process.cwd()。
   */
  private getSessionCwd(): string {
    try {
      const header = this.inner.sessionManager.getHeader?.() as { cwd?: unknown } | null | undefined;
      if (header && typeof header.cwd === "string" && header.cwd.trim() !== "") {
        return header.cwd;
      }
    } catch {
      // 忽略异常，回退 process.cwd()
    }
    return process.cwd();
  }

  setForceEmptySystemPrompt(force: boolean): void {
    this.forceEmptySystemPrompt = force;
    this.applyForcedEmptySystemPrompt();
  }

  beginExtensionBinding(options: ExtensionBindingOptions = {}): void {
    void this.ensureExtensionsBound(options).catch((err) => {
      console.error("[pidance] failed to dispatch session_start to extensions:", err instanceof Error ? err.message : err);
    });
  }

  async waitUntilReady(): Promise<void> {
    await this.waitForExtensionsBound();
  }

  private ensureExtensionsBound(options: ExtensionBindingOptions = {}): Promise<void> {
    if (options.forceEmptySystemPrompt) this.forceEmptySystemPrompt = true;
    if (this.extensionsBound) {
      this.applyForcedEmptySystemPrompt();
      return Promise.resolve();
    }
    if (this.extensionBindingPromise) return this.extensionBindingPromise;

    this.extensionBindingError = null;
    this.extensionBindingPromise = (async () => {
      if (!this._alive) return;
      const uiContext = this.createExtensionUiContext();
      if (typeof this.inner.bindExtensions === "function") {
        const bindExtensions = this.inner.bindExtensions as (bindings: {
          uiContext?: ExtensionUiContextLike;
          mode?: "rpc";
          commandContextActions?: ExtensionCommandContextActionsLike;
          shutdownHandler?: () => void;
          onError?: (error: { extensionPath: string; event: string; error: string }) => void;
        }) => Promise<void>;
        await bindExtensions.call(this.inner, {
          uiContext,
          mode: "rpc",
          commandContextActions: this.createExtensionCommandContextActions(),
          shutdownHandler: () => this.emit({
            type: "extension_ui_request",
            id: randomUUID(),
            method: "notify",
            notifyType: "warning",
            message: "Extension requested shutdown, but shutdown is not supported in Pidance.",
          } as ExtensionUiRequest as AgentEvent),
          onError: (error) => this.emitExtensionError(error),
        });
      } else {
        this.inner.extensionRunner.setUIContext?.(uiContext, "rpc");
      }
      this.extensionsBound = true;
      this.applyForcedEmptySystemPrompt();
      console.log(`[pidance] session_start dispatched to extensions for session ${this.inner.sessionId}`);
    })().catch((err) => {
      this.extensionBindingError = err;
      throw err;
    });

    return this.extensionBindingPromise;
  }

  private async waitForExtensionsBound(): Promise<void> {
    try {
      if (this.extensionBindingPromise) await this.extensionBindingPromise;
    } catch (err) {
      throw err instanceof Error ? err : new Error(String(err));
    }
    if (this.extensionBindingError) {
      throw this.extensionBindingError instanceof Error
        ? this.extensionBindingError
        : new Error(String(this.extensionBindingError));
    }
  }

  private shouldWaitForExtensions(type: string): boolean {
    return type === "prompt" || type === "steer" || type === "follow_up" || type === "get_commands";
  }

  private async withFinalRunningNotification<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } finally {
      notifyRunningChange();
    }
  }

  private applyForcedEmptySystemPrompt(): void {
    if (this.forceEmptySystemPrompt && this.inner.agent.state) {
      this.inner.agent.state.systemPrompt = "";
    }
  }

  private emit(event: AgentEvent): void {
    for (const l of this.listeners) l(event);
  }

  private resetIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (this.isRunning()) {
        this.resetIdleTimer();
        return;
      }
      this.destroy();
    }, 10 * 60 * 1000);
  }

  private persistBashOnlySession(): void {
    const manager = this.inner.sessionManager;
    const sessionFile = manager.getSessionFile();
    if (!sessionFile || existsSync(sessionFile)) return;

    const header = manager.getHeader();
    if (!header) return;

    const content = [header, ...manager.getEntries()]
      .map((entry) => JSON.stringify(entry))
      .join("\n") + "\n";
    writeFileSync(sessionFile, content, { encoding: "utf8", flag: "wx" });

    // Pi normally delays the first flush until an assistant message exists.
    // A leading shell command has no assistant message, so mark this SDK
    // manager as flushed after writing its own generated entries.
    (manager as unknown as { flushed: boolean }).flushed = true;
    cacheSessionPath(this.inner.sessionId, sessionFile);
  }

  onEvent(listener: EventListener): () => void {
    this.listeners.push(listener);
    for (const event of this.pendingUiRequests.values()) listener(event);
    return () => {
      const i = this.listeners.indexOf(listener);
      if (i !== -1) this.listeners.splice(i, 1);
    };
  }

  onDestroy(cb: () => void): void {
    this.onDestroyCallback = cb;
  }

  /**
   * 持久活动写入 owner：固定 customType=pidance.activity，经 SessionManager.appendCustomEntry。
   * 禁止 custom_message（会进入 LLM context）。调用方不可覆盖 customType。
   */
  appendActivity(input: SessionActivityInput | SessionActivity): { entryId: string; activity: SessionActivity } {
    if (!this._alive) {
      throw new Error("Session is not alive");
    }
    const activity = normalizeActivityInput(input);
    const entryId = this.inner.sessionManager.appendCustomEntry(
      PIDANCE_ACTIVITY_CUSTOM_TYPE,
      activity,
    );
    invalidateSessionListCache();
    return { entryId, activity };
  }

  /**
   * Best-effort 自动持久化：失败不抛、不阻断原事件、不 console 敏感内容。
   * 超长/非法由 normalizeActivityInput fail closed；不截断。
   */
  private tryAutoPersistActivity(input: SessionActivityInput | null): void {
    tryAppendActivityBestEffort((mapped) => this.appendActivity(mapped), input);
  }

  /**
   * 统一 extension_error 生产：先 best-effort 持久化，再 emit 原事件（形状/次数不变）。
   * 三个生产点（bindExtensions onError、custom_ui_input、custom_ui）均经此 helper，避免双 emit/双 append。
   */
  private emitExtensionError(error: {
    extensionPath: string;
    event: string;
    error: string;
  }): void {
    this.tryAutoPersistActivity(
      mapExtensionErrorToActivity({
        error: error.error,
        extensionPath: error.extensionPath,
        event: error.event,
      }),
    );
    this.emit({
      type: "extension_error",
      extensionPath: error.extensionPath,
      event: error.event,
      error: error.error,
    });
  }

  async send(command: Record<string, unknown>): Promise<unknown> {
    this.resetIdleTimer();
    const type = command.type as string;
    if (this.shouldWaitForExtensions(type)) await this.waitForExtensionsBound();

    switch (type) {
      case "prompt": {
        if (this.inner.isBashRunning) {
          throw new Error("Cannot send a prompt while a shell command is running");
        }
        // Fire and forget — events come via subscribe
        const promptImages = command.images as Array<{ type: "image"; data: string; mimeType: string }> | undefined;
        const streamingBehavior = command.streamingBehavior as "steer" | "followUp" | undefined;
        this.promptRunning = true;
        notifyRunningChange();
        // P0-1：首条 prompt 提交确认——send 不得只报告「调度成功」。
        // SDK 的 preflightResult 在预检（model/auth/streaming）失败时回调 false
        // 并随后 reject，预检通过（消息即将提交落盘）时回调 true；旧 SDK / 桩
        // 不回调时由 catch 兜底 settle。仅预检通过后 send 才返回，否则抛明确错误。
        let resolveSubmit: ((r: { ok: boolean; error?: string }) => void) | null = null;
        const submit = new Promise<{ ok: boolean; error?: string }>((resolve) => {
          resolveSubmit = resolve;
        });
        const settleSubmit = (r: { ok: boolean; error?: string }) => {
          resolveSubmit?.(r);
          resolveSubmit = null;
        };
        this.inner.prompt(command.message as string, {
          ...(promptImages?.length ? { images: promptImages } : {}),
          ...(streamingBehavior ? { streamingBehavior } : {}),
          source: "rpc",
          preflightResult: (ok: boolean) => settleSubmit({
            ok,
            error: ok ? undefined : "Prompt rejected before submission",
          }),
        }).then(() => {
          // P1-3：旧 SDK / 桩成功完成 prompt 但从不回调 preflightResult 时，
          // 在此幂等 settle（settleSubmit 已防重复），send 最终返回而非永久挂起；
          // 支持 preflight 的 SDK 已由 preflightResult 先 settle，此处为 no-op。
          settleSubmit({ ok: true });
          this.promptRunning = false;
          if (!streamingBehavior) this.emit({ type: "prompt_done" });
          notifyRunningChange();
        }).catch((error) => {
          this.promptRunning = false;
          invalidateSessionListCache();
          const errorMessage = error instanceof Error ? error.message : String(error);
          // 诊断：输出完整堆栈定位 prompt 失败根因（如扩展源码 startsWith 错误）
          if (error instanceof Error && error.stack) {
            console.error(`[pidance] prompt failed: ${errorMessage}\n${error.stack}`);
          }
          // best-effort 持久化；失败不阻断原 prompt_error
          this.tryAutoPersistActivity(
            mapPromptErrorToActivity({
              errorMessage,
              ...(streamingBehavior ? { streamingBehavior } : {}),
            }),
          );
          // P0-1：SDK 未调用 preflightResult（旧 SDK / 异常路径）时兜底 settle，
          // 让 send 抛错而非静默成功；已 settle（预检回调）时 no-op。
          settleSubmit({ ok: false, error: errorMessage });
          this.emit({
            type: "prompt_error",
            errorMessage,
          });
          if (!streamingBehavior) this.emit({ type: "prompt_done" });
          notifyRunningChange();
        });

        const submitResult = await submit;
        if (!submitResult.ok) {
          throw new Error(submitResult.error ?? "Prompt failed before submission");
        }
        return null;
      }

      case "abort":
        // 先强制清除 running 状态并广播：即使 SDK 的 waitForIdle 因流式挂起不返回，
        // 会话列表/聊天区也能立即恢复非运行态（用户已主动终止）。
        this.promptRunning = false;
        notifyRunningChange();
        await this.withFinalRunningNotification(() => this.inner.abort());
        return null;
      case "get_state": {
        const model = this.inner.model;
        const contextUsage = this.inner.getContextUsage();
        return {
          sessionId: this.inner.sessionId,
          sessionFile: this.inner.sessionFile ?? "",
          isStreaming: this.inner.isStreaming,
          isPromptRunning: this.promptRunning,
          isBashRunning: this.inner.isBashRunning,
          isCompacting: this.inner.isCompacting,
          autoCompactionEnabled: this.inner.autoCompactionEnabled,
          autoRetryEnabled: this.inner.autoRetryEnabled,
          model: model ? { id: model.id, provider: model.provider } : undefined,
          messageCount: 0,
          pendingMessageCount: this.inner.pendingMessageCount,
          queuedMessages: {
            steering: [...this.inner.getSteeringMessages()],
            followUp: [...this.inner.getFollowUpMessages()],
          },
          contextUsage: contextUsage
            ? { percent: contextUsage.percent, contextWindow: contextUsage.contextWindow, tokens: contextUsage.tokens }
            : null,
          systemPrompt: this.inner.agent.state?.systemPrompt ?? "",
          thinkingLevel: this.inner.agent.state?.thinkingLevel ?? "off",
          extensionStatuses: this.getExtensionStatuses(),
          extensionWidgets: this.getExtensionWidgets(),
          // 阻塞中扩展请求（切回会话时重建问题块用；服务端权威）
          pendingExtensionRequests: Array.from(this.pendingUiRequests.values())
            .filter((event) => event.type === "extension_ui_request")
            .map((event) => event),
        };
      }

      case "set_model": {
        const { provider, modelId } = command as { provider: string; modelId: string };
        const model = this.inner.modelRuntime.getModel(provider, modelId);
        if (!model) throw new Error(`Model not found: ${provider}/${modelId}`);
        await this.inner.setModel(model);
        invalidateModelsCache();
        invalidateSessionListCache();
        return { id: model.id, provider: model.provider };
      }

      case "fork": {
        if (this.inner.isBashRunning) {
          throw new Error("Cannot fork while a shell command is running");
        }
        const entryId = command.entryId as string;
        const sessionManager = this.inner.sessionManager;
        const currentSessionFile = this.inner.sessionFile;

        if (!sessionManager.isPersisted()) return { cancelled: true };
        if (!currentSessionFile) throw new Error("Persisted session is missing a session file");

        const entry = sessionManager.getEntry(entryId);
        if (!entry) throw new Error("Invalid entry ID for forking");

        const sessionDir = sessionManager.getSessionDir();
        let newSessionFile: string;

        if (!entry.parentId) {
          // Fork before the first message: create an empty session linked to this one
          const newManager = SessionManager.create(sessionManager.getCwd(), sessionDir);
          newManager.newSession({ parentSession: currentSessionFile });
          newSessionFile = newManager.getSessionFile() as string;
        } else {
          // Fork after some history: copy path up to (but not including) the fork point
          const sourceManager = SessionManager.open(currentSessionFile, sessionDir);
          const forkedPath = sourceManager.createBranchedSession(entry.parentId);
          if (!forkedPath) throw new Error("Failed to create forked session");
          newSessionFile = forkedPath;
        }

        const forkedManager = SessionManager.open(newSessionFile, sessionDir);
        const newSessionId = forkedManager.getSessionId();
        cacheSessionPath(newSessionId, newSessionFile);
        invalidateSessionListCache();
        // P1-2：fork 继承父会话模型选择——新文件没有 model_change（空 fork 或
        // fork 点在 model_change 之后）时，把源会话当前模型写入新文件，保证
        // fork 后用户手动选择不回落默认。
        const sourceModel = this.inner.model;
        if (sourceModel && shouldInheritModel(
          forkedManager.getEntries().some((e) => e.type === "model_change"),
          { provider: sourceModel.provider, modelId: sourceModel.id },
        )) {
          forkedManager.appendModelChange(sourceModel.provider, sourceModel.id);
        }
        this.destroy();
        return { cancelled: false, newSessionId };
      }

      case "navigate_tree": {
        if (this.inner.isBashRunning) {
          throw new Error("Cannot navigate while a shell command is running");
        }
        const { targetId, summarize, customInstructions } = parseNavigateTreeCommand(command);
        try {
          const result = await this.inner.navigateTree(targetId, {
            ...(summarize !== undefined ? { summarize } : {}),
            ...(customInstructions !== undefined ? { customInstructions } : {}),
            // 客户端自定义焦点只能追加默认 prompt，禁止替换
          });
          return result;
        } finally {
          invalidateSessionListCache();
        }
      }

      // P0a：分支树精确 leaf 切换——逻辑在 SessionService，经构造注入的导航动作落地。
      case "select_leaf_exact": {
        const rawEntryId = command.entryId;
        if (typeof rawEntryId !== "string" || rawEntryId.trim() === "") {
          throw new Error("entryId is required");
        }
        return this.navigationActionsOrThrow("select_leaf_exact")
          .selectLeafExact(this.sessionId, rawEntryId.trim());
      }

      // P0a：assistant 轮末分支锚点——逻辑在 SessionService，经构造注入的导航动作落地。
      case "branch_from_assistant": {
        const rawEntryId = command.assistantEntryId;
        if (typeof rawEntryId !== "string" || rawEntryId.trim() === "") {
          throw new Error("assistantEntryId is required");
        }
        return this.navigationActionsOrThrow("branch_from_assistant")
          .branchFromAssistant(this.sessionId, rawEntryId.trim());
      }

      // P0a：through-entry 线性新会话（含 assistant turnEnd 修复）——逻辑在
      // SessionService，经构造注入的导航动作落地。
      case "create_session_from_leaf": {
        const rawEntryId = command.entryId;
        if (typeof rawEntryId !== "string" || rawEntryId.trim() === "") {
          throw new Error("entryId is required");
        }
        return this.navigationActionsOrThrow("create_session_from_leaf")
          .createSessionFromLeaf(this.sessionId, rawEntryId.trim());
      }

      case "set_branch_label": {
        const { targetId, label } = parseSetBranchLabelCommand(command);
        const entryId = this.inner.sessionManager.appendLabelChange(targetId, label);
        invalidateSessionListCache();
        return {
          targetId,
          label: label ?? null,
          entryId,
        };
      }

      case "set_thinking_level": {
        const level = command.level as string;
        this.inner.setThinkingLevel(level);
        // setThinkingLevel clamps xhigh→high for models where supportsXhigh()===false.
        // If the model has DeepSeek thinking compat (reasoningEffortMap maps xhigh→max),
        // force the state back so the compat layer can use it correctly.
        if (level === "xhigh" && (this.inner.model as { compat?: { thinkingFormat?: string } } | null)?.compat?.thinkingFormat === "deepseek" && this.inner.agent?.state) {
          this.inner.agent.state.thinkingLevel = "xhigh";
        }
        invalidateSessionListCache();
        return null;
      }

      case "compact": {
        try {
          return await this.withFinalRunningNotification(() =>
            this.inner.compact(command.customInstructions as string | undefined)
          );
        } finally {
          invalidateSessionListCache();
        }
      }

      case "set_session_name": {
        const name = (command.name as string | undefined)?.trim();
        if (!name) throw new Error("Session name cannot be empty");
        this.inner.setSessionName(name);
        invalidateSessionListCache();
        return null;
      }

      case "get_session_stats": {
        return {
          ...this.inner.getSessionStats(),
          sessionName: this.inner.sessionManager.getSessionName(),
        };
      }

      case "get_last_assistant_text": {
        return { text: this.inner.getLastAssistantText() ?? "" };
      }

      case "set_auto_compaction": {
        this.inner.setAutoCompactionEnabled(command.enabled as boolean);
        return null;
      }

      case "clear_queue": {
        // Full clear only: pi has no single-item dequeue, and clear+requeue
        // races against the agent loop pulling messages mid-flight.
        return this.inner.clearQueue();
      }

      case "flush_queue_as_steer": {
        // 将 steering + followUp 全部清空后按顺序重新 steer 入队，
        // 使原 follow-up（等结束后发送）变为引导（当前轮工具结束后注入）。
        // 可选 message：输入框内容并入队尾后再整队引导发送。
        // 服务端原子完成，避免客户端 clear 后 requeue 的竞态窗口。
        const cleared = this.inner.clearQueue();
        const texts = [...cleared.steering, ...cleared.followUp];
        const extra = typeof command.message === "string" ? command.message.trim() : "";
        if (extra) texts.push(extra);
        for (const text of texts) {
          await this.inner.steer(text);
        }
        return { steering: texts, followUp: [] as string[] };
      }

      case "steer": {
        const steerImages = command.images as Array<{ type: "image"; data: string; mimeType: string }> | undefined;
        await this.inner.steer(command.message as string, steerImages?.length ? steerImages : undefined);
        return null;
      }

      case "follow_up": {
        const followImages = command.images as Array<{ type: "image"; data: string; mimeType: string }> | undefined;
        await this.inner.followUp(command.message as string, followImages?.length ? followImages : undefined);
        return null;
      }

      case "get_tools": {
        const all: ToolInfo[] = this.inner.getAllTools();
        const active = new Set<string>(this.inner.getActiveToolNames());
        return all.map((t) => ({
          name: t.name,
          description: t.description,
          active: active.has(t.name),
        }));
      }

      case "get_commands": {
        const commands: SlashCommandInfo[] = [];
        for (const registered of this.inner.extensionRunner.getRegisteredCommands()) {
          commands.push({
            name: registered.invocationName,
            description: registered.description,
            source: "extension",
            sourceInfo: registered.sourceInfo,
          });
        }
        for (const template of this.inner.promptTemplates) {
          commands.push({
            name: template.name,
            description: template.description,
            source: "prompt",
            sourceInfo: template.sourceInfo,
          });
        }
        for (const skill of this.inner.resourceLoader.getSkills().skills) {
          commands.push({
            name: `skill:${skill.name}`,
            description: skill.description,
            source: "skill",
            sourceInfo: skill.sourceInfo,
          });
        }
        return { commands };
      }

      case "set_tools": {
        const toolNames = command.toolNames as string[];
        // P0c：tool preset 下线后不再因 toolNames=[] 强制清空 systemPrompt
        this.inner.setActiveToolsByName(withExtensionTools(this.inner, toolNames));
        this.applyForcedEmptySystemPrompt();
        return null;
      }

      case "reload": {
        await this.waitForExtensionsBound();
        this.extensionStatuses.clear();
        this.extensionWidgets.clear();
        await this.inner.reload();
        if (typeof this.inner.bindExtensions !== "function") {
          this.inner.extensionRunner.setUIContext?.(this.createExtensionUiContext(), "rpc");
        }
        this.applyForcedEmptySystemPrompt();
        return { success: true };
      }

      case "abort_compaction": {
        this.inner.abortCompaction();
        return null;
      }

      case "extension_ui_response": {
        this.resolveExtensionUiResponse(command as ExtensionUiResponse);
        return null;
      }

      case "extension_ui_input": {
        this.handleExtensionUiInput(command.id as string, command.data as string);
        return null;
      }

      case "set_auto_retry": {
        this.inner.setAutoRetryEnabled(command.enabled as boolean);
        return null;
      }

      case "bash": {
        if (this.promptRunning || this.inner.isStreaming || this.inner.isCompacting || this.inner.isBashRunning) {
          throw new Error("Cannot run a shell command while the session is busy");
        }
        const execution = this.inner.executeBash(
          command.command as string,
          undefined,
          { excludeFromContext: command.excludeFromContext as boolean | undefined },
        );
        notifyRunningChange();
        try {
          const result = await execution;
          this.persistBashOnlySession();
          return result;
        } finally {
          invalidateSessionListCache();
          notifyRunningChange();
        }
      }

      case "abort_bash": {
        this.inner.abortBash();
        return null;
      }

      case "append_activity": {
        // 受控命令：校验后复用 appendActivity owner；customType 固定不可覆盖。
        const activity = parseAppendActivityCommand(command);
        return this.appendActivity(activity);
      }

      default:
        throw new Error(`Unsupported command: ${type}`);
    }
  }

  destroy(): void {
    if (!this._alive) return;
    this._alive = false;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.inner.isBashRunning) this.inner.abortBash();
    this.unsubscribe?.();
    for (const pending of this.pendingUiResponses.values()) pending.cancel();
    for (const id of Array.from(this.activeCustomUis.keys())) this.closeCustomUi(id, undefined);
    this.pendingUiResponses.clear();
    this.pendingUiRequests.clear();
    // P0-1：wrapper 销毁即释放全部渲染上下文状态（idle 超时亦走此路径）。
    this.toolRenderStates.clear();
    this.onDestroyCallback?.();
    notifyRunningChange();
  }

  private resolveExtensionUiResponse(response: ExtensionUiResponse): void {
    const pending = this.pendingUiResponses.get(response.id);
    if (!pending) return;
    pending.resolve(response);
  }

  private getExtensionStatuses(): Array<{ key: string; text: string }> {
    return Array.from(this.extensionStatuses, ([key, text]) => ({ key, text }));
  }

  private getExtensionWidgets(): ExtensionWidgetItem[] {
    return Array.from(this.extensionWidgets.values());
  }

  private getCustomUiWidth(options: unknown): number {
    if (!options || typeof options !== "object") return DEFAULT_CUSTOM_UI_COLUMNS;
    const overlayOptions = (options as { overlayOptions?: unknown }).overlayOptions;
    const resolved = typeof overlayOptions === "function" ? overlayOptions() : overlayOptions;
    if (!resolved || typeof resolved !== "object") return DEFAULT_CUSTOM_UI_COLUMNS;
    const width = (resolved as { width?: unknown }).width;
    return typeof width === "number" && Number.isFinite(width)
      ? Math.max(40, Math.min(140, Math.round(width)))
      : 92;
  }

  private emitCustomUiRender(id: string, custom: ActiveCustomUi): void {
    let lines: string[];
    try {
      lines = custom.component.render(custom.width);
    } catch (error) {
      lines = [`Extension custom UI render failed: ${error instanceof Error ? error.message : String(error)}`];
    }
    const event = {
      type: "extension_ui_request",
      id,
      method: "custom",
      lines,
    } as ExtensionUiRequest as AgentEvent;
    this.pendingUiRequests.set(id, event);
    this.emit(event);
  }

  private closeCustomUi(id: string, value: unknown): void {
    const custom = this.activeCustomUis.get(id);
    if (!custom || custom.settled) return;
    custom.settled = true;
    this.activeCustomUis.delete(id);
    this.pendingUiRequests.delete(id);
    try {
      custom.component.dispose?.();
    } catch {
      // Ignore dispose errors from extension UI components.
    }
    this.emit({
      type: "extension_ui_request",
      id,
      method: "custom",
      lines: [],
      closed: true,
    } as ExtensionUiRequest as AgentEvent);
    custom.resolve(value);
  }

  private handleExtensionUiInput(id: string, data: string): void {
    const custom = this.activeCustomUis.get(id);
    if (!custom || typeof data !== "string") return;
    try {
      custom.component.handleInput?.(data);
      if (this.activeCustomUis.has(id)) this.emitCustomUiRender(id, custom);
    } catch (error) {
      this.closeCustomUi(id, undefined);
      this.emitExtensionError({
        extensionPath: `custom-ui:${id}`,
        event: "custom_ui_input",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private requestExtensionCustomUi<T>(
    factory: unknown,
    options?: unknown,
  ): Promise<T> {
    if (typeof factory !== "function") return Promise.resolve(undefined as T);

    const id = randomUUID();
    const width = this.getCustomUiWidth(options);

    return new Promise<T>((resolve) => {
      let completed = false;
      const tui = createHeadlessCustomUiTui(
        () => {
          const custom = this.activeCustomUis.get(id);
          if (custom) this.emitCustomUiRender(id, custom);
        },
        width,
      );
      const finish = (value: T) => {
        if (completed) return;
        completed = true;
        resolve(value);
      };
      const done = (value: T) => {
        if (this.activeCustomUis.has(id)) {
          this.closeCustomUi(id, value);
        } else {
          finish(value);
        }
      };

      Promise.resolve()
        .then(() => factory(tui, PLAIN_TEXT_THEME, CUSTOM_UI_KEYBINDINGS, done))
        .then((component) => {
          if (completed) {
            try {
              (component as CustomUiComponent | undefined)?.dispose?.();
            } catch {
              // Ignore dispose errors from a component completed before mounting.
            }
            return;
          }
          if (!component || typeof component !== "object" || typeof (component as CustomUiComponent).render !== "function") {
            finish(undefined as T);
            return;
          }
          const custom: ActiveCustomUi = {
            component: component as CustomUiComponent,
            width,
            resolve: (value) => finish(value as T),
            settled: false,
          };
          this.activeCustomUis.set(id, custom);
          this.emitCustomUiRender(id, custom);
        })
        .catch((error) => {
          if (completed) return;
          this.emitExtensionError({
            extensionPath: `custom-ui:${id}`,
            event: "custom_ui",
            error: error instanceof Error ? error.message : String(error),
          });
          finish(undefined as T);
        });
    });
  }

  private requestExtensionUi<T>(
    request: ExtensionUiRequestBody,
    defaultValue: T,
    parseResponse: (response: ExtensionUiResponse) => T,
    timeout?: number,
    signal?: AbortSignal,
  ): Promise<T> {
    if (signal?.aborted) return Promise.resolve(defaultValue);

    const id = randomUUID();
    const fullRequest = {
      type: "extension_ui_request",
      id,
      ...request,
      ...(timeout ? { timeout, expiresAt: Date.now() + timeout } : {}),
    };

    return new Promise((resolve) => {
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => {
        if (timeoutId) clearTimeout(timeoutId);
        signal?.removeEventListener("abort", onAbort);
        this.pendingUiRequests.delete(id);
        this.pendingUiResponses.delete(id);
      };
      const settle = (value: T) => {
        cleanup();
        resolve(value);
      };
      const onAbort = () => settle(defaultValue);

      if (timeout) timeoutId = setTimeout(() => settle(defaultValue), timeout);
      signal?.addEventListener("abort", onAbort, { once: true });

      this.pendingUiRequests.set(id, fullRequest as AgentEvent);
      this.pendingUiResponses.set(id, {
        resolve: (response) => settle(parseResponse(response)),
        cancel: () => settle(defaultValue),
      });
      this.emit(fullRequest as AgentEvent);
    });
  }

  private createExtensionUiContext(): ExtensionUiContextLike {
    return {
      select: (title, options, opts) => this.requestExtensionUi(
        { method: "select", title, options, ...(opts?.timeout ? { timeout: opts.timeout } : {}) },
        undefined,
        (response) => "value" in response ? response.value : undefined,
        opts?.timeout,
        opts?.signal,
      ),
      confirm: (title, message, opts) => this.requestExtensionUi(
        { method: "confirm", title, message, ...(opts?.timeout ? { timeout: opts.timeout } : {}) },
        false,
        (response) => "confirmed" in response ? response.confirmed : false,
        opts?.timeout,
        opts?.signal,
      ),
      input: (title, placeholder, opts) => this.requestExtensionUi(
        { method: "input", title, ...(placeholder !== undefined ? { placeholder } : {}), ...(opts?.timeout ? { timeout: opts.timeout } : {}) },
        undefined,
        (response) => "value" in response ? response.value : undefined,
        opts?.timeout,
        opts?.signal,
      ),
      editor: (title, prefill, opts) => this.requestExtensionUi(
        { method: "editor", title, ...(prefill !== undefined ? { prefill } : {}), ...(opts?.timeout ? { timeout: opts.timeout } : {}) },
        undefined,
        (response) => "value" in response ? response.value : undefined,
        opts?.timeout,
        opts?.signal,
      ),
      notify: (message, type) => {
        const id = randomUUID();
        // warning/error 经单一 owner 自动持久化；info/success/缺省 transient。
        // 同 requestId 只写一次（失败不 remember）；不同 id 同文案各写一次。
        const activityRecord = persistExtensionNotify(
          this.notifyPersistState,
          (input) => this.appendActivity(input),
          {
            message: String(message),
            notifyType: type === undefined ? undefined : String(type),
            requestId: id,
          },
        );
        this.emit({
          type: "extension_ui_request",
          id,
          method: "notify",
          message,
          notifyType: type,
          activityRecord,
        } as ExtensionUiRequest as AgentEvent);
      },
      onTerminalInput: () => () => {},
      setStatus: (key, text) => {
        if (text === undefined) this.extensionStatuses.delete(key);
        else this.extensionStatuses.set(key, text);
        this.emit({
          type: "extension_ui_request",
          id: randomUUID(),
          method: "setStatus",
          statusKey: key,
          statusText: text,
        } as ExtensionUiRequest as AgentEvent);
      },
      setWorkingMessage: () => {},
      setWorkingVisible: () => {},
      setWorkingIndicator: () => {},
      setHiddenThinkingLabel: () => {},
      setWidget: (key, content, options) => {
        // 组件工厂形式（如 pi-subagents async widget 的 buildWidgetComponent）：headless
        // 渲染为 ANSI 行后走现有 lines 通道；渲染失败静默（不设置不 emit）。
        // **snapshot-only 范围（P1-7）**：每次 setWidget 调用时渲染一次静态行快照，
        // 工厂的 state/invalidate 生命周期与事件驱动重渲染（pi M2）不支持——动态内容
        // 需插件主动再次 setWidget 才更新；结果受 renderToLines 输出上限约束。
        if (typeof content === "function") {
          const lines = renderWidgetFactoryLines(content, this.renderBridgeTheme);
          if (lines === null) return;
          content = lines;
        }
        if (content !== undefined && !Array.isArray(content)) return;
        if (content === undefined) {
          this.extensionWidgets.delete(key);
        } else {
          this.extensionWidgets.set(key, {
            key,
            lines: content,
            placement: options?.placement ?? "aboveEditor",
          });
        }
        this.emit({
          type: "extension_ui_request",
          id: randomUUID(),
          method: "setWidget",
          widgetKey: key,
          widgetLines: content,
          widgetPlacement: options?.placement,
        } as ExtensionUiRequest as AgentEvent);
      },
      setFooter: () => {},
      setHeader: () => {},
      setTitle: (title) => {
        this.emit({
          type: "extension_ui_request",
          id: randomUUID(),
          method: "setTitle",
          title,
        } as ExtensionUiRequest as AgentEvent);
      },
      custom: <T = unknown>(factory: unknown, options?: unknown) => this.requestExtensionCustomUi<T>(factory, options),
      pasteToEditor: (text) => {
        this.emit({
          type: "extension_ui_request",
          id: randomUUID(),
          method: "set_editor_text",
          text,
        } as ExtensionUiRequest as AgentEvent);
      },
      setEditorText: (text) => {
        this.emit({
          type: "extension_ui_request",
          id: randomUUID(),
          method: "set_editor_text",
          text,
        } as ExtensionUiRequest as AgentEvent);
      },
      getEditorText: () => "",
      addAutocompleteProvider: () => {},
      setEditorComponent: () => {},
      getEditorComponent: () => undefined,
      get theme() { return PLAIN_TEXT_THEME; },
      getAllThemes: () => [],
      getTheme: () => undefined,
      setTheme: () => ({ success: false, error: "Theme switching is not supported in Pidance extension UI yet" }),
      getToolsExpanded: () => false,
      setToolsExpanded: () => {},
    };
  }

  private createExtensionCommandContextActions(): ExtensionCommandContextActionsLike {
    return {
      waitForIdle: async () => {
        const agent = this.inner.agent as { waitForIdle?: () => Promise<void> };
        await agent.waitForIdle?.();
      },
      newSession: async () => ({ cancelled: true }),
      fork: async () => ({ cancelled: true }),
      navigateTree: async (targetId, options) => {
        const result = await this.inner.navigateTree(targetId, {
          summarize: options?.summarize,
          ...(options?.customInstructions !== undefined
            ? { customInstructions: options.customInstructions }
            : {}),
        });
        return { cancelled: result.cancelled };
      },
      switchSession: async () => ({ cancelled: true }),
      reload: async () => {
        this.extensionStatuses.clear();
        this.extensionWidgets.clear();
        await this.inner.reload({
          beforeSessionStart: () => {
            this.inner.extensionRunner.setUIContext?.(this.createExtensionUiContext(), "rpc");
          },
        });
        this.applyForcedEmptySystemPrompt();
      },
    };
  }
}

// ============================================================================
// Session registry
// ============================================================================

declare global {
  var __piSessions: Map<string, AgentSessionWrapper> | undefined;
  var __piStartLocks: Map<string, Promise<{ session: AgentSessionWrapper; realSessionId: string }>> | undefined;
  var __piRunningListeners: Set<(ids: string[]) => void> | undefined;
}

function getRegistry(): Map<string, AgentSessionWrapper> {
  if (!globalThis.__piSessions) {
    globalThis.__piSessions = new Map();
    const cleanup = () => globalThis.__piSessions?.forEach((s) => s.destroy());
    process.once("exit", cleanup);
    process.once("SIGINT", cleanup);
    process.once("SIGTERM", cleanup);
  }
  return globalThis.__piSessions;
}

function getLocks(): Map<string, Promise<{ session: AgentSessionWrapper; realSessionId: string }>> {
  if (!globalThis.__piStartLocks) globalThis.__piStartLocks = new Map();
  return globalThis.__piStartLocks;
}

export function getRpcSession(sessionId: string): AgentSessionWrapper | undefined {
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
 */
export async function startRpcSession(
  sessionId: string,
  sessionFile: string,
  cwd: string,
  toolNames?: string[],
  navigationActions?: NavigationActions,
): Promise<{ session: AgentSessionWrapper; realSessionId: string }> {
  const registry = getRegistry();
  const locks = getLocks();

  const existing = registry.get(sessionId);
  if (existing?.isAlive()) return { session: existing, realSessionId: sessionId };

  const inflight = locks.get(sessionId);
  if (inflight) return inflight;

  const starting = (async () => {
    // Some extensions access the SDK's global theme even outside the terminal UI.
    initTheme();
    const agentDir = getAgentDir();

    const sessionManager = sessionFile
      ? SessionManager.open(sessionFile, undefined)
      : SessionManager.create(cwd, undefined);

    // Determine which tools to pass based on requested toolNames.
    // Since v0.68.0, session creation expects string[] tool names instead of Tool[] instances.
    let toolsOption: string[] | undefined;
    if (toolNames !== undefined) {
      // toolNames === [] -> "all off" (an empty allow-list disables every tool).
      // Otherwise DO NOT pass a builtin-only allow-list: passing CODING_TOOL_NAMES
      // set allowedToolNames to coding builtins only, which filtered every
      // extension/package-provided tool (e.g. subagents, web access) out of the
      // tool registry — so they were unavailable in Pidance sessions even though the
      // `pi` CLI keeps them. Leaving the allow-list unset lets the SDK register all
      // tools (and activate extension tools); we narrow the ACTIVE set below.
      toolsOption = toolNames.length === 0 ? [] : undefined;
    }

    // Project trust: pi gates project-local `.pi` settings/resources, project
    // package installs, and project extensions behind `projectTrusted`. Passing no
    // SettingsManager left the SDK default (`projectTrusted: true`), so every project
    // was loaded as trusted and `trust.json`/`defaultProjectTrust` never applied.
    // Resolve against the same cwd the services are built for, so settings and trust
    // can never disagree about which project they describe.
    const projectTrusted = resolveProjectTrustedForSession(cwd, agentDir);
    const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted });
    // 产品固化：消息队列投递一律 all（去掉 one-at-a-time 配置面）。
    // 仅内存生效即可覆盖本会话；磁盘若仍是旧值，下次保存 defaults 时也会写回 all。
    try {
      if (settingsManager.getSteeringMode() !== "all") settingsManager.setSteeringMode("all");
      if (settingsManager.getFollowUpMode() !== "all") settingsManager.setFollowUpMode("all");
    } catch {
      // SettingsManager 缺 setter 时不阻断会话启动
    }

    // Build services first so extension-registered providers are available
    // before the SDK restores the saved model from the session file.
    const services = await createAgentSessionServices({ cwd, agentDir, settingsManager });
    const { session: inner } = await createAgentSessionFromServices({
      services,
      sessionManager,
      ...(toolsOption !== undefined ? { tools: toolsOption } : {}),
    });

    // If specific tool names were requested (non-empty), set the active tools to the
    // requested builtin coding tools PLUS all extension/package tools, so installed
    // extensions stay usable in Pidance just like in the `pi` CLI.
    if (toolNames && toolNames.length > 0) {
      inner.setActiveToolsByName(withExtensionTools(inner, toolNames));
    }

    const wrapper = new AgentSessionWrapper(inner, navigationActions);
    // P0c：tool preset 下线后不再因 toolNames=[] 强制清空 systemPrompt
    wrapper.start();

    const realSessionId = inner.sessionId as string;
    const realSessionFile = inner.sessionFile as string | undefined;
    if (realSessionFile) cacheSessionPath(realSessionId, realSessionFile);

    wrapper.onDestroy(() => registry.delete(realSessionId));
    registry.set(realSessionId, wrapper);
    wrapper.beginExtensionBinding();

    return { session: wrapper, realSessionId };
  })().finally(() => locks.delete(sessionId));

  locks.set(sessionId, starting);
  return starting;
}
