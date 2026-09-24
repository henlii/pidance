/** 本地结构类型（不依赖 pi npm） */
export type AgentSessionEvent = { type: string; [key: string]: unknown };
export type SessionManagerLike = {
  getSessionFile?: () => string | undefined;
  getSessionId?: () => string;
  getCwd?: () => string;
  getLeafId?: () => string | null;
  [key: string]: unknown;
};
export type SettingsManagerLike = {
  getDefaultProvider?: () => string | undefined;
  getDefaultModel?: () => string | undefined;
  flush?: () => void | Promise<void>;
  [key: string]: unknown;
};
export type SlashCommandInfo = {
  name: string;
  description?: string;
  sourceInfo?: { source?: string; scope?: string };
  /**
   * 该命令是否提供参数补全（`/cmd <prefix>`，issue #75）。
   * 服务端只在插件真的注册了 `getArgumentCompletions` 时才置 true；
   * 客户端据此决定要不要在命令名之后继续问下一级候选。
   */
  hasArgumentCompletions?: boolean;
  [key: string]: unknown;
};
export type Theme = {
  fg?: (...args: unknown[]) => string;
  bg?: (...args: unknown[]) => string;
  [key: string]: unknown;
};

export interface ContextUsage {
  percent: number | null;
  contextWindow: number;
  tokens: number | null;
}

export interface ModelLike {
  id: string;
  provider: string;
}

export interface ToolInfo {
  name: string;
  description: string;
}

export interface NavigateTreeOptions {
  summarize?: boolean;
  customInstructions?: string;
  /** 仅 SDK/扩展内部使用；客户端命令禁止 replaceInstructions=true。 */
  replaceInstructions?: boolean;
  label?: string;
}

export interface NavigateTreeResult {
  editorText?: string;
  cancelled: boolean;
  aborted?: boolean;
  summaryEntry?: unknown;
}

export interface SessionStatsInfo {
  sessionFile?: string;
  sessionId: string;
  sessionName?: string;
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
  toolResults: number;
  totalMessages: number;
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
  cost: number;
  contextUsage?: ContextUsage;
}

interface PromptTemplateLike {
  name: string;
  description?: string;
  sourceInfo: SlashCommandInfo["sourceInfo"];
}

interface SkillLike {
  name: string;
  description?: string;
  sourceInfo: SlashCommandInfo["sourceInfo"];
}

interface ResourceLoaderLike {
  getSkills(): { skills: SkillLike[] };
}

interface ExtensionRunnerLike {
  getRegisteredCommands(): Array<{
    invocationName: string;
    description?: string;
    sourceInfo: SlashCommandInfo["sourceInfo"];
  }>;
  setUIContext?(uiContext?: unknown, mode?: "tui" | "rpc" | "json" | "print"): void;
  /**
   * 通用扩展事件发射（SDK 的 ExtensionRunner 运行时与类型都有）。
   *
   * #90 之后树导航由 Host 用**本会话的** runner 直接派发 `session_before_tree` /
   * `session_tree`（见 lib/sdk-session-host.ts 的 `navigateTreeCommand`）：两条事件必须在改动
   * 前后由同一个 runner 发出，而交出 writer 会 dispose Host（SDK 在那里 invalidate runner）。
   * 这个结构成员本身目前没有调用方。
   */
  emit?(event: unknown): Promise<{ cancel?: boolean } | undefined>;
}

type DialogOptionsLike = {
  signal?: AbortSignal;
  timeout?: number;
};

type WidgetOptionsLike = {
  placement?: "aboveEditor" | "belowEditor";
};

export interface ExtensionUiContextLike {
  select(title: string, options: string[], opts?: DialogOptionsLike): Promise<string | undefined>;
  confirm(title: string, message: string, opts?: DialogOptionsLike): Promise<boolean>;
  input(title: string, placeholder?: string, opts?: DialogOptionsLike): Promise<string | undefined>;
  editor(title: string, prefill?: string, opts?: DialogOptionsLike): Promise<string | undefined>;
  notify(message: string, type?: "info" | "warning" | "error"): void;
  onTerminalInput(): () => void;
  setStatus(key: string, text: string | undefined): void;
  setWorkingMessage(message?: string): void;
  setWorkingVisible(visible: boolean): void;
  setWorkingIndicator(options?: { frames?: string[]; intervalMs?: number }): void;
  setHiddenThinkingLabel(label?: string): void;
  setWidget(key: string, content: string[] | ((...args: never[]) => unknown) | undefined, options?: WidgetOptionsLike): void;
  setFooter(factory: unknown): void;
  setHeader(factory: unknown): void;
  setTitle(title: string): void;
  custom<T = unknown>(...args: unknown[]): Promise<T>;
  pasteToEditor(text: string): void;
  setEditorText(text: string): void;
  getEditorText(): string;
  addAutocompleteProvider(): void;
  setEditorComponent(): void;
  getEditorComponent(): undefined;
  readonly theme: Theme;
  getAllThemes(): unknown[];
  getTheme(name: string): undefined;
  setTheme(theme: unknown): { success: boolean; error?: string };
  getToolsExpanded(): boolean;
  setToolsExpanded(expanded: boolean): void;
}

export interface AgentSessionLike {
  readonly sessionId: string;
  readonly sessionFile: string | undefined;
  readonly isStreaming: boolean;
  readonly isCompacting: boolean;
  readonly autoCompactionEnabled: boolean;
  readonly autoRetryEnabled: boolean;
  readonly model: ModelLike | undefined;
  readonly modelRuntime: { getModel: (provider: string, modelId: string) => ModelLike | undefined };
  readonly sessionManager: SessionManagerLike;
  readonly settingsManager: SettingsManagerLike;
  readonly agent: { state?: { systemPrompt?: string; thinkingLevel?: string; messages?: unknown[] } };
  readonly extensionRunner: ExtensionRunnerLike;
  readonly promptTemplates: readonly PromptTemplateLike[];
  readonly resourceLoader: ResourceLoaderLike;

  readonly bindExtensions?: unknown;
  reload(options?: { beforeSessionStart?: () => void | Promise<void> }): Promise<void>;
  subscribe(listener: (event: AgentSessionEvent) => void): () => void;
  prompt(text: string, options?: {
    images?: Array<{ type: "image"; data: string; mimeType: string }>;
    streamingBehavior?: "steer" | "followUp";
    source?: "interactive" | "rpc";
    /**
     * P0-1：SDK 预检（model/auth/streaming）结果回调。true = 预检通过、
     * 消息即将提交落盘；false = 配置无效、消息不会进入会话。
     */
    preflightResult?: (ok: boolean) => void;
  }): Promise<void>;
  abort(): Promise<void>;
  executeBash(command: string, onChunk?: (chunk: string) => void, options?: { excludeFromContext?: boolean }): Promise<{ output: string; exitCode?: number; cancelled?: boolean; truncated?: boolean; fullOutputPath?: string }>;
  abortBash(): void;
  readonly isBashRunning: boolean;
  setModel(model: ModelLike): Promise<void>;
  navigateTree(targetId: string, options?: NavigateTreeOptions): Promise<NavigateTreeResult>;
  setThinkingLevel(level: string): void;
  compact(customInstructions?: string): Promise<unknown>;
  setSessionName(name: string): void;
  getSessionStats(): Omit<SessionStatsInfo, "sessionName">;
  getLastAssistantText(): string | undefined;
  setAutoCompactionEnabled(enabled: boolean): void;
  setAutoRetryEnabled(enabled: boolean): void;
  steer(text: string, images?: Array<{ type: "image"; data: string; mimeType: string }>): Promise<void>;
  followUp(text: string, images?: Array<{ type: "image"; data: string; mimeType: string }>): Promise<void>;
  readonly pendingMessageCount: number;
  getSteeringMessages(): readonly string[];
  getFollowUpMessages(): readonly string[];
  clearQueue(): { steering: string[]; followUp: string[] };
  getAllTools(): ToolInfo[];
  getActiveToolNames(): string[];
  setActiveToolsByName(names: string[]): void;
  abortCompaction(): void;
  getContextUsage(): ContextUsage | undefined;
}
