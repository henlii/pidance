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
import { normalizeToolCalls } from "@/lib/normalize";
import { recoverFailedSend } from "@/lib/send-failure";
import { attachCustomRenderedLines, preserveCustomRenderedLines } from "@/lib/custom-rendered-lines";
import type { SessionActivity } from "@/lib/session-activity";
import { sendAgentCommand } from "@/lib/agent-client";
import type { BranchActions } from "@/lib/branch-bookmarks";
import { mergeFollowUpForSteer, joinQueueForRecall } from "@/lib/queue-merge";
import { createEventStreamManager, type EventStreamManager, type EventStreamConnectionResult } from "@/lib/event-stream-manager";
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
import { parseTodos } from "@/lib/todo-parser";
import { getSessionCapabilities } from "@/components/session-capabilities";
import { useSessionCommands } from "@/hooks/useSessionCommands";
import { resolveDisplayModel, settleModelOverride } from "@/lib/model-selection";
import { useI18n } from "@/lib/i18n";
import {
  PROGRAMMATIC_SMOOTH_IGNORE_MS,
  RUN_SETTLE_MS,
  canNestedScrollerConsumeUp,
  getBottomZoneSize,
  getDistanceFromBottom,
  getScrollDirection,
  reduceAutoFollow,
  shouldShowJumpButton,
  type AutoFollowMode,
} from "@/lib/chat-auto-follow";
import {
  beginAgentRunFinish,
  canFinalizeAgentRun,
} from "@/lib/finish-agent-run";
import {
  applyToolExecutionStart,
  applyToolExecutionUpdate,
  applyToolExecutionEnd,
  applyToolExecutionResultRender,
  clearToolExecutions,
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
  pendingBash?: { command: string; excludeFromContext: boolean } | null;
  isCompacting?: boolean;
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

export type ThinkingLevelOption = "auto" | "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

const PROMPT_SETTLE_INITIAL_DELAY_MS = 800;
const PROMPT_SETTLE_POLL_MS = 600;
const PROMPT_SETTLE_MAX_MS = 20_000;
const AGENT_STATE_RECONCILE_MS = 15_000;
const BASH_STATE_RECONCILE_MS = 1_000;
// 外部 pi 冷启动（fork 会话首次启动进程）可超 5s；15s 覆盖启动窗口。
const EVENT_STREAM_CONNECT_TIMEOUT_MS = 15_000;
// 只有明确向上的键才构成 release 意图；向下滚动的键交给 scroll 几何判定恢复跟随。
const RELEASE_KEYS = new Set(["ArrowUp", "PageUp", "Home"]);

/**
 * wheel/touch 的向上意图若发生在可自己继续向上滚的嵌套区（代码块、工具输出等），
 * 让嵌套区优先消费，外层不 release。
 */
function isInsideNestedUpScrollable(target: EventTarget | null, container: HTMLElement): boolean {
  if (!(target instanceof Element)) return false;
  let el: Element | null = target;
  while (el && el !== container) {
    if (el instanceof HTMLElement) {
      const overflowY = getComputedStyle(el).overflowY;
      if (
        (overflowY === "auto" || overflowY === "scroll")
        && canNestedScrollerConsumeUp({ scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight })
      ) {
        return true;
      }
    }
    el = el.parentElement;
  }
  return false;
}

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
    session, newSessionCwd, newSessionIntentId, onAgentEnd, onSessionCreated, onSessionForked,
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
  const [bashRunning, setBashRunning] = useState(false);
  const [pendingBash, setPendingBash] = useState<{ command: string; excludeFromContext: boolean } | null>(null);
  const [modelNames, setModelNames] = useState<Record<string, string>>({});
  const [modelList, setModelList] = useState<ModelEntry[]>([]);
  const [modelThinkingLevels, setModelThinkingLevels] = useState<Record<string, string[]>>({});
  const [modelThinkingLevelMaps, setModelThinkingLevelMaps] = useState<Record<string, Record<string, string | null>>>({});
  // providerId → 该 provider 是否有可用凭据（未认证且无环境凭据 → false）。
  // 模型下拉据此灰显不可用模型，避免用户选择必然失败的 provider。
  const [modelAuthConfigured, setModelAuthConfigured] = useState<Record<string, boolean>>({});
  const [newSessionModel, setNewSessionModel] = useState<SelectedModel | null>(null);
  const [newSessionDefaultModel, setNewSessionDefaultModel] = useState<SelectedModel | null>(null);
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevelOption>("auto");
  const [retryInfo, setRetryInfo] = useState<{ attempt: number; maxAttempts: number; errorMessage?: string } | null>(null);
  const [contextUsage, setContextUsage] = useState<{ percent: number | null; contextWindow: number; tokens: number | null } | null>(null);
  const [systemPrompt, setSystemPrompt] = useState<string | null>(null);
  const [forkingEntryId, setForkingEntryId] = useState<string | null>(null);
  const [currentModelOverride, setCurrentModelOverride] = useState<{ provider: string; modelId: string } | null>(null);
  const [pendingModel, setPendingModel] = useState<{ provider: string; modelId: string } | null>(null);
  const [isCompacting, setIsCompacting] = useState(false);
  const [compactError, setCompactError] = useState<string | null>(null);
  const [compactResult, setCompactResult] = useState<CompactResultInfo | null>(null);
  const [agentPhase, setAgentPhase] = useState<AgentPhase>(null);
  // P4a 实时工具执行缓冲：以 toolCallId 键控的快照数组（插入序），由
  // tool_execution_start/update/end 事件驱动；UI（MessageView 实时工具视图）暂未消费。
  const [toolExecutionSnapshots, setToolExecutionSnapshots] = useState<ToolExecutionSnapshot[]>([]);
  const [slashCommands, setSlashCommands] = useState<SlashCommandInfo[]>([]);
  const [slashCommandsLoading, setSlashCommandsLoading] = useState(false);
  // notice/activity 展示状态所有权（#17 D5c）：reducer、addNotice、退出动画与
  // liveNoticeActivities 写入已抽至 useNoticeState，此处仅解构消费。
  const { notices, liveNoticeActivities, addNotice, addLiveActivity, clearLiveActivities, dismissNotice, toggleNoticePin } = useNoticeState();
  const [sessionStatsOverride, setSessionStatsOverride] = useState<SessionStatsInfo | null>(null);
  // extension UI 展示状态（#17 D5c）：5 state + ref + 3 更新回调已抽至 useExtensionUiState。
  const {
    extensionDialog, extensionCustomUi, extensionStatuses, extensionWidgets,
    extensionUiStateRef, commitExtensionUiState, patchExtensionUiState, dismissExtensionUiRequest,
  } = useExtensionUiState();
  const [queuedMessages, setQueuedMessages] = useState<QueuedMessages>({ steering: [], followUp: [] });
  // 本地 follow-up 队列（Codex 风格：发送入队、引导/取回消费）。
  // 外部 Pi 无 clear_queue RPC，队列自管才能支持“整队合并引导发送”而不双发。
  const [localFollowUpQueue, setLocalFollowUpQueue] = useState<string[]>([]);
  const localFollowUpRef = useRef<string[]>([]);
  const updateLocalFollowUp = useCallback((next: string[]) => {
    localFollowUpRef.current = next;
    setLocalFollowUpQueue(next);
    // 展示层 followUp 始终以本地队列为准（Pi 队列不再使用 follow_up RPC）
    setQueuedMessages((prev) => ({ ...prev, followUp: next }));
  }, []);
  // 分支切换/总结进行中：树节点、发送与再次导航全部暂停，避免与 navigateTree 并发写。
  const [branchBusy, setBranchBusy] = useState(false);

  const eventSourceRef = useRef<EventSource | null>(null);
  const sessionIdRef = useRef<string | null>(session?.id ?? null);
  const messagesSessionIdRef = useRef<string | null>(session?.id ?? null);
  const entryIdsRef = useRef<string[]>([]);
  const agentRunningRef = useRef(false);
  const bashRunningRef = useRef(false);
  const branchBusyRef = useRef(false);
  const bashRecoveryIdRef = useRef(0);
  const handleAgentEventRef = useRef<((event: AgentEvent, eventRunId?: number) => void) | null>(null);
  const handleFollowUpRef = useRef<(message: string, images?: AttachedImage[]) => Promise<void>>(async () => {});
  const executeBashRef = useRef<(command: string, excludeFromContext: boolean) => Promise<boolean> | undefined>(undefined);
  /** ask-user 两步协议暂存：select 的 Other 输入内容，自动响应随后到来的 input 请求 */
  const pendingOtherInputRef = useRef<string | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  // ── OpenChamber 风格自动跟随（纯状态机见 lib/chat-auto-follow.ts）──────────
  // 唯一 scrollTop 写入方是本控制器的 pinToBottom；明确例外：顶部懒加载 prepend
  // 补偿（markExternalScrollWrite）与扩展卡片就近滚动（notifyProgrammaticSmooth），
  // 二者都通过时间窗让 scroll 事件不参与状态判定。minimap 不需要标记：它产生的
  // 向上位移本就应该 release、向下进入末端区域本就应该恢复。
  const autoFollowModeRef = useRef<AutoFollowMode>("following");
  const [jumpButtonVisible, setJumpButtonVisible] = useState(false);
  const initialScrollDoneRef = useRef(false);
  const pendingSendPinRef = useRef(false);
  /** 分支导航成功应用新 context 后，下一次消息提交 effect 做 instant 钉底（与 send 分离，避免普通增长误触发）。 */
  const pendingResetPinRef = useRef(false);
  /** agent 执行结束后的会话整体替换（流式形态 → 文件最终形态）完成时钉底一次；仅 following 时生效，released 阅读不拉回。 */
  const pendingEndPinRef = useRef(false);
  const lastScrollTopRef = useRef(0);
  // 布局调整检测：clientHeight 变化（输入框变高/窗口 resize）触发的 scroll 事件
  // 不是用户滚动，不得把 following 误判为 released（否则输入框回车后自动滚动停止）。
  const lastClientHeightRef = useRef(0);
  const externalWriteUntilRef = useRef(0);
  const programmaticSmoothUntilRef = useRef(0);
  const runSettleUntilRef = useRef(0);
  const wasSessionBusyRef = useRef(false);
  const isMobileRef = useRef(false);
  const prefersReducedMotionRef = useRef(false);
  /**
   * 稳定容器元素：供 wheel/scroll/RO 绑定，避免 messages.length 每次变化断开重绑。
   * 通过 layout effect 在 loading→容器出现 / 容器替换时从 scrollContainerRef 同步。
   */
  const [scrollContainerEl, setScrollContainerEl] = useState<HTMLDivElement | null>(null);
  // 渲染期同步（与本文件 handleAgentEventRef 等既有模式一致）：事件回调里读最新断点。
  isMobileRef.current = opts.isMobile ?? false;

  // ── 自动跟随控制器 ────────────────────────────────────────────────────────
  // following：内容增长（ResizeObserver，paint 前）instant 钉底，绝不对 token 用 smooth。
  // released：流式增长、工具块重排、懒加载 prepend 都不回拉；只有用户向下进入
  // 末端区域或到真实底部才恢复（几何判定在 lib/chat-auto-follow.ts）。

  /** 回到底部按钮可见性：可滚动 + released + 不在末端区域。state 相同则不触发重渲染。 */
  const updateJumpButtonVisibility = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) {
      setJumpButtonVisible(false);
      return;
    }
    const show = shouldShowJumpButton(
      autoFollowModeRef.current,
      container.scrollHeight - container.clientHeight,
      getDistanceFromBottom(container.scrollHeight, container.scrollTop, container.clientHeight),
      getBottomZoneSize(container.clientHeight, isMobileRef.current),
    );
    setJumpButtonVisible((prev) => (prev === show ? prev : show));
  }, []);

  const applyAutoFollowMode = useCallback((mode: AutoFollowMode) => {
    if (autoFollowModeRef.current === mode) return;
    autoFollowModeRef.current = mode;
    updateJumpButtonVisibility();
  }, [updateJumpButtonVisibility]);

  /** 唯一钉底写入。instant 直接赋值（RO 回调内 paint 前生效）；smooth 标记程序化窗口。 */
  const pinToBottom = useCallback((behavior: ScrollBehavior = "instant") => {
    const container = scrollContainerRef.current;
    if (!container) return;
    const top = Math.max(0, container.scrollHeight - container.clientHeight);
    if (behavior === "smooth") {
      programmaticSmoothUntilRef.current = Date.now() + PROGRAMMATIC_SMOOTH_IGNORE_MS;
      container.scrollTo({ top, behavior: "smooth" });
      return;
    }
    // 预登记目标位置，pin 自身的 scroll 事件方向为 down/none，不参与状态判定。
    lastScrollTopRef.current = top;
    container.scrollTop = top;
  }, []);

  /** 发送消息：无论此前是否 released，立即回到 following；pin 等 DOM 就绪后在 messages effect 执行。 */
  const notifyAutoFollowSend = useCallback(() => {
    autoFollowModeRef.current = "following";
    pendingSendPinRef.current = true;
    setJumpButtonVisible(false);
  }, []);

  /**
   * 分支导航 / leaf 切换：在实际开始应用新 context 时调用（fetch 失败不调用）。
   * 恢复 following、隐藏 jump、标记 pendingReset 钉底，并重新 arm entry-stick 以覆盖异步重排。
   */
  const notifyAutoFollowBranchReset = useCallback(() => {
    autoFollowModeRef.current = "following";
    pendingResetPinRef.current = true;
    setJumpButtonVisible(false);
  }, []);

  /** 回到底部按钮：smooth 到底并恢复 following；prefers-reduced-motion 时 instant。 */
  const jumpToBottom = useCallback(() => {
    applyAutoFollowMode(reduceAutoFollow(autoFollowModeRef.current, { kind: "jump-button" }));
    pinToBottom(prefersReducedMotionRef.current ? "instant" : "smooth");
  }, [applyAutoFollowMode, pinToBottom]);

  /** 顶部懒加载 prepend 补偿写入前的标记：随后的 scroll 事件不参与状态判定。 */
  const markExternalScrollWrite = useCallback(() => {
    externalWriteUntilRef.current = Date.now() + 150;
  }, []);

  /** 扩展 inline 卡片「附近才滚到可见」的 smooth 滚动：不覆盖用户 released 状态。 */
  const notifyProgrammaticSmooth = useCallback(() => {
    programmaticSmoothUntilRef.current = Date.now() + PROGRAMMATIC_SMOOTH_IGNORE_MS;
  }, []);
  const ensuringNewSessionRef = useRef<Promise<string | null> | null>(null);
  const newSessionPromotedRef = useRef(false);
  const promptRunIdRef = useRef(0);
  /**
   * 当前 run 的 completion claim（finishAgentRun 写入）：阻止 agent_end /
   * prompt_done / reconcile 为同一 run 重复进入异步收尾；新 run 开始或收尾结束
   * 时释放，token 漂移也必须释放，否则后续 run 的收尾被永久阻塞。
   */
  const finishingPromptRunIdRef = useRef<number | null>(null);
  const optimisticUserMessageKeyRef = useRef<string | null>(null);

  const todos = useMemo(() => {
    const todoMessages = streamState.streamingMessage
      ? [...messages, streamState.streamingMessage as AgentMessage]
      : messages;
    return parseTodos(todoMessages);
  }, [messages, streamState.streamingMessage]);

  // SSE 连接管理交由可注入、可独立测试的 EventStreamManager（见
  // lib/event-stream-manager.ts）。这里只保留 lazy 初始化的 ref 通过引用
  // 复用同一实例，并把 agentRunningRef 作为重连门控注入。外部可见的
  // eventSourceRef 与之同步以便消费方契约不变。
  const eventStreamManagerRef = useRef<EventStreamManager | null>(null);
  if (eventStreamManagerRef.current === null) {
    eventStreamManagerRef.current = createEventStreamManager({
      connectTimeoutMs: EVENT_STREAM_CONNECT_TIMEOUT_MS,
      reconnectDelayMs: 1_000,
      shouldAutoReconnect: () => agentRunningRef.current,
    });
  }

  // P1-2：显示模型按固定优先级解析——用户手动选择（override）最高，其次
  // 新会话发送中携带的选择（pending），再其次磁盘持久化 model_change
  // （context.model），最后才是默认配置。extension 通知/subagent 完成提示/
  // activity/custom 消息都不会写入 override，因此不会覆盖用户选择。
  const currentModel = resolveDisplayModel(currentModelOverride, pendingModel, data?.context.model);
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
      // tail-first：首屏只拉最新 N 条，尽快结束 loading；更旧历史按需 prepend。
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
        return sameSession
          ? preserveCustomRenderedLines(previous, previousEntryIds, base.messages, base.entryIds)
          : base.messages;
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
      if (d.context.thinkingLevel && d.context.thinkingLevel !== "off") {
        setThinkingLevel(d.context.thinkingLevel as ThinkingLevelOption);
      }

      messagesLoaded = true;
      if (showLoading) setLoading(false);
      // D3 写动作按需请求成功标记；其它既有调用仍保持 null 返回语义。
      if (!includeState) return reportSuccess ? true : null;

      try {
        const stateRes = await fetch(`/api/sessions/${encodeURIComponent(sid)}/state`);
        if (!stateRes.ok) throw new Error(`HTTP ${stateRes.status}`);
        const agentState = await stateRes.json() as { running: boolean; state?: AgentStateResponse };
        if (sessionIdRef.current !== sid) return null;

        const liveState = agentState.state;
        if (liveState) {
          if (liveState.contextUsage !== undefined) setContextUsage(liveState.contextUsage ?? null);
          if (liveState.systemPrompt !== undefined) setSystemPrompt(liveState.systemPrompt ?? null);
          if (liveState.thinkingLevel !== undefined) setThinkingLevel((liveState.thinkingLevel as ThinkingLevelOption) ?? "auto");
          if (liveState.extensionStatuses !== undefined) patchExtensionUiState({ statuses: liveState.extensionStatuses ?? [] });
          if (liveState.extensionWidgets !== undefined) patchExtensionUiState({ widgets: liveState.extensionWidgets ?? [] });
          if (liveState.queuedMessages !== undefined) {
            setQueuedMessages({
              steering: normalizeQueuedMessages(liveState.queuedMessages).steering,
              followUp: [...localFollowUpRef.current],
            });
          }
        } else if (!agentState.running) {
          setQueuedMessages({ steering: [], followUp: [...localFollowUpRef.current] });
        }
        return agentState;
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
  }, [notifyAutoFollowBranchReset, patchExtensionUiState]);

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
      const nextEntryIds = prependOlderPage({
        previousMessages: olderMsgs,
        previousEntryIds: prevIds,
        olderMessages: olderMsgs,
        olderEntryIds: olderIds,
      }).entryIds;
      setMessages((previous) => prependOlderPage({
        previousMessages: previous,
        previousEntryIds: prevIds,
        olderMessages: olderMsgs,
        olderEntryIds: olderIds,
      }).messages);
      entryIdsRef.current = nextEntryIds;
      setEntryIds(nextEntryIds);
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
      const nextEntryIds = d.context.entryIds ?? [];
      const previousEntryIds = entryIdsRef.current;
      const shouldPreserveRenderedLines = messagesSessionIdRef.current === sid;
      // 仅在成功拿到新 context、即将写入 state 时重置跟随；fetch 失败不遗留 pending。
      notifyAutoFollowBranchReset();
      setMessages((previous) => shouldPreserveRenderedLines
        ? preserveCustomRenderedLines(previous, previousEntryIds, d.context.messages, nextEntryIds)
        : d.context.messages);
      entryIdsRef.current = nextEntryIds;
      messagesSessionIdRef.current = sid;
      setEntryIds(nextEntryIds);
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

    // 捕获本次 ensure 的 cwd：并发/切项目不得改写已发出的 body。
    const ensureCwd = cwd;
    const promise = (async () => {
      const selectedModel = newSessionModel ?? newSessionDefaultModel;
      // P0c：不再用预设收窄工具集——新会话不传 toolNames，SDK/扩展加载全集。
      const res = await fetch("/api/agent/new", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cwd: ensureCwd,
          // 必须带 type:"ensure_session"：createNew 据此只创建 runtime 不发送首条
          // prompt；缺失时 promptCommand 为空对象 → session.send({}) → Unsupported
          // command: undefined（08705ad 曾误删此字段，导致新会话创建 500）。
          type: "ensure_session",
          ...(selectedModel ? { provider: selectedModel.provider, modelId: selectedModel.modelId } : {}),
          ...(thinkingLevel !== "auto" ? { thinkingLevel } : {}),
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const result = await res.json() as { sessionId: string };
      const realId = result.sessionId;
      // 真实 sid 一旦返回即写入 ref：后续 prompt/SSE 失败也必须复用，禁止二次创建。
      sessionIdRef.current = realId;
      return realId;
    })();

    ensuringNewSessionRef.current = promise;
    try {
      return await promise;
    } finally {
      ensuringNewSessionRef.current = null;
    }
  }, [isNew, newSessionModel, newSessionDefaultModel, thinkingLevel]);

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

  const connectEvents = useCallback((sid: string): Promise<EventStreamConnectionResult> => {
    // 当前调用点均已按能力门禁；保留显式错误，防止未来误把只读会话接入 SSE。
    if (!capabilities.canConnectEvents) {
      return Promise.reject(new Error("Read-only sessions do not connect to agent events"));
    }
    // 建立时捕获 runId：连接排队/重连产生的回调携带旧 token，经 finishAgentRun
    // 校验丢弃，不会结束新 run。
    const streamRunId = promptRunIdRef.current;
    const manager = eventStreamManagerRef.current!;
    return manager.connect(sid, (event) => {
      handleAgentEventRef.current?.(event as unknown as AgentEvent, streamRunId);
    });
  }, [capabilities.canConnectEvents]);

  const ensureEventsConnected = useCallback(async (sid: string) => {
    if (!capabilities.canConnectEvents) return;
    // 同上：连接建立时捕获 runId（handleSend 在连接前已递增 promptRunIdRef）。
    const streamRunId = promptRunIdRef.current;
    try {
      await eventStreamManagerRef.current!.ensureConnected(sid, (event) => {
        handleAgentEventRef.current?.(event as unknown as AgentEvent, streamRunId);
      });
    } finally {
      // 同步外部可见的 eventSourceRef，保留清理与既有消费者的读取契约。
      eventSourceRef.current = eventStreamManagerRef.current?.getCurrentSource() as unknown as EventSource | null;
    }
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
      // ask-user 两步协议：select 的 Other（手动输入）提交时，插件期望收到
      // 选项里的哨兵文本（如 "4. Type something"），随后再发 input 请求收内容。
      // 用户输入内容暂存，自动响应后续 input；select 响应发哨兵，避免插件把
      // 自由文本当选项解析失败而放弃（表现为"已放弃提问"+工具卡到超时）。
      let effectiveResponse = response;
      if (
        request.method === "select" &&
        "value" in response &&
        typeof response.value === "string" &&
        request.options?.length &&
        !request.options.includes(response.value)
      ) {
        pendingOtherInputRef.current = response.value;
        // 哨兵 = 选项里自带的 Other 项（如 "4. Type something."）；无则用最后一项
        const otherInOptions = request.options.find((o) => {
          const l = o.trim().toLowerCase();
          return l === "other" || l === "其它" || l === "其他" || l.includes("type something");
        });
        effectiveResponse = { value: otherInOptions ?? request.options[request.options.length - 1] };
      }
      await sendAgentCommand(sid, {
        type: "extension_ui_response",
        id: request.id,
        ...effectiveResponse,
      });
      // OpenChamber 语义：取消问题块 = 终止当前执行（agent 阻塞在扩展请求上）。
      // 防护：若取消响应期间 agent 已自行停止（或用户已先停止），不再补发 abort，
      // 避免误中止之后新启动的 run。
      if ("cancelled" in response && response.cancelled === true && agentRunningRef.current) {
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
    agentRunningRef,
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
    // ask-user 两步协议：select Other 提交后插件会发 input 请求收内容——
    // 用暂存内容自动响应（不渲染弹窗），用户只需输入一次。
    const pendingOther = pendingOtherInputRef.current;
    if (request.method === "input" && pendingOther != null && request.id) {
      pendingOtherInputRef.current = null;
      const sid = sessionIdRef.current;
      if (sid) {
        sendAgentCommand(sid, {
          type: "extension_ui_response",
          id: request.id,
          value: pendingOther,
        }).catch((e) => console.error("Failed to auto-respond input:", e));
      }
      return;
    }
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
    if (state.thinkingLevel !== undefined) setThinkingLevel((state.thinkingLevel as ThinkingLevelOption) ?? "auto");
    if (state.isCompacting !== undefined) setIsCompacting(state.isCompacting);
    if (state.extensionStatuses !== undefined) patchExtensionUiState({ statuses: state.extensionStatuses ?? [] });
    if (state.extensionWidgets !== undefined) patchExtensionUiState({ widgets: state.extensionWidgets ?? [] });
    if (state.queuedMessages !== undefined) {
      setQueuedMessages({
        steering: normalizeQueuedMessages(state.queuedMessages).steering,
        followUp: [...localFollowUpRef.current],
      });
    }
  }, [patchExtensionUiState]);

  /**
   * 统一 agent run 结束路径（P2）：agent_end / prompt_done / reconcile idle 三路合一。
   * token（sid/runId/claim）校验通过才进入异步收尾：loadSession（含 includeState，
   * 刷新 contextUsage/systemPrompt/thinkingLevel/extensionStatuses/extensionWidgets/
   * queuedMessages 并顺手覆盖 isCompacting）→ 消息整体替换回调设置 settle/end-pin →
   * 按同一 token 安全结束状态。loadSession 失败也必须在 finally 结束，不得永久 running。
   */
  const finishAgentRun = useCallback(async (sid: string | null, runId: number) => {
    // 显式收窄：beginAgentRunFinish 的 sid 非空校验是 seam 层的防御性冗余。
    if (!sid) return;
    if (!beginAgentRunFinish({
      sessionId: sid,
      currentSessionId: sessionIdRef.current,
      eventRunId: runId,
      currentRunId: promptRunIdRef.current,
      running: agentRunningRef.current,
      claimedRunId: finishingPromptRunIdRef.current,
    })) return;
    // claim 必须在第一个 await 前占住：并发进入的 agent_end/prompt_done/reconcile 全部让路。
    finishingPromptRunIdRef.current = runId;
    try {
      const agentState = await loadSession(sid, false, true, false, false, () => {
        // 消息真正替换（onMessagesReplaced）：校验 token 后延长 settle 窗口并标记
        // end-pin。pendingEndPin 无条件下发，following/released 门禁已在 messages
        // effect 处理，released 阅读不会被拉回。
        if (runId !== promptRunIdRef.current) return;
        runSettleUntilRef.current = Date.now() + RUN_SETTLE_MS;
        pendingEndPinRef.current = true;
      });
      // includeState 已刷新大部分附属字段；applyAgentStateSnapshot 统一补齐
      // loadSession 未覆盖的 isCompacting（其余字段幂等重跑无害）。
      if (agentState && typeof agentState === "object" && "running" in agentState) {
        applyAgentStateSnapshot(agentState.state);
      }
    } finally {
      const valid = canFinalizeAgentRun({
        sessionId: sid,
        currentSessionId: sessionIdRef.current,
        eventRunId: runId,
        currentRunId: promptRunIdRef.current,
        claimedRunId: finishingPromptRunIdRef.current,
      });
      // 无条件释放 claim：token 漂移（切换会话/开启新 run）也必须让路，否则
      // 新 run 的收尾路径会被旧 claim 永久阻塞。
      finishingPromptRunIdRef.current = null;
      if (!valid) return;
      optimisticUserMessageKeyRef.current = null;
      agentRunningRef.current = false;
      setAgentRunning(false);
      setAgentPhase(null);
      setRetryInfo(null);
      dispatch({ type: "end" });
      onAgentEnd?.();
    }
  }, [loadSession, onAgentEnd, applyAgentStateSnapshot, dispatch, setAgentRunning, setAgentPhase, setRetryInfo]);

  const waitForPromptSettlement = useCallback(async (sid: string, runId?: number) => {
    await delay(PROMPT_SETTLE_INITIAL_DELAY_MS);
    const startedAt = Date.now();

    while (agentRunningRef.current && Date.now() - startedAt < PROMPT_SETTLE_MAX_MS) {
      if (runId !== undefined && promptRunIdRef.current !== runId) return;
      try {
        const res = await fetch(`/api/agent/${encodeURIComponent(sid)}`);
        if (res.ok) {
          const data = await res.json() as { running?: boolean; state?: AgentStateResponse };
          const state = data.state;
          if (!data.running || !state || (!state.isStreaming && !state.isPromptRunning)) {
            // 统一收尾路径：runId 缺省（刷新恢复场景）时回退当前 run id。
            await finishAgentRun(sid, runId ?? promptRunIdRef.current);
            return;
          }
        }
      } catch {
        // SSE remains the primary completion path.
      }
      await delay(PROMPT_SETTLE_POLL_MS);
    }
  }, [finishAgentRun]);

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
    if (!agentRunningRef.current) return;
    const runId = promptRunIdRef.current;
    try {
      const res = await fetch(`/api/agent/${encodeURIComponent(sid)}`);
      if (!res.ok) return;
      const data = await res.json() as { running?: boolean; state?: AgentStateResponse };
      // A slow response can straddle a run boundary (previous run finished
      // and the user already started the next one while this request was in
      // flight) — everything in it is stale, drop it.
      if (promptRunIdRef.current !== runId) return;
      const state = data.state;
      // Mirror compaction state unconditionally: a missed compaction_end
      // would otherwise leave the "Stop compaction" UI stuck. No state
      // (wrapper destroyed) means nothing is compacting.
      setIsCompacting(state?.isCompacting ?? false);
      setQueuedMessages({
        steering: normalizeQueuedMessages(state?.queuedMessages).steering,
        followUp: [...localFollowUpRef.current],
      });
      const busy = data.running && state
        && (state.isStreaming || state.isPromptRunning || state.isCompacting);
      if (busy || !agentRunningRef.current) return;
      // 服务端不 busy：走统一收尾路径（loadSession + 状态快照 + 结束副作用），
      // 不再单独应用终止快照，避免与 agent_end/prompt_done 路径差异。
      await finishAgentRun(sid, runId);
    } catch {
      // Network still down — the next poll / visibility / online tick retries.
    }
  }, [finishAgentRun]);

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

  useEffect(() => {
    agentRunningRef.current = agentRunning;
  }, [agentRunning]);

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
        // 新 run 开始：清空上一 run 的工具执行缓冲，避免旧快照跨 run 污染。
        commitToolExecutions(clearToolExecutions(toolExecutionBufferRef.current));
        agentRunningRef.current = true;
        setAgentRunning(true);
        setAgentPhase({ kind: "waiting_model" });
        dispatch({ type: "start" });
        break;
      case "agent_end":
        // 统一收尾路径：eventRunId 由 SSE 建立时捕获（旧 source 排队回调携带旧 token，
        // 经 finishAgentRun 校验丢弃，不会结束新 run）。
        void finishAgentRun(sessionIdRef.current, eventRunId ?? promptRunIdRef.current);
        break;
      case "prompt_done":
        // 同 agent_end：走同一收尾路径（含 claim/token 校验，重复进入被丢弃）。
        void finishAgentRun(sessionIdRef.current, eventRunId ?? promptRunIdRef.current);
        break;
      case "prompt_error":
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
        // Ignore streaming events arriving after this run already finished
        // (e.g. SSE data buffered while the tab was frozen, flushed after
        // reconcile) — they would resurrect a ghost streaming bubble.
        if (!agentRunningRef.current) break;
        const msg = event.message as Partial<AgentMessage> | undefined;
        if (msg?.role === "user") {
          break;
        }
        if (msg) {
          messagesSessionIdRef.current = sessionIdRef.current;
          const renderedMessage = attachCustomRenderedLines(
            msg as AgentMessage,
            (event as AgentEvent & { renderedLines?: unknown }).renderedLines,
          );
          dispatch({ type: "update", message: normalizeToolCalls(renderedMessage) });
        }
        setAgentPhase(null);
        break;
      }
      case "message_end": {
        // Same late-event guard: after reconcile finished this run,
        // loadSession already loaded this message from the session file —
        // appending it again would duplicate it.
        if (!agentRunningRef.current) break;
        const completed = event.message as AgentMessage | undefined;
        if (completed && completed.role === "user") {
          // Delivered steering/follow-up messages surface here as user
          // messages. The run's initial prompt also emits one, but handleSend
          // already appended it optimistically. Consume only the still-adjacent
          // optimistic bubble; later same-text queue deliveries must render.
          const delivered = normalizeToolCalls(completed);
          const deliveredKey = userMessageKey(delivered);
          const optimisticKey = optimisticUserMessageKeyRef.current;
          optimisticUserMessageKeyRef.current = null;
          setMessages((prev) => {
            const last = prev[prev.length - 1];
            if (optimisticKey && last?.role === "user" && userMessageKey(last) === optimisticKey) {
              return optimisticKey === deliveredKey
                ? prev
                : [...prev.slice(0, -1), delivered];
            }
            return [...prev, delivered];
          });
        } else if (completed) {
          messagesSessionIdRef.current = sessionIdRef.current;
          const renderedMessage = attachCustomRenderedLines(
            completed,
            (event as AgentEvent & { renderedLines?: unknown }).renderedLines,
          );
          setMessages((prev) => [...prev, normalizeToolCalls(renderedMessage)]);
        }
        dispatch({ type: "reset" });
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
      case "auto_retry_end":
        setRetryInfo(null);
        break;
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
  }, [addNotice, commitToolExecutions, finishAgentRun, handleExtensionUiRequest, loadSession]);
  handleAgentEventRef.current = handleAgentEvent;

  const handleSend = useCallback(async (message: string, images?: AttachedImage[]): Promise<boolean> => {
    // 只读会话：发送入口 UI 已替换为提示条，这里再拦一层。
    if (isReadOnly) return false;
    const trimmedMessage = message.trim();
    if (!trimmedMessage && !images?.length) return false;
    if (agentRunningRef.current || bashRunningRef.current) return false;
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

    const promptRunId = promptRunIdRef.current + 1;

    const imageBlocks = images?.map((img) => ({ type: "image" as const, source: { type: "base64" as const, media_type: img.mimeType, data: img.data } }));
    const userMsg: AgentMessage = {
      role: "user",
      content: imageBlocks?.length
        ? [...(message.trim() ? [{ type: "text" as const, text: message }] : []), ...imageBlocks]
        : message,
      timestamp: Date.now(),
    };
    setMessages((prev) => [...prev, userMsg]);
    optimisticUserMessageKeyRef.current = userMessageKey(userMsg);
    promptRunIdRef.current = promptRunId;
    agentRunningRef.current = true;
    setAgentRunning(true);
    setAgentPhase(isSlashCommandPrompt ? { kind: "running_command" } : { kind: "waiting_model" });
    dispatch({ type: "start" });
    // 发送即回到 following 并 instant 到底（pin 在 messages effect 中等 DOM 就绪执行），
    // 不再把刚发出的用户消息 smooth 推到顶部。
    notifyAutoFollowSend();

    const piImages = images?.map((img) => ({ type: "image" as const, data: img.data, mimeType: img.mimeType }));

    try {
      let sentSessionId: string | null = null;
      if (isNew && newSessionCwdRef.current) {
        const selectedModel = newSessionModel;
        const existingSid = sessionIdRef.current ?? await ensuringNewSessionRef.current;
        const sid = existingSid ?? await ensureNewSession();

        if (sid) {
          sentSessionId = sid;
          // ensure 成功即 promote：即使后续 SSE/prompt 失败也保留 sid，禁止二次创建。
          promoteNewSession(1, message);
          if (selectedModel) {
            setPendingModel(selectedModel);
            if (existingSid) {
              await sendAgentCommand(sid, { type: "set_model", provider: selectedModel.provider, modelId: selectedModel.modelId });
            }
          }
          await ensureEventsConnected(sid);
          await sendAgentCommand(sid, {
            type: "prompt",
            message,
            ...(piImages?.length ? { images: piImages } : {}),
          });
        } else {
          // 无可用 sid（竞态：isNew 已被并发消费等）：未发送，保留 draft。
          return false;
        }
      } else if (session) {
        sentSessionId = session.id;
        await ensureEventsConnected(session.id);
        await sendAgentCommand(session.id, {
          type: "prompt",
          message,
          ...(piImages?.length ? { images: piImages } : {}),
        });
      }
      if (isSlashCommandPrompt && sentSessionId) {
        void waitForPromptSettlement(sentSessionId, promptRunId);
      }
      // P0-1：发送已确认（prompt 预检通过 / 消息已提交），返回 true 供
      // ChatInput 确认后才清空 draft。
      return true;
    } catch (e) {
      console.error("Failed to send message:", e);
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
      addNotice({ type: "error", message: e instanceof Error ? e.message : String(e) });
      agentRunningRef.current = false;
      setAgentRunning(false);
      setAgentPhase(null);
      dispatch({ type: "end" });
      return false;
    }
  }, [isNew, isReadOnly, newSessionModel, session, ensureNewSession, ensureEventsConnected, promoteNewSession, waitForPromptSettlement, addNotice, notifyAutoFollowSend, opts.chatInputRef]);

  const executeBash = useCallback(async (command: string, excludeFromContext: boolean): Promise<boolean> => {
    // 只读会话：bash 命令同样会写 session 文件，拦截。
    if (isReadOnly) return false;
    if (agentRunningRef.current || bashRunningRef.current || branchBusyRef.current) return false;
    const inputText = `${excludeFromContext ? "!!" : "!"}${command}`;
    bashRunningRef.current = true;
    setPendingBash({ command, excludeFromContext });
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
    const sid = sessionIdRef.current;
    if (!sid) return;
    if (bashRunningRef.current) {
      try {
        await sendAgentCommand(sid, { type: "abort_bash" });
      } catch (e) {
        console.error("Failed to abort bash:", e);
      }
      return;
    }
    try {
      await sendAgentCommand(sid, { type: "abort" });
    } catch (e) {
      console.error("Failed to abort:", e);
    }
  }, [isReadOnly]);

  const handleModelChange = useCallback(async (provider: string, modelId: string) => {
    // 只读会话：set_model 会写会话状态，拦截。
    if (isReadOnly) return;
    if (isNew) {
      setNewSessionModel({ provider, modelId });
      setPendingModel({ provider, modelId });
      const sid = sessionIdRef.current ?? await ensuringNewSessionRef.current;
      if (!sid) return;
      try {
        await sendAgentCommand(sid, { type: "set_model", provider, modelId });
      } catch (e) {
        console.error("Failed to set model:", e);
      }
      return;
    }
    const sid = sessionIdRef.current;
    if (!sid) return;
    try {
      await sendAgentCommand(sid, { type: "set_model", provider, modelId });
      setCurrentModelOverride({ provider, modelId });
    } catch (e) {
      console.error("Failed to set model:", e);
    }
  }, [isNew, isReadOnly, setNewSessionModel]);

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
    const modelCwd = newSessionCwd ?? session?.cwd ?? "";
    const modelsUrl = modelCwd ? `/api/models?cwd=${encodeURIComponent(modelCwd)}` : "/api/models";
    const res = await fetch(modelsUrl, signal ? { signal } : undefined);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const d = await res.json() as ModelsResponse;
    setModelNames(d.models);
    setModelThinkingLevels(d.thinkingLevels ?? {});
    setModelThinkingLevelMaps(d.thinkingLevelMaps ?? {});
    setModelAuthConfigured(d.authConfigured ?? {});
    const nextModelList = d.modelList ?? [];
    setModelList(nextModelList);
    if (isNew) {
      const match = d.defaultModel
        ? nextModelList.find((m) => m.id === d.defaultModel?.modelId && m.provider === d.defaultModel?.provider)
        : undefined;
      // 默认模型优先落在已认证 provider 上：未认证且无环境凭据的模型必失败，不作为新会话默认。
      const configuredMap = d.authConfigured ?? {};
      const displayModel = match
        ?? nextModelList.find((m) => configuredMap[m.provider] !== false)
        ?? nextModelList[0];
      setNewSessionDefaultModel(displayModel ? { provider: displayModel.provider, modelId: displayModel.id } : null);
    }
  }, [isNew, newSessionCwd, session?.cwd]);

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
    // 引导/队列投递后回到 following 并钉底（消息会直接出现在会话中）。
    notifyAutoFollowSend();
    const piImages = images?.map((img) => ({ type: "image" as const, data: img.data, mimeType: img.mimeType }));
    try {
      await sendAgentCommand(sid, {
        type: "steer",
        message,
        ...(piImages?.length ? { images: piImages } : {}),
      });
    } catch (e) {
      console.error("Failed to steer:", e);
    }
  }, [isReadOnly, notifyAutoFollowSend]);

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
      console.error("Failed to steer:", e);
    }
  }, [isReadOnly]);

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
    if (images?.length || !agentRunningRef.current) {
      // 有图或空闲：直接 prompt（空闲时无“结束后投递”语义）
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
    // 运行中入队：队列块出现在输入框上方，钉底让用户看到入队结果。
    notifyAutoFollowSend();
    updateLocalFollowUp([...localFollowUpRef.current, text]);
  }, [isReadOnly, notifyAutoFollowSend, updateLocalFollowUp]);

  // 供 handlePromptWithStreamingBehavior（定义在前）引用最新 handleFollowUp
  handleFollowUpRef.current = handleFollowUp;

  const handleAbortCompaction = useCallback(async () => {
    // 只读会话不存在进行中的 compact，拦截。
    if (isReadOnly) return;
    // Pi 0.83 RPC 无 abort_compaction；不发未知命令。
    addNotice({
      type: "warning",
      message: "当前外部 Pi runtime 不支持中止压缩（abort_compaction）",
    });
  }, [isReadOnly, addNotice]);

  const handleRecallQueue = useCallback(async () => {
    // 只读会话没有队列（state 从不加载），拦截。
    if (isReadOnly) return;
    const items = localFollowUpRef.current;
    if (items.length === 0) return;
    // 取回：队列内容回填输入框（TUI queue restore 语义），清空本地队列。
    opts.chatInputRef?.current?.prependText(joinQueueForRecall(items));
    updateLocalFollowUp([]);
  }, [isReadOnly, updateLocalFollowUp, opts.chatInputRef]);

  /** 引导发送：本地 follow-up 队列（+ 可选 extra）合并为一条 steer 消息，成功后清空。 */
  const handleSendQueueAsSteer = useCallback(async (extraMessage?: string) => {
    if (isReadOnly) return;
    const sid = sessionIdRef.current;
    if (!sid) return;
    const merged = mergeFollowUpForSteer(localFollowUpRef.current, extraMessage);
    if (!merged) return;
    notifyAutoFollowSend();
    try {
      if (agentRunningRef.current) {
        // 运行中：steer（打断当前思考，立即引导）
        await sendAgentCommand(sid, { type: "steer", message: merged });
      } else {
        // 空闲：Pi 的 steer 只入进程队列不唤醒；用 prompt 立即发起新回合
        await sendAgentCommand(sid, { type: "prompt", message: merged });
      }
      updateLocalFollowUp([]);
    } catch (e) {
      console.error("Failed to send queue as steer:", e);
      addNotice({ type: "error", message: String(e instanceof Error ? e.message : e) });
    }
  }, [isReadOnly, notifyAutoFollowSend, updateLocalFollowUp, addNotice]);

  const handleThinkingLevelChange = useCallback(async (level: ThinkingLevelOption) => {
    // 只读会话：set_thinking_level 会写会话状态，拦截。
    if (isReadOnly) return;
    setThinkingLevel(level);
    if (level === "auto") return; // "auto" leaves pi's current setting untouched
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
    if (agentRunningRef.current || bashRunningRef.current || branchBusyRef.current) return;
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

  // 会话切换：清空阻塞队列与可见卡片；不发送 extension_ui_response。
  useEffect(() => {
    const current = extensionUiStateRef.current;
    commitExtensionUiState({
      ...clearAllExtensionUiBlocking(current),
      customUi: null,
    });
    clearLiveActivities();
  }, [session?.id, newSessionCwd, commitExtensionUiState, extensionUiStateRef, clearLiveActivities]);

  useEffect(() => {
    if (session) {
      sessionIdRef.current = session.id;
      if (session.readOnly === true) {
        // 只读会话：只走 GET 详情读取路径。不拉 /state、不连 per-session SSE、
        // 不触发任何会启动 AgentSession 的调用；历史消息与分支树照常展示。
        void loadSession(session.id, true, false);
      } else {
        loadSession(session.id, true, true).then((agentState) => {
          // includeState=true 的运行时不会返回 true；该分支仅收窄 loadSession 的联合返回类型。
          if (agentState === true) return;
          if (agentState?.running) {
            loadTools(session.id);
            if (agentState.state?.isStreaming || agentState.state?.isPromptRunning) {
              agentRunningRef.current = true;
              setAgentRunning(true);
              setAgentPhase(agentState.state.isStreaming ? { kind: "waiting_model" } : { kind: "running_command" });
              dispatch({ type: "start" });
              void connectEvents(session.id);
              if (!agentState.state.isStreaming && agentState.state.isPromptRunning) {
                void waitForPromptSettlement(session.id);
              }
            }
            if (agentState.state?.isBashRunning) {
              bashRunningRef.current = true;
              setBashRunning(true);
              // 恢复执行中的 bash 命令气泡（pendingBash 不持久化，刷新后由服务端快照恢复）
              if (agentState.state.pendingBash) {
                setPendingBash(agentState.state.pendingBash);
              }
              void waitForBashSettlement(session.id);
            }
          }
          if (agentState?.state) {
            if (agentState.state.isCompacting !== undefined) setIsCompacting(agentState.state.isCompacting);
            if (agentState.state.contextUsage !== undefined) setContextUsage(agentState.state.contextUsage ?? null);
            if (agentState.state.systemPrompt !== undefined) setSystemPrompt(agentState.state.systemPrompt ?? null);
            if (agentState.state.thinkingLevel !== undefined) setThinkingLevel((agentState.state.thinkingLevel as ThinkingLevelOption) ?? "auto");
            if (agentState.state.extensionStatuses !== undefined) patchExtensionUiState({ statuses: agentState.state.extensionStatuses ?? [] });
            if (agentState.state.extensionWidgets !== undefined) patchExtensionUiState({ widgets: agentState.state.extensionWidgets ?? [] });
            if (agentState.state.queuedMessages !== undefined) {
              setQueuedMessages({
                steering: normalizeQueuedMessages(agentState.state.queuedMessages).steering,
                followUp: [...localFollowUpRef.current],
              });
            }
            // 切回会话时恢复阻塞中的问题块（服务端权威队列）。
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
      eventStreamManagerRef.current?.close();
      eventSourceRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    onSystemPromptChange?.(systemPrompt);
  }, [systemPrompt, onSystemPromptChange]);

  useEffect(() => {
    if (!onBranchDataChange) return;
    onBranchDataChange(data?.tree ?? [], activeLeafId, handleLeafChange, branchActions);
  }, [data?.tree, activeLeafId, handleLeafChange, branchActions, onBranchDataChange]);

  // 同步稳定容器元素：loading 结束 / 空会话→有消息 时容器才挂载；仅元素身份变化才更新 state。
  useEffect(() => {
    const el = scrollContainerRef.current;
    setScrollContainerEl((prev) => (prev === el ? prev : el));
  }, [loading, messages.length, isNew]);

  // 向上意图监听：wheel deltaY<0、触摸下拉、ArrowUp/PageUp/Home 立即 release。
  // 发生在可自己向上滚的嵌套区时让嵌套区优先消费，不误 release。
  // 依赖 scrollContainerEl（非 messages.length），避免每条消息断开重绑。
  useEffect(() => {
    const container = scrollContainerEl;
    if (!container) return;

    const releaseOnUpIntent = () => {
      applyAutoFollowMode(reduceAutoFollow(autoFollowModeRef.current, { kind: "up-intent" }));
    };

    const onWheel = (event: WheelEvent) => {
      if (event.deltaY >= 0) return;
      if (isInsideNestedUpScrollable(event.target, container)) return;
      releaseOnUpIntent();
    };

    let touchStartY: number | null = null;
    let touchTarget: EventTarget | null = null;
    const onTouchStart = (event: TouchEvent) => {
      touchStartY = event.touches[0]?.clientY ?? null;
      touchTarget = event.target;
    };
    const onTouchMove = (event: TouchEvent) => {
      if (touchStartY === null) return;
      const y = event.touches[0]?.clientY;
      if (y === undefined) return;
      // 手指向下滑动 = 内容向上走 = 向上阅读意图；超过 4px 阈值才判定一次
      if (y - touchStartY > 4) {
        if (!isInsideNestedUpScrollable(touchTarget, container)) releaseOnUpIntent();
        touchStartY = null;
      }
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (!RELEASE_KEYS.has(event.key)) return;
      if (event.target instanceof Element && event.target.closest("input, textarea, [contenteditable='true']")) return;
      releaseOnUpIntent();
    };

    container.addEventListener("wheel", onWheel, { passive: true });
    container.addEventListener("touchstart", onTouchStart, { passive: true });
    container.addEventListener("touchmove", onTouchMove, { passive: true });
    window.addEventListener("keydown", onKeyDown);
    return () => {
      container.removeEventListener("wheel", onWheel);
      container.removeEventListener("touchstart", onTouchStart);
      container.removeEventListener("touchmove", onTouchMove);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [scrollContainerEl, applyAutoFollowMode]);

  // scroll 几何判定：程序化写入窗口（prepend 补偿、扩展卡片、smooth pin）内不判状态。
  // 其余规则：到真实底部恢复；向下进入末端区域恢复；following 中向上位移即 release。
  useEffect(() => {
    const container = scrollContainerEl;
    if (!container) return;
    const onScroll = () => {
      const now = Date.now();
      const previousTop = lastScrollTopRef.current;
      const nextTop = container.scrollTop;
      lastScrollTopRef.current = nextTop;
      if (now < externalWriteUntilRef.current || now < programmaticSmoothUntilRef.current) {
        updateJumpButtonVisibility();
        return;
      }
      // 布局调整（输入框变高、窗口尺寸变化）引起的 scroll 事件：仅刷新按钮，
      // 不参与 following/released 状态判定。
      const clientChanged = container.clientHeight !== lastClientHeightRef.current;
      lastClientHeightRef.current = container.clientHeight;
      if (clientChanged) {
        updateJumpButtonVisibility();
        return;
      }
      applyAutoFollowMode(
        reduceAutoFollow(autoFollowModeRef.current, {
          kind: "scroll",
          distance: getDistanceFromBottom(container.scrollHeight, nextTop, container.clientHeight),
          direction: getScrollDirection(previousTop, nextTop),
          zoneSize: getBottomZoneSize(container.clientHeight, isMobileRef.current),
        }),
      );
      updateJumpButtonVisibility();
    };
    container.addEventListener("scroll", onScroll, { passive: true });
    return () => container.removeEventListener("scroll", onScroll);
  }, [scrollContainerEl, applyAutoFollowMode, updateJumpButtonVisibility]);

  // agent/bash 结束后的 settle 窗口 + 双 rAF 补钉：
  // 结束瞬间 process group 从「扁平流式」切到折叠结构、streaming 槽卸除，高度会突变；
  // 若只 pin 一次且过早，视口会停在中间，表现为「滚动条向上跳很长」。
  useEffect(() => {
    const busy = agentRunning || bashRunning;
    if (wasSessionBusyRef.current && !busy) {
      runSettleUntilRef.current = Date.now() + RUN_SETTLE_MS;
      if (autoFollowModeRef.current === "following") {
        requestAnimationFrame(() => {
          pinToBottom("instant");
          requestAnimationFrame(() => {
            if (autoFollowModeRef.current === "following") pinToBottom("instant");
          });
        });
      }
    }
    wasSessionBusyRef.current = busy;
  }, [agentRunning, bashRunning, pinToBottom]);

  // 内容尺寸监听：following 时布局变化即 instant 钉底（与 chat-auto-follow 注释一致）。
  // 不再仅限 busy/settle/entry——agent 结束后的滞后重排也要补钉；released 时只更新按钮。
  // ResizeObserver 回调在 paint 前触发，钉底不产生可见跳动。
  // 依赖 scrollContainerEl，不因 messages.length 断开重绑。
  useEffect(() => {
    const container = scrollContainerEl;
    if (!container) return;
    const content = container.firstElementChild;
    const onResize = () => {
      const now = Date.now();
      if (autoFollowModeRef.current !== "following") {
        updateJumpButtonVisibility();
        return;
      }
      if (now < programmaticSmoothUntilRef.current) return;
      // prepend 等外部 scrollTop 写入窗口内：只刷新 jump 按钮，禁止钉底覆盖补偿。
      if (now < externalWriteUntilRef.current) {
        updateJumpButtonVisibility();
        return;
      }
      pinToBottom("instant");
      updateJumpButtonVisibility();
    };
    const observer = new ResizeObserver(onResize);
    observer.observe(container);
    if (content) observer.observe(content);
    return () => observer.disconnect();
  }, [scrollContainerEl, pinToBottom, updateJumpButtonVisibility]);

  // DOM 就绪后的 instant pin：发送消息 / 分支重置 / end-pin / 初次打开。
  // following 期间后续增长由 ResizeObserver 负责。
  // 依赖 messages（非仅 length）：分支切换条数不变时仍能消费 pendingResetPinRef。
  useEffect(() => {
    if (messages.length === 0) return;
    if (!scrollContainerRef.current) return;
    if (pendingSendPinRef.current || pendingResetPinRef.current || pendingEndPinRef.current) {
      pendingSendPinRef.current = false;
      pendingResetPinRef.current = false;
      pendingEndPinRef.current = false;
      initialScrollDoneRef.current = true;
      // end-pin 尊重 released：执行结束后用户若已向上阅读，绝不强行拉回底部。
      if (autoFollowModeRef.current === "following") pinToBottom("instant");
    } else if (!initialScrollDoneRef.current) {
      initialScrollDoneRef.current = true;
      pinToBottom("instant");
    }
    updateJumpButtonVisibility();
  }, [messages, pinToBottom, updateJumpButtonVisibility]);

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mql = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => {
      prefersReducedMotionRef.current = mql.matches;
    };
    update();
    mql.addEventListener("change", update);
    return () => mql.removeEventListener("change", update);
  }, []);

  // Load model list
  useEffect(() => {
    const controller = new AbortController();
    loadModels(controller.signal).catch((e) => {
      if (e instanceof DOMException && e.name === "AbortError") return;
    });
    return () => controller.abort();
  }, [loadModels, modelsRefreshKey]);

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
    agentRunning, modelNames, modelList, modelAuthConfigured, modelThinkingLevels, modelThinkingLevelMaps, newSessionModel, thinkingLevel,
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
