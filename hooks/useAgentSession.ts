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
  BinaryMessageInput,
  ChatInputHandle,
} from "@/lib/types";
import { preserveCustomRenderedLines } from "@/lib/custom-rendered-lines";
import type { SessionActivity } from "@/lib/session-activity";
import { readAgentLiveFlag, sendAgentCommand } from "@/lib/agent-client";
import { generateSubmissionId, isQueueablePromptReason, type PromptReason, type PromptReceipt, type QueueDispatchReceipt } from "@/lib/agent-commands";
import { clearDraft } from "@/lib/draft-store";
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
import type { ContextUsage, SessionStatsInfo } from "@/lib/pi-types";
import {
  applyExtensionUiRequest,
  clearAllExtensionUiBlocking,
  clearExtensionUiRequest,
  projectBlockingHead,
  restoreCustomUi,
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
} from "@/lib/session-context-window";
import { submissionKey } from "@/lib/session-timeline";
import {
  adoptServerSnapshot,
  isQueueWriteConflict,
  itemImageRefs,
  payloadsForWrite,
  projection,
  proposeQueue,
  queueEntry,
  queueRows,
  settleSyncFailure,
  settleSyncSuccess,
  type QueueBook,
  type QueueEntry,
  type QueueReceiptView,
  type QueueSnapshot,
} from "@/lib/queue-state";
import { normalizeFollowUpItemList, type FollowUpItem, type QueuedImageRef } from "@/lib/session-queue";
import type { QueueItemPayload } from "@/lib/agent-commands";
import { encodeFilePathForApi } from "@/lib/file-paths";
import { canApplyProjection } from "@/lib/session-projection";
import type { TimelineHydrateMode, TurnMetrics } from "@/lib/browser-session-runtime-registry";
import {
  closeSelectionOp,
  hasOpenOp,
  isLatestOp,
  openSelectionOp,
  type SelectionOpBook,
} from "@/lib/selection-ops";

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
  | { type: "update"; message: Partial<AgentMessage> | null }
  | { type: "end" }
  | { type: "reset" };

/** 输入框图片 → 队列载荷（安全尺寸 base64 直传，Host 落盘到会话 outbox）。 */
function toQueuePayloads(text: string, images?: AttachedImage[]): QueueItemPayload[] {
  if (!images?.length) return text ? [{ text }] : [];
  return [{
    text,
    images: images.map((image) => ({ source: "data" as const, data: image.data, mimeType: image.mimeType })),
  }];
}

/**
 * 队列取回：把 Host outbox 里的图片字节读回输入框。
 *
 * 不写 `original`：outbox 副本会随队列条目一起删除，原图信息会让回填的消息
 * 指向一个很快就不存在的文件。单张读失败就跳过，不回滚已经取回的正文。
 */
async function fetchQueueImages(refs: readonly QueuedImageRef[]): Promise<AttachedImage[]> {
  const loaded = await Promise.all(refs.map(async (ref): Promise<AttachedImage | null> => {
    try {
      // 必须带 type=read：不带 type 的 GET 默认是目录列表，对文件返回 400。
      const response = await fetch(
        `/api/files/${encodeFilePathForApi(ref.path)}?type=read&mime=${encodeURIComponent(ref.mimeType)}`,
        { cache: "no-store" },
      );
      if (!response.ok) return null;
      const blob = await response.blob();
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
        reader.onerror = () => reject(reader.error ?? new Error("读取排队图片失败"));
        reader.readAsDataURL(blob);
      });
      const data = dataUrl.slice(dataUrl.indexOf(",") + 1);
      if (!data) return null;
      return { data, mimeType: ref.mimeType, previewUrl: dataUrl };
    } catch {
      return null;
    }
  }));
  return loaded.filter((image): image is AttachedImage => image !== null);
}

function streamReducer(state: StreamingState, action: StreamAction): StreamingState {
  switch (action.type) {
    case "start":
      return { isStreaming: true, streamingMessage: null };
    case "update":
      // 只置位无正文（run 已开始、尚未收到首帧）：保持 null，避免空 live 气泡。
      return { isStreaming: true, streamingMessage: action.message ?? null };
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
  /** host 热投影的当前模型（切回会话时 loadSession 返回前恢复模型显示用） */
  model?: { provider: string; modelId: string } | null;
  isStreaming?: boolean;
  isPromptRunning?: boolean;
  isBashRunning?: boolean;
  /** bash 执行中的命令快照（服务端 ExternalRpcSession 记录；刷新恢复用） */
  pendingBash?: { command: string; excludeFromContext: boolean; startedAt: number } | null;
  isCompacting?: boolean;
  lockedByOther?: boolean;
  extensionStatuses?: ExtensionStatusItem[];
  extensionWidgets?: ExtensionWidgetItem[];
  queuedMessages?: { steering?: string[]; followUp?: string[]; followUpRevision?: number | null } | null;
  pendingExtensionRequests?: AgentEvent[];
  /**
   * 活动 custom 面板的快照（由 host 保存的最后一次渲染行）。
   * custom 只有 SSE 事件、没有重放，刷新/切回后靠它恢复面板内容与输入入口。
   */
  activeCustomUi?: { id?: string; lines?: string[] } | null;
  /** host 侧本 run 的吞吐读数（冷挂载/刷新时 seed；本地采样后失效）。 */
  turnMetrics?: { tokensPerSecond?: number; ttftMs?: number } | null;
};

export interface QueuedMessageRow {
  id: string;
  text: string;
  /** waiting = 待投递；claimed = 已提交未确认；unknown = 结果未知（绝不自动重投） */
  state: "waiting" | "claimed" | "unknown";
  /** 本条目携带的图片数量（图片实字节在 Host 侧的 outbox 目录，不在浏览器内存）。 */
  imageCount: number;
}

export interface QueuedMessages {
  steering: string[];
  followUp: string[];
  /** UI 行（含在途与未知条目）；旧服务端无此字段时回落到 followUp。 */
  followUpRows: QueuedMessageRow[];
  /** Host 队列版本（单调）；null = 未知（旧 Host），此时不做新旧判定 */
  followUpRevision: number | null;
}

function normalizeQueuedMessages(
  q?: {
    steering?: string[];
    followUp?: string[];
    followUpItems?: QueuedMessageRow[];
    followUpRevision?: number | null;
    inFlight?: string[];
  } | null,
): { steering: string[]; items: FollowUpItem[]; inFlight: string[]; revision: number | null } {
  const inFlight = Array.isArray(q?.inFlight)
    ? q.inFlight.filter((text): text is string => typeof text === "string")
    : [];
  const items: FollowUpItem[] = Array.isArray(q?.followUpItems)
    ? normalizeFollowUpItemList(q.followUpItems)
    // 旧 Host 只回正文：按正文造条目，身份在本次投影内稳定
    : (q?.followUp ?? []).map((text, index) => ({ id: `srv-${index}`, text, state: "waiting" as const }));
  return {
    steering: q?.steering ?? [],
    items,
    inFlight,
    revision: typeof q?.followUpRevision === "number" ? q.followUpRevision : null,
  };
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

/** steer 乐观消息本地标记（仅前端内存，不写盘；投递时由 registry 按稳定 key 对账）。 */
type SteerOptimisticMessage = AgentMessage & { _steerOptimistic?: boolean };

/**
 * 请求被取消（切换会话 / 新的加载取代了本次）—— 不是失败，不得写 error。
 * fetch abort 会抛 DOMException(AbortError)；旧浏览器/Node 也可能是普通 Error。
 */
function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function readCompactResult(result: unknown, reason: string): CompactResultInfo | null {
  if (!result || typeof result !== "object") return null;
  const r = result as CompactCommandResult;
  if (typeof r.tokensBefore !== "number" || typeof r.estimatedTokensAfter !== "number") return null;
  return { reason, tokensBefore: r.tokensBefore, estimatedTokensAfter: r.estimatedTokensAfter };
}

export type { AttachedImage, ChatInputHandle } from "@/lib/types";

type SelectedModel = { provider: string; modelId: string };
type ModelEntry = { id: string; name: string; provider: string; contextWindow?: number };
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
  /** 定位到历史窗口后是否还有「更新」的历史可向下加载（around 窗口专有） */
  const [hasMoreAfter, setHasMoreAfter] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeLeafId, setActiveLeafId] = useState<string | null>(null);
  /** activeLeafId 的 ref 镜像：跳转门禁要读「发起时」的 leaf */
  const activeLeafIdRef = useRef<string | null>(null);
  activeLeafIdRef.current = activeLeafId;
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [entryIds, setEntryIds] = useState<string[]>([]);
  /** 与 messages 平行的稳定 key（React 列表用），由 registry 投影。 */
  const [messageKeys, setMessageKeys] = useState<string[]>([]);
  /** 同一会话并发 tail/state 请求的响应代数；只允许最新请求提交 React 状态。 */
  const loadRequestSeqRef = useRef(0);
  /**
   * 会话加载（tail/hot state/更旧历史/分支 context）的取消句柄。
   * 大会话的 tail 可达数百 KB；切走后若不断开，响应体会被完整下载并解析，
   * 之后才被 sessionId 守卫丢弃——白花流量与内存。
   */
  const loadAbortRef = useRef<AbortController | null>(null);
  const beginLoadRequest = useCallback((): AbortSignal => {
    loadAbortRef.current?.abort();
    const controller = new AbortController();
    loadAbortRef.current = controller;
    return controller.signal;
  }, []);
  const historyLoadingRef = useRef(false);
  const hasMoreBeforeRef = useRef(false);
  const hasMoreAfterRef = useRef(false);
  const [streamState, dispatch] = useReducer(streamReducer, { isStreaming: false, streamingMessage: null });
  const [agentRunning, setAgentRunning] = useState(false);
  /** 最近一轮 run 的延迟/吞吐读数（由 registry snapshot 投影，算法见 TurnMetrics）。 */
  const [turnMetrics, setTurnMetrics] = useState<TurnMetrics>({});
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
  /** thinkingLevel 的 ref 镜像：回滚与陈旧响应判定需要读到最新值。 */
  const thinkingLevelRef = useRef<ThinkingLevelOption | null>(null);
  thinkingLevelRef.current = thinkingLevel;
  // 当前会话的思考档是否已被权威源（loadSession context / 引导页默认）确认：
  // 确认前模型按钮不显示档位，避免切回会话瞬间残留上一会话/中间态档位。
  const [thinkingReady, setThinkingReady] = useState(false);
  const thinkingReadyRef = useRef(false);
  thinkingReadyRef.current = thinkingReady;
  // 档位权威已确认的会话 id（loadSession 应用 context 后置位，切会话复位）：
  // 用于过滤 attach 重放/加载窗口内的 thinking_level_changed 回写。
  const thinkingSettledRef = useRef<string | null>(null);
  // settings.json 默认只服务于新会话引导页；已有会话没有自己的档位时为 off，
  // 不得把全局默认带入其它会话。
  const resolvedThinking: AgentThinkingLevel = isNew
    ? thinkingLevel ?? settingsDefaultThinking ?? "off"
    : thinkingLevel ?? "off";
  const [retryInfo, setRetryInfo] = useState<{ attempt: number; maxAttempts: number; errorMessage?: string } | null>(null);
  const [contextUsage, setContextUsage] = useState<{ percent: number | null; contextWindow: number; tokens: number | null } | null>(null);
  /**
   * 上下文读数的写入代次：SSE（message_end/agent_end）每写一次就 +1。
   * reconcile 是异步兜底，回来后必须确认期间没有更新的权威读数，否则旧响应会
   * 覆盖较新的用量，或把压缩后的「未知」态顶回压缩前的数字。
   */
  const contextUsageGenerationRef = useRef(0);
  const applyLiveContextUsage = useCallback((usage: { percent: number | null; contextWindow: number; tokens: number | null }) => {
    contextUsageGenerationRef.current += 1;
    setContextUsage(usage);
  }, []);
  const [systemPrompt, setSystemPrompt] = useState<string | null>(null);
  const [forkingEntryId, setForkingEntryId] = useState<string | null>(null);
  const [currentModelOverride, setCurrentModelOverride] = useState<{ provider: string; modelId: string } | null>(null);
  /** override 的 ref 镜像：失败回滚需要读到选择前的值。 */
  const currentModelOverrideRef = useRef<{ provider: string; modelId: string } | null>(null);
  currentModelOverrideRef.current = currentModelOverride;
  /** 模型/思考写入操作的代次登记（每会话唯一在途操作）。 */
  const selectionOpBookRef = useRef<SelectionOpBook>({});
  const selectionOpSeqRef = useRef(0);
  /** 每会话串行链：两次选择不得交错成「模型 B + 深度 A」。 */
  const selectionChainRef = useRef<Record<string, Promise<unknown>>>({});
  /**
   * 每会话最近已知模型（sessionId → model）：切换会话 setData(null) 清磁盘投影后、
   * loadSession 返回前的窗口内恢复模型显示，避免输入框显示「模型」占位。
   * 数据源：hot/live state 投影与磁盘 context.model（loadSession 成功后登记）。
   */
  const [lastKnownModel, setLastKnownModel] = useState<{ provider: string; modelId: string } | null>(null);
  const lastKnownModelBySessionRef = useRef<Map<string, { provider: string; modelId: string }>>(new Map());
  /**
   * 仅由**磁盘上下文**写入的观察值（hot/live 不写）：
   * 「磁盘相对上次读取发生了变化」才是外部写入的证据；混入 live 值会误判。
   */
  const lastDiskModelBySessionRef = useRef<Map<string, { provider: string; modelId: string }>>(new Map());
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
  const [queuedMessages, setQueuedMessages] = useState<QueuedMessages>({ steering: [], followUp: [], followUpRows: [], followUpRevision: null });
  // 每会话本地 follow-up 队列：Host 是唯一 owner，浏览器只持「权威条目 + 一个
  // 乐观待提交值 + CAS 基线」，按 sessionId 分账（见 lib/queue-state.ts 不变量）。
  const queueBookRef = useRef<QueueBook>({});
  /** 当前显示的会话（队列投影据此取账）。 */
  const currentQueueSessionIdRef = useRef<string | null>(session?.id ?? null);
  const followUpSyncRef = useRef<Promise<void>>(Promise.resolve());
  const queueEntryNow = useCallback((): QueueEntry => {
    return queueEntry(queueBookRef.current, currentQueueSessionIdRef.current ?? "");
  }, []);
  /** 把当前会话的队列投影刷新到 UI。 */
  const publishQueue = useCallback((steering?: string[]) => {
    setQueuedMessages((current) => {
      const entry = queueEntryNow();
      return {
        steering: steering ?? current.steering,
        followUp: projection(entry),
        followUpRows: queueRows(entry),
        followUpRevision: entry.serverRevision,
      };
    });
  }, [queueEntryNow]);
  /** 采纳任意会话的权威队列快照（可来自 state/SSE/prefs/写入回执）。 */
  const adoptRemoteQueue = useCallback((sid: string, snapshot: QueueSnapshot) => {
    queueBookRef.current = adoptServerSnapshot(queueBookRef.current, sid, snapshot);
  }, []);
  /**
   * 热 state 投影：权威内容与版本一次落地。
   *
   * `sid` 是这份快照**属于哪个会话**。调用方必须传自己请求的那个会话，而不是
   * 「当前显示的会话」—— 否则迟到的响应会把上一个会话的队列写进当前界面。
   */
  const applyProjectedQueues = useCallback((sid: string, value?: AgentStateResponse["queuedMessages"]) => {
    const next = normalizeQueuedMessages(value);
    adoptRemoteQueue(sid, { items: next.items, inFlight: next.inFlight, revision: next.revision });
    if (currentQueueSessionIdRef.current !== sid) return;
    setQueuedMessages({
      steering: next.steering,
      followUp: projection(queueEntry(queueBookRef.current, sid)),
      followUpRows: queueRows(queueEntry(queueBookRef.current, sid)),
      followUpRevision: queueEntry(queueBookRef.current, sid).serverRevision,
    });
  }, [adoptRemoteQueue]);
  /** 从服务端队列载荷取权威快照（回执与 SSE 事件同形）。 */
  const snapshotFromQueuePayload = useCallback((receipt: unknown): QueueSnapshot => {
    const view = (receipt ?? {}) as QueueReceiptView;
    return {
      items: normalizeFollowUpItemList(view.items),
      inFlight: Array.isArray(view.inFlight)
        ? view.inFlight.filter((text): text is string => typeof text === "string")
        : [],
      revision: typeof view.revision === "number" ? view.revision : null,
    };
  }, []);
  /** 采纳 SSE 队列事件（事件自带 sessionId，可能是别的会话）。 */
  const adoptQueueEvent = useCallback((event: { sessionId?: string } & QueueReceiptView) => {
    const sid = typeof event?.sessionId === "string" && event.sessionId
      ? event.sessionId
      : currentQueueSessionIdRef.current;
    if (!sid) return;
    adoptRemoteQueue(sid, snapshotFromQueuePayload(event));
    if (currentQueueSessionIdRef.current === sid) publishQueue();
  }, [adoptRemoteQueue, publishQueue, snapshotFromQueuePayload]);
  /** 采纳 prompt/follow_up 回执里的入队快照（同一个会话，内容已持久化）。 */
  const acceptQueuedReceipt = useCallback((
    sid: string,
    queue?: { items: FollowUpItem[]; revision: number; inFlight: string[] },
  ) => {
    if (!queue) return;
    adoptRemoteQueue(sid, { items: queue.items, inFlight: queue.inFlight, revision: queue.revision });
    if (currentQueueSessionIdRef.current === sid) publishQueue();
  }, [adoptRemoteQueue, publishQueue]);
  /**
   * 写入队列并同步给 Host。
   *
   * `targetSid` 必须由调用方显式传入（而不是在这里读「当前会话」）：请求在途时
   * 用户切走会话，失败结算也只能落在原会话账上（R3：A 的补偿写到 B）。
   * 成功/冲突都以回执里的权威快照为准：只更新版本不更新内容会形成「新版本 +
   * 旧内容」，下一次合法 CAS 就会删掉别人刚入队的消息（R2）。
   */
  const updateLocalFollowUp = useCallback(async (
    next: readonly (string | QueueItemPayload)[],
    targetSid?: string,
  ) => {
    const sid = targetSid ?? currentQueueSessionIdRef.current ?? sessionIdRef.current;
    if (!sid) return;
    const proposal = proposeQueue(queueBookRef.current, sid, next);
    queueBookRef.current = proposal.book;
    if (currentQueueSessionIdRef.current === sid) publishQueue();
    const sync = followUpSyncRef.current
      .catch(() => undefined)
      .then(async () => {
        // Host 同步持久化并在 settled 后投递；浏览器不再并发写同一 queue prefs。
        // 带 expectedRevision：多标签各自基于同一快照整组替换时由服务端 CAS
        // 拒绝过期写入，而不是静默覆盖另一标签页刚入队的消息。
        // items 带上图片载荷（新图 base64 / 已有图引用）：不传等于把队列里的图删掉。
        const writeItems = payloadsForWrite(queueEntry(queueBookRef.current, sid));
        const receipt = await sendAgentCommand<QueueReceiptView>(sid, {
          type: "set_follow_up_queue",
          items: writeItems,
          expectedRevision: queueEntry(queueBookRef.current, sid).serverRevision,
        });
        queueBookRef.current = settleSyncSuccess(
          queueBookRef.current,
          sid,
          proposal.revision,
          snapshotFromQueuePayload(receipt),
        );
        if (currentQueueSessionIdRef.current === sid) publishQueue();
        if (isQueueWriteConflict(receipt)) throw new Error(t("input_queueConflict"));
        // 落盘失败：内容没写进产品队列，不得声称已入队（否则刷新后就没了）。
        if (receipt && typeof receipt === "object" && receipt.persist === true) {
          throw new Error(t("input_queuePersistFailed"));
        }
      });
    followUpSyncRef.current = sync.catch(() => undefined);
    try {
      await sync;
    } catch (error) {
      queueBookRef.current = settleSyncFailure(queueBookRef.current, sid, proposal.revision);
      if (currentQueueSessionIdRef.current === sid) publishQueue();
      throw error;
    }
  }, [publishQueue, snapshotFromQueuePayload, t]);

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
  /** bash 执行代次：finally 只清理自己那次。 */
  const bashExecSeqRef = useRef(0);
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
    notifyBrowsingHistory,
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

  // 显示模型按固定优先级解析：用户手动选择（override）最高，其次磁盘
  // model_change（context.model），最后才是默认配置。extension 通知/subagent
  // 完成提示/activity/custom 消息都不会写入 override，因此不会覆盖用户选择。
  // 全局默认模型只用于新会话引导；已有会话只读自身 override/model_change。
  // override 的唯一失效入口是 settleModelOverride（磁盘确认一致或外部改动）。
  const persistedModel = data?.context.model ?? lastKnownModel;
  const currentModel = resolveDisplayModel(
    currentModelOverride,
    persistedModel,
    isNew ? newSessionDefaultModel : null,
  );
  const displayModel = isNew ? (newSessionModel ?? newSessionDefaultModel) : currentModel;

  /**
   * 上下文占用的磁盘兜底。
   *
   * host 空闲 dispose 后没有热 state（`getAgentState` 只返回 live/activeRun），
   * 而 `contextUsage` 只在热 state 里；那就会让「上下文比例」在切走几分钟后
   * 整块消失。这里从最后一条带 usage 的 assistant 消息算占用：
   * `input + cacheRead + cacheWrite` 就是下一次请求的 prompt 大小
   * （input 不含缓存桶，与 provider 语义一致）。
   *
   * 有热 state 时一律以它为准（压缩后它会显式给 `tokens: null` 表示未知，
   * 那时也不能退回磁盘旧值，否则会把压缩前的占用显示出来）。
   */
  const diskContextUsage = useMemo((): ContextUsage | null => {
    if (contextUsage) return null;
    for (let index = messages.length - 1; index >= 0; index--) {
      const message = messages[index];
      if (message.role !== "assistant") continue;
      const usage = (message as import("@/lib/types").AssistantMessage).usage;
      if (!usage) continue;
      const tokens = (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
      if (tokens <= 0) continue;
      const contextWindow = displayModel
        ? modelList.find((m) => m.provider === displayModel.provider && m.id === displayModel.modelId)?.contextWindow ?? 0
        : 0;
      // 目录缺容量时报 0：顶栏与右栏据此只显示「未知」，不编造百分比。
      return {
        percent: contextWindow > 0 ? (tokens / contextWindow) * 100 : null,
        contextWindow,
        tokens,
      };
    }
    return null;
  }, [contextUsage, messages, displayModel, modelList]);

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
      // 热 state 优先，其次磁盘兜底（非 live 会话仍能显示上下文比例）。
      ...((contextUsage ?? diskContextUsage) ? { contextUsage: contextUsage ?? diskContextUsage ?? undefined } : {}),
    } satisfies SessionStatsInfo;
  }, [messages, sessionStatsOverride, contextUsage, diskContextUsage, data?.filePath, session?.id, session?.name]);

  const loadSession = useCallback(async (
    sid: string,
    showLoading = false,
    includeState = false,
    reportSuccess = false,
    resetBranchFollow = false,
    onMessagesReplaced?: () => void,
  ) => {
    const loadRequestSeq = ++loadRequestSeqRef.current;
    const signal = beginLoadRequest();
    let messagesLoaded = false;
    try {
      if (showLoading) setLoading(true);
      const registry = getOrCreateBrowserSessionRuntimeRegistry();
      const hydrateSinceSeq = registry.getSnapshot(sid)?.timelineSeq ?? 0;
      // 切换会话：先清上一会话的 live 投影，避免 systemPrompt/用量串台。
      // contextUsage 不在起点清空：若后续 live/hot state 缺失（压缩/队列收尾后
      // host 已 dispose），保留旧值或磁盘兜底可继续显示，避免顶栏统计整块消失；
      // 每次 setData 后统一由 applyLiveState / 兜底路径覆写。
      if (includeState) {
        setSystemPrompt(null);
      }
      // tail-first：首屏只拉最新 N 条，尽快结束 loading；更旧历史按需 prepend。
      const hydrateRequestSeq = registry.beginHydrate(sid);
      const params = new URLSearchParams({
        deferThinking: "1",
        deferMedia: "1",
        limit: String(DEFAULT_SESSION_TAIL_LIMIT),
      });
      const res = await fetch(`/api/sessions/${encodeURIComponent(sid)}?${params}`, { signal });
      if (loadRequestSeq !== loadRequestSeqRef.current || sessionIdRef.current !== sid) return null;
      if (res.status === 404) {
        if (showLoading) {
          setData(null);
          setActiveLeafId(null);
          setMessages([]);
          entryIdsRef.current = [];
          messagesSessionIdRef.current = sid;
          setEntryIds([]);
          setMessageKeys([]);
          hasMoreBeforeRef.current = false;
          setHasMoreBefore(false);
          setError(null);
        }
        return null;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d = await res.json() as SessionData;
      if (loadRequestSeq !== loadRequestSeqRef.current || sessionIdRef.current !== sid) return null;
      const runState = registry.getRunState(sid);
      if (
        runState?.finishingRunId !== null
        && runState?.finishingRunId !== runState?.promptRunId
      ) {
        return null;
      }
      const tailEntryIds = d.context.entryIds ?? [];
      const tailMessages = d.context.messages ?? [];
      // 归并一律交给 registry：从 slot 自己的 timeline 算，不依赖 React updater
      // 同步执行，也不再从 hook 回传 previous。
      const sameSession = messagesSessionIdRef.current === sid;
      const previousSnapshot = getOrCreateBrowserSessionRuntimeRegistry().getSnapshot(sid);
      const previousEntriesLoaded = (previousSnapshot?.entryIds.length ?? 0) > 0;
      const mode: TimelineHydrateMode = sameSession && previousEntriesLoaded ? "tail" : "replace";
      // 磁盘不保存 live ANSI 行：重载前先把当前分叉的渲染覆盖层合并进去。
      const hydratedMessages = sameSession && previousSnapshot
        ? preserveCustomRenderedLines(
            previousSnapshot.messages,
            previousSnapshot.entryIds,
            tailMessages,
            tailEntryIds,
          )
        : tailMessages;
      // 归并先执行。两种「未应用」要分开：
      // - superseded：更新的响应已落地 → 本次整份作废（含 leaf/分页/模型）。
      // - stale：期间有 live 事件，时间线不得被磁盘快照覆盖；但这份响应仍是
      //   最新磁盘读取，下面照常提交 leaf/model/分页，否则外部改动（另一实例
      //   换模型）在被打断的那次刷新里会被永久忽略。
      const outcome = getOrCreateBrowserSessionRuntimeRegistry().hydrate(
        sid,
        hydratedMessages,
        tailEntryIds,
        { sinceSeq: hydrateSinceSeq, hydrateRequestSeq, mode },
      );
      if (outcome === "superseded") return null;
      // 只有分支导航成功拿到整体会话、即将应用新 context 时才重置跟随；
      // 请求失败/取消不会改变当前阅读位置。
      if (resetBranchFollow) notifyAutoFollowBranchReset();
      setData(d);
      setActiveLeafId(d.leafId);
      onMessagesReplaced?.();
      messagesSessionIdRef.current = sid;
      const resolvedEntryIds = entryIdsRef.current;
      const more = d.context.hasMoreBefore === true
        || (typeof d.context.totalMessageCount === "number"
          && d.context.totalMessageCount > resolvedEntryIds.length);
      hasMoreBeforeRef.current = more;
      setHasMoreBefore(more);
      // P1-2：override 不再无条件清除——改为「吸附」：磁盘 model_change 已与
      // 用户选择一致时让磁盘权威接管（清除 override）；磁盘缺失/不一致（写盘
      // 竞态、fork 后新会话无 model_change）时保留 override，防止 run 结束 /
      // reload / subagent 完成等内部 loadSession 把用户选择覆盖回落默认。
      // 但磁盘相对上次观察发生新变化时，那是外部（另一实例/标签页）的写入，
      // 磁盘优先：否则本页会把对方的修改覆盖回去。
      // 有在途写入操作时不结算：此时的磁盘值可能正处于本次写入的中间态，
      // 用它判定「外部改动」会误清掉刚提交的选择。
      const lastDiskModel = lastDiskModelBySessionRef.current.get(sid) ?? null;
      if (!hasOpenOp(selectionOpBookRef.current, sid)) {
        setCurrentModelOverride((prev) => settleModelOverride({
          override: prev,
          persisted: d.context.model,
          lastDiskObserved: lastDiskModel,
        }));
      }
      setError(null);
      if (isThinkingLevel(d.context.thinkingLevel)) {
        // off 也是会话的有效值，必须覆盖上一个会话遗留的深度。
        setThinkingLevel(d.context.thinkingLevel);
      }
      // 权威档位已到（无论有无档）：解锁思考档显示/事件回写。
      thinkingSettledRef.current = sid;
      setThinkingReady(true);
      // 登记磁盘权威模型（每会话）：供后续切换时即时恢复显示。
      if (d.context.model?.provider && d.context.model?.modelId) {
        lastKnownModelBySessionRef.current.set(sid, { provider: d.context.model.provider, modelId: d.context.model.modelId });
        lastDiskModelBySessionRef.current.set(sid, { provider: d.context.model.provider, modelId: d.context.model.modelId });
        setLastKnownModel({ provider: d.context.model.provider, modelId: d.context.model.modelId });
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
        if (liveState.model?.provider && liveState.model?.modelId) {
          lastKnownModelBySessionRef.current.set(sid, { provider: liveState.model.provider, modelId: liveState.model.modelId });
          setLastKnownModel({ provider: liveState.model.provider, modelId: liveState.model.modelId });
        }
        if (liveState.extensionStatuses !== undefined) {
          patchExtensionUiState({ statuses: liveState.extensionStatuses ?? [] });
        }
        if (liveState.extensionWidgets !== undefined) {
          patchExtensionUiState({ widgets: liveState.extensionWidgets ?? [] });
        }
        if (liveState.queuedMessages !== undefined) {
          applyProjectedQueues(sid, liveState.queuedMessages);
        }
        // 活动 custom 面板：热状态恢复（#34）。
        applyActiveCustomUi(liveState.activeCustomUi);
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
        const hotRes = await fetch(`/api/sessions/${encodeURIComponent(sid)}/state`, { signal });
        if (hotRes.ok) {
          const hot = await hotRes.json() as {
            live?: boolean;
            running?: boolean;
            activeRun?: boolean;
            lockedByOther?: boolean;
            state?: AgentStateResponse;
          };
          if (loadRequestSeq !== loadRequestSeqRef.current || sessionIdRef.current !== sid) return null;
          const live = readAgentLiveFlag(hot);
          if (live && hot.state) {
            setLockedByOther(false);
            applyLiveState(hot.state);
            return { running: live, live, activeRun: hot.activeRun === true, lockedByOther: false, state: hot.state };
          }
          setLockedByOther(hot.lockedByOther === true);
          if (!live) {
            setQueuedMessages({
              steering: [],
              followUp: projection(queueEntryNow()),
              followUpRows: queueRows(queueEntryNow()),
              followUpRevision: queueEntryNow().serverRevision,
            });
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
      // 切走/被新加载取代导致的取消不是错误，不写 error。
      if (!isAbortError(e)) setError(String(e));
      return null;
    } finally {
      if (showLoading && !messagesLoaded) setLoading(false);
    }
  }, [applyProjectedQueues, beginLoadRequest, notifyAutoFollowBranchReset, patchExtensionUiState, queueEntryNow]);

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
      const res = await fetch(`/api/sessions/${encodeURIComponent(sid)}/context?${params}`, {
        signal: beginLoadRequest(),
      });
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
      // 归并（去重 + prepend）由 registry 从 slot 当前 timeline 原子完成；
      // hook 不再读 React updater 内赋值的变量，避免把空数组写进时间线。
      const outcome = getOrCreateBrowserSessionRuntimeRegistry().hydrate(sid, olderMsgs, olderIds, {
        hydrateRequestSeq,
        mode: "prepend",
      });
      const applied = outcome === "applied";
      // 被并发 hydrate（分支切换 / 更新的尾页）取代时不能声称成功：
      // 否则分页与「还能继续上滚」的判定会基于未应用的响应。
      if (!applied) return false;
      const nextEntryIds = entryIdsRef.current ?? prevIds;
      entryIdsRef.current = nextEntryIds;
      const more = d.context.hasMoreBefore === true
        || (typeof d.context.totalMessageCount === "number"
          && d.context.totalMessageCount > nextEntryIds.length);
      hasMoreBeforeRef.current = more;
      setHasMoreBefore(more);
      return true;
    } catch (e) {
      if (!isAbortError(e)) console.error("Failed to load older history:", e);
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
      const res = await fetch(url, { signal: beginLoadRequest() });
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
      const previousSnapshot = getOrCreateBrowserSessionRuntimeRegistry().getSnapshot(sid);
      const shouldPreserveRenderedLines = messagesSessionIdRef.current === sid;
      const hydrated = shouldPreserveRenderedLines && previousSnapshot
        ? preserveCustomRenderedLines(
            previousSnapshot.messages,
            previousSnapshot.entryIds,
            d.context.messages,
            nextEntryIds,
          )
        : d.context.messages;
      const outcome = getOrCreateBrowserSessionRuntimeRegistry().hydrate(sid, hydrated, nextEntryIds, {
        sinceSeq: hydrateSinceSeq,
        hydrateRequestSeq,
        mode: "replace",
      });
      const applied = outcome === "applied";
      // 分支切换与 SSE 并发时旧响应作废：不重置跟随、不写过期分页。
      if (!applied) return;
      // 仅在成功拿到新 context 并已应用时才重置跟随；fetch 失败不遗留 pending。
      notifyAutoFollowBranchReset();
      messagesSessionIdRef.current = sid;
      const more = d.context.hasMoreBefore === true
        || (typeof d.context.totalMessageCount === "number"
          && d.context.totalMessageCount > nextEntryIds.length);
      hasMoreBeforeRef.current = more;
      setHasMoreBefore(more);
    } catch (e) {
      if (!isAbortError(e)) console.error("Failed to load context:", e);
    }
  }, [notifyAutoFollowBranchReset, beginLoadRequest]);

  /**
   * 按 entryId 定位跳转：服务端返回该条前后各半页的窗口，整体替换时间线后由调用方滚动。
   *
   * 为什么不是逐页翻页：懒加载分页 + 只渲染末 N 条，历史长会话（实测 1343 条消息）
   * 要翻很多页才能到位。服务端一次定位即可，且窗口自带前后游标（能继续上下加载）。
   *
   * 门禁：请求发出时捕获 {sessionId, leafId, 代次}，返回时任一不匹配即整份作废
   * （切会话 / 切分支 / 连点两次都不能改时间线或留下错误窗口）。
   */
  const jumpGenerationRef = useRef(0);
  const jumpToEntry = useCallback(async (
    entryId: string,
    options?: { limit?: number; toEnd?: boolean },
  ): Promise<boolean> => {
    const sid = sessionIdRef.current;
    if (!sid || !entryId) return false;
    const generation = ++jumpGenerationRef.current;
    const leafAtStart = activeLeafIdRef.current;
    const isCurrent = () =>
      jumpGenerationRef.current === generation
      && sessionIdRef.current === sid
      && activeLeafIdRef.current === leafAtStart;
    const registry = getOrCreateBrowserSessionRuntimeRegistry();
    const hydrateRequestSeq = registry.beginHydrate(sid);
    const hydrateSinceSeq = registry.getSnapshot(sid)?.timelineSeq ?? 0;
    // 进入「浏览历史」态必须发生在**加载之前**：hydrate 提交新窗口的那一帧会改变
    // 内容高度，若此时仍是 following，自动跟随会先钉底（用户看到「先向下滚一段」），
    // 随后才切态。放在这里后，整个定位过程（请求 → 提交 → 滚动）都不再被钉底打断。
    notifyBrowsingHistory();
    try {
      const params = new URLSearchParams({
        around: entryId,
        deferThinking: "1",
        deferMedia: "1",
        // 默认取到最新（toEnd=1）：跳转历史后，时间线必须仍然包含「目标 → 最新」整段，
        // 否则运行中会话的尾部（流式输出）会脱离时间线。性能靠渲染窗口控制，不靠截断数据。
        toEnd: options?.toEnd === false ? "0" : "1",
      });
      if (options?.limit) params.set("limit", String(options.limit));
      if (leafAtStart) params.set("leafId", leafAtStart);
      const res = await fetch(`/api/sessions/${encodeURIComponent(sid)}/context?${params}`, {
        signal: beginLoadRequest(),
      });
      // anchor 不在当前 leaf 路径 → 404：显式失败（不静默回退尾页）
      if (!res.ok) return false;
      const d = await res.json() as {
        context: {
          messages: AgentMessage[];
          entryIds: string[];
          hasMoreBefore?: boolean;
          hasMoreAfter?: boolean;
          totalMessageCount?: number;
        };
      };
      if (!isCurrent()) return false;
      const nextEntryIds = d.context.entryIds ?? [];
      const nextMessages = d.context.messages ?? [];
      if (nextEntryIds.length === 0) return false;
      const outcome = registry.hydrate(sid, nextMessages, nextEntryIds, {
        sinceSeq: hydrateSinceSeq,
        hydrateRequestSeq,
        mode: "replace",
      });
      if (outcome !== "applied" || !isCurrent()) return false;
      messagesSessionIdRef.current = sid;
      // 游标直接取服务端给出的窗口起止（不能用总数推断：否则历史开头也一直「还有更早」）
      hasMoreBeforeRef.current = d.context.hasMoreBefore === true;
      setHasMoreBefore(hasMoreBeforeRef.current);
      const moreAfter = d.context.hasMoreAfter === true;
      hasMoreAfterRef.current = moreAfter;
      setHasMoreAfter(moreAfter);
      return true;
    } catch (e) {
      if (!isAbortError(e)) console.error("Failed to jump to entry:", e);
      return false;
    }
  }, [beginLoadRequest, notifyBrowsingHistory]);

  /**
   * 定位到历史窗口后继续向下加载「更新」的历史（与 loadOlderHistory 对称）。
   * 只在 around 窗口留下 hasMoreAfter=true 时可用；尾部窗口不需要（它本来就是最新）。
   */
  const loadNewerHistory = useCallback(async (): Promise<boolean> => {
    const sid = sessionIdRef.current;
    if (!sid || !hasMoreAfterRef.current || historyLoadingRef.current) return false;
    const after = entryIdsRef.current[entryIdsRef.current.length - 1];
    if (!after) return false;
    historyLoadingRef.current = true;
    setHistoryLoading(true);
    const registry = getOrCreateBrowserSessionRuntimeRegistry();
    const hydrateRequestSeq = registry.beginHydrate(sid);
    const hydrateSinceSeq = registry.getSnapshot(sid)?.timelineSeq ?? 0;
    try {
      const params = new URLSearchParams({ after, deferThinking: "1", deferMedia: "1" });
      if (activeLeafId) params.set("leafId", activeLeafId);
      const res = await fetch(`/api/sessions/${encodeURIComponent(sid)}/context?${params}`, {
        signal: beginLoadRequest(),
      });
      if (!res.ok) return false;
      const d = await res.json() as {
        context: {
          messages: AgentMessage[];
          entryIds: string[];
          hasMoreAfter?: boolean;
        };
      };
      if (sessionIdRef.current !== sid) return false;
      const newerIds = d.context.entryIds ?? [];
      const newerMsgs = d.context.messages ?? [];
      if (newerIds.length === 0) {
        hasMoreAfterRef.current = false;
        setHasMoreAfter(false);
        return false;
      }
      // 追加到尾部：与 hydrate 的 tail 语义一致（保留当前窗口在前的顺序）
      const outcome = registry.hydrate(sid, [...(registry.getSnapshot(sid)?.messages ?? []), ...newerMsgs], [...entryIdsRef.current, ...newerIds], {
        sinceSeq: hydrateSinceSeq,
        hydrateRequestSeq,
        mode: "replace",
      });
      if (outcome !== "applied") return false;
      hasMoreAfterRef.current = d.context.hasMoreAfter === true;
      setHasMoreAfter(hasMoreAfterRef.current);
      return true;
    } catch (e) {
      if (!isAbortError(e)) console.error("Failed to load newer history:", e);
      return false;
    } finally {
      historyLoadingRef.current = false;
      setHistoryLoading(false);
    }
  }, [activeLeafId, beginLoadRequest]);

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
    // 引导页按目标项目只读枚举磁盘 skills（/api/skills?cwd=，sessionless），
    // 让斜杠菜单显示「当前项目可用的 skill」，点选后以 /skill:<name> 提交，
    // SDK 会在 prompt 展开时读取 SKILL.md 注入。
    const sid = sessionIdRef.current ?? session?.id ?? null;
    if (!sid) {
      const cwd = newSessionCwdRef.current;
      if (!cwd) {
        setSlashCommands([]);
        return [] as SlashCommandInfo[];
      }
      setSlashCommandsLoading(true);
      try {
        const res = await fetch(`/api/skills?cwd=${encodeURIComponent(cwd)}`);
        if (!res.ok) {
          setSlashCommands([]);
          return [] as SlashCommandInfo[];
        }
        const data = await res.json() as {
          skills?: Array<{ name: string; description?: string; sourceInfo?: { source?: string; scope?: string } }>;
        };
        const skills: SlashCommandInfo[] = (data.skills ?? []).map((skill) => ({
          name: `skill:${skill.name}`,
          description: skill.description,
          source: "skill",
        }));
        setSlashCommands(skills);
        return skills;
      } catch (e) {
        console.error("Failed to load skills for guide:", e);
        setSlashCommands([]);
        return [] as SlashCommandInfo[];
      } finally {
        setSlashCommandsLoading(false);
      }
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
  }, [isReadOnly, session?.id, sendAgentCommand]);

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
   * 从状态恢复活动 custom 面板（Issue #34）：custom 只有事件、没有重放，
   * 刷新或切回后服务端仍在等输入，但浏览器端会缺内容与输入入口。
   * 只恢复不清理（关闭由 closed 事件负责，避免与刚打开的面板竞争）。
   */
  const applyActiveCustomUi = useCallback((active: { id?: unknown; lines?: unknown } | null | undefined) => {
    if (!active) return;
    const current = extensionUiStateRef.current;
    const next = restoreCustomUi(current, active);
    if (next !== current) commitExtensionUiState(next);
  }, [commitExtensionUiState, extensionUiStateRef]);

  /**
   * 用 host 下发的本 run 吞吐读数兜底（冷挂载/刷新看不到 step 开始）。
   * 空对象（服务端也没有读数）等于清掉 seed，避免显示上一轮的旧值。
   *
   * `sid` 是这份读数**属于哪个会话**：必须由调用方显式传入，不能读「当前会话」
   * ——否则为 A 发起的请求在切到 B 之后返回，会把 A 的读数 seed 进 B 的 slot。
   */
  const seedTurnMetricsFromState = useCallback((sid: string, state?: AgentStateResponse | null) => {
    if (!state) return;
    if (!canApplyProjection({ sessionId: sid }, { sessionId: sessionIdRef.current })) return;
    const metrics = state.turnMetrics ?? null;
    const usable = metrics && (metrics.tokensPerSecond !== undefined || metrics.ttftMs !== undefined)
      ? metrics
      : null;
    getOrCreateBrowserSessionRuntimeRegistry().seedTurnMetrics(sid, usable);
  }, []);

  /**
   * 将 /api/agent 状态快照的附属字段应用到本地 state（散落重复点的统一收口）。
   * 只覆盖显式提供的字段；running/streaming 等执行态由调用方负责。
   */
  const applyAgentStateSnapshot = useCallback((sid: string, state?: AgentStateResponse | null) => {
    if (!state) return;
    // 会话已切走：整份快照（含队列投影）丢弃，避免迟到响应写进当前界面。
    if (!canApplyProjection({ sessionId: sid }, { sessionId: sessionIdRef.current })) return;
    if (state.contextUsage !== undefined) setContextUsage(state.contextUsage ?? null);
    seedTurnMetricsFromState(sid, state);
    if (state.systemPrompt !== undefined) setSystemPrompt(state.systemPrompt ?? null);
    if (isThinkingLevel(state.thinkingLevel)) setThinkingLevel(state.thinkingLevel);
    // host 热投影的模型：磁盘 loadSession 未返回前恢复模型显示，避免切换窗口
    // 内 displayModel 为空显示「模型」占位。
    if (state.model?.provider && state.model?.modelId) {
      setLastKnownModel({ provider: state.model.provider, modelId: state.model.modelId });
    }
    if (state.isCompacting !== undefined) setIsCompacting(state.isCompacting);
    if (state.extensionStatuses !== undefined) patchExtensionUiState({ statuses: state.extensionStatuses ?? [] });
    if (state.extensionWidgets !== undefined) patchExtensionUiState({ widgets: state.extensionWidgets ?? [] });
    if (state.queuedMessages !== undefined) {
      applyProjectedQueues(sid, state.queuedMessages);
    }
    // 活动 custom 面板：刷新/重连后从状态恢复内容与输入入口（#34）。
    applyActiveCustomUi(state.activeCustomUi);
  }, [applyProjectedQueues, applyActiveCustomUi, patchExtensionUiState, seedTurnMetricsFromState, setLastKnownModel]);

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
        applyAgentStateSnapshot(sid, agentState.state);
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
      setAgentPhase(null);
      setRetryInfo(null);
      {
        const nextSnapshots = finalizeRunningToolExecutions(toolExecutionBufferRef.current);
        toolExecutionBufferRef.current = nextSnapshots;
        setToolExecutionSnapshots(getToolExecutionSnapshots(nextSnapshots));
      }
      dispatch({ type: "end" });
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
        applyAgentStateSnapshot(sid, result.state as AgentStateResponse | undefined);
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
        // light=1：轮询只看 isBashRunning，无需 systemPrompt 等大字段。
        const res = await fetch(`/api/agent/${encodeURIComponent(sid)}?light=1`);
        if (!res.ok) continue;
        const data = await res.json() as { state?: AgentStateResponse };
        if (data.state?.isBashRunning) continue;

        await loadSession(sid);
        if (bashRecoveryIdRef.current !== recoveryId || sessionIdRef.current !== sid) return;
        getOrCreateBrowserSessionRuntimeRegistry().setBashRunning(sid, false);
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
    const contextGenerationAtRequest = contextUsageGenerationRef.current;
    try {
      const result = await registry.reconcile(sid);
      if (!result || result.stale) return;
      const state = result.state as AgentStateResponse | undefined;
      // 迟到响应不得写进已切走的会话：压缩态与读数都以「该响应所属会话」为准，
      // 不读「当前会话」推断目标（否则 A 的压缩态会写进 B 的界面）。
      const stillCurrent = canApplyProjection(
        { sessionId: sid },
        { sessionId: sessionIdRef.current },
      );
      if (stillCurrent) {
        // Mirror compaction state: a missed compaction_end would otherwise leave
        // the Stop UI stuck.
        setIsCompacting(state?.isCompacting ?? false);
      }
      // 刷新/后台回收回来后，本 run 的完整读数只有服务端有：接上它（本地跑完一个
      // 完整 step 后 registry 会自动忽略 seed，不会用旧值覆盖更新的本地读数）。
      seedTurnMetricsFromState(sid, state);
      // 迟到的响应不得覆盖已切走会话的上下文，也不得覆盖请求期间到达的更新读数
      // （压缩后的 {tokens:null} 合法，不能用「更大」判新旧）。
      if (
        state?.contextUsage !== undefined
        && canApplyProjection(
          { sessionId: sid, generation: contextGenerationAtRequest },
          { sessionId: sessionIdRef.current, generation: contextUsageGenerationRef.current },
        )
      ) {
        setContextUsage(state.contextUsage ?? null);
      }
      if (state?.queuedMessages !== undefined) {
        applyProjectedQueues(sid, state.queuedMessages);
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
    // 浏览器冻结恢复后 EventSource 可能仍停在 OPEN/CONNECTING 但底层已静默断流，
    // 仅靠 readyState 判断会漏。手机锁屏/后台回来一律强制重连一次（close→connect），
    // 再 reconcile + 重拉尾页，保证把冻结期间完成的消息/状态收口（#28 移动端后台）。
    if (source) registry.getEventSource(sid)?.close?.();
    ensureEventsConnected(sid);
    void reconcileAgentState(sid);
    // 无论是否 running 都重拉：空闲会话也可能在后台跑完（本 slot 未感知）。
    void loadSession(sid, false);
  }, [ensureEventsConnected, reconcileAgentState, loadSession]);

  useEffect(() => {
    const sid = session?.id;
    if (!sid || isNew || session?.readOnly) return;
    let cancelled = false;
    const refreshLock = () => {
      if (document.visibilityState !== "visible") return;
      void fetch(`/api/sessions/${encodeURIComponent(sid)}/state`, { cache: "no-store" })
        .then((response) => (response.ok ? response.json() : null))
        .then((hot: { lockedByOther?: boolean } | null) => {
          if (cancelled || !hot || sessionIdRef.current !== sid) return;
          setLockedByOther(hot.lockedByOther === true);
        })
        .catch(() => undefined);
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") refreshLock();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    // 跨进程运行锁在 agent_settled 后立即释放；已显示锁定条的页面用短轮询
    // 感知释放，避免旧的 5s 窗口让用户还要等一轮才能发送。
    const interval = lockedByOther ? window.setInterval(refreshLock, 1_000) : undefined;
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
      if (interval) window.clearInterval(interval);
    };
  }, [session?.id, session?.readOnly, isNew, lockedByOther]);

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
        // agentRunning/streamState 由 registry snapshot 投影，此处不再直写。
        setAgentPhase({ kind: "waiting_model" });
        dispatch({ type: "start" });
        break;
      case "agent_end":
      case "prompt_done": {
        if (event.type === "agent_end") {
          const usage = event.contextUsage as AgentStateResponse["contextUsage"] | undefined;
          if (usage && typeof usage.contextWindow === "number" && usage.contextWindow > 0) {
            applyLiveContextUsage(usage);
          }
        }
        const sid = sessionIdRef.current;
        const runId = sid
          ? getOrCreateBrowserSessionRuntimeRegistry().getRunState(sid)?.promptRunId
          : undefined;
        if (sid && runId !== undefined) void finishAgentRun(sid, runId);
        break;
      }
      case "prompt_error": {
        if (sessionIdRef.current) setServerPref(`sessionQueueHold.${sessionIdRef.current}`, true);
        // 时间线清理已下沉到 registry.applyEventToSlot（视图卸载也照常执行）。
        addNotice({ type: "error", message: (event.errorMessage as string | undefined) ?? t("input_commandFailed") });
        break;
      }
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
        // Host 随每条 assistant 消息结束下发上下文占用：run 期间顶栏随工具轮次推进，
        // 不再等 agent_end 才跳一次（SDK 的 usage 只在消息结束时才有读数）。
        const usage = event.contextUsage as AgentStateResponse["contextUsage"] | undefined;
        if (usage && typeof usage.contextWindow === "number" && usage.contextWindow > 0) {
          applyLiveContextUsage(usage);
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
        // Host 已把该条目投递出去并落盘：事件带权威队列快照（items/inFlight/
        // revision）。按快照采纳，不再自行推算剩余项。
        adoptQueueEvent(event as { sessionId?: string } & QueueReceiptView);
        break;
      }
      case "follow_up_queue_changed": {
        // 跨标签页/其它端点的队列写入：同一会话的权威快照，直接采纳。
        adoptQueueEvent(event as { sessionId?: string } & QueueReceiptView);
        break;
      }
      case "follow_up_flush_error":
        addNotice({
          type: "error",
          message: (event.errorMessage as string | undefined) ?? "Follow-up queue flush failed",
        });
        break;
      case "thinking_level_changed": {
        // SDK clamp/落盘后的权威深度回写 UI：用户选择经 SDK 校验可能被 clamp
        // （模型不支持时降档）或已在磁盘生效，必须以事件值覆盖本地预选，否则
        // UI 显示与真实生效深度分叉（"思考总是乱变"）。
        // 只接受当前会话且档位权威已确认后的回写：切回会话瞬间 attach 重放的
        // 历史事件不抢在 loadSession 前落 UI（loadSession 的 context 值更权威）。
        const level = event.level as string | undefined;
        if (level && isThinkingLevel(level)) {
          if (thinkingReadyRef.current && thinkingSettledRef.current === sessionIdRef.current) {
            setThinkingLevel(level as ThinkingLevelOption);
          }
        }
        break;
      }
      case "queue_update":
        // followUp 以服务端队列为准（Pidance 自管）；steering 仍来自 Pi 进程队列
        setQueuedMessages({
          steering: [...((event.steering as string[] | undefined) ?? [])],
          followUp: projection(queueEntryNow()),
          followUpRows: queueRows(queueEntryNow()),
          followUpRevision: queueEntryNow().serverRevision,
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
          // Pi 在成功压缩后会明确把 contextUsage 标成「未知」：压缩前最后一条
          // assistant usage 不能代表压缩后的上下文，下一次 assistant 返回前不能继续
          // 显示旧百分比。保留 contextWindow，仅清除 tokens/percent，顶栏显示 ?。
          setContextUsage((previous) => previous
            ? { ...previous, tokens: null, percent: null }
            : null);
          setCompactResult(readCompactResult(event.result, (event.reason as string | undefined) ?? "auto"));
          if (sessionIdRef.current) void loadSession(sessionIdRef.current, false, true);
        }
        break;
      case "extension_ui_request":
        handleExtensionUiRequest(event as ExtensionUiRequest);
        break;
    }
  }, [addNotice, adoptQueueEvent, commitToolExecutions, finishAgentRun, handleExtensionUiRequest, loadSession, queueEntryNow, t]);
  handleAgentEventRef.current = handleAgentEvent;

  const handleSend = useCallback(async (message: string, images?: AttachedImage[], binaryBlocks?: BinaryMessageInput[]): Promise<boolean> => {
    // 只读会话：发送入口 UI 已替换为提示条，这里再拦一层。
    if (isReadOnly) return false;
    if (lockedByOther) {
      addNotice({ type: "error", message: t("chat_sessionLocked") });
      return false;
    }
    const trimmedMessage = message.trim();
    if (!trimmedMessage && !images?.length && !binaryBlocks?.length) return false;
    if (getRuntimeAgentRunning() || bashRunningRef.current) return false;
    // 分支切换/摘要进行中：prompt 会与 navigateTree 并发写会话文件，先拦住。
    if (branchBusyRef.current) {
      addNotice({ type: "info", message: t("input_branchSwitchInProgress") });
      return false;
    }
    const isSlashCommandPrompt = !images?.length && !binaryBlocks?.length && trimmedMessage.startsWith("/");

    const isBashCommand = !images?.length && !binaryBlocks?.length && trimmedMessage.startsWith("!");
    if (isBashCommand) {
      const isExcluded = trimmedMessage.startsWith("!!");
      const bashCmd = (isExcluded ? trimmedMessage.slice(2) : trimmedMessage.slice(1)).trim();
      if (!bashCmd) return false;
      return await executeBashRef.current?.(bashCmd, isExcluded) ?? false;
    }

    // 乐观气泡只来自 registry.submitPrompt 的 slot append + subscribe；
    // 本 hook 不再复制一份 user 消息（否则 UI 双条、磁盘一条），
    // 也不再用正文文本做回滚匹配 —— 回滚统一按 registry 的 stable key。
    promptSubmittedRef.current = false;
    abortRequestedRef.current = false;
    setAgentPhase(isSlashCommandPrompt ? { kind: "running_command" } : { kind: "waiting_model" });
    // 乐观 running 由 registry.submitPrompt 在首个 await 之前同步置位（下面立即调用），
    // 视图不持有第二份运行态，也不需要独立入口——独立入口在 target 解析失败时
    // 会留下永久 busy。
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
    const failUnsent = (error?: string) => {
      if (!sendStillCurrent()) return false;
      const locked = Boolean(error && error.includes("locked by another"));
      if (locked) setLockedByOther(true);
      addNotice({
        type: "error",
        message: locked
          ? t("chat_sessionLocked")
          : (error && error !== "rejected" ? error : t("chat_sendFailed")),
      });
      setAgentPhase(null);
      return false;
    };

    let sentSessionId: string | null = null;
    try {
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
          binaryBlocks,
          draftKey,
          model: selectedModel ?? undefined,
          ...(isNew && resolvedThinking ? { thinkingLevel: resolvedThinking } : {}),
        });
        sentSessionId = receipt.sessionId;
        if (sendStillCurrent()) {
          sessionIdRef.current = receipt.sessionId;
          if (newSessionIntentIdRef.current === intentAtSend) {
            promoteNewSession(1, message);
          }
        }
        if (receipt.status === "queued") {
          // 服务端把消息可靠放进了产品队列（如手动压缩中）：草稿可以清，但本轮
          // 不是已投递 run——队列面板负责表现，等 flush 后才会出现 user 消息。
          acceptQueuedReceipt(receipt.sessionId, receipt.queue);
          addNotice({ type: "info", message: t("input_queuedWhileBusy") });
          if (sendStillCurrent()) clearDraft(draftKey);
          return true;
        }
        if (receipt.status !== "accepted") {
          acceptQueuedReceipt(receipt.sessionId, receipt.queue);
          return failUnsent(receipt.error);
        }
        if (sendStillCurrent()) promptSubmittedRef.current = true;
      } else if (target.kind === "persisted") {
        sentSessionId = target.sessionId;
        if (abortRequestedRef.current) return false;
        const receipt = await runtime.submitPrompt({
          target,
          submissionId,
          message,
          images,
          binaryBlocks,
          draftKey,
        });
        if (receipt.status === "queued") {
          acceptQueuedReceipt(target.sessionId, receipt.queue);
          addNotice({ type: "info", message: t("input_queuedWhileBusy") });
          clearDraft(draftKey);
          return true;
        }
        if (receipt.status !== "accepted") {
          if (sendStillCurrent()) acceptQueuedReceipt(target.sessionId, receipt.queue);
          return failUnsent(receipt.error);
        }
        if (sendStillCurrent()) promptSubmittedRef.current = true;
      }
      if (sendStillCurrent() && promptSubmittedRef.current && sentSessionId) {
        setServerPref(`sessionQueueHold.${sentSessionId}`, null);
        // 已提交（accepted）：该草稿不再回填。发送确认后立刻清，避免“发送中切走
        // 会话 → 旧 draftKey 仍持有已发文本 → 切回草稿复现”。
        // 只清与本次发送文本一致的草稿；用户已改写成新内容时保留。
        clearDraft(draftKey);
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
        if (sendStillCurrent() && !promptSubmittedRef.current) setAgentPhase(null);
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
      // 回滚走 registry 的 stable key（不再用文本猜测，也不依赖数组下标）；
      // 只有在记录确实还被移除时才恢复 draft，draft 由 insertIfEmpty 在输入框
      // 为空时写入，不覆盖用户新输入。
      let restoreDraft = false;
      {
        const registry = getOrCreateBrowserSessionRuntimeRegistry();
        const rollbackSid = sentSessionId ?? sessionIdRef.current;
        if (rollbackSid) {
          restoreDraft = registry.dropLocal(rollbackSid, submissionKey(submissionId));
        }
      }
      if (restoreDraft) {
        opts.chatInputRef?.current?.insertIfEmpty(trimmedMessage);
      }
      {
        const message = e instanceof Error ? e.message : String(e);
        if (message.includes("locked by another")) setLockedByOther(true);
        addNotice({
          type: "error",
          message: message.includes("locked by another") ? t("chat_sessionLocked") : message,
        });
      }
      if (sendStillCurrent()) setAgentPhase(null);
      return false;
    }
  }, [isNew, isReadOnly, lockedByOther, newSessionModel, newSessionDefaultModel, session, promoteNewSession, waitForPromptSettlement, addNotice, notifyAutoFollowSend, opts.chatInputRef, t, onSessionCreated]);

  const executeBash = useCallback(async (command: string, excludeFromContext: boolean): Promise<boolean> => {
    // 只读会话：bash 命令同样会写 session 文件，拦截。
    if (isReadOnly) return false;
    if (lockedByOther) {
      addNotice({ type: "error", message: t("chat_sessionLocked") });
      return false;
    }
    if (getRuntimeAgentRunning() || bashRunningRef.current || branchBusyRef.current) return false;
    const inputText = `${excludeFromContext ? "!!" : "!"}${command}`;
    const bashPending = { command, excludeFromContext, startedAt: Date.now() };
    const registry = getOrCreateBrowserSessionRuntimeRegistry();
    // 执行代次：本次 finally 只允许清掉自己那次；同一会话里更新的 bash 不被误清。
    const execId = ++bashExecSeqRef.current;
    // 先门禁：新会话在 ensure 返回前就要占住运行态，否则 ensure 窗口内可重复提交。
    let bashSid = session?.id ?? sessionIdRef.current;
    if (!bashSid && isNew && newSessionIntentIdRef.current) {
      bashSid = pendingSessionId(newSessionIntentIdRef.current);
    }
    if (bashSid) registry.setBashRunning(bashSid, true, bashPending);
    try {
      const sid = sessionIdRef.current ?? session?.id ?? await ensureNewSession();
      if (!sid) throw new Error("Unable to create a session for the shell command");
      bashSid = sid;
      registry.setBashRunning(sid, true, bashPending);
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
      // 命令已返回：本页不再认为 bash 在跑（服务端权威以 reconcile/loadSession 为准）。
      // 只在仍是最新一次执行时清理，避免迟到的 finally 清掉更新的 bash 运行态。
      if (bashSid && bashExecSeqRef.current === execId) {
        registry.setBashRunning(bashSid, false);
      }
    }
  }, [addNotice, isReadOnly, lockedByOther, ensureNewSession, loadSession, opts.chatInputRef, promoteNewSession, session, t]);
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

  /**
   * 模型 + 思考档的唯一写入入口。
   *
   * 两条不变量：
   * - 顺序 set_model → set_thinking_level（Host 的 set_model 会套用模型自带档位）。
   * - 按操作代次串行与结算：同会话的两次选择依次执行，迟到的失败不得回滚更新的选择。
   */
  const applySelection = useCallback(async (args: {
    sessionId: string;
    model?: { provider: string; modelId: string } | null;
    thinkingLevel?: string | null;
    onFailure?: () => void;
  }): Promise<boolean> => {
    const { sessionId, model, thinkingLevel, onFailure } = args;
    const opId = ++selectionOpSeqRef.current;
    selectionOpBookRef.current = openSelectionOp(selectionOpBookRef.current, sessionId, opId);
    const previous = selectionChainRef.current[sessionId] ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(async () => {
      if (model) {
        await sendAgentCommand(sessionId, {
          type: "set_model",
          provider: model.provider,
          modelId: model.modelId,
        });
      }
      if (thinkingLevel && isThinkingLevel(thinkingLevel)) {
        await sendAgentCommand(sessionId, { type: "set_thinking_level", level: thinkingLevel });
      }
    });
    selectionChainRef.current[sessionId] = run;
    try {
      await run;
      selectionOpBookRef.current = closeSelectionOp(selectionOpBookRef.current, sessionId, opId);
      return true;
    } catch (e) {
      // 只有仍是最新操作时才回滚/报错：更新的选择已经把它顶替。
      if (isLatestOp(selectionOpBookRef.current, sessionId, opId)) {
        onFailure?.();
        addNotice({
          type: "error",
          message: t("models_switchFailed", {
            error: e instanceof Error ? e.message : String(e),
          }),
        });
      }
      selectionOpBookRef.current = closeSelectionOp(selectionOpBookRef.current, sessionId, opId);
      return false;
    }
  }, [addNotice, t]);

  const handleModelChange = useCallback(async (provider: string, modelId: string, thinkingLevel?: string | null) => {
    // 只读会话：set_model 会写会话状态，拦截。
    if (isReadOnly) return;
    if (isNew) {
      // 引导页常无 live session：本地状态必须先更新（否则无 sid 时直接 return，思考/模型选不中）
      setNewSessionModel({ provider, modelId });
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
      await applySelection({
        sessionId: sid,
        model: { provider, modelId },
        thinkingLevel,
        // 引导页失败：本地选择保留（用户可重选），不写 error 之外的状态。
      });
      return;
    }
    const sid = sessionIdRef.current;
    if (!sid) return;
    // 本地立即同步显示；失败时按代次回滚到选择前的值。
    const previousThinking = thinkingLevelRef.current;
    const previousOverride = currentModelOverrideRef.current;
    if (thinkingLevel && isThinkingLevel(thinkingLevel)) setThinkingLevel(thinkingLevel);
    setCurrentModelOverride({ provider, modelId });
    await applySelection({
      sessionId: sid,
      model: { provider, modelId },
      thinkingLevel,
      onFailure: () => {
        setCurrentModelOverride(previousOverride);
        setThinkingLevel(previousThinking);
      },
    });
  }, [isNew, isReadOnly, setNewSessionModel, applySelection]);

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
        addNotice({ type: "success", message: result.message ?? t("input_commandCompleted") });
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
  /**
   * 拒绝原因 → 可读提示。
   *
   * 客户端不得把「任何 rejected」都当成「应该排队」：无模型/鉴权/busy 是完全不同的
   * 处置，静默排队会把错误展示成成功（R8）。
   */
  const queueRejectionMessage = useCallback((reason?: PromptReason): string => {
    switch (reason) {
      case "busy":
        return t("input_rejectedBusy");
      case "compacting":
        return t("input_rejectedCompacting");
      case "bash":
        return t("input_rejectedBash");
      case "media":
        return t("input_imageSendRetry");
      case "locked":
        return t("chat_sessionLocked");
      case "model":
        return t("input_rejectedModel");
      case "auth":
        return t("input_rejectedAuth");
      default:
        return t("chat_sendFailed");
    }
  }, [t]);

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
    const registry = getOrCreateBrowserSessionRuntimeRegistry();
    // 本地 key 由 registry 生成：同文两条引导必须能各自回滚，
    // 因此不能用正文派生 key。
    const optimisticRecordKey = registry.appendLocal(sid, optimistic);
    const piImages = images?.map((img) => ({ type: "image" as const, data: img.data, mimeType: img.mimeType }));
    try {
      const receipt = await sendAgentCommand<PromptReceipt>(sid, {
        type: "steer",
        message,
        ...(piImages?.length ? { images: piImages } : {}),
      });
      // 回执必须被检查：「没抛异常」不等于已引导。服务端结构化拒绝（busy/无模型/
      // 压缩中）时消息既没进 SDK 引导队列也没回输入框——旧实现只 console.error。
      if (receipt?.status === "rejected") {
        registry.dropLocal(sid, optimisticRecordKey);
        if (sessionIdRef.current === sid) {
          opts.chatInputRef?.current?.restoreDraft(message, images);
          addNotice({ type: "error", message: queueRejectionMessage(receipt.reason) });
        }
        return;
      }
      if (receipt?.status === "queued") {
        // 服务端把引导并入产品队列（compacting 等）：不是失败，按权威队列投影。
        acceptQueuedReceipt(sid, receipt.queue);
        ensureEventsConnected(sid);
      }
    } catch (e) {
      // 失败回滚乐观消息：按 stable key 原子移除（不重写整张时间线，
      // 因此不会盖掉较新的 live 消息）；内容退回**原会话**输入框（含图片）。
      registry.dropLocal(sid, optimisticRecordKey);
      if (sessionIdRef.current === sid) {
        opts.chatInputRef?.current?.restoreDraft(message, images);
        addNotice({ type: "error", message: e instanceof Error ? e.message : String(e) });
      }
      console.error("Failed to steer:", e);
    }
  }, [acceptQueuedReceipt, addNotice, ensureEventsConnected, isReadOnly, notifyAutoFollowSend, opts.chatInputRef, queueRejectionMessage]);

  /**
   * SDK 错误：扩展命令（/xxx）不能被 steer/followUp 排队，但 prompt() 在
   * streaming 时也会立即执行扩展命令（见 Pi AgentSession.prompt）。
   */
  const isExtensionCommandQueueError = useCallback((e: unknown): boolean => {
    const msg = e instanceof Error ? e.message : String(e);
    return /Extension command .* cannot be queued/.test(msg);
  }, []);

  /** 整队转引导的失败文案：冲突与拒绝是两类处置。 */
  const queueDispatchErrorMessage = useCallback((receipt?: QueueDispatchReceipt): string => {
    if (!receipt || receipt.ok !== false) return t("chat_sendFailed");
    if ("conflict" in receipt && receipt.conflict) return t("input_queueConflict");
    if ("reason" in receipt) return queueRejectionMessage(receipt.reason as PromptReason);
    return t("chat_sendFailed");
  }, [queueRejectionMessage, t]);

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
    const restore = (reason: PromptReason | undefined, fallback?: string) => {
      if (sessionIdRef.current !== sid) return;
      opts.chatInputRef?.current?.restoreDraft(message, images);
      addNotice({ type: "error", message: reason ? queueRejectionMessage(reason) : (fallback ?? t("chat_sendFailed")) });
    };
    try {
      const receipt = await sendAgentCommand<PromptReceipt>(sid, {
        type: "steer",
        message,
        ...(piImages?.length ? { images: piImages } : {}),
      });
      // 回执必须被校验：只捕异常会把结构化拒绝当成引导成功（P7/R7）。
      if (receipt?.status === "rejected") {
        restore(receipt.reason);
        return;
      }
      if (receipt?.status === "queued") {
        acceptQueuedReceipt(sid, receipt.queue);
        ensureEventsConnected(sid);
        return;
      }
    } catch (e) {
      if (isExtensionCommandQueueError(e)) {
        // 扩展命令不能 steer：prompt() 在 streaming 时也立即执行扩展命令。
        // 它的回执同样要看（旧实现直接丢返回值）。
        try {
          const receipt = await sendAgentCommand<PromptReceipt>(sid, { type: "prompt", message, ...(piImages?.length ? { images: piImages } : {}) });
          if (receipt?.status === "rejected") restore(receipt.reason);
          else if (receipt?.status === "queued") acceptQueuedReceipt(sid, receipt.queue);
        } catch (fallbackError) {
          restore(undefined, fallbackError instanceof Error ? fallbackError.message : String(fallbackError));
        }
        return;
      }
      restore(undefined, e instanceof Error ? e.message : String(e));
      console.error("Failed to steer:", e);
    }
  }, [acceptQueuedReceipt, addNotice, ensureEventsConnected, isExtensionCommandQueueError, isReadOnly, opts.chatInputRef, queueRejectionMessage, t]);

  /**
   * follow-up 发送（Codex 风格）：运行中入产品队列（Host 是唯一 owner，不调 SDK
   * follow_up，否则引导合并后进程队列仍会投递导致双发）；空闲时直接 prompt。
   * 图片附件不进文本队列：带图一律走 follow_up 命令（Host 判断准入），失败退回
   * 原会话输入框，不得静默丢图。
   */
  const handleFollowUp = useCallback(async (message: string, images?: AttachedImage[]) => {
    // 只读会话：follow-up 会写 session 文件，拦截。
    if (isReadOnly) return;
    const sid = sessionIdRef.current;
    if (!sid) return;
    const text = message.trim();
    // 纯图发送（UI 允许）：旧实现在这里直接 return，输入框已清空 → 图片静默消失。
    if (!text && !images?.length) return;
    const running = getRuntimeAgentRunning() || isCompacting;
    notifyAutoFollowSend();
    const restoreDraft = () => {
      // 失败恢复只能回到**本会话**输入框：切走会话后不得写当前会话草稿。
      // 图片一起退：只退正文等于把用户刚贴的图丢掉。
      if (sessionIdRef.current !== sid) return;
      opts.chatInputRef?.current?.restoreDraft(text, images);
    };
    if (images?.length && running) {
      // 运行中带图：不再整条回绝（旧行为让用户只能等结束后手动重发），
      // 统一入队：图片安全尺寸字节由 Host 先落到会话 outbox，投递时再回读。
      try {
        const entry = queueEntry(queueBookRef.current, sid);
        await updateLocalFollowUp([...payloadsForWrite(entry), ...toQueuePayloads(text, images)], sid);
        ensureEventsConnected(sid);
      } catch (error) {
        restoreDraft();
        addNotice({
          type: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }
    if (images?.length || !running) {
      // 有图（空闲）或空闲：直接 prompt（空闲时无"结束后投递"语义）。
      const piImages = images?.map((img) => ({ type: "image" as const, data: img.data, mimeType: img.mimeType }));
      try {
        const receipt = await sendAgentCommand<PromptReceipt>(sid, {
          type: "prompt",
          message: text,
          ...(piImages?.length ? { images: piImages } : {}),
        });
        // 服务端把消息可靠放进产品队列（如手动压缩中）：入队不是失败，只更新队列投影。
        if (receipt?.status === "queued") {
          acceptQueuedReceipt(sid, receipt.queue);
          ensureEventsConnected(sid);
          return;
        }
        // runtime 误判空闲（agent_start 事件未到/竞态窗口）时服务器会拒绝：
        // 按**原因**处置，只有 busy/compacting/bash 这类延迟语义才转入队列，
        // 无模型/鉴权/媒体错误必须退回输入框而不是排队（否则错误被当成功）。
        if (receipt?.status === "rejected") {
          // 无模型/鉴权等不可延迟的原因必须退回输入框（否则错误被当成功）；
          // busy/compacting/bash 这类延迟语义转入队列——包括带图消息，
          // 图片随载荷一起入队（Host 落盘 outbox），不再因为「带图」而回退。
          if (!isQueueablePromptReason(receipt.reason)) {
            restoreDraft();
            addNotice({ type: "error", message: queueRejectionMessage(receipt.reason) });
            return;
          }
          const entry = queueEntry(queueBookRef.current, sid);
          await updateLocalFollowUp([...payloadsForWrite(entry), ...toQueuePayloads(text, images)], sid);
          ensureEventsConnected(sid);
        }
      } catch (e) {
        restoreDraft();
        addNotice({ type: "error", message: String(e instanceof Error ? e.message : e) });
      }
      return;
    }
    // 运行中入队：Host 同步落盘并返回权威队列；失败时退回本会话草稿。
    try {
      const entry = queueEntry(queueBookRef.current, sid);
      await updateLocalFollowUp([...payloadsForWrite(entry), ...toQueuePayloads(text, images)], sid);
      // 入队即把本会话 SSE 连上（Host 空闲时 set_follow_up_queue 已 wake host）；
      // 否则 Host 稍后自动 flush 的 agent_start/message 事件没有订阅源 → UI 不更新，
      // 直到刷新才看见队列消息真正执行。
      ensureEventsConnected(sid);
    } catch (error) {
      restoreDraft();
      addNotice({
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }, [acceptQueuedReceipt, addNotice, ensureEventsConnected, isCompacting, isReadOnly, notifyAutoFollowSend, opts.chatInputRef, queueRejectionMessage, t, updateLocalFollowUp]);

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
    const sid = sessionIdRef.current;
    if (!sid) return;
    const entry = queueEntry(queueBookRef.current, sid);
    const items = projection(entry);
    if (items.length === 0) return;
    // 图片先读回（Host 的 outbox 副本会随清队一起删掉），再确认清队，
    // 避免清除失败时同一消息同时留在两处。
    let images: AttachedImage[] = [];
    try {
      images = await fetchQueueImages(itemImageRefs(entry.items));
    } catch {
      images = [];
    }
    if (sessionIdRef.current !== sid) return;
    try {
      await updateLocalFollowUp([], sid);
      if (sessionIdRef.current !== sid) return;
      opts.chatInputRef?.current?.prependText(joinQueueForRecall(items), images);
    } catch (error) {
      addNotice({ type: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }, [addNotice, isReadOnly, updateLocalFollowUp, opts.chatInputRef]);

  /**
   * 手动转引导：「整队 + 可选输入框内容」合并为一条 steer。
   *
   * 清队与投递是**同一个服务端用例**（dispatch_follow_up_queue）：旧实现的
   * 「先清队、再 steer、失败回填」补偿 saga 在会话切换后会把 A 的队列写到 B，
   * 也无法判断清队之后是否已有在途批次被投递。
   */
  const handleSendQueueAsSteer = useCallback(async (extraMessage?: string) => {
    if (isReadOnly) return;
    const sid = sessionIdRef.current;
    if (!sid) return;
    const merged = mergeFollowUpForSteer(
      projection(queueEntry(queueBookRef.current, sid)),
      extraMessage,
    );
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
    const registry = getOrCreateBrowserSessionRuntimeRegistry();
    const optimisticRecordKey = registry.appendLocal(sid, optimistic);
    try {
      const receipt = await sendAgentCommand<QueueDispatchReceipt>(sid, {
        type: "dispatch_follow_up_queue",
        ...(extraMessage?.trim() ? { extra: extraMessage.trim() } : {}),
        expectedRevision: queueEntry(queueBookRef.current, sid).serverRevision,
      });
      // 无论接受/拒绝/冲突：先采纳服务端权威队列（内容 + 版本一次落地）。
      adoptRemoteQueue(sid, snapshotFromQueuePayload(receipt));
      if (currentQueueSessionIdRef.current === sid) publishQueue();
      const accepted = Boolean(receipt && typeof receipt === "object" && receipt.ok === true);
      if (!accepted) {
        registry.dropLocal(sid, optimisticRecordKey);
        if (extraMessage?.trim() && sessionIdRef.current === sid) {
          opts.chatInputRef?.current?.prependText(extraMessage.trim());
        }
        addNotice({ type: "error", message: queueDispatchErrorMessage(receipt) });
        return;
      }
      // 发送后连 SSE，确保本轮消息/回复实时投影
      ensureEventsConnected(sid);
    } catch (e) {
      // 失败：乐观气泡撤回，队列按权威快照恢复，输入框内容退回（不静默丢）。
      registry.dropLocal(sid, optimisticRecordKey);
      if (extraMessage?.trim() && sessionIdRef.current === sid) {
        opts.chatInputRef?.current?.prependText(extraMessage.trim());
      }
      console.error("Failed to send queue as steer:", e);
      addNotice({ type: "error", message: String(e instanceof Error ? e.message : e) });
    }
  }, [adoptRemoteQueue, ensureEventsConnected, isReadOnly, notifyAutoFollowSend, publishQueue, queueDispatchErrorMessage, snapshotFromQueuePayload, addNotice, opts.chatInputRef]);

  const handleThinkingLevelChange = useCallback(async (level: ThinkingLevelOption) => {
    // 只读会话：set_thinking_level 会写会话状态，拦截。
    if (isReadOnly) return;
    // 与 handleModelChange 共用同一结算入口：串行 + 按操作代次回滚，
    // 避免同一会话里「旧请求迟到失败抹掉更新的选择」。
    const previous = thinkingLevelRef.current;
    setThinkingLevel(level);
    const sid = sessionIdRef.current ?? await ensuringNewSessionRef.current;
    if (!sid) return;
    await applySelection({
      sessionId: sid,
      thinkingLevel: level,
      onFailure: () => setThinkingLevel(previous),
    });
  }, [applySelection, isReadOnly]);

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
  const lastRemoteQueueRef = useRef<string | null>(null);
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
        // 内容与版本一次落地（旧实现的「先写内容、再单独推进版本」会形成
        // 新版本 + 旧内容，下一次合法 CAS 就删掉别人刚入队的消息）。
        adoptRemoteQueue(sid, { items: remote.items, revision: remote.revision });
        lastRemoteQueueRef.current = JSON.stringify(remote.items);
        if (currentQueueSessionIdRef.current === sid) publishQueue();
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [adoptRemoteQueue, publishQueue, session?.id]);

  useEffect(() => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    const remote = readFollowUpQueuePreference(serverPrefs, sid);
    if (remote === null) return;
    const signature = JSON.stringify(remote.items);
    if (signature === lastRemoteQueueRef.current) return;
    // focus/visibilitychange 刷新（手机切回前台的常见路径）。
    adoptRemoteQueue(sid, { items: remote.items, revision: remote.revision });
    lastRemoteQueueRef.current = signature;
    if (currentQueueSessionIdRef.current === sid) publishQueue();
  }, [adoptRemoteQueue, publishQueue, serverPrefs, session?.id]);

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
    // 切会话后首帧消息 = 新会话尾页：标记 reset pin，useChatAutoFollow 会在消息
    // 就绪时钉底（跨会话组件复用导致 initialScrollDone 已置位，不标记则不再滚动）。
    notifyAutoFollowBranchReset();
    setMessages([]);
    entryIdsRef.current = [];
    setEntryIds([]);
    setMessageKeys([]);
    setData(null);
    setActiveLeafId(null);
    hasMoreBeforeRef.current = false;
    setHasMoreBefore(false);
    dispatch({ type: "reset" });
    setTurnMetrics({});
    setLockedByOther(false);
    setRetryInfo(null);
    setIsCompacting(false);
    setSystemPrompt(null);
    setContextUsage(null);
    setCurrentModelOverride(null);
    setNewSessionModel(null);
    // 模型即时恢复：切换后 loadSession 返回前，从上一会话记录恢复当前会话的
    // 最近已知模型，避免输入框在窗口期内显示「模型」占位。
    const rememberedModel = (session?.id ? lastKnownModelBySessionRef.current.get(session.id) : undefined) ?? null;
    setLastKnownModel(rememberedModel);
    setThinkingLevel(null);
    thinkingSettledRef.current = null;
    setThinkingReady(false);
    if (!session?.id) {
      // 引导页/无会话：直接用 settings 默认档（发送时 ensure body 会带档），
      // 无需等 loadSession。
      setThinkingReady(true);
    }
    // 会话切换：把 followUp 队列投影切到新会话（映射保留旧会话条目，切回恢复）。
    // switchLocalQueue 推进代次，使上一会话在途的失败回滚失效。
    const queueSid = session?.id ?? null;
    currentQueueSessionIdRef.current = queueSid;
    // 账本按 sessionId 保留（切回恢复）；投影换到新会话。
    setQueuedMessages({
      steering: [],
      followUp: projection(queueEntry(queueBookRef.current, queueSid ?? "")),
      followUpRows: queueRows(queueEntry(queueBookRef.current, queueSid ?? "")),
      followUpRevision: queueSid ? queueEntry(queueBookRef.current, queueSid).serverRevision : null,
    });
    lastRemoteQueueRef.current = null;

    const registry = getOrCreateBrowserSessionRuntimeRegistry();
    const runtimeId = session?.id ?? (isNew && newSessionIntentId ? pendingSessionId(newSessionIntentId) : null);
    let unsubSnapshot: (() => void) | null = null;
    if (runtimeId) {
      // 只读会话也订阅同一投影（单一 owner），但不 attach：
      // 打开历史不得唤醒 writer、不建 SSE。
      if (session?.readOnly !== true) {
        runtimeSubscriptionRef.current = registry.attach(runtimeId, (event) => {
          handleAgentEventRef.current?.(event as AgentEvent);
        });
      }
      unsubSnapshot = registry.subscribe(runtimeId, (snap) => {
        if (sessionIdRef.current && snap.sessionId !== sessionIdRef.current && snap.sessionId !== runtimeId) {
          return;
        }
        setMessages(snap.messages);
        setEntryIds(snap.entryIds);
        setMessageKeys(snap.messageKeys);
        setTurnMetrics(snap.turnMetrics);
        entryIdsRef.current = snap.entryIds;
        // run/stream/bash 均由本 snapshot 投影：视图不再自行置位。
        // 只读会话不跑 agent/bash，只同步消息列表并清空运行态。
        if (session?.readOnly === true) {
          setAgentRunning(false);
          setBashRunning(false);
          bashRunningRef.current = false;
          setPendingBash(null);
          dispatch({ type: "end" });
          eventSourceRef.current = null;
          return;
        }
        setAgentRunning(snap.agentRunning);
        if (snap.streamState.isStreaming) {
          dispatch({
            type: "update",
            message: snap.streamState.streamingMessage ?? null,
          });
        } else {
          dispatch({ type: "end" });
        }
        setBashRunning(snap.bashRunning);
        bashRunningRef.current = snap.bashRunning;
        setPendingBash(snap.pendingBash);
        eventSourceRef.current = registry.getEventSource(snap.sessionId) as unknown as EventSource | null;
      });
    } else {
      // 无 runtimeId（无会话且非新 intent）：没有 snapshot 可投影，显式清空。
      setAgentRunning(false);
      setBashRunning(false);
      bashRunningRef.current = false;
      setPendingBash(null);
    }

    if (session) {
      if (session.readOnly === true) {
        void loadSession(session.id, true, false);
      } else {
        // 刚由本页创建/正在跑的新会话：registry slot 已有内存消息（乐观+SSE），
        // 直接渲染避免「引导页 → 全屏 loading → 会话」闪白；showLoading=false
        // 时仍走 includeState（热状态/磁盘权威在后台对账）。
        const hasLiveSlotContent =
          runtimeId != null
          && (registry.getSnapshot(runtimeId)?.messages.length ?? 0) > 0;
        // 记录切回前的 run token：loadSession 期间若有新 agent_start，不能用
        // 旧的 idle 快照清掉新 run。
        const runAtLoad = runtimeId ? registry.getRunState(runtimeId) : null;
        loadSession(session.id, !hasLiveSlotContent, true).then((agentState) => {
          if (agentState === true) return;
          const runAfterLoad = registry.getRunState(session.id);
          const serviceConfirmedIdle =
            agentState?.activeRun === false
            && agentState.lockedByOther !== true;
          if (
            serviceConfirmedIdle
            && runAtLoad?.agentRunning
            && !runAtLoad.sendInFlight
            && runAfterLoad?.agentRunning
            && runAfterLoad.promptRunId === runAtLoad.promptRunId
          ) {
            // host 已在 agent_settled 后销毁，但旧 slot 未收到边界事件；磁盘
            // hydrate 已在 loadSession 中完成，此处只收口浏览器运行态。
            registry.completeRun(session.id, runAfterLoad.promptRunId);
            setAgentPhase(null);
            setRetryInfo(null);
          }
          if (agentState?.running || agentState?.live) {
            loadTools(session.id);
            if (agentState.state?.isStreaming || agentState.state?.isPromptRunning) {
              // 刷新/冷挂载后服务端已在跑的 run：先导入 registry slot，
              // 否则 reconcile 会把它当空闲收尾、输入框也会允许 prompt（被服务端拒）。
              getOrCreateBrowserSessionRuntimeRegistry().importRunningRun(session.id);
              setAgentPhase(agentState.state.isStreaming ? { kind: "waiting_model" } : { kind: "running_command" });
              if (!agentState.state.isStreaming && agentState.state.isPromptRunning) {
                void waitForPromptSettlement(session.id);
              }
            }
            if (agentState.state?.isBashRunning) {
              getOrCreateBrowserSessionRuntimeRegistry().setBashRunning(
                session.id,
                true,
                agentState.state.pendingBash ?? null,
              );
              void waitForBashSettlement(session.id);
            }
          }
          if (agentState?.lockedByOther !== undefined) setLockedByOther(agentState.lockedByOther);
          if (agentState?.state) {
            // 这份快照属于本会话（session.id），但响应到达时用户可能已切走：
            // 逐个字段都不得写进别的会话。
            const stillCurrent = canApplyProjection(
              { sessionId: session.id },
              { sessionId: sessionIdRef.current },
            );
            if (stillCurrent && agentState.state.isCompacting !== undefined) {
              setIsCompacting(agentState.state.isCompacting);
            }
            if (stillCurrent && agentState.state.contextUsage !== undefined) {
              setContextUsage(agentState.state.contextUsage ?? null);
            }
            seedTurnMetricsFromState(session.id, agentState.state);
            if (stillCurrent && agentState.state.systemPrompt !== undefined) {
              setSystemPrompt(agentState.state.systemPrompt ?? null);
            }
            if (stillCurrent && isThinkingLevel(agentState.state.thinkingLevel)) {
              setThinkingLevel(agentState.state.thinkingLevel);
            }
            if (stillCurrent && agentState.state.extensionStatuses !== undefined) {
              patchExtensionUiState({ statuses: agentState.state.extensionStatuses ?? [] });
            }
            if (stillCurrent && agentState.state.extensionWidgets !== undefined) {
              patchExtensionUiState({ widgets: agentState.state.extensionWidgets ?? [] });
            }
            if (agentState.state.queuedMessages !== undefined) {
              applyProjectedQueues(session.id, agentState.state.queuedMessages);
            }
            // 活动 custom 面板：冷加载/刷新恢复（#34）。会话已切走则不写
            // （customUi 是全局面板态，不按会话分，故使用同一个归属守卫）。
            if (stillCurrent) applyActiveCustomUi(agentState.state.activeCustomUi);
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
      // 切走/换 intent：立刻断开在途的会话加载（大会话 tail 可达数百 KB），
      // 不要等响应下载并解析完再靠 sessionId 守卫丢弃。
      loadAbortRef.current?.abort();
      loadAbortRef.current = null;
      unsubSnapshot?.();
      const sid = runtimeId ?? sessionIdRef.current ?? session?.id;
      if (sid && runtimeSubscriptionRef.current) {
        getOrCreateBrowserSessionRuntimeRegistry().detach(sid, runtimeSubscriptionRef.current);
        runtimeSubscriptionRef.current = null;
      }
    };
  }, [session?.id, session?.readOnly, newSessionIntentId, isNew, notifyAutoFollowBranchReset]);

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
    data, loading, historyLoading, hasMoreBefore, error, activeLeafId, messages, entryIds, messageKeys, streamState,
    agentRunning, turnMetrics, lockedByOther, modelNames, modelList, modelAuthConfigured, modelThinkingLevels, modelThinkingLevelMaps, newSessionModel, thinkingLevel: resolvedThinking, thinkingReady, defaultThinkingLevel: isNew ? settingsDefaultThinking : null,
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
    loadNewerHistory,
    hasMoreAfter,
    jumpToEntry,
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
