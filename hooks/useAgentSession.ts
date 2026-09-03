"use client";

import { useState, useCallback, useRef, useEffect, useMemo, useReducer } from "react";
import type {
  AgentMessage,
  ExtensionStatusItem,
  ExtensionUiRequest,
  ExtensionWidgetItem,
  SessionInfo,
  SessionTreeNode,
  AttachedImage,
  ChatInputHandle,
} from "@/lib/types";
import { recoverFailedSend } from "@/lib/send-failure";
import { preserveCustomRenderedLines } from "@/lib/custom-rendered-lines";
import type { SessionActivity } from "@/lib/session-activity";
import { readAgentLiveFlag, sendAgentCommand } from "@/lib/agent-client";
import { generateSubmissionId } from "@/lib/agent-commands";
import { getOrCreateBrowserSessionRuntimeRegistry, type RegistrySubscription } from "@/lib/browser-session-runtime-registry";
import {
  captureChatTargetToken,
  sameChatTargetToken,
  resolveSubmitTarget,
  resetChatTargetRefs,
  type ChatTargetToken,
} from "@/lib/chat-submit-target";
import type { BranchActions } from "@/lib/branch-bookmarks";
import {
  mergeFollowUpForSteer,
  joinQueueForRecall,
  readFollowUpQueuePreference,
} from "@/lib/queue-merge";
import { pendingSessionId } from "@/lib/new-session-intent";
import type { SessionStatsInfo } from "@/lib/pi-types";
import {
  applyExtensionUiRequest,
  clearAllExtensionUiBlocking,
  clearExtensionUiRequest,
  projectBlockingHead,
} from "@/lib/extension-ui-bridge";
import type { ExtensionUiBlockingRequest } from "@/lib/extension-ui-bridge";
import { useExtensionUiState, type ExtensionUiDialogRequest, type ExtensionUiCustomRequest } from "@/hooks/useExtensionUiState";
import { useNoticeState } from "@/hooks/useNoticeState";
import { parseLatestTodoSnapshot } from "@/lib/todo-parser";
import { getSessionCapabilities } from "@/components/session-capabilities";
import { useSessionCommands } from "@/hooks/useSessionCommands";
import { useChatAutoFollow } from "@/hooks/useChatAutoFollow";
import { ensureServerPrefsLoaded, setServerPref, useServerPreferences } from "@/lib/server-preferences";
import { resolveDisplayModel, settleModelOverride } from "@/lib/model-selection";
import { useI18n } from "@/lib/i18n";
import { getDesktopBridge } from "@/lib/desktop-bridge";
import { guidePageThinkingUpdate, thinkingLevelForEnsureBody } from "@/lib/thinking-level-policy";
import { isThinkingLevel, type AgentThinkingLevel } from "@/lib/agent-settings";

import {
  applyToolExecutionStart,
  applyToolExecutionUpdate,
  applyToolExecutionEnd,
  applyToolExecutionResultRender,
  clearToolExecutions,
  finalizeRunningToolExecutions,
  getToolExecutionSnapshots,
  type ToolExecutionBufferState,
  type ToolExecutionSnapshot,
  type ToolExecutionStartInput,
  type ToolExecutionUpdateInput,
  type ToolExecutionEndInput,
} from "@/lib/tool-execution-buffer";
import {
  DEFAULT_SESSION_HISTORY_PAGE,
  DEFAULT_SESSION_TAIL_LIMIT,
  mergeTailReload,
  prependOlderPage,
} from "@/lib/session-context-window";

export interface SessionData {
  sessionId: string;
  filePath: string;
  tree: SessionTreeNode[];
  leafId: string | null;
  context: {
    messages: AgentMessage[];
    entryIds: string[];
    thinkingLevel: string;
    model: { provider: string; modelId: string } | null;
    hasMoreBefore?: boolean;
    totalMessageCount?: number;
  };
}

interface StreamingState {
  isStreaming: boolean;
  streamingMessage: Partial<AgentMessage> | null;
}

type StreamAction =
  | { type: "start" }
  | { type: "update"; message: Partial<AgentMessage> }
  | { type: "end" }
  | { type: "reset" };

function streamReducer(state: StreamingState, action: StreamAction): StreamingState {
  switch (action.type) {
    case "start":
      return { isStreaming: true, streamingMessage: null };
    case "update":
      return { isStreaming: true, streamingMessage: action.message };
    case "end":
    case "reset":
      return { isStreaming: false, streamingMessage: null };
    default:
      return state;
  }
}

interface AgentEvent {
  type: string;
  [key: string]: unknown;
}

interface CompactCommandResult {
  tokensBefore?: number;
  estimatedTokensAfter?: number;
}

interface LastAssistantTextResponse {
  text?: string;
}

type AgentStateResponse = {
  contextUsage?: { percent: number | null; contextWindow: number; tokens: number | null } | null;
  systemPrompt?: string;
  thinkingLevel?: string;
  isStreaming?: boolean;
  isPromptRunning?: boolean;
  isBashRunning?: boolean;
  /** bash 执行中的命令快照（服务端 ExternalRpcSession 记录；刷新恢复用） */
  pendingBash?: { command: string; excludeFromContext: boolean; startedAt: number } | null;
  isCompacting?: boolean;
  lockedByOther?: boolean;
  extensionStatuses?: ExtensionStatusItem[];
  extensionWidgets?: ExtensionWidgetItem[];
  queuedMessages?: { steering?: string[]; followUp?: string[] } | null;
  pendingExtensionRequests?: AgentEvent[];
};

export interface QueuedMessages {
  steering: string[];
  followUp: string[];
}

function normalizeQueuedMessages(q?: { steering?: string[]; followUp?: string[] } | null): QueuedMessages {
  return { steering: q?.steering ?? [], followUp: q?.followUp ?? [] };
}

// 通知状态机纯逻辑已抽至 lib/notice-reducer.ts；此处再导出保持既有消费方（如 ChatWindow）兼容。
export type { NoticeItem, NoticeType } from "@/lib/notice-reducer";

export type AgentPhase =
  | { kind: "waiting_model" }
  | { kind: "running_command" }
  | { kind: "running_tools"; tools: { id: string; name: string }[] }
  | null;

export interface CompactResultInfo {
  reason: "manual" | "threshold" | "overflow" | "auto" | string;
  tokensBefore: number;
  estimatedTokensAfter: number;
}

export interface SlashCommandInfo {
  name: string;
  description?: string;
  source: "extension" | "prompt" | "skill";
  sourceInfo?: {
    path: string;
    source: string;
    scope: "user" | "project" | "temporary";
    origin: "package" | "top-level";
    baseDir?: string;
  };
}

export type BuiltinSlashCommandResult =
  | { handled: false }
  | { handled: true; message?: string; error?: string; action?: "openSessionStats" };

export interface UseAgentSessionOptions {
  session: SessionInfo | null;
  newSessionCwd: string | null;
  /**
   * 新建意图代际 id（AppShell NewSessionIntent.id）。
   * ensure/promote 时回传，供父层丢弃迟到的旧 intent 结果；缺省时行为与仅 cwd 一致。
   */
  newSessionIntentId?: string | null;
  onAgentEnd?: () => void;
  /** agentRunning 变化时通知父层（侧栏冷启动期即可显示运行中，不必等 SSE）。 */
  onAgentRunningChange?: (running: boolean, sessionId: string | null) => void;
  onSessionCreated?: (session: SessionInfo, intentId?: string | null) => void;
  /** fork/新会话成功后切换会话；prefill 为预填到新会话输入框的文本（draft 注入）。 */
  onSessionForked?: (newSessionId: string, prefill?: string) => void;
  modelsRefreshKey?: number;
  chatInputRef?: React.RefObject<ChatInputHandle | null>;
  onBranchDataChange?: (tree: SessionTreeNode[], activeLeafId: string | null, onLeafChange: (leafId: string | null) => void, actions: BranchActions) => void;
  onSystemPromptChange?: (prompt: string | null) => void;
  onSessionStatsPanelOpen?: () => void;
  /** 移动端断点（与 useIsMobile 同源）：决定末端区域与底部 spacer 尺寸。 */
  isMobile?: boolean;
}

export type ThinkingLevelOption = AgentThinkingLevel;

const PROMPT_SETTLE_INITIAL_DELAY_MS = 800;
const PROMPT_SETTLE_POLL_MS = 600;
const PROMPT_SETTLE_MAX_MS = 20_000;
const AGENT_STATE_RECONCILE_MS = 15_000;
const BASH_STATE_RECONCILE_MS = 1_000;
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractMessageText(message: Partial<AgentMessage>): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) =>
      block && typeof block === "object"
        && (block as { type?: string }).type === "text"
        && typeof (block as { text?: unknown }).text === "string"
        ? (block as { text: string }).text
        : "")
    .filter(Boolean)
    .join("\n");
}

function imageSignature(block: unknown): string {
  if (!block || typeof block !== "object" || (block as { type?: unknown }).type !== "image") return "";
  const source = (block as { source?: unknown }).source;
  if (source && typeof source === "object") {
    const src = source as { type?: unknown; media_type?: unknown; data?: unknown; url?: unknown };
    return [
      src.type === "url" ? "url" : "base64",
      typeof src.media_type === "string" ? src.media_type : "",
      typeof src.data === "string" ? src.data : "",
      typeof src.url === "string" ? src.url : "",
    ].join(":");
  }
  const flat = block as { data?: unknown; mimeType?: unknown };
  return [
    "base64",
    typeof flat.mimeType === "string" ? flat.mimeType : "",
    typeof flat.data === "string" ? flat.data : "",
    "",
  ].join(":");
}

/** steer 乐观消息本地标记（仅前端内存，不写盘；投递时按 key 去重替换）。 */
type SteerOptimisticMessage = AgentMessage & { _steerOptimistic?: boolean };

function userMessageKey(message: Partial<AgentMessage>): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return JSON.stringify({ text: content, images: [] });
  if (!Array.isArray(content)) return JSON.stringify({ text: "", images: [] });
  return JSON.stringify({
    text: extractMessageText(message),
    images: content.map(imageSignature).filter(Boolean),
  });
}

function readCompactResult(result: unknown, reason: string): CompactResultInfo | null {
  if (!result || typeof result !== "object") return null;
  const r = result as CompactCommandResult;
  if (typeof r.tokensBefore !== "number" || typeof r.estimatedTokensAfter !== "number") return null;
  return { reason, tokensBefore: r.tokensBefore, estimatedTokensAfter: r.estimatedTokensAfter };
}

export type { AttachedImage, ChatInputHandle } from "@/lib/types";

type SelectedModel = { provider: string; modelId: string };
type ModelEntry = { id: string; name: string; provider: string };
type ModelsResponse = {
  models: Record<string, string>;
  modelList?: ModelEntry[];
  defaultModel?: SelectedModel | null;
  thinkingLevels?: Record<string, string[]>;
  thinkingLevelMaps?: Record<string, Record<string, string | null>>;
  /** providerId → 是否已有可用凭据；未认证且无环境凭据的 provider 模型在 UI 灰显。 */
  authConfigured?: Record<string, boolean>;
};

type SlashCommandsResponse = {
  commands?: SlashCommandInfo[];
};

export function useAgentSession(opts: UseAgentSessionOptions) {
  const { t } = useI18n();
  const {
    session, newSessionCwd, newSessionIntentId, onAgentEnd, onAgentRunningChange, onSessionCreated, onSessionForked,
    modelsRefreshKey, onBranchDataChange, onSystemPromptChange, onSessionStatsPanelOpen,
  } = opts;

  const isNew = session === null && newSessionCwd !== null;
  // intent 捕获的 cwd/id：避免用户随后切项目导致 ensure body 漂移。
  const newSessionCwdRef = useRef(newSessionCwd);
  const newSessionIntentIdRef = useRef(newSessionIntentId ?? null);
  newSessionCwdRef.current = newSessionCwd;
  newSessionIntentIdRef.current = newSessionIntentId ?? null;
  // 只读（subagent 持久化）会话能力：UI 层先行拦截一切会产生 AgentSession
  // 或写会话的操作；后端 requireWritableSession 仍是权威防线。
  const capabilities = getSessionCapabilities(session);
  const isReadOnly = capabilities.readOnly;

  const [data, setData] = useState<SessionData | null>(null);
  const [loading, setLoading] = useState(!isNew);
  /** 向上拉取更旧历史中（不阻塞输入/发送）。 */
  const [historyLoading, setHistoryLoading] = useState(false);
  /** 当前内存窗口之前是否还有更旧消息（服务端 tail/before 分页）。 */
  const [hasMoreBefore, setHasMoreBefore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeLeafId, setActiveLeafId] = useState<string | null>(null);
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [entryIds, setEntryIds] = useState<string[]>([]);
  const historyLoadingRef = useRef(false);
  const hasMoreBeforeRef = useRef(false);
  const [streamState, dispatch] = useReducer(streamReducer, { isStreaming: false, streamingMessage: null });
  const [agentRunning, setAgentRunning] = useState(false);
  const [lockedByOther, setLockedByOther] = useState(false);
  const [bashRunning, setBashRunning] = useState(false);
  const [pendingBash, setPendingBash] = useState<{ command: string; excludeFromContext: boolean; startedAt: number } | null>(null);
  const [modelNames, setModelNames] = useState<Record<string, string>>({});
  const [modelList, setModelList] = useState<ModelEntry[]>([]);
  const [modelThinkingLevels, setModelThinkingLevels] = useState<Record<string, string[]>>({});
  const [modelThinkingLevelMaps, setModelThinkingLevelMaps] = useState<Record<string, Record<string, string | null>>>({});
  // providerId → 该 provider 是否有可用凭据（未认证且无环境凭据 → false）。
  // 模型下拉据此灰显不可用模型，避免用户选择必然失败的 provider。
  const [modelAuthConfigured, setModelAuthConfigured] = useState<Record<string, boolean>>({});
  const [newSessionModel, setNewSessionModel] = useState<SelectedModel | null>(null);
  const [newSessionDefaultModel, setNewSessionDefaultModel] = useState<SelectedModel | null>(null);
  const [settingsDefaultThinking, setSettingsDefaultThinking] = useState<AgentThinkingLevel | null>(null);
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevelOption | null>(null);
  // settings.json 默认只服务于新会话引导页；已有会话没有自己的档位时为 off，
  // 不得把全局默认带入其它会话。
  const resolvedThinking: AgentThinkingLevel = isNew
    ? thinkingLevel ?? settingsDefaultThinking ?? "off"
    : thinkingLevel ?? "off";
  const [retryInfo, setRetryInfo] = useState<{ attempt: number; maxAttempts: number; errorMessage?: string } | null>(null);
  const [contextUsage, setContextUsage] = useState<{ percent: number | null; contextWindow: number; tokens: number | null } | null>(null);
  const [systemPrompt, setSystemPrompt] = useState<string | null>(null);
  const [forkingEntryId, setForkingEntryId] = useState<string | null>(null);
  const [currentModelOverride, setCurrentModelOverride] = useState<{ provider: string; modelId: string } | null>(null);
  const [pendingModel, setPendingModel] = useState<{ provider: string; modelId: string } | null>(null);
  /** pendingModel 的 ref 副本（handleSend 闭包读取最新值） */
  const pendingModelRef = useRef<{ provider: string; modelId: string } | null>(null);
  const [isCompacting, setIsCompacting] = useState(false);
  const [compactError, setCompactError] = useState<string | null>(null);
  const [compactResult, setCompactResult] = useState<CompactResultInfo | null>(null);
  const [agentPhase, setAgentPhase] = useState<AgentPhase>(null);
  // P4a 实时工具执行缓冲：以 toolCallId 键控的快照数组（插入序），由
  // tool_execution_start/update/end 事件驱动；UI（MessageView 实时工具视图）暂未消费。
  const [toolExecutionSnapshots, setToolExecutionSnapshots] = useState<ToolExecutionSnapshot[]>([]);
  const [slashCommands, setSlashCommands] = useState<SlashCommandInfo[]>([]);
  const [slashCommandsLoading, setSlashCommandsLoading] = useState(false);
  // notice/activity 展示状态所有权（#17 D5c + #23 每会话队列）：
  // 通知按 sessionId 入队，当前加载的会话展示其 FIFO 投影（3 普通 + 3 高级）。
  const { notices, liveNoticeActivities, addNotice, addLiveActivity, clearLiveActivities, dismissNotice, toggleNoticePin } = useNoticeState(session?.id ?? null);
  const [sessionStatsOverride, setSessionStatsOverride] = useState<SessionStatsInfo | null>(null);
  // extension UI 展示状态（#17 D5c）：5 state + ref + 3 更新回调已抽至 useExtensionUiState。
  const {
    extensionDialog, extensionCustomUi, extensionStatuses, extensionWidgets,
    extensionUiStateRef, commitExtensionUiState, patchExtensionUiState, dismissExtensionUiRequest,
  } = useExtensionUiState();
  const [queuedMessages, setQueuedMessages] = useState<QueuedMessages>({ steering: [], followUp: [] });
  // 每会话本地 follow-up 队列：localFollowUpRef 始终指向当前会话条目的投影，
  // 会话切换只换映射条目，不携带上一会话队列；每会话条目内容与 Host 持久化
  // sessionQueue.<sid> 一致（当前会话由 Host 自动投递，非当前会话队列保留在服务端）。
  const sessionQueuesRef = useRef<Map<string, string[]>>(new Map());
  const currentQueueSessionIdRef = useRef<string | null>(session?.id ?? null);
  // 当前会话的 followUp 投影（作为最后显示的队列块来源）
  const localFollowUpRef = useRef<string[]>([]);
  const localQueueOwnerRef = useRef<string | null>(session?.id ?? null);
  const followUpSyncRef = useRef<Promise<void>>(Promise.resolve());
  const applySessionLocalQueue = useCallback((sid: string | null, next: string[]) => {
    if (!sid) return;
    const map = new Map(sessionQueuesRef.current);
    if (next.length === 0) map.delete(sid);
    else map.set(sid, [...next]);
    sessionQueuesRef.current = map;
    if (localQueueOwnerRef.current === sid) {
      localFollowUpRef.current = [...next];
      setQueuedMessages({ steering: [], followUp: [...next] });
    }
  }, []);
  const applyLocalFollowUpQueue = useCallback((next: string[]) => {
    applySessionLocalQueue(currentQueueSessionIdRef.current, next);
  }, [applySessionLocalQueue]);
  const applyProjectedQueues = useCallback((value?: AgentStateResponse["queuedMessages"]) => {
    const next = normalizeQueuedMessages(value);
    applyLocalFollowUpQueue(next.followUp);
    setQueuedMessages({ steering: next.steering, followUp: next.followUp });
  }, [applyLocalFollowUpQueue]);
  const updateLocalFollowUp = useCallback(async (next: string[]) => {
    const previous = localFollowUpRef.current;
    const applied = [...next];
    applyLocalFollowUpQueue(applied);
    const sid = sessionIdRef.current;
    if (!sid) return;
    const sync = followUpSyncRef.current
      .catch(() => undefined)
      .then(async () => {
        // Host 同步持久化并在 settled 后投递；浏览器不再并发写同一 queue prefs。
        await sendAgentCommand(sid, { type: "set_follow_up_queue", items: applied });
      });
    followUpSyncRef.current = sync.catch(() => undefined);
    try {
      await sync;
    } catch (error) {
      if (sessionIdRef.current === sid && localFollowUpRef.current === applied) {
        applyLocalFollowUpQueue(previous);
      }
      throw error;
    }
  }, [applyLocalFollowUpQueue]);
  // 分支切换/总结进行中：树节点、发送与再次导航全部暂停，避免与 navigateTree 并发写。
  const [branchBusy, setBranchBusy] = useState(false);

  const eventSourceRef = useRef<EventSource | null>(null);
  const runtimeSubscriptionRef = useRef<RegistrySubscription | null>(null);
  const sessionIdRef = useRef<string | null>(session?.id ?? null);
  /** 每次 render 用当前 props/refs 构造的导航 target token；旧闭包只读它做 CAS。 */
  const currentTargetTokenRef = useRef<ChatTargetToken | null>(null);
  currentTargetTokenRef.current = captureChatTargetToken({
    isNew,
    intentId: newSessionIntentId ?? newSessionIntentIdRef.current,
    persistedSessionId: isNew ? null : (session?.id ?? null),
  });
  /** 切换会话时取消进行中的后台 wake，避免串台写 systemPrompt */
  const wakeAbortRef = useRef<AbortController | null>(null);
  // 侧栏运行中指示：agentRunning 在 ensureEventsConnected 前已置位（冷启动窗口），
  // 比 SSE running 更早，用于消除「发送后好几秒才显示运行中」。
  useEffect(() => {
    onAgentRunningChange?.(agentRunning, sessionIdRef.current ?? session?.id ?? null);
  }, [agentRunning, session?.id, onAgentRunningChange]);
  const messagesSessionIdRef = useRef<string | null>(session?.id ?? null);
  const entryIdsRef = useRef<string[]>([]);
  const getRuntimeAgentRunning = useCallback((sessionId?: string | null): boolean => {
    const sid = sessionId
      ?? sessionIdRef.current
      ?? (newSessionIntentIdRef.current ? pendingSessionId(newSessionIntentIdRef.current) : null);
    return sid ? getOrCreateBrowserSessionRuntimeRegistry().getRunState(sid)?.agentRunning === true : false;
  }, []);
  const abortRequestedRef = useRef(false);
  const bashRunningRef = useRef(false);
  const branchBusyRef = useRef(false);
  const bashRecoveryIdRef = useRef(0);
  const handleAgentEventRef = useRef<((event: AgentEvent, eventRunId?: number) => void) | null>(null);
  const handleFollowUpRef = useRef<(message: string, images?: AttachedImage[]) => Promise<void>>(async () => {});
  const executeBashRef = useRef<(command: string, excludeFromContext: boolean) => Promise<boolean> | undefined>(undefined);
  const {
    scrollContainerRef,
    jumpButtonVisible,
    jumpToBottom,
    notifyAutoFollowSend,
    notifyAutoFollowBranchReset,
    notifyAutoFollowEnd,
    markExternalScrollWrite,
    notifyProgrammaticSmooth,
  } = useChatAutoFollow({
    isMobile: opts.isMobile ?? false,
    loading,
    isNew,
    messages,
    agentRunning,
    bashRunning,
  });
  const ensuringNewSessionRef = useRef<Promise<string | null> | null>(null);
  const newSessionPromotedRef = useRef(false);
  const optimisticUserMessageKeyRef = useRef<string | null>(null);
  /** prompt 命令已提交成功（防止切走/收尾竞态把已发送消息回滚成失败） */
  const promptSubmittedRef = useRef(false);

  const lastTodosBySessionRef = useRef<{ sessionId: string; todos: readonly import("@/lib/todo-parser").TodoItem[] } | null>(null);
  const todos = useMemo(() => {
    const todoMessages = streamState.streamingMessage
      ? [...messages, streamState.streamingMessage as AgentMessage]
      : messages;
    const snapshot = parseLatestTodoSnapshot(todoMessages);
    const sid = session?.id ?? sessionIdRef.current ?? "";
    if (snapshot) {
      lastTodosBySessionRef.current = { sessionId: sid, todos: snapshot };
      return snapshot;
    }
    // 尾页加载可能切掉更早的 todowrite：同会话保留上一合法快照，避免待办面板闪没。
    const cached = lastTodosBySessionRef.current;
    return cached && cached.sessionId === sid ? cached.todos : [];
  }, [messages, streamState.streamingMessage, session?.id]);

  // SSE 由 BrowserSessionRuntimeRegistry 唯一持有；本 hook 只 attach/订阅 snapshot。

  // P1-2：显示模型按固定优先级解析——用户手动选择（override）最高，其次
  // 新会话发送中携带的选择（pending），再其次磁盘持久化 model_change
  // （context.model），最后才是默认配置。extension 通知/subagent 完成提示/
  // activity/custom 消息都不会写入 override，因此不会覆盖用户选择。
  // 全局默认模型只用于新会话引导；已有会话只读自身 override/pending/model_change。
  const currentModel = resolveDisplayModel(
    currentModelOverride,
    pendingModel,
    data?.context.model,
    isNew ? newSessionDefaultModel : null,
  );
  const displayModel = isNew ? (newSessionModel ?? newSessionDefaultModel) : currentModel;

  const sessionStats = useMemo(() => {
    if (sessionStatsOverride) return sessionStatsOverride;
    const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
    let cost = 0;
    let userMessages = 0;
    let assistantMessages = 0;
    let toolResults = 0;
    let toolCalls = 0;
    for (const msg of messages) {
      if (msg.role === "user") userMessages += 1;
      if (msg.role === "toolResult") toolResults += 1;
      if (msg.role !== "assistant") continue;
      assistantMessages += 1;
      const u = (msg as import("@/lib/types").AssistantMessage).usage;
      toolCalls += (msg as import("@/lib/types").AssistantMessage).content.filter((c) => c.type === "toolCall").length;
      if (!u) continue;
      tokens.input += u.input ?? 0;
      tokens.output += u.output ?? 0;
      tokens.cacheRead += u.cacheRead ?? 0;
      tokens.cacheWrite += u.cacheWrite ?? 0;
      cost += u.cost?.total ?? 0;
    }
    tokens.total = tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite;
    if (tokens.total === 0 && messages.length === 0) return null;
    return {
      sessionFile: data?.filePath || undefined,
      sessionId: sessionIdRef.current ?? session?.id ?? "",
      sessionName: session?.name,
      userMessages,
      assistantMessages,
      toolCalls,
      toolResults,
      totalMessages: messages.length,
      tokens,
      cost,
      ...(contextUsage ? { contextUsage } : {}),
    } satisfies SessionStatsInfo;
  }, [messages, sessionStatsOverride, contextUsage, data?.filePath, session?.id, session?.name]);

  const loadSession = useCallback(async (
    sid: string,
    showLoading = false,
    includeState = false,
    reportSuccess = false,
    resetBranchFollow = false,
    onMessagesReplaced?: () => void,
  ) => {
    let messagesLoaded = false;
    try {
      if (showLoading) setLoading(true);
      const registry = getOrCreateBrowserSessionRuntimeRegistry();
      const hydrateSinceSeq = registry.getSnapshot(sid)?.timelineSeq ?? 0;
      // 切换会话：先清上一会话的 live 投影，避免 systemPrompt/用量串台
      if (includeState) {
        setSystemPrompt(null);
        setContextUsage(null);
      }
      // tail-first：首屏只拉最新 N 条，尽快结束 loading；更旧历史按需 prepend。
      const hydrateRequestSeq = registry.beginHydrate(sid);
      const params = new URLSearchParams({
        deferThinking: "1",
        deferMedia: "1",
        limit: String(DEFAULT_SESSION_TAIL_LIMIT),
      });
      const res = await fetch(`/api/sessions/${encodeURIComponent(sid)}?${params}`);
      if (res.status === 404) {
        if (showLoading) {
          setData(null);
          setActiveLeafId(null);
          setMessages([]);
          entryIdsRef.current = [];
          messagesSessionIdRef.current = sid;
          setEntryIds([]);
          hasMoreBeforeRef.current = false;
          setHasMoreBefore(false);
          setError(null);
        }
        return null;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d = await res.json() as SessionData;
      if (sessionIdRef.current !== sid) return null;
      const runState = registry.getRunState(sid);
      if (
        runState?.finishingRunId !== null
        && runState?.finishingRunId !== runState?.promptRunId
      ) {
        return null;
      }
      const tailEntryIds = d.context.entryIds ?? [];
      const tailMessages = d.context.messages ?? [];
      const previousEntryIds = entryIdsRef.current;
      const sameSession = messagesSessionIdRef.current === sid;
      // 同会话 tail 再拉（agent_end / 内部 reload）：保留已 prepend 的更旧前缀。
      // 只有分支导航成功拿到整体会话、即将应用新 context 时才重置跟随；
      // 请求失败/取消不会改变当前阅读位置。
      if (resetBranchFollow) notifyAutoFollowBranchReset();
      setData(d);
      setActiveLeafId(d.leafId);
      let resolvedEntryIds = tailEntryIds;
      let hydratedMessages = tailMessages;
      setMessages((previous) => {
        const base = sameSession && previousEntryIds.length > 0
          ? mergeTailReload({
              previousMessages: previous,
              previousEntryIds,
              nextMessages: tailMessages,
              nextEntryIds: tailEntryIds,
            })
          : { messages: tailMessages, entryIds: tailEntryIds };
        resolvedEntryIds = base.entryIds;
        hydratedMessages = sameSession
          ? preserveCustomRenderedLines(previous, previousEntryIds, base.messages, base.entryIds)
          : base.messages;
        return hydratedMessages;
      });
      // 整体替换完成：调用方（agent_end 收尾）可在此延长 settle 窗口 / 标记 end-pin，
      // 覆盖异步返回晚于 settle 窗口时的高度突变（流式占位消失 → 钳位跳变）。
      onMessagesReplaced?.();
      // entryIds 与 messages 同一 merge 规则（不依赖 setState 时序：再算一次纯函数）
      if (sameSession && previousEntryIds.length > 0) {
        resolvedEntryIds = mergeTailReload({
          previousMessages: tailMessages,
          previousEntryIds,
          nextMessages: tailMessages,
          nextEntryIds: tailEntryIds,
        }).entryIds;
      }
      entryIdsRef.current = resolvedEntryIds;
      messagesSessionIdRef.current = sid;
      setEntryIds(resolvedEntryIds);
      const appliedHydrate = getOrCreateBrowserSessionRuntimeRegistry().hydrate(
        sid,
        hydratedMessages,
        resolvedEntryIds,
        { sinceSeq: hydrateSinceSeq, hydrateRequestSeq },
      );
      if (!appliedHydrate) {
        const live = getOrCreateBrowserSessionRuntimeRegistry().getSnapshot(sid);
        if (live) {
          setMessages(live.messages);
          setEntryIds(live.entryIds);
          entryIdsRef.current = live.entryIds;
        }
      }
      const more = d.context.hasMoreBefore === true
        || (typeof d.context.totalMessageCount === "number"
          && d.context.totalMessageCount > resolvedEntryIds.length);
      hasMoreBeforeRef.current = more;
      setHasMoreBefore(more);
      // P1-2：override 不再无条件清除——改为「吸附」：磁盘 model_change 已与
      // 用户选择一致时让磁盘权威接管（清除 override）；磁盘缺失/不一致（写盘
      // 竞态、fork 后新会话无 model_change）时保留 override，防止 run 结束 /
      // reload / subagent 完成等内部 loadSession 把用户选择覆盖回落默认。
      setCurrentModelOverride((prev) => settleModelOverride(prev, d.context.model));
      setError(null);
      if (isThinkingLevel(d.context.thinkingLevel)) {
        // off 也是会话的有效值，必须覆盖上一个会话遗留的深度。
        setThinkingLevel(d.context.thinkingLevel);
      }

      messagesLoaded = true;
      if (showLoading) setLoading(false);
      // D3 写动作按需请求成功标记；其它既有调用仍保持 null 返回语义。
      if (!includeState) return reportSuccess ? true : null;

      // —— 状态：热路径同步（已 live，毫秒级）；冷 ensureLive 后台异步 ——
      // 消息已先展示。后台 wake 与发送共用服务端 start lock，不会双开 host。
      const applyLiveState = (liveState: AgentStateResponse) => {
        if (liveState.contextUsage !== undefined) setContextUsage(liveState.contextUsage ?? null);
        if (liveState.systemPrompt !== undefined) setSystemPrompt(liveState.systemPrompt ?? null);
        if (liveState.thinkingLevel !== undefined) {
          if (isThinkingLevel(liveState.thinkingLevel)) setThinkingLevel(liveState.thinkingLevel);
        }
        if (liveState.extensionStatuses !== undefined) {
          patchExtensionUiState({ statuses: liveState.extensionStatuses ?? [] });
        }
        if (liveState.extensionWidgets !== undefined) {
          patchExtensionUiState({ widgets: liveState.extensionWidgets ?? [] });
        }
        if (liveState.queuedMessages !== undefined) {
          applyProjectedQueues(liveState.queuedMessages);
        }
        if (Array.isArray(liveState.pendingExtensionRequests)) {
          const queue = (liveState.pendingExtensionRequests as AgentEvent[])
            .filter((e): e is ExtensionUiBlockingRequest => {
              const method = (e as { method?: string }).method;
              return method === "select" || method === "confirm" || method === "input" || method === "editor";
            });
          if (queue.length > 0) {
            patchExtensionUiState({
              blockingQueue: queue,
              ...projectBlockingHead(queue),
            });
          }
        }
      };

      try {
        // 热：不 wake。打开会话只读投影，不抢写锁；发送时再 ensureLive。
        const hotRes = await fetch(`/api/sessions/${encodeURIComponent(sid)}/state`);
        if (hotRes.ok) {
          const hot = await hotRes.json() as {
            live?: boolean;
            running?: boolean;
            activeRun?: boolean;
            lockedByOther?: boolean;
            state?: AgentStateResponse;
          };
          if (sessionIdRef.current !== sid) return null;
          const live = readAgentLiveFlag(hot);
          if (live && hot.state) {
            setLockedByOther(false);
            applyLiveState(hot.state);
            return { running: live, live, activeRun: hot.activeRun === true, lockedByOther: false, state: hot.state };
          }
          setLockedByOther(hot.lockedByOther === true);
          if (!live) {
            setQueuedMessages({ steering: [], followUp: [...localFollowUpRef.current] });
          }
          return { running: false, live: false, activeRun: false, lockedByOther: hot.lockedByOther === true };
        }

        setLockedByOther(false);
        return { running: false, live: false, activeRun: false, lockedByOther: false };
      } catch (e) {
        console.error("Failed to load agent state:", e);
        return null;
      }
    } catch (e) {
      setError(String(e));
      return null;
    } finally {
      if (showLoading && !messagesLoaded) setLoading(false);
    }
  }, [applyProjectedQueues, notifyAutoFollowBranchReset, patchExtensionUiState]);

  /**
   * 向上滚动加载更旧历史（OpenChamber loadOlder 语义）。
   * 不置 loading，不阻塞发送；prepend 后由 ChatWindow 做滚轴补偿。
   */
  const loadOlderHistory = useCallback(async (): Promise<boolean> => {
    const sid = sessionIdRef.current;
    if (!sid || !hasMoreBeforeRef.current || historyLoadingRef.current) return false;
    const before = entryIdsRef.current[0];
    if (!before) return false;
    historyLoadingRef.current = true;
    setHistoryLoading(true);
    const registry = getOrCreateBrowserSessionRuntimeRegistry();
    const hydrateRequestSeq = registry.beginHydrate(sid);
    try {
      const params = new URLSearchParams({
        deferThinking: "1",
        deferMedia: "1",
        before,
        limit: String(DEFAULT_SESSION_HISTORY_PAGE),
      });
      if (activeLeafId) params.set("leafId", activeLeafId);
      const res = await fetch(`/api/sessions/${encodeURIComponent(sid)}/context?${params}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d = await res.json() as {
        context: {
          messages: AgentMessage[];
          entryIds: string[];
          hasMoreBefore?: boolean;
          totalMessageCount?: number;
        };
      };
      if (sessionIdRef.current !== sid) return false;
      const olderIds = d.context.entryIds ?? [];
      const olderMsgs = d.context.messages ?? [];
      if (olderIds.length === 0) {
        hasMoreBeforeRef.current = false;
        setHasMoreBefore(false);
        return false;
      }
      const prevIds = entryIdsRef.current;
      let nextMessages: AgentMessage[] = [];
      const nextEntryIds = prependOlderPage({
        previousMessages: olderMsgs,
        previousEntryIds: prevIds,
        olderMessages: olderMsgs,
        olderEntryIds: olderIds,
      }).entryIds;
      setMessages((previous) => {
        nextMessages = prependOlderPage({
          previousMessages: previous,
          previousEntryIds: prevIds,
          olderMessages: olderMsgs,
          olderEntryIds: olderIds,
        }).messages;
        return nextMessages;
      });
      entryIdsRef.current = nextEntryIds;
      setEntryIds(nextEntryIds);
      registry.hydrate(sid, nextMessages, nextEntryIds, { hydrateRequestSeq });
      const more = d.context.hasMoreBefore === true
        || (typeof d.context.totalMessageCount === "number"
          && d.context.totalMessageCount > nextEntryIds.length);
      hasMoreBeforeRef.current = more;
      setHasMoreBefore(more);
      return true;
    } catch (e) {
      console.error("Failed to load older history:", e);
      return false;
    } finally {
      historyLoadingRef.current = false;
      setHistoryLoading(false);
    }
  }, [activeLeafId]);

  const loadContext = useCallback(async (sid: string, leafId: string | null) => {
    try {
      // 分支切换：同样 tail-first，避免整包阻塞
      const params = new URLSearchParams({
        deferThinking: "1",
        deferMedia: "1",
        limit: String(DEFAULT_SESSION_TAIL_LIMIT),
      });
      if (leafId) params.set("leafId", leafId);
      const url = `/api/sessions/${encodeURIComponent(sid)}/context?${params}`;
      const registry = getOrCreateBrowserSessionRuntimeRegistry();
      const hydrateRequestSeq = registry.beginHydrate(sid);
      const hydrateSinceSeq = registry.getSnapshot(sid)?.timelineSeq ?? 0;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d = await res.json() as {
        context: {
          messages: AgentMessage[];
          entryIds: string[];
          hasMoreBefore?: boolean;
          totalMessageCount?: number;
        };
      };
      if (sessionIdRef.current !== sid) return;
      const nextEntryIds = d.context.entryIds ?? [];
      const previousEntryIds = entryIdsRef.current;
      const shouldPreserveRenderedLines = messagesSessionIdRef.current === sid;
      // 仅在成功拿到新 context、即将写入 state 时重置跟随；fetch 失败不遗留 pending。
      notifyAutoFollowBranchReset();
      let hydrated = d.context.messages;
      setMessages((previous) => {
        hydrated = shouldPreserveRenderedLines
          ? preserveCustomRenderedLines(previous, previousEntryIds, d.context.messages, nextEntryIds)
          : d.context.messages;
        return hydrated;
      });
      entryIdsRef.current = nextEntryIds;
      messagesSessionIdRef.current = sid;
      setEntryIds(nextEntryIds);
      const appliedHydrate = getOrCreateBrowserSessionRuntimeRegistry().hydrate(
        sid,
        hydrated,
        nextEntryIds,
        { sinceSeq: hydrateSinceSeq, hydrateRequestSeq },
      );
      if (!appliedHydrate) {
        const live = getOrCreateBrowserSessionRuntimeRegistry().getSnapshot(sid);
        if (live) {
          setMessages(live.messages);
          setEntryIds(live.entryIds);
          entryIdsRef.current = live.entryIds;
        }
      }
      const more = d.context.hasMoreBefore === true
        || (typeof d.context.totalMessageCount === "number"
          && d.context.totalMessageCount > nextEntryIds.length);
      hasMoreBeforeRef.current = more;
      setHasMoreBefore(more);
    } catch (e) {
      console.error("Failed to load context:", e);
    }
  }, [notifyAutoFollowBranchReset]);

  const loadTools = useCallback(async (_sid: string) => {
    // 外部 Pi RPC 无 get_tools；工具由会话启动 allow-list 控制，无需探测。
    if (isReadOnly) return;
  }, [isReadOnly]);

  const promoteNewSession = useCallback((messageCount = 0, firstMessage = "(no messages)") => {
    const sid = sessionIdRef.current;
    const cwd = newSessionCwdRef.current;
    if (!isNew || !cwd || !sid || newSessionPromotedRef.current) return;
    newSessionPromotedRef.current = true;
    onSessionCreated?.({
      id: sid,
      path: "",
      cwd,
      name: undefined,
      created: new Date().toISOString(),
      modified: new Date().toISOString(),
      messageCount,
      firstMessage,
    }, newSessionIntentIdRef.current);
  }, [isNew, onSessionCreated]);

  const ensureNewSession = useCallback(async () => {
    if (sessionIdRef.current) return sessionIdRef.current;
    const cwd = newSessionCwdRef.current;
    if (!isNew || !cwd) return sessionIdRef.current;
    if (ensuringNewSessionRef.current) return ensuringNewSessionRef.current;

    const ensureCwd = cwd;
    const intentAtEnsure = newSessionIntentIdRef.current;
    const promise = (async () => {
      const selectedModel = newSessionModel ?? newSessionDefaultModel;
      const res = await fetch("/api/agent/new", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cwd: ensureCwd,
          type: "ensure_session",
          ...(selectedModel ? { provider: selectedModel.provider, modelId: selectedModel.modelId } : {}),
          ...(() => {
            const level = thinkingLevelForEnsureBody(resolvedThinking);
            return level ? { thinkingLevel: level } : {};
          })(),
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const result = await res.json() as { sessionId: string };
      const realId = result.sessionId;
      if (newSessionIntentIdRef.current === intentAtEnsure) {
        sessionIdRef.current = realId;
      }
      return realId;
    })();

    ensuringNewSessionRef.current = promise;
    try {
      return await promise;
    } finally {
      if (ensuringNewSessionRef.current === promise) {
        ensuringNewSessionRef.current = null;
      }
    }
  }, [isNew, newSessionModel, newSessionDefaultModel, resolvedThinking]);

  const loadSlashCommands = useCallback(async () => {
    // 只读会话：get_commands 会经 /api/agent 启动 AgentSession，直接返回空集。
    if (isReadOnly) {
      setSlashCommands([]);
      return [] as SlashCommandInfo[];
    }
    // 新会话空态：禁止因 slash 菜单 mount 而提前 POST /api/agent/new。
    // 仅当已有真实 sid（用户已写操作 ensure 成功）才拉 commands。
    const sid = sessionIdRef.current ?? session?.id ?? null;
    if (!sid) {
      setSlashCommands([]);
      return [] as SlashCommandInfo[];
    }
    setSlashCommandsLoading(true);
    try {
      const data = await sendAgentCommand<SlashCommandsResponse>(sid, { type: "get_commands" });
      const commands = data?.commands ?? [];
      setSlashCommands(commands);
      return commands;
    } catch (e) {
      console.error("Failed to load slash commands:", e);
      setSlashCommands([]);
      return [] as SlashCommandInfo[];
    } finally {
      setSlashCommandsLoading(false);
    }
  }, [isReadOnly, session?.id]);

  const ensureEventsConnected = useCallback((sid: string) => {
    if (!capabilities.canConnectEvents) return;
    const registry = getOrCreateBrowserSessionRuntimeRegistry();
    registry.ensureEventsConnected(sid);
    eventSourceRef.current = registry.getEventSource(sid) as unknown as EventSource | null;
  }, [capabilities.canConnectEvents]);

  const respondToExtensionUi = useCallback(async (
    request: ExtensionUiDialogRequest,
    response: { value: string } | { confirmed: boolean } | { cancelled: true },
  ) => {
    if (!capabilities.canSendSessionCommands) return;
    const sid = sessionIdRef.current;
    // 按 id 从 FIFO 移除并推进；旧卡片延迟回调若 id 已不在队列则忽略，绝不伪造响应。
    const currentState = extensionUiStateRef.current;
    const nextState = clearExtensionUiRequest(currentState, request.id);
    if (nextState === currentState) return;
    commitExtensionUiState(nextState);
    if (!sid) return;
    try {
      // 对齐 TUI：select/confirm/input/editor 的响应原样回传插件（选项点击即返回，
      // 无 Other 哨兵改写——ask-user 的自由文本由插件自行发起 input 请求）。
      await sendAgentCommand(sid, {
        type: "extension_ui_response",
        id: request.id,
        ...response,
      });
      // OpenChamber 语义：取消问题块 = 终止当前执行（agent 阻塞在扩展请求上）。
      // 防护：若取消响应期间 agent 已自行停止（或用户已先停止），不再补发 abort，
      // 避免误中止之后新启动的 run。
      if ("cancelled" in response && response.cancelled === true && getRuntimeAgentRunning()) {
        try {
          await sendAgentCommand(sid, { type: "abort" });
        } catch {
          // abort 失败不阻断 cancelled 响应本身。
        }
      }
    } catch (e) {
      console.error("Failed to send extension UI response:", e);
    }
  }, [capabilities.canSendSessionCommands, commitExtensionUiState, extensionUiStateRef]);

  const sendExtensionCustomInput = useCallback(async (request: ExtensionUiCustomRequest, data: string) => {
    if (!capabilities.canSendSessionCommands) return;
    const sid = sessionIdRef.current;
    if (!sid) return;
    // 关闭或切换到下一次 custom 请求后，旧输入事件不能再写入代理会话。
    if (extensionUiStateRef.current.customUi?.id !== request.id) return;
    try {
      await sendAgentCommand(sid, {
        type: "extension_ui_input",
        id: request.id,
        data,
      });
    } catch (e) {
      console.error("Failed to send extension custom UI input:", e);
    }
  }, [capabilities.canSendSessionCommands, extensionUiStateRef]);

  // ── P3a：分支 / 新会话命令迁出至 useSessionCommands（纯逻辑见该文件）─────
  // 显式注入依赖；branchBusyRef / branchBusy / setBranchBusy 仍是同一门禁，
  // state 所有权保留在本 hook（handleSend / executeBash / dispatchWorkspaceHistoryPrompt 共用）。
  const {
    handleFork,
    handleNavigate,
    handleLeafChange,
    handleBranchHere,
    handleBranchFromAssistant,
    handleNewSessionFromHere,
    handleNewSessionFromAnswer,
    navigateBranch,
    setBranchLabel,
    branchActions,
  } = useSessionCommands({
    sessionIdRef,
    isReadOnly,
    canWrite: capabilities.canSendSessionCommands,
    getAgentRunning: () => getRuntimeAgentRunning(),
    bashRunningRef,
    branchBusyRef,
    branchBusy,
    setBranchBusy,
    setForkingEntryId,
    setActiveLeafId,
    sendAgentCommand,
    loadSession,
    loadContext,
    addNotice,
    chatInputRef: opts.chatInputRef,
    onSessionForked,
  });

  const handleExtensionUiRequest = useCallback((request: ExtensionUiRequest) => {
    const result = applyExtensionUiRequest(extensionUiStateRef.current, request);
    commitExtensionUiState(result.state);
    for (const effect of result.effects) {
      if (effect.type === "notice") {
        addNotice({ id: effect.id, message: effect.message, type: effect.noticeType, activityRecord: effect.activityRecord });
        if (effect.activityRecord) {
          // 服务端已确认写盘，直接并入独立活动投影供 M4 历史面板读取。这里不能调用
          // loadSession：其异步磁盘快照可能晚于 message_end 返回并覆盖较新的 SSE 消息。
          const activity: SessionActivity = {
            version: 1,
            kind: effect.noticeType === "error" ? "error" : "warning",
            title: effect.noticeType === "error" ? "Extension error" : "Extension warning",
            content: effect.message,
            source: "extension.ui.notify",
            requestId: effect.id,
            metadata: { notifyType: effect.noticeType },
          };
          // 写入与 requestId 去重统一收口在 useNoticeState（addLiveActivity）。
          addLiveActivity(activity);
        }
      } else if (effect.type === "setTitle") {
        document.title = effect.title;
      } else {
        opts.chatInputRef?.current?.insertText(effect.text);
      }
    }
  }, [addNotice, addLiveActivity, commitExtensionUiState, opts.chatInputRef, extensionUiStateRef]);

  /**
   * 将 /api/agent 状态快照的附属字段应用到本地 state（散落重复点的统一收口）。
   * 只覆盖显式提供的字段；running/streaming 等执行态由调用方负责。
   */
  const applyAgentStateSnapshot = useCallback((state?: AgentStateResponse | null) => {
    if (!state) return;
    if (state.contextUsage !== undefined) setContextUsage(state.contextUsage ?? null);
    if (state.systemPrompt !== undefined) setSystemPrompt(state.systemPrompt ?? null);
    if (isThinkingLevel(state.thinkingLevel)) setThinkingLevel(state.thinkingLevel);
    if (state.isCompacting !== undefined) setIsCompacting(state.isCompacting);
    if (state.extensionStatuses !== undefined) patchExtensionUiState({ statuses: state.extensionStatuses ?? [] });
    if (state.extensionWidgets !== undefined) patchExtensionUiState({ widgets: state.extensionWidgets ?? [] });
    if (state.queuedMessages !== undefined) {
      applyProjectedQueues(state.queuedMessages);
    }
  }, [applyProjectedQueues, patchExtensionUiState]);

  /**
   * 统一 agent run 结束路径（P2）：agent_end / prompt_done / reconcile idle 三路合一。
   * token（sid/runId/claim）校验通过才进入异步收尾：loadSession（含 includeState，
   * 刷新 contextUsage/systemPrompt/thinkingLevel/extensionStatuses/extensionWidgets/
   * queuedMessages 并顺手覆盖 isCompacting）→ 消息整体替换回调设置 settle/end-pin →
   * 按同一 token 安全结束状态。loadSession 失败也必须在 finally 结束，不得永久 running。
   */
  const finishAgentRun = useCallback(async (sid: string | null, runId: number) => {
    if (!sid) return;
    const registry = getOrCreateBrowserSessionRuntimeRegistry();
    const before = registry.getRunState(sid);
    if (
      sessionIdRef.current !== sid
      || !before
      || before.promptRunId !== runId
      || before.sendInFlight
    ) return;
    // claim 必须在第一个 await 前占住：agent_end/prompt_done/reconcile 共用 slot claim。
    if (!registry.beginRunFinish(sid, runId)) return;
    try {
      const agentState = await loadSession(sid, false, true, false, false, () => {
        if (registry.getRunState(sid)?.promptRunId !== runId) return;
        notifyAutoFollowEnd();
      });
      if (agentState && typeof agentState === "object" && "running" in agentState) {
        applyAgentStateSnapshot(agentState.state);
      }
    } finally {
      const current = registry.getRunState(sid);
      const valid = Boolean(
        current
        && sessionIdRef.current === sid
        && current.promptRunId === runId
        && current.finishingRunId === runId,
      );
      registry.completeRun(sid, runId);
      registry.releaseRunFinish(sid, runId);
      if (!valid) return;
      optimisticUserMessageKeyRef.current = null;
      setAgentRunning(false);
      setAgentPhase(null);
      setRetryInfo(null);
      {
        const nextSnapshots = finalizeRunningToolExecutions(toolExecutionBufferRef.current);
        toolExecutionBufferRef.current = nextSnapshots;
        setToolExecutionSnapshots(getToolExecutionSnapshots(nextSnapshots));
      }
      dispatch({ type: "end" });
      const desktop = getDesktopBridge();
      if (desktop && (document.visibilityState !== "visible" || !document.hasFocus())) {
        void desktop.notify(t("desktop_notificationTitle"), t("desktop_notificationBody"))
          .catch(() => undefined);
      }
      onAgentEnd?.();
    }
  }, [loadSession, onAgentEnd, applyAgentStateSnapshot, dispatch, setAgentRunning, setAgentPhase, setRetryInfo, notifyAutoFollowEnd, t]);

  const waitForPromptSettlement = useCallback(async (sid: string, runId?: number) => {
    const registry = getOrCreateBrowserSessionRuntimeRegistry();
    await delay(PROMPT_SETTLE_INITIAL_DELAY_MS);
    const startedAt = Date.now();

    while (Date.now() - startedAt < PROMPT_SETTLE_MAX_MS) {
      const current = registry.getRunState(sid);
      if (!current?.agentRunning) return;
      if (runId !== undefined && current.promptRunId > runId + 1) return;
      try {
        const result = await registry.reconcile(sid);
        if (!result || result.stale) return;
        applyAgentStateSnapshot(result.state as AgentStateResponse | undefined);
        if (result.shouldFinish) {
          await finishAgentRun(sid, result.runId);
          return;
        }
      } catch {
        // SSE remains the primary completion path.
      }
      await delay(PROMPT_SETTLE_POLL_MS);
    }
  }, [applyAgentStateSnapshot, finishAgentRun]);

  const waitForBashSettlement = useCallback(async (sid: string) => {
    const recoveryId = bashRecoveryIdRef.current + 1;
    bashRecoveryIdRef.current = recoveryId;

    while (
      bashRunningRef.current
      && bashRecoveryIdRef.current === recoveryId
      && sessionIdRef.current === sid
    ) {
      await delay(BASH_STATE_RECONCILE_MS);
      try {
        const res = await fetch(`/api/agent/${encodeURIComponent(sid)}`);
        if (!res.ok) continue;
        const data = await res.json() as { state?: AgentStateResponse };
        if (data.state?.isBashRunning) continue;

        await loadSession(sid);
        if (bashRecoveryIdRef.current !== recoveryId || sessionIdRef.current !== sid) return;
        bashRunningRef.current = false;
        setBashRunning(false);
        setPendingBash(null);
        return;
      } catch {
        // Keep polling while the page is mounted; network recovery is transparent.
      }
    }
  }, [loadSession]);

  // Reconcile client streaming state with the server. When SSE events are
  // missed (network drop, mobile tab backgrounded, half-open connection),
  // agent_end never arrives and the UI stays in streaming state forever.
  // If the server reports idle while we still think it's running, finish
  // through the same path as agent_end / prompt_done.
  const reconcileAgentState = useCallback(async (sid: string) => {
    const registry = getOrCreateBrowserSessionRuntimeRegistry();
    const current = registry.getRunState(sid);
    if (!current?.agentRunning) return;
    try {
      const result = await registry.reconcile(sid);
      if (!result || result.stale) return;
      const state = result.state as AgentStateResponse | undefined;
      // Mirror compaction state unconditionally: a missed compaction_end
      // would otherwise leave the Stop UI stuck.
      setIsCompacting(state?.isCompacting ?? false);
      if (state?.queuedMessages !== undefined) {
        applyProjectedQueues(state.queuedMessages);
      }
      if (result.shouldFinish) {
        await finishAgentRun(sid, result.runId);
      }
    } catch {
      // Network still down — the next poll / visibility / online tick retries.
    }
  }, [applyProjectedQueues, finishAgentRun]);

  // Recovery net for missed SSE events: while the agent is running, verify
  // against the server periodically and whenever the tab returns to the
  // foreground or the network comes back.
  useEffect(() => {
    if (!agentRunning) return;
    const reconcile = () => {
      // Read the ref on every tick: for brand-new sessions the id is
      // assigned only after ensure_session returns.
      const sid = sessionIdRef.current;
      if (sid) void reconcileAgentState(sid);
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") reconcile();
    };
    const interval = setInterval(reconcile, AGENT_STATE_RECONCILE_MS);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", reconcile);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", reconcile);
    };
  }, [agentRunning, reconcileAgentState]);

  // 标签页从后台切回：SSE 可能停在 CLOSED（浏览器冻结/长待机后自动断开）。
  // 切回时统一：重连 SSE + 主动 reconcile + 重拉当前会话尾页，保证消息与
  // 运行态与磁盘权威对齐（切走期间模型可能已输出、队列已投递、分支已推进）。
  const syncOnTabReturn = useCallback(async () => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    const registry = getOrCreateBrowserSessionRuntimeRegistry();
    const source = registry.getEventSource(sid);
    const stillOpen = source && (source.readyState === 1 || source.readyState === 0);
    if (!stillOpen) {
      ensureEventsConnected(sid);
    }
    void reconcileAgentState(sid);
    // 仅重拉运行中的会话尾页；空闲会话 loadSession 会带 live 状态，可能有 SSE 已
    // 送达而 UI 未消费的残余（浏览器冻结时长），重拉是权威收口。
    if (getRuntimeAgentRunning()) {
      void loadSession(sid, false);
    }
  }, [ensureEventsConnected, reconcileAgentState, loadSession]);

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") void syncOnTabReturn();
    };
    const onFocus = () => {
      if (document.visibilityState === "visible") void syncOnTabReturn();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onFocus);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onFocus);
    };
  }, [syncOnTabReturn]);

  // P4a 工具执行缓冲：ref 持有不可变 Map 状态（事件处理零拷贝读取），setState 只同步
  // 数组投影给 React。apply* 为纯函数，非法/迟到事件内部安全忽略并返回原引用。
  const toolExecutionBufferRef = useRef<ToolExecutionBufferState>(new Map());
  const commitToolExecutions = useCallback((next: ToolExecutionBufferState) => {
    toolExecutionBufferRef.current = next;
    setToolExecutionSnapshots(getToolExecutionSnapshots(next));
  }, []);

  const handleAgentEvent = useCallback((event: AgentEvent, eventRunId?: number) => {
    switch (event.type) {
      case "agent_start":
        // registry 在应用事件前递增当前 session 的 run id；hook 只处理视图副作用。
        commitToolExecutions(clearToolExecutions(toolExecutionBufferRef.current));
        setAgentRunning(true);
        setAgentPhase({ kind: "waiting_model" });
        dispatch({ type: "start" });
        break;
      case "agent_end":
      case "prompt_done": {
        const sid = sessionIdRef.current;
        const runId = sid
          ? getOrCreateBrowserSessionRuntimeRegistry().getRunState(sid)?.promptRunId
          : undefined;
        if (sid && runId !== undefined) void finishAgentRun(sid, runId);
        break;
      }
      case "prompt_error":
        if (sessionIdRef.current) setServerPref(`sessionQueueHold.${sessionIdRef.current}`, true);
        // P0-1：prompt 异步失败且乐观 bubble 未被 message_end 消费（消息未确认
        // 落盘）时移除假 bubble，避免永久 pending；真实消息以磁盘权威为准，
        // finishAgentRun 的 loadSession 会重建列表。已消费（消息已确认）时 no-op。
        if (optimisticUserMessageKeyRef.current) {
          const promptErrorKey = optimisticUserMessageKeyRef.current;
          optimisticUserMessageKeyRef.current = null;
          setMessages((prev) => {
            const last = prev[prev.length - 1];
            return last?.role === "user" && userMessageKey(last) === promptErrorKey
              ? prev.slice(0, -1)
              : prev;
          });
        }
        addNotice({ type: "error", message: (event.errorMessage as string | undefined) ?? "Command failed" });
        break;
      case "extension_error":
        if (sessionIdRef.current) setServerPref(`sessionQueueHold.${sessionIdRef.current}`, true);
        addNotice({
          type: "error",
          message: (event.error as string | undefined) ?? "Extension command failed",
        });
        break;
      case "leaf_drift":
        // 外部 Pi 无法恢复非末尾分支：明确提示，避免静默把后续消息挂到错误分支。
        addNotice({
          type: "warning",
          message: t("session_leafDrift"),
        });
        break;
      case "message_start":
      case "message_update": {
        // timeline/stream 由 registry snapshot 驱动；这里只更新 agentPhase。
        if (!getRuntimeAgentRunning()) break;
        const msg = event.message as Partial<AgentMessage> | undefined;
        if (msg?.role === "user") break;
        setAgentPhase(null);
        break;
      }
      case "message_end": {
        if (event.message && (event.message as AgentMessage).role === "user") {
          optimisticUserMessageKeyRef.current = null;
        }
        setAgentPhase({ kind: "waiting_model" });
        break;
      }
      case "tool_execution_start": {
        commitToolExecutions(applyToolExecutionStart(toolExecutionBufferRef.current, event as ToolExecutionStartInput));
        const id = event.toolCallId as string;
        const name = event.toolName as string;
        setAgentPhase((prev) => {
          const tools = prev?.kind === "running_tools" ? [...prev.tools] : [];
          if (!tools.some((t) => t.id === id)) tools.push({ id, name });
          return { kind: "running_tools", tools };
        });
        break;
      }
      case "tool_execution_update": {
        // P4a 实时输出：驱动工具执行缓冲（replace 语义见 lib 层）；agentPhase 不随
        // update 变化，实时内容由缓冲投影提供。end 后迟到的 update 在 lib 层安全忽略。
        commitToolExecutions(applyToolExecutionUpdate(toolExecutionBufferRef.current, event as ToolExecutionUpdateInput));
        break;
      }
      case "tool_call": {
        // 插件 renderCall 由服务端附在 tool_call；复用 start 合并语义，既可补齐
        // 已有 execution_start 快照，也可在事件顺序变化时创建兜底快照。
        commitToolExecutions(applyToolExecutionStart(toolExecutionBufferRef.current, {
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          args: event.input ?? event.args,
          renderedCallLines: event.renderedCallLines,
        }));
        break;
      }
      case "tool_result": {
        // 最终插件渲染收敛进同一快照；若 execution_end 已先到，lib 层只补渲染行，
        // 不改写既有终态。缺字段时仍由原 tool_execution_end / 消息结果负责。
        commitToolExecutions(applyToolExecutionResultRender(toolExecutionBufferRef.current, {
          toolCallId: event.toolCallId,
          renderedResultLines: event.renderedResultLines,
        }));
        break;
      }
      case "tool_execution_end": {
        commitToolExecutions(applyToolExecutionEnd(toolExecutionBufferRef.current, event as ToolExecutionEndInput));
        const id = event.toolCallId as string;
        setAgentPhase((prev) => {
          if (prev?.kind !== "running_tools") return prev;
          const tools = prev.tools.filter((t) => t.id !== id);
          if (tools.length === 0) return { kind: "waiting_model" };
          return { kind: "running_tools", tools };
        });
        break;
      }
      case "follow_up_flushed": {
        // Host 已确认被投递 run 的 user 消息落盘/settled；按 remaining 清本地投影。
        // 持久化也由 Host 同步完成，浏览器不得用旧 prefs 反向覆盖。
        const remaining = Array.isArray(event.remaining)
          ? (event.remaining as unknown[]).filter((item): item is string => typeof item === "string")
          : [];
        applyLocalFollowUpQueue(remaining);
        break;
      }
      case "follow_up_flush_error":
        addNotice({
          type: "error",
          message: (event.errorMessage as string | undefined) ?? "Follow-up queue flush failed",
        });
        break;
      case "queue_update":
        // followUp 以本地队列为准（Pidance 自管）；steering 仍来自 Pi 进程队列
        setQueuedMessages({
          steering: [...((event.steering as string[] | undefined) ?? [])],
          followUp: [...localFollowUpRef.current],
        });
        break;
      case "auto_retry_start":
        setRetryInfo({ attempt: event.attempt as number, maxAttempts: event.maxAttempts as number, errorMessage: event.errorMessage as string | undefined });
        break;
      case "auto_retry_end": {
        setRetryInfo(null);
        // 重试耗尽仍失败：顶栏 notice + 会话内 error 消息双通道
        if (event.success === false) {
          const finalError = typeof event.finalError === "string" && event.finalError.trim()
            ? event.finalError.trim()
            : t("message_apiError");
          addNotice({ type: "error", message: finalError });
        }
        break;
      }
      case "auto_compaction_start":
      case "compaction_start":
        setIsCompacting(true);
        setCompactError(null);
        setCompactResult(null);
        break;
      case "auto_compaction_end":
      case "compaction_end":
        setIsCompacting(false);
        if (event.errorMessage) {
          setCompactError(event.errorMessage as string);
          setCompactResult(null);
        } else if (!event.aborted) {
          setCompactResult(readCompactResult(event.result, (event.reason as string | undefined) ?? "auto"));
          if (sessionIdRef.current) loadSession(sessionIdRef.current);
        }
        break;
      case "extension_ui_request":
        handleExtensionUiRequest(event as ExtensionUiRequest);
        break;
    }
  }, [addNotice, applyLocalFollowUpQueue, commitToolExecutions, finishAgentRun, handleExtensionUiRequest, loadSession, t]);
  handleAgentEventRef.current = handleAgentEvent;

  const handleSend = useCallback(async (message: string, images?: AttachedImage[]): Promise<boolean> => {
    // 只读会话：发送入口 UI 已替换为提示条，这里再拦一层。
    if (isReadOnly) return false;
    const trimmedMessage = message.trim();
    if (!trimmedMessage && !images?.length) return false;
    if (getRuntimeAgentRunning() || bashRunningRef.current) return false;
    // 分支切换/摘要进行中：prompt 会与 navigateTree 并发写会话文件，先拦住。
    if (branchBusyRef.current) {
      addNotice({ type: "info", message: "Branch switch in progress — please wait" });
      return false;
    }
    const isSlashCommandPrompt = !images?.length && trimmedMessage.startsWith("/");

    const isBashCommand = !images?.length && trimmedMessage.startsWith("!");
    if (isBashCommand) {
      const isExcluded = trimmedMessage.startsWith("!!");
      const bashCmd = (isExcluded ? trimmedMessage.slice(2) : trimmedMessage.slice(1)).trim();
      if (!bashCmd) return false;
      return await executeBashRef.current?.(bashCmd, isExcluded) ?? false;
    }

    const imageBlocks = images?.map((img) => ({ type: "image" as const, source: { type: "base64" as const, media_type: img.mimeType, data: img.data } }));
    const userMsg: AgentMessage = {
      role: "user",
      content: imageBlocks?.length
        ? [...(message.trim() ? [{ type: "text" as const, text: message }] : []), ...imageBlocks]
        : message,
      timestamp: Date.now(),
    };
    // 乐观气泡只来自 registry.submitPrompt 的 slot append + subscribe；
    // 本 hook 不再复制一份 user 消息（否则 UI 双条、磁盘一条）。
    // userMsg 仅用于 rejected 回滚的乐观 key 匹配。
    optimisticUserMessageKeyRef.current = userMessageKey(userMsg);
    promptSubmittedRef.current = false;
    abortRequestedRef.current = false;
    setAgentRunning(true);
    setAgentPhase(isSlashCommandPrompt ? { kind: "running_command" } : { kind: "waiting_model" });
    dispatch({ type: "start" });
    // 发送即回到 following 并 instant 到底（pin 在 messages effect 中等 DOM 就绪执行），
    // 不再把刚发出的用户消息 smooth 推到顶部。
    notifyAutoFollowSend();

    // 新会话：ensureLive 可能要数秒，先在侧栏插占位行，避免「消息已发出、列表还没有」
    if (isNew && newSessionCwdRef.current && newSessionIntentIdRef.current && onSessionCreated) {
      const intentId = newSessionIntentIdRef.current;
      const cwd = newSessionCwdRef.current;
      onSessionCreated({
        id: pendingSessionId(intentId),
        path: "",
        cwd,
        projectRoot: cwd,
        created: new Date().toISOString(),
        modified: new Date().toISOString(),
        messageCount: 1,
        firstMessage: trimmedMessage,
      }, intentId);
    }

    const runtime = getOrCreateBrowserSessionRuntimeRegistry();
    const submissionId = generateSubmissionId();
    const intentAtSend = newSessionIntentIdRef.current;
    const draftKey = session?.id
      ?? (isNew && intentAtSend ? `new:${intentAtSend}` : (newSessionCwdRef.current ? `new:${newSessionCwdRef.current}` : "new"));
    const sendToken = captureChatTargetToken({
      isNew,
      intentId: intentAtSend,
      persistedSessionId: isNew ? null : (session?.id ?? null),
    });
    const sendStillCurrent = () => sendToken !== null && sameChatTargetToken(sendToken, currentTargetTokenRef.current);

    try {
      let sentSessionId: string | null = null;
      const target = resolveSubmitTarget({
        isNew,
        intentId: intentAtSend,
        cwd: newSessionCwdRef.current,
        persistedSessionId: session?.id ?? null,
        ensuredSessionId: isNew ? sessionIdRef.current : null,
      });
      if (!target) return false;
      if (target.kind === "new") {
        const selectedModel = newSessionModel ?? newSessionDefaultModel;
        const receipt = await runtime.submitPrompt({
          target,
          submissionId,
          message,
          images,
          draftKey,
          model: selectedModel ?? undefined,
        });
        sentSessionId = receipt.sessionId;
        if (sendStillCurrent()) {
          sessionIdRef.current = receipt.sessionId;
          if (newSessionIntentIdRef.current === intentAtSend) {
            promoteNewSession(1, message);
          }
        }
        if (receipt.status !== "accepted") {
          if (receipt.status === "rejected" && sendStillCurrent()) {
            const optimisticKey = optimisticUserMessageKeyRef.current;
            setMessages((prev) => recoverFailedSend({
              messages: prev,
              optimisticKey,
              isOptimisticMatch: (msg) => userMessageKey(msg) === optimisticKey,
            }).messages);
            optimisticUserMessageKeyRef.current = null;
          }
          return false;
        }
        if (sendStillCurrent()) promptSubmittedRef.current = true;
      } else if (target.kind === "persisted") {
        sentSessionId = target.sessionId;
        if (abortRequestedRef.current) return false;
        // 下一轮生效：应用切换前记录的 pending 模型（引导消息不经过此路径）
        const pendingModelToApply = pendingModelRef.current;
        if (pendingModelToApply) {
          pendingModelRef.current = null;
          setPendingModel(null);
          try {
            await sendAgentCommand(target.sessionId, {
              type: "set_model",
              provider: pendingModelToApply.provider,
              modelId: pendingModelToApply.modelId,
            });
          } catch (e) {
            pendingModelRef.current = pendingModelToApply;
            setPendingModel(pendingModelToApply);
            addNotice({
              type: "error",
              message: t("models_switchFailed", {
                error: e instanceof Error ? e.message : String(e),
              }),
            });
          }
        }
        const receipt = await runtime.submitPrompt({
          target,
          submissionId,
          message,
          images,
          draftKey,
        });
        if (receipt.status !== "accepted") {
          if (receipt.status === "rejected" && sendStillCurrent()) {
            const optimisticKey = optimisticUserMessageKeyRef.current;
            setMessages((prev) => recoverFailedSend({
              messages: prev,
              optimisticKey,
              isOptimisticMatch: (msg) => userMessageKey(msg) === optimisticKey,
            }).messages);
            optimisticUserMessageKeyRef.current = null;
          }
          return false;
        }
        if (sendStillCurrent()) promptSubmittedRef.current = true;
      }
      if (sendStillCurrent() && promptSubmittedRef.current && sentSessionId) {
        setServerPref(`sessionQueueHold.${sentSessionId}`, null);
      }
      if (sendStillCurrent() && isSlashCommandPrompt && sentSessionId) {
        const runId = runtime.getRunState(sentSessionId)?.promptRunId;
        void waitForPromptSettlement(sentSessionId, runId);
      }
      // P0-1：发送已确认（prompt 预检通过 / 消息已提交），返回 true 供
      // ChatInput 确认后才清空 draft。
      return true;
    } catch (e) {
      const aborted = abortRequestedRef.current
        || (e instanceof Error && e.name === "AbortError");
      if (aborted) {
        if (sendStillCurrent() && !promptSubmittedRef.current) {
          setAgentRunning(false);
          setAgentPhase(null);
          dispatch({ type: "end" });
        }
        return false;
      }
      console.error("Failed to send message:", e);
      if (promptSubmittedRef.current) {
        if (sendStillCurrent()) promptSubmittedRef.current = false;
        addNotice({ type: "warning", message: t("chat_sendSubmittedSwitched") });
        return true;
      }
      if (!sendStillCurrent()) return false;
      // P0-1：失败 = 消息未确认进入权威视图 → 移除假 bubble + 保留 draft。
      // 发送失败时乐观 user 消息若仍在列表末尾（未被 message_end 消费），
      // 它是未落地的「假 bubble」；draft 由 insertIfEmpty 恢复（输入框空才写入，
      // 不覆盖用户新输入）。
      const optimisticKey = optimisticUserMessageKeyRef.current;
      let restoreDraft = false;
      setMessages((prev) => {
        const recovery = recoverFailedSend({
          messages: prev,
          optimisticKey,
          isOptimisticMatch: (msg) => userMessageKey(msg) === optimisticKey,
        });
        restoreDraft = recovery.restoreDraft;
        return recovery.messages;
      });
      optimisticUserMessageKeyRef.current = null;
      if (restoreDraft) {
        opts.chatInputRef?.current?.insertIfEmpty(trimmedMessage);
      }
      {
        const message = e instanceof Error ? e.message : String(e);
        addNotice({
          type: "error",
          message: message.includes("locked by another") ? t("chat_sessionLocked") : message,
        });
      }
      if (sendStillCurrent()) {
        setAgentRunning(false);
        setAgentPhase(null);
        dispatch({ type: "end" });
      }
      return false;
    }
  }, [isNew, isReadOnly, newSessionModel, newSessionDefaultModel, session, promoteNewSession, waitForPromptSettlement, addNotice, notifyAutoFollowSend, opts.chatInputRef, t, onSessionCreated]);

  const executeBash = useCallback(async (command: string, excludeFromContext: boolean): Promise<boolean> => {
    // 只读会话：bash 命令同样会写 session 文件，拦截。
    if (isReadOnly) return false;
    if (getRuntimeAgentRunning() || bashRunningRef.current || branchBusyRef.current) return false;
    const inputText = `${excludeFromContext ? "!!" : "!"}${command}`;
    bashRunningRef.current = true;
    setPendingBash({ command, excludeFromContext, startedAt: Date.now() });
    setBashRunning(true);
    try {
      const sid = sessionIdRef.current ?? session?.id ?? await ensureNewSession();
      if (!sid) throw new Error("Unable to create a session for the shell command");
      // ensure 成功即 promote（写操作已创建 Pi session）。
      promoteNewSession(1, inputText);
      await sendAgentCommand(sid, {
        type: "bash",
        command,
        excludeFromContext,
      });
      await loadSession(sid);
      return true;
    } catch (e) {
      console.error("Failed to execute shell command:", e);
      addNotice({ type: "error", message: e instanceof Error ? e.message : String(e) });
      opts.chatInputRef?.current?.insertIfEmpty(inputText);
      return false;
    } finally {
      bashRunningRef.current = false;
      setPendingBash(null);
      setBashRunning(false);
    }
  }, [addNotice, isReadOnly, ensureNewSession, loadSession, opts.chatInputRef, promoteNewSession, session]);
  executeBashRef.current = executeBash;

  const handleAbort = useCallback(async () => {
    // 只读会话没有任何运行中的 agent，abort 无意义且不发送。
    if (isReadOnly) return;
    const pendingId = isNew && newSessionIntentIdRef.current
      ? pendingSessionId(newSessionIntentIdRef.current)
      : null;
    const liveId = sessionIdRef.current;
    const sid = liveId ?? pendingId;
    if (!sid) return;
    abortRequestedRef.current = true;
    if (liveId) setServerPref(`sessionQueueHold.${liveId}`, true);
    if (bashRunningRef.current) {
      if (!liveId) return;
      try {
        await sendAgentCommand(liveId, { type: "abort_bash" });
      } catch (e) {
        console.error("Failed to abort bash:", e);
      }
      return;
    }
    // 显式 Stop 与目标 submission 绑定：先取消在途 POST（若有），等它结算，
    // 再发服务端 abort；保证顺序：主模型先收到 abort，迟到的 prompt 不会复活。
    const registry = getOrCreateBrowserSessionRuntimeRegistry();
    const cancellation = registry.cancellationFor(sid);
    if (cancellation) {
      cancellation.cancel();
      try {
        await registry.abortSubmission(sid);
      } catch {
        // 结算异常不阻断 abort 命令。
      }
    }
    if (liveId && !liveId.startsWith("pending:")) {
      try {
        await sendAgentCommand(liveId, { type: "abort" });
      } catch (e) {
        console.error("Failed to abort:", e);
      }
    }
  }, [isNew, isReadOnly]);

  const handleModelChange = useCallback(async (provider: string, modelId: string, thinkingLevel?: string | null) => {
    // 只读会话：set_model 会写会话状态，拦截。
    if (isReadOnly) return;
    if (isNew) {
      // 引导页常无 live session：本地状态必须先更新（否则无 sid 时直接 return，思考/模型选不中）
      setNewSessionModel({ provider, modelId });
      setPendingModel({ provider, modelId });
      const localThinking = guidePageThinkingUpdate(thinkingLevel);
      if (localThinking) setThinkingLevel(localThinking as ThinkingLevelOption);
      // ensure 正在跑（首次 prompt 并发）时等它；失败/超时不得吞掉本地模型选择
      let sid = sessionIdRef.current;
      if (!sid && ensuringNewSessionRef.current) {
        try {
          sid = (await ensuringNewSessionRef.current) ?? null;
        } catch {
          sid = null;
        }
      }
      if (!sid) return; // 首条消息 ensureNewSession 会带上当前 model/thinkingLevel
      try {
        if (thinkingLevel && isThinkingLevel(thinkingLevel)) {
          await sendAgentCommand(sid, { type: "set_thinking_level", level: thinkingLevel });
        }
        await sendAgentCommand(sid, { type: "set_model", provider, modelId });
      } catch (e) {
        console.error("Failed to set model:", e);
      }
      return;
    }
    const sid = sessionIdRef.current;
    if (!sid) return;
    // 本地立即同步显示（选择路径不经过 handleThinkingLevelChange）
    if (thinkingLevel) setThinkingLevel(thinkingLevel as ThinkingLevelOption);
    setCurrentModelOverride({ provider, modelId });
    setPendingModel({ provider, modelId });
    pendingModelRef.current = { provider, modelId };
    try {
      // 思考深度立即应用（下次 prompt 生效）；auto 表示用配置默认，不发送
      if (thinkingLevel && isThinkingLevel(thinkingLevel)) {
        await sendAgentCommand(sid, { type: "set_thinking_level", level: thinkingLevel });
      }
      // 旧会话也立即 set_model 落盘：只记 pending 会在刷新/切走后丢失，看起来像切换失败
      await sendAgentCommand(sid, { type: "set_model", provider, modelId });
    } catch (e) {
      pendingModelRef.current = null;
      setPendingModel(null);
      setCurrentModelOverride(null);
      addNotice({
        type: "error",
        message: t("models_switchFailed", {
          error: e instanceof Error ? e.message : String(e),
        }),
      });
    }
  }, [isNew, isReadOnly, setNewSessionModel, addNotice, t]);

  const handleCompact = useCallback(async () => {
    // 只读会话：compact 会重写 session 文件，拦截。
    if (isReadOnly) return;
    const sid = sessionIdRef.current;
    if (!sid || isCompacting) return;
    setIsCompacting(true);
    setCompactError(null);
    setCompactResult(null);
    try {
      const result = await sendAgentCommand<CompactCommandResult>(sid, { type: "compact" });
      setCompactResult(readCompactResult(result, "manual"));
      await loadSession(sid, true);
    } catch (e) {
      setCompactError(e instanceof Error ? e.message : String(e));
      setCompactResult(null);
    } finally {
      setIsCompacting(false);
    }
  }, [isCompacting, isReadOnly, loadSession]);

  const loadModels = useCallback(async (signal?: AbortSignal) => {
    // 模型目录与每模型思考缓存是浏览器运行时共享的基础层；先完成这两项，
    // 再由 currentModel/resolvedThinking 叠加当前会话，不随会话切换互相污染。
    const [res] = await Promise.all([
      fetch("/api/models", signal ? { signal } : undefined),
      ensureServerPrefsLoaded(),
    ]);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const d = await res.json() as ModelsResponse;
    setModelNames(d.models);
    setModelThinkingLevels(d.thinkingLevels ?? {});
    setModelThinkingLevelMaps(d.thinkingLevelMaps ?? {});
    setModelAuthConfigured(d.authConfigured ?? {});
    const nextModelList = d.modelList ?? [];
    setModelList(nextModelList);
    const match = d.defaultModel
      ? nextModelList.find((m) => m.id === d.defaultModel?.modelId && m.provider === d.defaultModel?.provider)
      : undefined;
    // 目录默认：已有会话无 model_change 时也用它兜底，避免选择器整栏消失。
    const configuredMap = d.authConfigured ?? {};
    const catalogDefault = match
      ?? nextModelList.find((m) => configuredMap[m.provider] !== false)
      ?? nextModelList[0];
    setNewSessionDefaultModel(catalogDefault ? { provider: catalogDefault.provider, modelId: catalogDefault.id } : null);
  }, []);

  // 命令条目持久化：斜杠命令成功后追加 pidance.command 到会话时间线（type:"custom"）。
  // 写入失败静默（命令已执行成功，条目只是展示）。
  const recordCommandEntry = useCallback(async (command: string, result?: string) => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    try {
      await fetch(`/api/sessions/${encodeURIComponent(sid)}/command-entry`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command, ok: true, result }),
      });
    } catch (e) {
      console.error("Failed to record command entry:", e);
    }
  }, []);

  const handleBuiltinSlashCommand = useCallback(async (text: string): Promise<BuiltinSlashCommandResult> => {
    // 只读会话：内置 slash 命令（compact/reload/name/session/copy）全部走 RPC，拦截。
    if (isReadOnly) return { handled: false };
    if (!text.startsWith("/")) return { handled: false };
    const match = text.match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/);
    if (!match) return { handled: false };

    const [, commandName, rawArgs = ""] = match;
    const args = rawArgs.trim();
    // 内置 slash 是明确写命令：允许 ensure；读资源路径不得走这里。
    const sid = sessionIdRef.current ?? await ensureNewSession();
    if (sid && isNew) promoteNewSession();
    const complete = (result: BuiltinSlashCommandResult): BuiltinSlashCommandResult => {
      if (!result.handled) return result;
      if (result.error) {
        addNotice({ type: "error", message: result.error });
      } else if (result.action !== "openSessionStats") {
        addNotice({ type: "success", message: result.message ?? "Command completed" });
      }
      return result;
    };

    try {
      switch (commandName) {
        case "compact": {
          if (!sid || isCompacting) return complete({ handled: true, error: "No active session to compact" });
          setIsCompacting(true);
          setCompactError(null);
          setCompactResult(null);
          const result = await sendAgentCommand<CompactCommandResult>(sid, {
            type: "compact",
            ...(args ? { customInstructions: args } : {}),
          });
          setCompactResult(readCompactResult(result, "manual"));
          await recordCommandEntry(`/compact${args ? ` ${args}` : ""}`, "Compacted context");
          if (await loadSession(sid, true)) promoteNewSession();
          return complete({ handled: true, message: "Compacted context" });
        }

        case "reload": {
          if (!sid) return complete({ handled: true, error: "No active session to reload" });
          await sendAgentCommand(sid, { type: "reload" });
          await recordCommandEntry("/reload", "Reloaded session resources");
          await Promise.all([
            loadSession(sid, false, true),
            loadTools(sid),
            loadSlashCommands(),
            loadModels(),
          ]);
          return complete({ handled: true, message: "Reloaded session resources" });
        }

        case "name": {
          if (!sid) return complete({ handled: true, error: "No active session to name" });
          if (!args) return complete({ handled: true, error: "Usage: /name <name>" });
          await sendAgentCommand(sid, { type: "set_session_name", name: args });
          await recordCommandEntry(`/name ${args}`, `Session renamed to ${args}`);
          if (await loadSession(sid)) promoteNewSession();
          return complete({ handled: true, message: `Session renamed to ${args}` });
        }

        case "session": {
          if (!sid) return complete({ handled: true, error: "No active session" });
          const stats = await sendAgentCommand<SessionStatsInfo>(sid, { type: "get_session_stats" });
          if (stats) {
            setSessionStatsOverride(stats);
          }
          await recordCommandEntry("/session", "Opened session stats");
          await loadSession(sid);
          onSessionStatsPanelOpen?.();
          return complete({ handled: true, action: "openSessionStats" });
        }

        case "copy": {
          if (!sid) return complete({ handled: true, error: "No active session" });
          const data = await sendAgentCommand<LastAssistantTextResponse>(sid, { type: "get_last_assistant_text" });
          const textToCopy = data?.text ?? "";
          if (!textToCopy) return complete({ handled: true, error: "No assistant message to copy" });
          await navigator.clipboard.writeText(textToCopy);
          await recordCommandEntry("/copy", "Copied last assistant message");
          await loadSession(sid);
          return complete({ handled: true, message: "Copied last assistant message" });
        }

        default:
          return { handled: false };
      }
    } catch (e) {
      return complete({ handled: true, error: e instanceof Error ? e.message : String(e) });
    } finally {
      if (commandName === "compact") setIsCompacting(false);
    }
  }, [addNotice, ensureNewSession, isCompacting, isNew, isReadOnly, loadModels, loadSession, loadSlashCommands, loadTools, promoteNewSession, onSessionStatsPanelOpen, recordCommandEntry]);

  // Queued (undelivered) messages live in the queue panel only; the chat gets
  // the real user message when pi delivers it (user message_end event). An
  // optimistic chat bubble here would duplicate the queue panel and turn into
  // a ghost message if the queue is recalled.
  const handleSteer = useCallback(async (message: string, images?: AttachedImage[]) => {
    // 只读会话：steer 会写 session 文件，拦截。
    if (isReadOnly) return;
    const sid = sessionIdRef.current;
    if (!sid) return;
    const source = getOrCreateBrowserSessionRuntimeRegistry().getEventSource(sid);
    if (!source || source.readyState === 2) {
      ensureEventsConnected(sid);
    }
    // 引导/队列投递后回到 following 并钉底（消息会直接出现在会话中）。
    notifyAutoFollowSend();
    // 乐观显示：引导消息立即写入 timeline（不等当前命令执行完投递）；
    // 视觉顺序由 compositor 投影——先本轮思考/工具，再引导气泡。
    // 仅前端显示，agent 运行逻辑不变（steer RPC 照常入 Pi 队列）；
    // Pi 实际投递时按 key 删除本地乐观，避免双条。
    const optimistic: SteerOptimisticMessage = {
      role: "user",
      content: images?.length ? message : message,
      timestamp: Date.now(),
      _steerOptimistic: true,
    };
    const optimisticKey = userMessageKey(optimistic);
    getOrCreateBrowserSessionRuntimeRegistry().appendLocal(sid, optimistic);
    const piImages = images?.map((img) => ({ type: "image" as const, data: img.data, mimeType: img.mimeType }));
    try {
      await sendAgentCommand(sid, {
        type: "steer",
        message,
        ...(piImages?.length ? { images: piImages } : {}),
      });
    } catch (e) {
      // 失败回滚乐观消息；hydrate 带 slot 序号，避免旧列表盖掉较新 live。
      setMessages((prev) => {
        const next = prev.filter((m) => !((m as SteerOptimisticMessage)._steerOptimistic && userMessageKey(m) === optimisticKey));
        const registry = getOrCreateBrowserSessionRuntimeRegistry();
        registry.hydrate(sid, next, entryIdsRef.current, {
          sinceSeq: registry.getSnapshot(sid)?.timelineSeq ?? 0,
          hydrateRequestSeq: registry.beginHydrate(sid),
        });
        return next;
      });
      console.error("Failed to steer:", e);
    }
  }, [ensureEventsConnected, isReadOnly, notifyAutoFollowSend]);

  /**
   * SDK 错误：扩展命令（/xxx）不能被 steer/followUp 排队，但 prompt() 在
   * streaming 时也会立即执行扩展命令（见 Pi AgentSession.prompt）。
   */
  const isExtensionCommandQueueError = useCallback((e: unknown): boolean => {
    const msg = e instanceof Error ? e.message : String(e);
    return /Extension command .* cannot be queued/.test(msg);
  }, []);

  const handlePromptWithStreamingBehavior = useCallback(async (
    message: string,
    behavior: "steer" | "followUp",
    images?: AttachedImage[],
  ) => {
    // 只读会话：排队 prompt 同样写 session，拦截。
    if (isReadOnly) return;
    const sid = sessionIdRef.current;
    if (!sid) return;
    if (behavior === "followUp") {
      await handleFollowUpRef.current(message, images);
      return;
    }
    const piImages = images?.map((img) => ({ type: "image" as const, data: img.data, mimeType: img.mimeType }));
    try {
      await sendAgentCommand(sid, {
        type: "steer",
        message,
        ...(piImages?.length ? { images: piImages } : {}),
      });
    } catch (e) {
      if (isExtensionCommandQueueError(e)) {
        // 扩展命令不能 steer：prompt() 在 streaming 时也立即执行扩展命令
        await sendAgentCommand(sid, { type: "prompt", message });
        return;
      }
      console.error("Failed to steer:", e);
    }
  }, [isReadOnly, isExtensionCommandQueueError]);

  /**
   * follow-up 发送（Codex 风格）：agent 运行中入本地队列（不调 follow_up RPC，
   * 否则引导合并后进程队列仍会投递导致双发）；空闲时直接 prompt（等效发送）。
   * 图片附件不排队（本地队列仅文本），有图时直接 prompt 发送。
   */
  const handleFollowUp = useCallback(async (message: string, images?: AttachedImage[]) => {
    // 只读会话：follow-up 会写 session 文件，拦截。
    if (isReadOnly) return;
    const sid = sessionIdRef.current;
    if (!sid) return;
    const text = message.trim();
    if (!text) return;
    if (images?.length || (!getRuntimeAgentRunning() && !isCompacting)) {
      // 有图或空闲：直接 prompt（空闲时无“结束后投递”语义）；压缩中即使
      // runtime 暂时没有 agentRunning，也必须进入 follow-up 队列。
      notifyAutoFollowSend();
      const piImages = images?.map((img) => ({ type: "image" as const, data: img.data, mimeType: img.mimeType }));
      try {
        await sendAgentCommand(sid, {
          type: "prompt",
          message: text,
          ...(piImages?.length ? { images: piImages } : {}),
        });
      } catch (e) {
        console.error("Failed to send prompt:", e);
      }
      return;
    }
    // 运行中入队：先乐观显示，再等待 Host 同步确认；Host 是 settled 投递 owner。
    notifyAutoFollowSend();
    try {
      await updateLocalFollowUp([...localFollowUpRef.current, text]);
    } catch (error) {
      opts.chatInputRef?.current?.prependText(text);
      addNotice({
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }, [addNotice, isCompacting, isReadOnly, notifyAutoFollowSend, opts.chatInputRef, updateLocalFollowUp]);

  // 供 handlePromptWithStreamingBehavior（定义在前）引用最新 handleFollowUp
  handleFollowUpRef.current = handleFollowUp;

  const handleAbortCompaction = useCallback(async () => {
    if (isReadOnly || !isCompacting) return;
    const sid = sessionIdRef.current;
    if (!sid) return;
    try {
      await sendAgentCommand(sid, { type: "abort_compaction" });
      setIsCompacting(false);
      setCompactError(null);
      setCompactResult(null);
    } catch (error) {
      setCompactError(error instanceof Error ? error.message : String(error));
    }
  }, [isCompacting, isReadOnly]);

  const handleRecallQueue = useCallback(async () => {
    // 只读会话没有队列（state 从不加载），拦截。
    if (isReadOnly) return;
    const items = localFollowUpRef.current;
    if (items.length === 0) return;
    // 取回：Host 确认清队后再回填，避免清除失败时同一消息同时留在两处。
    try {
      await updateLocalFollowUp([]);
      opts.chatInputRef?.current?.prependText(joinQueueForRecall(items));
    } catch (error) {
      addNotice({ type: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }, [addNotice, isReadOnly, updateLocalFollowUp, opts.chatInputRef]);

  /** 引导发送：本地 follow-up 队列（+ 可选 extra）合并为一条 steer 消息，成功后清空。 */
  const handleSendQueueAsSteer = useCallback(async (extraMessage?: string) => {
    if (isReadOnly) return;
    const sid = sessionIdRef.current;
    if (!sid) return;
    const originalQueue = [...localFollowUpRef.current];
    const merged = mergeFollowUpForSteer(originalQueue, extraMessage);
    if (!merged) return;
    notifyAutoFollowSend();
    // 乐观显示：合并后的引导消息立即写入 timeline；视觉顺序由 compositor
    // 投影（本轮思考/工具之后）。投递时按 key 去重。
    const optimistic: SteerOptimisticMessage = {
      role: "user",
      content: merged,
      timestamp: Date.now(),
      _steerOptimistic: true,
    };
    const optimisticKey = userMessageKey(optimistic);
    getOrCreateBrowserSessionRuntimeRegistry().appendLocal(sid, optimistic);
    let queueCleared = false;
    try {
      // 先让 Host 停止 settled 自动投递，再发送合并消息，避免当前 run 恰好结束时双发。
      await updateLocalFollowUp([]);
      queueCleared = true;
      if (getRuntimeAgentRunning()) {
        try {
          // 运行中：steer（打断当前思考，立即引导）
          await sendAgentCommand(sid, { type: "steer", message: merged });
        } catch (e) {
          if (!isExtensionCommandQueueError(e)) throw e;
          // 扩展命令（/xxx）不能被 steer 排队；prompt() 在 streaming 时立即执行
          await sendAgentCommand(sid, { type: "prompt", message: merged });
        }
      } else {
        // 空闲：Pi 的 steer 只入进程队列不唤醒；用 prompt 立即发起新回合
        await sendAgentCommand(sid, { type: "prompt", message: merged });
      }
    } catch (e) {
      if (queueCleared) {
        try {
          await updateLocalFollowUp(originalQueue);
        } catch {
          // 首个错误仍是用户可操作的主因；Host 同步错误已由队列投影回滚保护。
        }
      }
      if (extraMessage?.trim()) opts.chatInputRef?.current?.prependText(extraMessage.trim());
      // 失败回滚乐观消息；hydrate 带 slot 序号，避免旧列表盖掉较新 live。
      setMessages((prev) => {
        const next = prev.filter((m) => !((m as SteerOptimisticMessage)._steerOptimistic && userMessageKey(m) === optimisticKey));
        const registry = getOrCreateBrowserSessionRuntimeRegistry();
        registry.hydrate(sid, next, entryIdsRef.current, {
          sinceSeq: registry.getSnapshot(sid)?.timelineSeq ?? 0,
          hydrateRequestSeq: registry.beginHydrate(sid),
        });
        return next;
      });
      console.error("Failed to send queue as steer:", e);
      addNotice({ type: "error", message: String(e instanceof Error ? e.message : e) });
    }
  }, [isReadOnly, notifyAutoFollowSend, updateLocalFollowUp, addNotice, isExtensionCommandQueueError, opts.chatInputRef]);

  const handleThinkingLevelChange = useCallback(async (level: ThinkingLevelOption) => {
    // 只读会话：set_thinking_level 会写会话状态，拦截。
    if (isReadOnly) return;
    setThinkingLevel(level);
    const sid = sessionIdRef.current ?? await ensuringNewSessionRef.current;
    if (!sid) return;
    try {
      await sendAgentCommand(sid, { type: "set_thinking_level", level });
    } catch (e) {
      console.error("Failed to set thinking level:", e);
    }
  }, [isReadOnly]);

  /**
   * Workspace History 命令：仅通过 type:prompt 派发 slash 到扩展，
   * 禁止本地 git checkout/reset 或 { command: "undo" } 形态。
   * isReadOnly / agentRunning / bashRunning / branchBusy 时直接 return（与 handleSend 门禁对齐）。
   */
  const dispatchWorkspaceHistoryPrompt = useCallback(async (message: string) => {
    if (isReadOnly) return;
    if (getRuntimeAgentRunning() || bashRunningRef.current || branchBusyRef.current) return;
    const sid = sessionIdRef.current;
    if (!sid) return;
    try {
      await sendAgentCommand(sid, { type: "prompt", message });
      await loadSession(sid, false, true);
    } catch (e) {
      console.error("Workspace history prompt failed:", e);
      addNotice({ type: "error", message: String(e) });
    }
  }, [addNotice, isReadOnly, loadSession]);

  const handleWorkspaceUndo = useCallback(async () => {
    await dispatchWorkspaceHistoryPrompt("/undo");
  }, [dispatchWorkspaceHistoryPrompt]);

  const handleWorkspaceRedo = useCallback(async () => {
    await dispatchWorkspaceHistoryPrompt("/redo");
  }, [dispatchWorkspaceHistoryPrompt]);

  const handleWorkspaceCheckpoint = useCallback(async (label?: string) => {
    const trimmed = typeof label === "string" ? label.trim() : "";
    const message = trimmed ? `/checkpoint ${trimmed}` : "/checkpoint";
    await dispatchWorkspaceHistoryPrompt(message);
  }, [dispatchWorkspaceHistoryPrompt]);

  // 队列持久层由 Host 同步写；挂载时绕过浏览器 singleton 取新快照，
  // focus 后再消费 useServerPreferences 的刷新结果。两路都只更新 UI 投影，不反写 Host。
  const serverPrefs = useServerPreferences();
  const lastRemoteQueueRef = useRef<string[] | null>(null);
  useEffect(() => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    let cancelled = false;
    void fetch("/api/preferences", { cache: "no-store" })
      .then((response) => response.ok ? response.json() : null)
      .then((body: { prefs?: unknown } | null) => {
        if (cancelled || sessionIdRef.current !== sid) return;
        const remote = readFollowUpQueuePreference(body?.prefs, sid);
        if (remote === null) return;
        lastRemoteQueueRef.current = remote;
        applyLocalFollowUpQueue(remote);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [applyLocalFollowUpQueue, session?.id]);

  useEffect(() => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    const remote = readFollowUpQueuePreference(serverPrefs, sid);
    if (remote === null) return;
    if (JSON.stringify(remote) === JSON.stringify(lastRemoteQueueRef.current)) return;
    lastRemoteQueueRef.current = remote;
    applyLocalFollowUpQueue(remote);
  }, [applyLocalFollowUpQueue, serverPrefs, session?.id]);

  // 会话切换：清空阻塞队列与可见卡片；不发送 extension_ui_response。
  useEffect(() => {
    const current = extensionUiStateRef.current;
    commitExtensionUiState({
      ...clearAllExtensionUiBlocking(current),
      customUi: null,
    });
    clearLiveActivities();
  }, [session?.id, newSessionCwd, commitExtensionUiState, extensionUiStateRef, clearLiveActivities]);

  // 切离会话：不主动销毁 live host，交给 10 分钟 idle 自动释放（切回仍热启动）。
  // 仅取消上一会话的后台 wake，避免串台写 systemPrompt。
  const previousLiveSessionIdRef = useRef<string | null>(null);
  useEffect(() => {
    const prev = previousLiveSessionIdRef.current;
    const next = session?.id ?? null;
    if (prev && prev !== next) {
      wakeAbortRef.current?.abort();
      wakeAbortRef.current = null;
    }
    previousLiveSessionIdRef.current =
      session && session.readOnly !== true ? session.id : null;
  }, [session?.id, session?.readOnly]);


  useEffect(() => {
    // 会话/新 intent 变化：先清空上一会话的本地聊天状态，避免切到新 intent 时
    // 仍显示旧消息（sessionKey remount 移除后的 state 残留竞态）。
    resetChatTargetRefs({
      sessionId: sessionIdRef,
      newSessionPromoted: newSessionPromotedRef,
      promptSubmitted: promptSubmittedRef,
      ensuringNewSession: ensuringNewSessionRef,
    }, session?.id ?? null);
    setMessages([]);
    entryIdsRef.current = [];
    setEntryIds([]);
    setData(null);
    setActiveLeafId(null);
    hasMoreBeforeRef.current = false;
    setHasMoreBefore(false);
    dispatch({ type: "reset" });
    setAgentRunning(false);
    setLockedByOther(false);
    setBashRunning(false);
    bashRunningRef.current = false;
    setPendingBash(null);
    setRetryInfo(null);
    setIsCompacting(false);
    setSystemPrompt(null);
    setContextUsage(null);
    setCurrentModelOverride(null);
    setPendingModel(null);
    setNewSessionModel(null);
    setThinkingLevel(null);
    pendingModelRef.current = null;
    optimisticUserMessageKeyRef.current = null;
    // 会话切换：把 followUp 队列投影切到新会话（映射保留旧会话条目，切回恢复）。
    const queueSid = session?.id ?? null;
    currentQueueSessionIdRef.current = queueSid;
    localQueueOwnerRef.current = queueSid;
    const ownQueue = sessionQueuesRef.current.get(queueSid ?? "") ?? [];
    localFollowUpRef.current = [...ownQueue];
    setQueuedMessages({ steering: [], followUp: [...ownQueue] });
    lastRemoteQueueRef.current = null;

    const registry = getOrCreateBrowserSessionRuntimeRegistry();
    const runtimeId = session?.id ?? (isNew && newSessionIntentId ? pendingSessionId(newSessionIntentId) : null);
    let unsubSnapshot: (() => void) | null = null;
    if (runtimeId && session?.readOnly !== true) {
      runtimeSubscriptionRef.current = registry.attach(runtimeId, (event) => {
        handleAgentEventRef.current?.(event as AgentEvent);
      });
      unsubSnapshot = registry.subscribe(runtimeId, (snap) => {
        if (sessionIdRef.current && snap.sessionId !== sessionIdRef.current && snap.sessionId !== runtimeId) {
          return;
        }
        setMessages(snap.messages);
        setEntryIds(snap.entryIds);
        entryIdsRef.current = snap.entryIds;
        setAgentRunning(snap.agentRunning);
        if (snap.streamState.isStreaming) {
          dispatch({
            type: "update",
            message: snap.streamState.streamingMessage ?? {},
          });
        } else {
          dispatch({ type: "end" });
        }
        eventSourceRef.current = registry.getEventSource(snap.sessionId) as unknown as EventSource | null;
      });
    }

    if (session) {
      if (session.readOnly === true) {
        void loadSession(session.id, true, false);
      } else {
        loadSession(session.id, true, true).then((agentState) => {
          if (agentState === true) return;
          if (agentState?.running || agentState?.live) {
            loadTools(session.id);
            if (agentState.state?.isStreaming || agentState.state?.isPromptRunning) {
              setAgentRunning(true);
              setAgentPhase(agentState.state.isStreaming ? { kind: "waiting_model" } : { kind: "running_command" });
              dispatch({ type: "start" });
              if (!agentState.state.isStreaming && agentState.state.isPromptRunning) {
                void waitForPromptSettlement(session.id);
              }
            }
            if (agentState.state?.isBashRunning) {
              bashRunningRef.current = true;
              setBashRunning(true);
              if (agentState.state.pendingBash) {
                setPendingBash(agentState.state.pendingBash);
              }
              void waitForBashSettlement(session.id);
            }
          }
          if (agentState?.lockedByOther !== undefined) setLockedByOther(agentState.lockedByOther);
          if (agentState?.state) {
            if (agentState.state.isCompacting !== undefined) setIsCompacting(agentState.state.isCompacting);
            if (agentState.state.contextUsage !== undefined) setContextUsage(agentState.state.contextUsage ?? null);
            if (agentState.state.systemPrompt !== undefined) setSystemPrompt(agentState.state.systemPrompt ?? null);
            if (isThinkingLevel(agentState.state.thinkingLevel)) setThinkingLevel(agentState.state.thinkingLevel);
            if (agentState.state.extensionStatuses !== undefined) patchExtensionUiState({ statuses: agentState.state.extensionStatuses ?? [] });
            if (agentState.state.extensionWidgets !== undefined) patchExtensionUiState({ widgets: agentState.state.extensionWidgets ?? [] });
            if (agentState.state.queuedMessages !== undefined) {
              applyProjectedQueues(agentState.state.queuedMessages);
            }
            if (Array.isArray(agentState.state.pendingExtensionRequests)) {
              const queue = (agentState.state.pendingExtensionRequests as AgentEvent[])
                .filter((e): e is ExtensionUiBlockingRequest => {
                  const method = (e as { method?: string }).method;
                  return method === "select" || method === "confirm" || method === "input" || method === "editor";
                });
              if (queue.length > 0) {
                patchExtensionUiState({
                  blockingQueue: queue,
                  ...projectBlockingHead(queue),
                });
              }
            }
          }
        });
      }
    }
    return () => {
      bashRecoveryIdRef.current += 1;
      unsubSnapshot?.();
      const sid = runtimeId ?? sessionIdRef.current ?? session?.id;
      if (sid && runtimeSubscriptionRef.current) {
        getOrCreateBrowserSessionRuntimeRegistry().detach(sid, runtimeSubscriptionRef.current);
        runtimeSubscriptionRef.current = null;
      }
    };
  }, [session?.id, session?.readOnly, newSessionIntentId, isNew]);

  useEffect(() => {
    onSystemPromptChange?.(systemPrompt);
  }, [systemPrompt, onSystemPromptChange]);

  useEffect(() => {
    if (!onBranchDataChange) return;
    onBranchDataChange(data?.tree ?? [], activeLeafId, handleLeafChange, branchActions);
  }, [data?.tree, activeLeafId, handleLeafChange, branchActions, onBranchDataChange]);


  // Load model list
  useEffect(() => {
    const controller = new AbortController();
    loadModels(controller.signal).catch((e) => {
      if (e instanceof DOMException && e.name === "AbortError") return;
    });
    return () => controller.abort();
  }, [loadModels, modelsRefreshKey]);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/agent-settings")
      .then((r) => r.json())
      .then((d: { defaultThinkingLevel?: unknown }) => {
        if (cancelled || !isThinkingLevel(d.defaultThinkingLevel)) return;
        setSettingsDefaultThinking(d.defaultThinkingLevel);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  // Compact error auto-dismiss
  useEffect(() => {
    if (!compactError) return;
    const t = setTimeout(() => setCompactError(null), 3000);
    return () => clearTimeout(t);
  }, [compactError]);

  useEffect(() => {
    if (!compactResult) return;
    const t = setTimeout(() => setCompactResult(null), 6000);
    return () => clearTimeout(t);
  }, [compactResult]);

  useEffect(() => {
    setSessionStatsOverride(null);
  }, [messages.length, contextUsage?.tokens, contextUsage?.percent, contextUsage?.contextWindow]);

  return {
    // State
    data, loading, historyLoading, hasMoreBefore, error, activeLeafId, messages, entryIds, streamState,
    agentRunning, modelNames, modelList, modelAuthConfigured, modelThinkingLevels, modelThinkingLevelMaps, newSessionModel, thinkingLevel: resolvedThinking, defaultThinkingLevel: isNew ? settingsDefaultThinking : null,
    retryInfo, contextUsage, systemPrompt, forkingEntryId,
    isCompacting, compactError, compactResult, currentModel, displayModel, sessionStats,
    slashCommands, slashCommandsLoading, queuedMessages,
    notices,
    liveNoticeActivities,
    dismissNotice,
    toggleNoticePin,
    extensionDialog, extensionCustomUi, extensionStatuses, extensionWidgets, respondToExtensionUi, dismissExtensionUiRequest, sendExtensionCustomInput,
    todos,
    isAutoModelSelection: isNew && newSessionModel === null,
    agentPhase,
    // P4a 实时工具执行快照（插入序；run 结束保留至下一个 run 开始，agent_start 清空）
    toolExecutionSnapshots,
    isNew,
    // Refs
    sessionIdRef, eventSourceRef, scrollContainerRef,
    // 自动跟随
    jumpButtonVisible, jumpToBottom, markExternalScrollWrite, notifyProgrammaticSmooth,
    // Actions
    loadOlderHistory,
    handleSend, handleAbort, handleFork, handleNavigate, handleModelChange,
    handleCompact, handleSteer, handleFollowUp, handlePromptWithStreamingBehavior, handleAbortCompaction,
    handleRecallQueue, handleSendQueueAsSteer,
    handleBuiltinSlashCommand,
    // REFACTOR-DEAD: handleToolPresetChange 已注释（P0c 工具不收窄）。
    handleThinkingLevelChange, loadTools, loadSlashCommands, setActiveLeafId, setData, setMessages,
    dispatch, setAgentRunning, setForkingEntryId,
    bashRunning, pendingBash,
    // Workspace History（仅 type:prompt 派发到扩展）
    handleWorkspaceUndo, handleWorkspaceRedo, handleWorkspaceCheckpoint,
    handleBranchHere, handleBranchFromAssistant,
    handleNewSessionFromHere, handleNewSessionFromAnswer,
    // 分支书签与带选项切换（D3）
    branchBusy, branchActions, navigateBranch, setBranchLabel,
    // Subscriptions
    handleAgentEventRef,
  };
}
