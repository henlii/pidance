"use client";
import { registerAbortHandler } from "@/hooks/useKeyboardShortcuts";
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { AgentMessage, BashExecutionMessage, SessionInfo, SessionTreeNode, ToolResultMessage } from "@/lib/types";
import type { BranchActions } from "@/lib/branch-bookmarks";
import { parseAnsiLine } from "@/lib/ansi";
import { composeChatPlan, type ChatRenderItem, type ChatRenderPlanItem } from "@/lib/chat-compositor";
import type { TurnMetrics } from "@/lib/browser-session-runtime-registry";
import { MessageView } from "./MessageView";
import { ImagePreviewOverlay } from "./MessageImage";
import { ChatInput, type ChatInputHandle } from "./ChatInput";
import { ChatMinimap, useMessageRefs } from "./ChatMinimap";
import { MessageNavRail } from "./MessageNavRail";
import type { UserMessageOutlineItem } from "@/lib/session-outline";
import { CHAT_BLOCK_MAX_HEIGHT, CHAT_BLOCK_MAX_HEIGHT_MOBILE, CHAT_COLUMN_MAX_WIDTH, CHAT_GUTTER } from "@/lib/chat-column";

/**
 * 输入区/面板/底栏的左右内边距：与消息列逐像素对齐。
 * 消息列的左右边距由两侧竖条（MessageNavRail / ChatMinimap，各 CHAT_GUTTER px）
 * 充当，所以输入区也要退同样宽度，否则两者左右边缘会差一个竖条。
 */
const CHAT_INPUT_SIDE_PADDING = CHAT_GUTTER;
const CHAT_INPUT_SIDE_PADDING_MOBILE = 16;
import { ExtensionDialog } from "./ExtensionDialog";
import { ExtensionCustomPanel } from "./ExtensionCustomPanel";
import { NewSessionGuide } from "./NewSessionGuide";
import { TodoPanel } from "./TodoPanel";
import { useAgentSession, type AgentPhase, type NoticeItem } from "@/hooks/useAgentSession";
import { useAudio } from "@/hooks/useAudio";
import { useI18n } from "@/lib/i18n";
import { getServerPref, setServerPref, useServerPreferences } from "@/lib/server-preferences";
import { useDragDrop } from "@/hooks/useDragDrop";
import { useIsMobile } from "@/hooks/useIsMobile";
import type { SessionStatsInfo } from "@/lib/pi-types";
import type { SessionActivity } from "@/lib/session-activity";
import {
  captureScrollDistance,
  getNextVisibleCount,
  getVisibleRenderWindow,
  growVisibleCountOnAppend,
  shrinkVisibleCountOnPlanShrink,
  resolveHistoryLoadAction,
  restoreScrollTop,
  shouldShowHistorySentinel,
  VISIBLE_PAGE_SIZE,
} from "@/lib/chat-lazy-load";
import {
  applyViewportScrollAnchor,
  captureReadingScrollAnchor,
  captureViewportScrollAnchor,
  CHAT_IGNORE_RECAPTURE_ATTR,
  shouldApplyPrependCompensation,
  type PrependCompensationPending,
  type ViewportScrollAnchor,
} from "@/lib/chat-scroll-anchor";

interface Props {
  session: SessionInfo | null;
  newSessionCwd: string | null;
  /** 新建意图 id，透传 useAgentSession 供 onSessionCreated 门禁。 */
  newSessionIntentId?: string | null;
  /** 新会话引导页默认目标项目（入口解析的 cwd；null = 回落 localStorage 上次项目） */
  guideDefaultCwd?: string | null;
  /** 引导页改项目/工作树：同步到全局项目身份（文件栏、Git、标题） */
  onGuideTargetChange?: (cwd: string, projectRoot?: string | null) => void;
  onAgentEnd?: () => void;
  /** agentRunning 变化（含冷启动前）→ 侧栏立即显示运行中 */
  onAgentRunningChange?: (running: boolean, sessionId: string | null) => void;
  onSessionCreated?: (session: SessionInfo, intentId?: string | null) => void;
  /** fork/新会话成功后切换会话；prefill 为预填到新会话输入框的文本（draft 注入）。 */
  onSessionForked?: (newSessionId: string, prefill?: string) => void;
  modelsRefreshKey?: number;
  chatInputRef?: React.RefObject<ChatInputHandle | null>;
  onBranchDataChange?: (tree: SessionTreeNode[], activeLeafId: string | null, onLeafChange: (leafId: string | null) => void, actions: BranchActions) => void;
  onSystemPromptChange?: (prompt: string | null) => void;
  onSessionStatsChange?: (stats: SessionStatsInfo | null) => void;
  onSessionStatsPanelOpen?: () => void;
  onContextUsageChange?: (usage: { percent: number | null; contextWindow: number; tokens: number | null } | null) => void;
  /** 最近一轮 run 的延迟/吞吐，供顶栏显示。 */
  onTurnMetricsChange?: (metrics: TurnMetrics) => void;
  onOpenFile?: (filePath: string) => void;
  /** 输入框下方 footer（状态条）是否折叠：由 AppShell 持有（ChatWindow 按 sessionKey
   *  重挂载，本页选择必须待在更上层的稳定宿主里）。 */
  footerCollapsed: boolean;
  onFooterToggle: () => void;
}

function phaseLabel(phase: AgentPhase, t: ReturnType<typeof useI18n>["t"]): string {
  if (phase?.kind === "running_tools") {
    const names = phase.tools.map((t) => t.name);
    if (names.length === 0) return `${t("chat_runningTool")}...`;
    if (names.length === 1) return `${t("chat_runningNamed", { name: names[0] })}...`;
    if (names.length <= 3) return `${t("chat_runningNamed", { name: names.join(", ") })}...`;
    return `${t("chat_runningNamed", { name: `${names.slice(0, 2).join(", ")} (+${names.length - 2})` })}...`;
  }
  if (phase?.kind === "waiting_model") return `${t("chat_waitingModel")}...`;
  if (phase?.kind === "running_command") return `${t("chat_runningCommand")}...`;
  return `${t("chat_thinking")}...`;
}



function planItemStableKey(
  item: ChatRenderPlanItem | undefined,
  messageKeys: readonly string[],
): string | null {
  if (!item) return null;
  if (item.kind === "processGroup") {
    return `process:${messageKeys[item.userIdx] ?? item.userIdx}:${messageKeys[item.finalAssistantIdx] ?? item.finalAssistantIdx}`;
  }
  if (item.source === "live") return "live";
  const idx = item.messageIndex;
  if (typeof idx !== "number") return item.keyPrefix ?? null;
  return messageKeys[idx] ?? `idx:${idx}`;
}

// 过程详情默认持续展开（Issue #13）：外层不再默认隐藏整个 user→answer 过程；
// 用户仍可主动收起/展开，局部 thinking / tool 明细保持各自的按需折叠。
//
// 性能（不改可见效果）：展开态的内容改为**进视口才挂载**。child 元素本身的构造很便宜
// （renderMessage 只拼 JSX），贵的是 React 把整棵子树渲染进 DOM —— 长会话里一轮过程
// 动辄 40–50 条消息、47 次工具调用，按 entryId 跳到历史后整页可达 2.7 万 DOM 节点、
// 秒级长任务。不把子树交给 React，就不会付这份代价。
export function ProcessDetailsGroup({ messageCount, toolCallCount, children, t, eager = false }: { messageCount: number; toolCallCount: number; children: ReactNode; t: ReturnType<typeof useI18n>["t"]; eager?: boolean }) {
  const [expanded, setExpanded] = useState(true);
  const holderRef = useRef<HTMLDivElement>(null);
  // 无 IntersectionObserver 时直接挂载。eager 只给收尾刚收成的最后一轮：
  // 首帧必须是真实内容。更早的历史组仍先占位，进视口再挂载。
  const [inViewport, setInViewport] = useState(() => eager || typeof IntersectionObserver === "undefined");
  /**
   * 卸载后用于占位的高度 = 上一次实测高度。
   * 用估算值占位会让滚动位置漂移（实测连续跳转后目标偏 18012px）；
   * 记住真实高度则挂载/卸载前后布局几乎不变。
   */
  const estimateHeight = messageCount * 56 + toolCallCount * 24;
  const measuredHeightRef = useRef<number | null>(estimateHeight);
  const syncMeasuredHeight = () => {
    const el = holderRef.current;
    if (!el) return;
    const height = el.getBoundingClientRect().height;
    if (height > 0) measuredHeightRef.current = height;
  };
  useLayoutEffect(() => {
    syncMeasuredHeight();
  }, [inViewport]);
  useEffect(() => {
    const el = holderRef.current;
    if (!el || !inViewport) return;
    syncMeasuredHeight();
    const ro = new ResizeObserver(() => { syncMeasuredHeight(); });
    ro.observe(el);
    return () => ro.disconnect();
  }, [inViewport]);

  useEffect(() => {
    const el = holderRef.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    // 双向：进视口挂载，远离视口卸载。
    // 必须可卸载 —— 连续跳转时已展开的块若不回收，DOM 会累积到 2 万+ 节点，
    // 后一次跳转又变卡（实测第二次跳转长任务回到 92 个）。
    // rootMargin 上下各留一屏半：预挂载减少滚动空白，卸载留足余量避免抖动。
    const io = new IntersectionObserver(
      (entries) => {
        const node = holderRef.current;
        if (node) {
          const height = node.getBoundingClientRect().height;
          if (height > 0) measuredHeightRef.current = height;
        }
        setInViewport(entries[0]?.isIntersecting === true);
      },
      { rootMargin: "150% 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);
  const parts = [t("chat_processDetails"), `${messageCount} ${t(messageCount === 1 ? "chat_message" : "chat_messages")}`];
  if (toolCallCount > 0) parts.push(`${toolCallCount} ${t(toolCallCount === 1 ? "chat_toolCall" : "chat_toolCalls")}`);

  return (
    <div style={{ marginBottom: 14 }}>
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          width: "auto",
          minHeight: 24,
          padding: "2px 0",
          border: "none",
          background: "transparent",
          color: "var(--text-muted)",
          cursor: "pointer",
          fontSize: 12,
          textAlign: "left",
        }}
        title={expanded ? t("chat_hideProcess") : t("chat_showProcess")}
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, transform: expanded ? "rotate(90deg)" : "none", transition: "transform 0.15s" }}>
          <polyline points="4 2.5 7.5 6 4 9.5" />
        </svg>
        <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {parts.join(" · ")}
        </span>
      </button>
      <div ref={holderRef}>
        {expanded && (inViewport ? (
          <div style={{ marginTop: 8 }}>{children}</div>
        ) : (
          // 占位高度按内容规模估算（每条消息/每次工具调用都占高度）：估得越准，
          // 滚动条与后续定位的漂移越小。真实内容挂载后高度会替换掉它。
          <div
            style={{
              marginTop: 8,
              // 优先用上次实测高度（布局几乎不变）；首次未见才退化为估算
              minHeight: measuredHeightRef.current ?? (messageCount * 56 + toolCallCount * 24),
            }}
            aria-hidden="true"
          />
        ))}
      </div>
    </div>
  );
}

export function ChatWindow({ session, newSessionCwd, newSessionIntentId, guideDefaultCwd, onGuideTargetChange, onAgentEnd, onAgentRunningChange, onSessionCreated, onSessionForked, modelsRefreshKey, chatInputRef, onBranchDataChange, onSystemPromptChange, onSessionStatsChange, onSessionStatsPanelOpen, onContextUsageChange, onTurnMetricsChange, onOpenFile, footerCollapsed, onFooterToggle }: Props) {
  const { t } = useI18n();
  const { soundEnabled, onSoundToggle, playDoneSound, unlockAudio } = useAudio();
  const isMobile = useIsMobile();
  // 只读（subagent 持久化）会话：历史正常读，一切写入口关闭，编辑器换成只读提示。
  const isReadOnly = session?.readOnly === true;

  // OpenChamber draft-target 语义：空态引导页选中的目标 cwd（项目根或工作树路径）。
  // 持久化到 localStorage（对应 OpenChamber oc.chatInput.lastDraftTarget），
  // 选择不触发跳转/创建——仅覆盖新会话的创建目录，发送第一条消息才真正建会话。
  const [draftTargetCwd, setDraftTargetCwd] = useState<string | null>(() => {
    // 新意图显式目标优先（顶部新建 = 当前选中项目；项目行 = 对应项目）；
    // 否则回落 localStorage 上次项目（刷新恢复）。
    if (guideDefaultCwd) return guideDefaultCwd;
    try {
      return localStorage.getItem("pidance.draftTargetCwd");
    } catch {
      return null;
    }
  });
  const handleDraftTargetChange = useCallback((cwd: string | null, projectRoot?: string | null) => {
    setDraftTargetCwd(cwd);
    try {
      if (cwd) {
        localStorage.setItem("pidance.draftTargetCwd", cwd);
        setServerPref("draftTargetCwd", cwd);
      } else {
        localStorage.removeItem("pidance.draftTargetCwd");
        setServerPref("draftTargetCwd", null);
      }
    } catch {
      // localStorage 不可用时仅内存生效
    }
    if (cwd) onGuideTargetChange?.(cwd, projectRoot ?? cwd);
  }, [onGuideTargetChange]);
  // 入口显式目标（顶部新建 = 当前选中项目 / 项目行 = 对应项目）同步进 localStorage，
  // 保证刷新后仍恢复为"上次的项目"（OpenChamber persistDraftTarget 语义）。
  useEffect(() => {
    if (guideDefaultCwd) handleDraftTargetChange(guideDefaultCwd);
  }, [guideDefaultCwd, handleDraftTargetChange]);
  const effectiveNewSessionCwd = draftTargetCwd ?? newSessionCwd;
  // Wrap onAgentEnd to play the completion sound. This is more reliable than
  // wrapping handleAgentEventRef because useAgentSession overwrites that ref
  // on every render (it syncs the latest callback), which would blow away an
  // externally-installed wrapper after the first re-render.
  const playDoneSoundRef = useRef(playDoneSound);
  playDoneSoundRef.current = playDoneSound;
  const soundEnabledRef = useRef(soundEnabled);
  soundEnabledRef.current = soundEnabled;
  const wrappedOnAgentEnd = useCallback(() => {
    if (soundEnabledRef.current) {
      playDoneSoundRef.current();
    }
    onAgentEnd?.();
  }, [onAgentEnd]);

  const {
    loading, historyLoading, hasMoreBefore, error, messages, entryIds, messageKeys, streamState,
    agentRunning, turnMetrics, bashRunning, pendingBash, modelNames, modelList, modelAuthConfigured, modelThinkingLevels, modelThinkingLevelMaps, thinkingLevel, thinkingReady,
    retryInfo, contextUsage, forkingEntryId,
    isCompacting, compactError, compactResult, displayModel: displayModelValue, sessionStats, defaultThinkingLevel,
    slashCommands, slashCommandsLoading, queuedMessages,
    notices, liveNoticeActivities, dismissNotice, toggleNoticePin, extensionDialog, extensionCustomUi, extensionStatuses, extensionWidgets, respondToExtensionUi, dismissExtensionUiRequest, sendExtensionCustomInput,
    todos,
    isAutoModelSelection,
    agentPhase, toolExecutionSnapshots,
    isNew,
    sessionIdRef, scrollContainerRef,
    jumpButtonVisible, jumpToBottom, markExternalScrollWrite, notifyProgrammaticSmooth, isAutoFollowing,
    loadOlderHistory,
    loadNewerHistory,
    jumpToEntry,
    hasMoreAfter,
    lockedByOther,
    handleSend, handleAbort, handleModelChange,
    handleCompact, handleSteer, handleFollowUp, handlePromptWithStreamingBehavior, handleAbortCompaction,
    handleRecallQueue, handleSendQueueAsSteer,
    handleBuiltinSlashCommand,
    handleThinkingLevelChange, loadSlashCommands,
    handleBranchHere, handleBranchFromAssistant,
    handleNewSessionFromHere, handleNewSessionFromAnswer,
  } = useAgentSession({
    session, newSessionCwd: effectiveNewSessionCwd, newSessionIntentId, onAgentEnd: wrappedOnAgentEnd, onAgentRunningChange, onSessionCreated, onSessionForked,
    modelsRefreshKey, chatInputRef, onBranchDataChange, onSystemPromptChange, onSessionStatsPanelOpen,
    isMobile,
  });
  /**
   * 会话全部用户消息大纲（左侧导航条「列出所有提问」）。
   * 只读接口：直接读完整 entry 列表，不受首屏懒加载窗口限制。
   * 刷新时机：切会话、消息数变化（新提问落盘）、agent 结束。
   */
  const [userOutline, setUserOutline] = useState<UserMessageOutlineItem[]>([]);
  /**
   * entryId → 消息 DOM 的解析器（由渲染层提供）。
   * 导航条跳转必须走这里：槽位映射（visibleRefIndexByMessage + 分页平移 + process
   * group 共享槽位）是渲染层的知识，导航条自己算会指错消息（实测跳 2 号落到 1 号）。
   */
  const resolveMessageElementRef = useRef<((entryId: string) => HTMLElement | null) | null>(null);
  /**
   * 把渲染窗口（visibleCount）扩到包含目标 entry，返回是否扩了。
   * 会话有「分页加载」与「只渲染末 N 条」两层懒加载：目标可能已加载但未被渲染，
   * 此时 refs 里没有它 —— 必须先把窗口撑开到覆盖它，否则跳转永远落在旧位置。
   */
  const expandRenderWindowToEntryRef = useRef<((entryId: string) => boolean) | null>(null);
  const outlineSessionId = session?.id ?? null;
  useEffect(() => {
    if (!outlineSessionId) {
      setUserOutline([]);
      return;
    }
    const controller = new AbortController();
    void fetch(`/api/sessions/${encodeURIComponent(outlineSessionId)}/outline`, {
      signal: controller.signal,
      cache: "no-store",
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { userMessages?: UserMessageOutlineItem[] } | null) => {
        if (controller.signal.aborted || !data) return;
        setUserOutline(Array.isArray(data.userMessages) ? data.userMessages : []);
      })
      .catch(() => {
        // 只读投影失败：保持上一次大纲，不清空（避免导航条闪没）
      });
    return () => controller.abort();
  }, [outlineSessionId, messages.length, agentRunning]);

  const writesDisabled = isReadOnly || lockedByOther;
  const sessionBusy = agentRunning || bashRunning || isCompacting;
  const liveSlot = streamState.isStreaming && streamState.streamingMessage
    ? { message: streamState.streamingMessage, isActive: true }
    : undefined;
  const chatPlan = composeChatPlan({
    messages,
    isStreaming: streamState.isStreaming,
    agentOrBashRunning: sessionBusy,
    liveSlot,
  });
  const [todosCollapsed, setTodosCollapsed] = useState(true);
  const todoCollapseScope = session?.id ?? (effectiveNewSessionCwd ? `new:${effectiveNewSessionCwd}` : "new-session");
  // Todo 展开状态只属于当前聊天视图；切换会话后恢复默认折叠。
  useEffect(() => {
    setTodosCollapsed(true);
  }, [todoCollapseScope]);

  const serverPrefs = useServerPreferences();
  useEffect(() => {
    const remoteDraft = getServerPref<unknown>("draftTargetCwd");
    if (typeof remoteDraft === "string" && remoteDraft && remoteDraft !== draftTargetCwd && !guideDefaultCwd) {
      setDraftTargetCwd(remoteDraft);
    }
  }, [serverPrefs]);

  // 阻塞弹窗（dialog）expiresAt 到达：按 id 从 FIFO 清理并推进；不发送
  // extension_ui_response（服务端 timeout 自结算）。

  // 阻塞弹窗（dialog）expiresAt 到达：按 id 从 FIFO 清理并推进；不发送
  // extension_ui_response（服务端 timeout 自结算）。
  useEffect(() => {
    const requestId = extensionDialog?.id;
    const expiresAt = extensionDialog?.expiresAt;
    if (!requestId || typeof expiresAt !== "number" || !Number.isFinite(expiresAt)) return;

    let timer: ReturnType<typeof setTimeout> | undefined;
    const scheduleExpiry = () => {
      const remaining = expiresAt - Date.now();
      if (remaining <= 0) {
        dismissExtensionUiRequest(requestId);
        return;
      }
      timer = setTimeout(scheduleExpiry, Math.min(remaining, 2_147_483_647));
    };
    scheduleExpiry();

    return () => {
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [extensionDialog?.id, extensionDialog?.expiresAt, dismissExtensionUiRequest]);

  // Register the abort handler for the global Esc shortcut
  useEffect(() => {
    registerAbortHandler(sessionBusy ? handleAbort : null);
  }, [sessionBusy, handleAbort]);

// --- Lazy-load historical messages ---
  // 1) 客户端 visibleCount：已加载计划项内只渲染末 N 条（过程组是一项，不是一条消息）
  // 2) 服务端 hasMoreBefore：滚到顶时 loadOlderHistory prepend 更旧页（OpenChamber 风格）
  // 3) 尾部追加时同步增大 visibleCount，避免自动跟随时 startIndex 前移卸载更早消息
  const [visibleCount, setVisibleCount] = useState(VISIBLE_PAGE_SIZE);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const pendingCompensationRef = useRef<PrependCompensationPending | null>(null);
  const compensationGenRef = useRef(0);
  const ignoreScrollRecaptureRef = useRef(false);
  const prevPlanTotalRef = useRef<number | null>(null);
  const readingAnchorRef = useRef<ViewportScrollAnchor | null>(null);
  const prevPlanSigRef = useRef<string | null>(null);
  const { startIndex: planStartIndex, hasMore: localHasMore } = getVisibleRenderWindow(chatPlan.length, visibleCount);
  const renderedHeadKey = planItemStableKey(chatPlan[planStartIndex], messageKeys);
  const renderedHeadKeyRef = useRef(renderedHeadKey);
  renderedHeadKeyRef.current = renderedHeadKey;
  // 快照必须在绘制前作废：A→B→A 时旧 then() 不得改新事务。
  useLayoutEffect(() => {
    compensationGenRef.current += 1;
    pendingCompensationRef.current = null;
    prevPlanTotalRef.current = null;
    readingAnchorRef.current = null;
    prevPlanSigRef.current = null;
  }, [session?.id]);
  // 会话切换时重置可见窗口（首屏末 N 条）
  useEffect(() => {
    setVisibleCount(VISIBLE_PAGE_SIZE);
  }, [session?.id]);

  // IntersectionObserver on the sentinel div at the top of the message list.
  // When it becomes visible, expand local window or fetch older pages from server.
  useEffect(() => {
    const sentinel = sentinelRef.current;
    const container = scrollContainerRef.current;
    if (!sentinel || !container) return;
    const capturePending = (): number => {
      const generation = ++compensationGenRef.current;
      pendingCompensationRef.current = {
        generation,
        sessionId: session?.id ?? null,
        visibleCount,
        distance: captureScrollDistance(container.scrollHeight, container.scrollTop),
        renderedHeadKey: renderedHeadKeyRef.current,
        anchor: captureViewportScrollAnchor(container),
      };
      return generation;
    };
    const recaptureIfPending = () => {
      if (ignoreScrollRecaptureRef.current) return;
      if (container.getAttribute(CHAT_IGNORE_RECAPTURE_ATTR) === "1") return;
      const anchor = captureViewportScrollAnchor(container);
      if (!isAutoFollowing()) readingAnchorRef.current = captureReadingScrollAnchor(container) ?? anchor;
      const pending = pendingCompensationRef.current;
      if (!pending) return;
      pending.distance = captureScrollDistance(container.scrollHeight, container.scrollTop);
      pending.anchor = anchor;
    };
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries[0]?.isIntersecting) return;
        const action = resolveHistoryLoadAction({
          localHasMore,
          hasMoreBefore,
          historyLoading,
        });
        if (action === "none") return;
        const generation = capturePending();
        if (action === "expand-local") {
          setVisibleCount((prev) => getNextVisibleCount(prev));
          return;
        }
        // load-server：扩窗交给计划增长的 layout（与 hydrate 同一绘制前批次），
        // then 只负责失败/过期时丢掉本事务快照，不得改另一会话的 visibleCount。
        void loadOlderHistory().then((loaded) => {
          if (compensationGenRef.current !== generation) return;
          if (!loaded && pendingCompensationRef.current?.generation === generation) {
            pendingCompensationRef.current = null;
          }
        });
      },
      { root: container, threshold: 0 },
    );
    observer.observe(sentinel);
    // 用户滚动发生之后再采锚点（wheel 监听器在默认滚动之前触发）。
    container.addEventListener("scroll", recaptureIfPending, { passive: true });
    return () => {
      observer.disconnect();
      container.removeEventListener("scroll", recaptureIfPending);
    };
  }, [localHasMore, visibleCount, scrollContainerRef, hasMoreBefore, historyLoading, loadOlderHistory, session?.id, isAutoFollowing]);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    const onScroll = () => {
      if (ignoreScrollRecaptureRef.current) return;
      if (container.getAttribute(CHAT_IGNORE_RECAPTURE_ATTR) === "1") return;
      if (isAutoFollowing()) return;
      readingAnchorRef.current = captureReadingScrollAnchor(container) ?? captureViewportScrollAnchor(container);
    };
    container.addEventListener("scroll", onScroll, { passive: true });
    return () => container.removeEventListener("scroll", onScroll);
  }, [scrollContainerRef, session?.id, isAutoFollowing, messages.length, chatPlan.length]);

  // 计划变长（prepend / 流式追加）时在绘制前补 visibleCount，保持 startIndex，
  // 再决定是否消费本事务的 prepend 快照。setState 会再跑一遍 layout，仍在绘制前。
  useLayoutEffect(() => {
    const prevTotal = prevPlanTotalRef.current;
    const nextTotal = chatPlan.length;
    let windowReady = true;
    if (prevTotal === null || prevTotal === 0) {
      prevPlanTotalRef.current = nextTotal;
    } else if (nextTotal !== prevTotal) {
      if (nextTotal > prevTotal) {
        const grown = growVisibleCountOnAppend(visibleCount, prevTotal, nextTotal);
        if (grown !== visibleCount) {
          windowReady = false;
          setVisibleCount(grown);
        }
      } else if (nextTotal < prevTotal) {
        const shrunk = shrinkVisibleCountOnPlanShrink(visibleCount, prevTotal, nextTotal);
        if (shrunk !== visibleCount) {
          windowReady = false;
          setVisibleCount(shrunk);
        }
      }
      prevPlanTotalRef.current = nextTotal;
    }

    if (!windowReady) return;
    const container = scrollContainerRef.current;
    const pending = pendingCompensationRef.current;
    if (container && shouldApplyPrependCompensation({
      pending,
      sessionId: session?.id ?? null,
      generation: compensationGenRef.current,
      renderedHeadKey,
      visibleCount,
    }) && pending) {
      markExternalScrollWrite();
      ignoreScrollRecaptureRef.current = true;
      const restored = pending.anchor ? applyViewportScrollAnchor(container, pending.anchor) : false;
      if (!restored) {
        container.scrollTop = restoreScrollTop(container.scrollHeight, pending.distance);
      }
      pendingCompensationRef.current = null;
      requestAnimationFrame(() => {
        ignoreScrollRecaptureRef.current = false;
      });
    }
    const planLayoutSig = chatPlan.map((item) => (
      item.kind === "processGroup"
        ? `g:${item.userIdx}:${item.finalAssistantIdx}:${item.messageCount}`
        : `m:${item.source}:${item.messageIndex ?? "x"}:${item.keyPrefix}`
    )).join("|");
    const following = isAutoFollowing();
    if (container && !following && readingAnchorRef.current && prevPlanSigRef.current && prevPlanSigRef.current !== planLayoutSig) {
      markExternalScrollWrite();
      applyViewportScrollAnchor(container, readingAnchorRef.current);
    }
    prevPlanSigRef.current = planLayoutSig;
    if (container && !following) {
      readingAnchorRef.current = captureReadingScrollAnchor(container) ?? captureViewportScrollAnchor(container);
    } else {
      readingAnchorRef.current = null;
    }
  }, [renderedHeadKey, visibleCount, chatPlan, entryIds, messages.length, session?.id, markExternalScrollWrite, scrollContainerRef, isAutoFollowing]);
  // Push session stats up to AppShell for the top bar.
  // Compare scalar fields to avoid loops from new object identity each render.
  const statsKey = sessionStats
    ? [
      sessionStats.sessionId,
      sessionStats.sessionFile ?? "",
      sessionStats.sessionName ?? "",
      sessionStats.userMessages,
      sessionStats.assistantMessages,
      sessionStats.toolCalls,
      sessionStats.toolResults,
      sessionStats.totalMessages,
      sessionStats.tokens.input,
      sessionStats.tokens.output,
      sessionStats.tokens.cacheRead,
      sessionStats.tokens.cacheWrite,
      sessionStats.tokens.total,
      sessionStats.cost ?? 0,
    ].join("|")
    : null;
  const sessionStatsRef = useRef(sessionStats);
  sessionStatsRef.current = sessionStats;
  useEffect(() => {
    onSessionStatsChange?.(sessionStatsRef.current);
  }, [statsKey, onSessionStatsChange]);
  useEffect(() => () => { onSessionStatsChange?.(null); }, [onSessionStatsChange]);

  // 会话级上下文占用：热 state 优先；非 live（打开历史/只读）会话回退磁盘统计，
  // 否则切换模型提示与错误卡片的占用行会缺数据。
  const sessionContextUsage = sessionStats?.contextUsage ?? contextUsage ?? null;

  // Push context usage up to AppShell as well.
  const ctxKey = contextUsage
    ? `${contextUsage.percent ?? "null"}|${contextUsage.contextWindow}|${contextUsage.tokens ?? "null"}`
    : null;
  const contextUsageRef = useRef(contextUsage);
  contextUsageRef.current = contextUsage;
  useEffect(() => {
    onContextUsageChange?.(contextUsageRef.current);
  }, [ctxKey, onContextUsageChange]);
  useEffect(() => () => { onContextUsageChange?.(null); }, [onContextUsageChange]);

  // 吞吐读数只在 message_end 时变，用标量 key 避免流式帧触发多余推送。
  const metricsKey = `${turnMetrics.ttftMs ?? ""}|${turnMetrics.tokensPerSecond ?? ""}`;
  const turnMetricsRef = useRef(turnMetrics);
  turnMetricsRef.current = turnMetrics;
  useEffect(() => {
    onTurnMetricsChange?.(turnMetricsRef.current);
  }, [metricsKey, onTurnMetricsChange]);
  useEffect(() => () => { onTurnMetricsChange?.({}); }, [onTurnMetricsChange]);

  const onDrop = useCallback((files: File[]) => {
    // 运行中也可以拖入：图片按入队语义附件，其他文件由 ChatInput 给出提示。
    if (writesDisabled) return;
    chatInputRef?.current?.addFiles(files);
  }, [writesDisabled, chatInputRef]);

  const { isDragOver, handleDragEnter, handleDragOver, handleDragLeave, handleDrop } = useDragDrop(onDrop);

  const visibleMessages = messages.filter((m) => m.role === "user" || m.role === "assistant");
  const messageRefs = useMessageRefs(visibleMessages.length);

  const isEmptyNew = isNew && messages.length === 0 && !streamState.isStreaming && !sessionBusy;
  const messageCwd = session?.cwd ?? effectiveNewSessionCwd ?? undefined;
  const availableThinkingLevels = displayModelValue
    ? (modelThinkingLevels[`${displayModelValue.provider}:${displayModelValue.modelId}`] ?? null)
    : null;

  const currentThinkingLevelMap = displayModelValue
    ? (modelThinkingLevelMaps[`${displayModelValue.provider}:${displayModelValue.modelId}`] ?? null)
    : null;

  const chatInputElement = (
    <>
      {extensionDialog ? (
        // 面板打开时独占输入区（与输入框同内边距/同宽）：输入栏（含队列、模型选择）与底栏
        // 一并让位，否则面板与输入栏上下挤在一起、键盘归属也不清楚。
        <div
          style={{
            flexShrink: 0,
            padding: `0 ${isMobile ? CHAT_INPUT_SIDE_PADDING_MOBILE : CHAT_INPUT_SIDE_PADDING}px 8px`,
          }}
        >
          <div style={{ maxWidth: CHAT_COLUMN_MAX_WIDTH, margin: "0 auto" }}>
            <ExtensionDialog
              request={extensionDialog}
              disabled={writesDisabled || !sessionIdRef.current}
              onRespond={(response) => {
                void respondToExtensionUi(extensionDialog, response);
              }}
            />
          </div>
        </div>
      ) : isReadOnly && session ? (
        <ReadOnlySessionBar session={session} isMobile={isMobile} />
      ) : lockedByOther ? (
        <LockedSessionBar isMobile={isMobile} />
      ) : (
        <ChatInput
      ref={chatInputRef}
      onSend={handleSend}
      onAbort={handleAbort}
      onSteer={sessionBusy ? handleSteer : undefined}
      onFollowUp={sessionBusy ? handleFollowUp : undefined}
      onPromptWithStreamingBehavior={sessionBusy ? handlePromptWithStreamingBehavior : undefined}
      isStreaming={sessionBusy}
      model={displayModelValue}
      isAutoModelSelection={isAutoModelSelection}
      modelNames={modelNames}
      modelList={modelList}
      sessionTokens={sessionContextUsage?.tokens ?? null}
      modelAuthConfigured={modelAuthConfigured}
      onModelChange={handleModelChange}
      onCompact={session || isNew ? handleCompact : undefined}
      onAbortCompaction={handleAbortCompaction}
      isCompacting={isCompacting}
      compactError={compactError}
      compactResult={compactResult}
      thinkingLevel={thinkingLevel}
      thinkingReady={thinkingReady}
      defaultThinkingLevel={defaultThinkingLevel}
      onThinkingLevelChange={session || isNew ? handleThinkingLevelChange : undefined}
      availableThinkingLevels={availableThinkingLevels}
      thinkingLevelMap={currentThinkingLevelMap}
      thinkingLevelMaps={modelThinkingLevelMaps}
      retryInfo={retryInfo}
      queuedMessages={queuedMessages}
      onRecallQueue={handleRecallQueue}
      onSendQueueAsSteer={handleSendQueueAsSteer}
      slashCommands={slashCommands}
      slashCommandsLoading={slashCommandsLoading}
      onLoadSlashCommands={loadSlashCommands}
      onBuiltinCommand={handleBuiltinSlashCommand}
      soundEnabled={soundEnabled}
      onSoundToggle={onSoundToggle}
      footerCollapsed={footerCollapsed}
      onFooterToggle={isEmptyNew ? undefined : onFooterToggle}
      onAudioUnlock={unlockAudio}
      draftKey={session?.id ?? (effectiveNewSessionCwd ? `new:${effectiveNewSessionCwd}` : undefined)}
      cwd={session?.cwd ?? effectiveNewSessionCwd}
      blocked={Boolean(extensionDialog)}
    />
      )}
    </>
  );

  // TodoPanel 是 rpiv-todo 快照的内置镜像（无扩展 widget 时兜底展示）；
  // 扩展已提供 todo 类 widget（如 rpiv-todos 任务清单）时隐藏，避免同一列表双份渲染。
  const hasTodoWidget = extensionWidgets.some((widget) => /todo/i.test(widget.key));
  const todoPanelElement = todos.length === 0 || hasTodoWidget ? null : (
    <div
      style={{
        flexShrink: 0,
        padding: `0 ${isMobile ? CHAT_INPUT_SIDE_PADDING_MOBILE : CHAT_INPUT_SIDE_PADDING}px`,
      }}
    >
      <div style={{ maxWidth: CHAT_COLUMN_MAX_WIDTH, margin: "0 auto" }}>
        <TodoPanel
          todos={todos}
          collapsed={todosCollapsed}
          onToggle={() => setTodosCollapsed((value) => !value)}
        />
      </div>
    </div>
  );

  const aboveEditorWidgets = extensionWidgets.filter((widget) => widget.placement !== "belowEditor");
  const belowEditorWidgets = extensionWidgets.filter((widget) => widget.placement === "belowEditor");
  const persistedActivities = messages.flatMap((message, index) => {
    if (message.role !== "custom" || message.customType !== "pidance.activity" || !message.details) return [];
    const activity = message.details as SessionActivity;
    if (activity.version !== 1 || typeof activity.title !== "string" || typeof activity.content !== "string") return [];
    return [{ key: entryIds[index] ?? `${activity.requestId ?? "activity"}-${index}`, activity, timestamp: message.timestamp }];
  });
  // notify 写盘成功后先使用 hook 的页内增量投影；agent_end 重载把同 requestId
  // 带回 messages 后自动去重。这样详情入口即时可用，又不为一条 activity 全量重载。
  const persistedRequestIds = new Set(persistedActivities.map((item) => item.activity.requestId).filter(Boolean));
  const visibleActivities = [
    ...persistedActivities,
    ...liveNoticeActivities
      .filter((item) => !item.activity.requestId || !persistedRequestIds.has(item.activity.requestId))
      .map((item) => ({ key: `live-${item.activity.requestId ?? item.timestamp}`, ...item })),
  ];

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-text-muted">
        {t("chat_loadingSession")}
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-full items-center justify-center text-[var(--error-text)]">
        {error}
      </div>
    );
  }

  return (
    // data-chat-entry-ids：回放验收用（#26 D2），跨视口比对 entryId 投影与顺序。
    <div
      data-pidance-chat="true"
      data-chat-message-count={messages.length}
      data-chat-entry-count={entryIds.length}
      data-chat-entry-ids={entryIds.join(",")}
      className="relative flex h-full min-h-0 flex-col overflow-hidden"
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* 图片查看器：全屏遮罩，只在组件根挂载一次（它自带 portal 到 body，
          与输入区/移动端分支无关）。 */}
      <ImagePreviewOverlay />
      {isDragOver && !writesDisabled && (
        <div className="pointer-events-none absolute inset-0 z-50 flex animate-[drop-zone-in_0.15s_ease_both] items-center justify-center bg-[color-mix(in_srgb,var(--accent)_6%,transparent)] backdrop-blur-[1px]">
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            {[0, 0.8, 1.6].map((delay) => (
              <div
                key={delay}
                className="absolute h-[720px] w-[720px] rounded-full border-[1.5px] border-solid border-[color-mix(in_srgb,var(--accent)_50%,transparent)] animate-[drop-ripple_2.4s_ease-out_infinite_backwards]"
                style={{ transformOrigin: "center", animationDelay: `${delay}s` }}
              />
            ))}
          </div>
          <svg
            width="280" height="280" viewBox="0 0 140 140" fill="none" xmlns="http://www.w3.org/2000/svg"
            style={{ filter: "drop-shadow(0 6px 18px color-mix(in srgb, var(--accent) 18%, transparent))" }}
          >
            <rect x="28" y="44" width="84" height="60" rx="8" fill="color-mix(in srgb, var(--accent) 8%, transparent)" stroke="color-mix(in srgb, var(--accent) 50%, transparent)" strokeWidth="1.8"/>
            <path d="M36 100 L54 72 L68 88 L80 74 L104 100Z" fill="color-mix(in srgb, var(--accent) 16%, transparent)" stroke="color-mix(in srgb, var(--accent) 40%, transparent)" strokeWidth="1.4" strokeLinejoin="round"/>
            <circle cx="96" cy="58" r="8" fill="color-mix(in srgb, var(--accent) 22%, transparent)" stroke="color-mix(in srgb, var(--accent) 55%, transparent)" strokeWidth="1.6"/>
            <g stroke="color-mix(in srgb, var(--accent) 45%, transparent)" strokeWidth="1.4" strokeLinecap="round">
              <line x1="96" y1="46" x2="96" y2="43"/>
              <line x1="96" y1="70" x2="96" y2="73"/>
              <line x1="84" y1="58" x2="81" y2="58"/>
              <line x1="108" y1="58" x2="111" y2="58"/>
              <line x1="87.5" y1="49.5" x2="85.4" y2="47.4"/>
              <line x1="104.5" y1="66.5" x2="106.6" y2="68.6"/>
              <line x1="104.5" y1="49.5" x2="106.6" y2="47.4"/>
              <line x1="87.5" y1="66.5" x2="85.4" y2="68.6"/>
            </g>
          </svg>
        </div>
      )}

      {extensionCustomUi && (
        <ExtensionCustomPanel
          request={extensionCustomUi}
          onInput={sendExtensionCustomInput}
        />
      )}

      {isEmptyNew ? (
        <div className="flex flex-1 flex-col items-center justify-center overflow-y-auto px-4 py-8">
          <div className="w-full max-w-[760px]">
            <div
              className="mb-3"
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                marginLeft: 16,
                marginRight: 52,
                fontFamily: "var(--font-mono)",
              }}
            >
              <div style={{ display: "flex", alignItems: "baseline", gap: 10, minWidth: 0, flex: 1, lineHeight: 1.4, overflow: "hidden" }}>
                <span style={{ fontSize: 28, fontWeight: 700, letterSpacing: 0, color: "var(--text)", flexShrink: 0, whiteSpace: "nowrap" }}>π</span>
                <span style={{ fontSize: 22, color: "var(--text)", fontWeight: 700, letterSpacing: 0, flexShrink: 0, whiteSpace: "nowrap" }}>Pidance</span>
              </div>
            </div>
            <NoticeShelf notices={notices} activities={visibleActivities} onDismiss={dismissNotice} onTogglePin={toggleNoticePin} align="right" />

            <div className="mb-4">
              <NewSessionGuide
                // 传实际创建目录（draft 为空时回落 intent cwd）：下拉显示的目标必须
                // 等于新会话真正落在的目录，不因未手动选择而显示空态。
                targetCwd={effectiveNewSessionCwd}
                onTargetChange={handleDraftTargetChange}
              />
            </div>
            {todoPanelElement}
            {chatInputElement}
          </div>
        </div>
      ) : (
      <>
      <div className="relative flex min-h-0 flex-1 overflow-hidden">
        <div
          style={{
            position: "absolute",
            top: 12,
            left: isMobile ? 0 : CHAT_GUTTER,
            right: isMobile ? 0 : CHAT_GUTTER,
            zIndex: 40,
            pointerEvents: "none",
          }}
        >
          <div style={{ maxWidth: CHAT_COLUMN_MAX_WIDTH, margin: "0 auto" }}>
            <NoticeShelf notices={notices} activities={visibleActivities} onDismiss={dismissNotice} onTogglePin={toggleNoticePin} floating align="right" />
          </div>
        </div>
        {/* 左侧用户消息导航条：绝对定位覆盖层，不参与布局——会话列宽度只由
            scroller 的内边距决定，短会话（无节点）也不会因此变宽。 */}
        {isMobile ? null : (
          <div
            style={{
              position: "absolute",
              top: 0,
              bottom: 0,
              left: 0,
              width: CHAT_GUTTER,
              zIndex: 30,
            }}
          >
            <MessageNavRail
              // 渲染批次标识：只在消息/已加载条数变化时重建导航条的元素缓存
              renderKey={`${messages.length}|${entryIds.length}`}
              scrollContainer={scrollContainerRef}
              outline={userOutline}
              entryIds={entryIds}
              resolveMessageElementRef={resolveMessageElementRef}
              expandRenderWindowToEntryRef={expandRenderWindowToEntryRef}
              jumpToEntry={jumpToEntry}
              isAtLiveTail={!hasMoreAfter}
            />
          </div>
        )}
        <div
          ref={scrollContainerRef}
          data-chat-scroller="true"
          className="min-h-0 flex-1 overflow-y-auto py-4 [scrollbar-width:none]"
          // overflow-anchor:none：钉底由自动跟随显式负责，浏览器不再自行锚定；
          // 内嵌消息块滚到边界后允许滚轮/触屏继续传给会话容器。
          // 左右内边距与输入栏同口径（两侧各让出 18px 竖条 / 移动端 16px），
          // 保证消息列、输入栏、扩展面板三者同宽同中心线。
          style={{
            overflowAnchor: "none",
            overscrollBehavior: "auto",
            padding: `0 ${isMobile ? CHAT_INPUT_SIDE_PADDING_MOBILE : CHAT_INPUT_SIDE_PADDING}px`,
          }}
        >
          <div style={{ maxWidth: CHAT_COLUMN_MAX_WIDTH, margin: "0 auto" }}>
            {/* 状态条与 aboveEditor widget 已移至输入区（对齐 TUI footer/editor 布局） */}

            {(() => {
              const toolResultsMap = new Map<string, ToolResultMessage>();
              for (const msg of messages) {
                if (msg.role === "toolResult") {
                  toolResultsMap.set((msg as ToolResultMessage).toolCallId, msg as ToolResultMessage);
                }
              }

              const visibleRefIndexByMessage = new Map<number, number>();
              let refIdx = 0;
              messages.forEach((msg, idx) => {
                if (msg.role === "user" || msg.role === "assistant") {
                  visibleRefIndexByMessage.set(idx, refIdx++);
                }
              });

              const attachVisibleRef = (idx: number, refIndex: number) => (el: HTMLDivElement | null) => {
                messageRefs.current[refIndex] = el;
              };

              // 供导航条跳转使用：按 entryId 找已渲染的消息元素。
              resolveMessageElementRef.current = (entryId: string) => {
                const index = entryIds.indexOf(entryId);
                if (index < 0) return null;
                const refIndex = visibleRefIndexByMessage.get(index);
                return refIndex === undefined ? null : (messageRefs.current[refIndex] ?? null);
              };

              const renderMessage = (item: ChatRenderItem): ReactNode => {
                const isLive = item.source === "live";
                const idx = isLive ? -1 : (item.messageIndex as number);
                const msg = item.messageOverride ?? messages[idx];
                const isVisible = msg.role === "user" || msg.role === "assistant";
                const currentRefIdx = isLive ? undefined : visibleRefIndexByMessage.get(idx);
                // 稳定身份：prepend 更旧历史后下标会整体平移，用记录 key 才能让
                // 已有 MessageView 保持挂载（折叠态、选区、局部状态不被重置）。
                const stableKey = isLive ? "live" : (messageKeys[idx] ?? `idx:${idx}`);
                const view = (
                  <MessageView
                    key={`${item.keyPrefix}-view-${stableKey}`}
                    message={msg}
                    toolResults={toolResultsMap}
                    toolExecutionSnapshots={toolExecutionSnapshots}
                    modelNames={modelNames}
                    cwd={messageCwd}
                    onOpenFile={onOpenFile}
                    isStreaming={isLive}
                    toolsActive={sessionBusy}
                    entryId={isLive ? undefined : entryIds[idx]}
                    // 只读/忙碌：分支写入口一律不下发（hook 侧另有 guard）；
                    // live 项无 entryId、不参与分支 action。
                    onBranchHere={!isLive && !sessionBusy && !isNew && !writesDisabled ? handleBranchHere : undefined}
                    onNewSessionFromHere={!isLive && !sessionBusy && !isNew && !writesDisabled ? handleNewSessionFromHere : undefined}
                    onBranchFromAssistant={!isLive && !sessionBusy && !isNew && !writesDisabled ? handleBranchFromAssistant : undefined}
                    onNewSessionFromAnswer={!isLive && !sessionBusy && !isNew && !writesDisabled ? handleNewSessionFromAnswer : undefined}
                    forking={!isLive && forkingEntryId === entryIds[idx]}
                    showTimestamp={item.showTimestamp}
                    prevTimestamp={!isLive && idx > 0 ? (messages[idx - 1] as AgentMessage & { timestamp?: number }).timestamp : undefined}
                    sessionId={session?.id ?? sessionIdRef.current ?? undefined}
                    contextUsage={sessionContextUsage}
                    onCompactContext={!isLive && !sessionBusy && !writesDisabled ? handleCompact : undefined}
                  />
                );
                const anchorId = isLive || !entryIds[idx] ? undefined : `${item.keyPrefix}:${entryIds[idx]}`;
                if (!anchorId && (!isVisible || !item.attachRef || currentRefIdx === undefined)) return view;
                return (
                  <div
                    key={`${item.keyPrefix}-${stableKey}`}
                    ref={isVisible && item.attachRef && currentRefIdx !== undefined ? attachVisibleRef(idx, currentRefIdx) : undefined}
                    data-message-entry-id={!isLive && item.attachRef ? entryIds[idx] : undefined}
                    data-chat-anchor={anchorId}
                  >
                    {view}
                  </div>
                );
              };

              const rendered: ReactNode[] = [];
              /** 计划项下标 → 该计划项对应的消息下标（供渲染窗口撑开精确定位） */
              const messageIndexByPlanIndex = new Map<number, number>();
              const plan = chatPlan;
              const lastProcessUserIdx = [...plan].reverse().find((entry) => entry.kind === "processGroup")?.userIdx;
              for (const item of plan) {
                if (item.kind === "message") {
                  const messageIndex = (item as { messageIndex?: number | null }).messageIndex;
                  if (typeof messageIndex === "number") {
                    messageIndexByPlanIndex.set(rendered.length, messageIndex);
                  }
                  rendered.push(renderMessage(item));
                  continue;
                }
                if (item.attachRefMessageIndex !== undefined) {
                  messageIndexByPlanIndex.set(rendered.length, item.attachRefMessageIndex);
                }
                const processRefIdx = item.attachRefMessageIndex === undefined ? undefined : visibleRefIndexByMessage.get(item.attachRefMessageIndex);
                const processGroup = (
                    <ProcessDetailsGroup
                      t={t}
                      messageCount={item.messageCount}
                      toolCallCount={item.toolCallCount}
                      eager={item.userIdx === lastProcessUserIdx}
                    >
                      {item.children.map((child) => renderMessage(child))}
                    </ProcessDetailsGroup>
                  );
                  rendered.push(
                    <div
                      key={`process-group-${messageKeys[item.userIdx] ?? `u:${item.userIdx}`}-${messageKeys[item.finalAssistantIdx] ?? `a:${item.finalAssistantIdx}`}`}
                      ref={processRefIdx === undefined ? undefined : (el) => { messageRefs.current[processRefIdx] = el; }}
                    >
                      {processGroup}
                    </div>,
                  );
              }
              const startIndex = planStartIndex;
              // 渲染窗口（只渲染末尾 visibleCount 条计划项）是否覆盖目标 entry：
              // 目标可能已加载但落在窗口外，导航条跳转前需要先把窗口撑开到覆盖它。
              expandRenderWindowToEntryRef.current = (entryId: string) => {
                const targetIndex = entryIds.indexOf(entryId);
                if (targetIndex < 0) return false;
                const planIndex = [...messageIndexByPlanIndex.entries()]
                  .find(([, messageIndex]) => messageIndex === targetIndex)?.[0];
                if (planIndex === undefined || planIndex >= startIndex) return false;
                // 渲染窗口是「末尾 visibleCount 条计划项」：撑开到覆盖目标计划项
                setVisibleCount(rendered.length - planIndex);
                return true;
              };
              // 服务端仍有更旧时也要挂哨兵，否则本地渲染到头后无法再触发上滚加载。
              const showSentinel = shouldShowHistorySentinel(localHasMore, hasMoreBefore);
              return (
                <>
                  {showSentinel && (
                    <div ref={sentinelRef} className="py-3 text-center text-xs text-text-muted">
                      {historyLoading
                        ? t("chat_loadingSession")
                        : t("chat_loadEarlier", { count: localHasMore ? startIndex : VISIBLE_PAGE_SIZE })}
                    </div>
                  )}
                  {rendered.slice(startIndex)}
                </>
              );
            })()}

            {agentRunning && !streamState.streamingMessage && (
              <div className="flex items-center gap-2 py-2 text-[13px] text-text-muted">
                <span className="size-1.5 rounded-full bg-status-running" aria-hidden="true" />
                <span>{phaseLabel(agentPhase, t)}</span>
              </div>
            )}

            {bashRunning && !pendingBash && (
              <div className="flex items-center gap-2 py-2 text-[13px] text-text-muted">
                <span className="size-1.5 rounded-full bg-status-running" aria-hidden="true" />
                <span>{t("chat_runningCommand")}...</span>
              </div>
            )}

            {/* 按 entryId 定位到历史后，窗口后面可能还有更新的历史：底部哨兵继续向下加载
                （否则「定位到中间」会丢掉访问后续历史的路径）。 */}
            {hasMoreAfter && (
              <div className="py-3 text-center">
                <button
                  type="button"
                  onClick={() => void loadNewerHistory()}
                  disabled={historyLoading}
                  style={{
                    border: "1px solid var(--border)",
                    borderRadius: 6,
                    background: "var(--bg-panel)",
                    color: "var(--text-muted)",
                    cursor: historyLoading ? "default" : "pointer",
                    fontSize: 12,
                    padding: "4px 10px",
                  }}
                >
                  {historyLoading ? t("chat_loadingSession") : t("chat_loadNewer")}
                </button>
              </div>
            )}

            {pendingBash && (
              <MessageView
                message={{
                  role: "bashExecution",
                  command: pendingBash.command,
                  output: "",
                  excludeFromContext: pendingBash.excludeFromContext,
                  // 服务端记录的 bash 开始时间：刷新恢复后实时显示执行时长
                  timestamp: pendingBash.startedAt,
                } as BashExecutionMessage}
                sessionId={session?.id ?? sessionIdRef.current ?? undefined}
              />
            )}

            {/* 扩展阻塞请求由输入区上方的阻塞面板承载，不插入消息时间线。 */}

            {/* OpenChamber 风格底部常驻 spacer（桌面 10vh / 移动 40px）：给末端留呼吸感，
                取代旧的 agentRunning 整视口占位——跟随钉底由 useAgentSession 的自动跟随负责。 */}
            <div aria-hidden="true" style={{ height: isMobile ? 40 : "10vh" }} />
          </div>
        </div>
        {/* 回到底部：仅 released 且不在末端区域时可见（样式与动效在 globals.css，
            150ms 淡入/位移/缩放，prefers-reduced-motion 时禁用位移）。 */}
        <button
          type="button"
          className={`chat-jump-bottom${jumpButtonVisible ? " is-visible" : ""}`}
          aria-label={t("chat_backToBottom")}
          aria-hidden={!jumpButtonVisible}
          tabIndex={jumpButtonVisible ? 0 : -1}
          onClick={jumpToBottom}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </button>
        {/* 右侧消息概览条：同为覆盖层（不参与布局），宽度不影响消息列。 */}
        {isMobile ? null : (
          <div
            style={{
              position: "absolute",
              top: 0,
              bottom: 0,
              right: 0,
              width: CHAT_GUTTER,
              zIndex: 30,
            }}
          >
            <ChatMinimap
              messages={messages}
              plan={chatPlan}
              scrollContainer={scrollContainerRef}
              messageRefs={messageRefs}
            />
          </div>
        )}
      </div>

      <div className="relative">
        {/* aboveEditor widget（对齐 TUI：紧贴输入框上方） */}
        <div
          style={{
            padding: `0 ${isMobile ? CHAT_INPUT_SIDE_PADDING_MOBILE : CHAT_INPUT_SIDE_PADDING}px`,
          }}
        >
          <div style={{ maxWidth: CHAT_COLUMN_MAX_WIDTH, margin: "0 auto" }}>
            <ExtensionWidgets widgets={aboveEditorWidgets} />
          </div>
        </div>
        {todoPanelElement}
        {isCompacting && (
          <div
            role="status"
            aria-live="polite"
            style={{
              display: "flex",
              alignItems: "center",
              gap: 7,
              padding: "4px 16px 6px",
              color: "var(--text-muted)",
              fontSize: 12,
            }}
          >
            <span className="size-1.5 rounded-full bg-status-running" aria-hidden="true" />
            <span>{t("input_compacting")}</span>
          </div>
        )}
        {chatInputElement}
        {/* belowEditor widget + footer 状态条（对齐 TUI：输入框下方）；面板打开时与输入栏一起让位 */}
        {!extensionDialog && (
          <div
            style={{
              padding: `0 ${isMobile ? CHAT_INPUT_SIDE_PADDING_MOBILE : CHAT_INPUT_SIDE_PADDING}px`,
            }}
          >
            <div style={{ maxWidth: CHAT_COLUMN_MAX_WIDTH, margin: "0 auto" }}>
              {!footerCollapsed && (
                <>
                  <ExtensionWidgets widgets={belowEditorWidgets} />
                  <ExtensionStatusBar statuses={extensionStatuses} />
                </>
              )}
            </div>
          </div>
        )}
      </div>
      </>
      )}
    </div>
  );
}

/**
 * 只读会话的紧凑提示条，整体替代编辑器：说明这是什么会话、能做什么、
 * 什么被关掉。文案保持具体直白，与现有英文界面一致。
 */
function LockedSessionBar({ isMobile }: { isMobile: boolean }) {
  const { t } = useI18n();
  return (
    <div style={{ flexShrink: 0, padding: `0 ${isMobile ? 16 : CHAT_INPUT_SIDE_PADDING}px 8px` }}>
      <div style={{ maxWidth: CHAT_COLUMN_MAX_WIDTH, margin: "0 auto" }}>
        <div
          role="status"
          aria-label={t("chat_sessionWriteLocked")}
          style={{
            display: "flex",
            alignItems: "flex-start",
            gap: 8,
            border: "1px solid var(--border)",
            borderRadius: 10,
            background: "var(--bg-panel)",
            padding: "8px 12px",
            fontSize: 12,
            lineHeight: 1.5,
            color: "var(--text-muted)",
          }}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, marginTop: 2, color: "var(--text-dim)" }} aria-hidden="true">
            <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
            <path d="M7 11V7a5 5 0 0 1 10 0v4" />
          </svg>
          <span style={{ minWidth: 0 }}>
            <span style={{ color: "var(--text)", fontWeight: 600 }}>{t("chat_sessionWriteLocked")}</span>
            {`. ${t("chat_sessionWriteLockedDescription")}`}
          </span>
        </div>
      </div>
    </div>
  );
}

function ReadOnlySessionBar({ session, isMobile }: { session: SessionInfo; isMobile: boolean }) {
  const { t } = useI18n();
  const sub = session.subagent;
  const identity = sub
    ? `${sub.agent ? t("chat_agentNamed", { name: sub.agent }) : t("chat_subagent")} · ${t("chat_subagentRun", { count: sub.runIndex })}`
    : null;
  return (
    // 与 ChatInput 相同的外边距节奏（桌面端两侧让出 18px 竖条）。
    <div style={{ flexShrink: 0, padding: `0 ${isMobile ? 16 : CHAT_INPUT_SIDE_PADDING}px 8px` }}>
      <div style={{ maxWidth: CHAT_COLUMN_MAX_WIDTH, margin: "0 auto" }}>
        <div
          role="note"
          aria-label={t("chat_readOnlySession")}
          style={{
            display: "flex",
            alignItems: "flex-start",
            gap: 8,
            border: "1px solid var(--border)",
            borderRadius: 10,
            background: "var(--bg-panel)",
            padding: "8px 12px",
            fontSize: 12,
            lineHeight: 1.5,
            color: "var(--text-muted)",
          }}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, marginTop: 2, color: "var(--text-dim)" }} aria-hidden="true">
            <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
            <path d="M7 11V7a5 5 0 0 1 10 0v4" />
          </svg>
          <span style={{ minWidth: 0 }}>
            <span style={{ color: "var(--text)", fontWeight: 600 }}>{t("chat_readOnlySession")}</span>
            {identity ? ` — ${identity}` : ` — ${t("chat_subagentSessionFallback")}`}
            {`. ${t("chat_readOnlySessionDescription")}`}
          </span>
        </div>
      </div>
    </div>
  );
}

function ExtensionStatusBar({ statuses }: { statuses: Array<{ key: string; text: string }> }) {
  if (statuses.length === 0) return null;
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 10 }}>
      {statuses.map((status) => (
        <div
          key={status.key}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            maxWidth: "100%",
            padding: "4px 8px",
            border: "1px solid color-mix(in srgb, var(--accent) 24%, var(--border))",
            borderRadius: 6,
            background: "color-mix(in srgb, var(--accent) 7%, var(--bg))",
            color: "var(--text-muted)",
            fontSize: 12,
          }}
        >
          <span style={{ color: "var(--accent)", fontFamily: "var(--font-mono)", fontSize: 11 }}>{status.key}</span>
          <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {renderAnsiLine(status.text, `status-${status.key}`)}
          </span>
        </div>
      ))}
    </div>
  );
}

function ExtensionWidgets({ widgets }: { widgets: Array<{ key: string; lines: string[] }> }) {
  const { t } = useI18n();
  // 内容限高内滚：超长 widget（如统计表）否则会把输入区整块顶出可视区
  const bodyMaxHeight = useIsMobile() ? CHAT_BLOCK_MAX_HEIGHT_MOBILE : CHAT_BLOCK_MAX_HEIGHT;
  // 折叠状态按 widget key 记忆（localStorage，跨会话/刷新）；默认展开。
  const [collapsedKeys, setCollapsedKeys] = useState<Set<string>>(() => loadCollapsedWidgetKeys());

  const toggleCollapse = useCallback((key: string) => {
    setCollapsedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      saveCollapsedWidgetKeys(next);
      return next;
    });
  }, []);

  if (widgets.length === 0) return null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 10 }}>
      {widgets.map((widget) => {
        const collapsed = collapsedKeys.has(widget.key);
        return (
          <div
            key={widget.key}
            style={{
              border: "1px solid var(--border)",
              borderRadius: 7,
              background: "var(--bg-panel)",
              overflow: "hidden",
            }}
          >
            <button
              type="button"
              onClick={() => toggleCollapse(widget.key)}
              aria-expanded={!collapsed}
              aria-label={collapsed ? t("extension_widgetExpand", { name: widget.key }) : t("extension_widgetCollapse", { name: widget.key })}
              title={collapsed ? t("extension_widgetExpand", { name: widget.key }) : t("extension_widgetCollapse", { name: widget.key })}
              style={{
                display: "flex",
                width: "100%",
                minHeight: 36,
                alignItems: "center",
                gap: 8,
                padding: "8px 12px",
                border: "none",
                borderBottom: collapsed ? "none" : "1px solid var(--border)",
                background: "transparent",
                color: "var(--text)",
                fontSize: 13,
                fontFamily: "inherit",
                cursor: "pointer",
                textAlign: "left",
              }}
            >
              <svg
                width="10"
                height="10"
                viewBox="0 0 12 12"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
                style={{ flexShrink: 0, transform: collapsed ? "none" : "rotate(90deg)", transition: "transform 0.15s ease" }}
              >
                <polyline points="4 2.5 7.5 6 4 9.5" />
              </svg>
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{widget.key}</span>
            </button>
            {!collapsed && (
              <pre style={{ margin: 0, padding: "8px 9px", color: "var(--text-muted)", fontSize: 12, lineHeight: 1.5, whiteSpace: "pre-wrap", wordBreak: "break-word", fontFamily: "var(--font-mono)", maxHeight: bodyMaxHeight, overflow: "auto", overscrollBehavior: "auto", touchAction: "pan-y" }}>
                {(Array.isArray(widget.lines) ? widget.lines : []).map((line, index, lines) => (
                  <Fragment key={index}>
                    {renderAnsiLine(line, `widget-${widget.key}-line-${index}`)}
                    {index < lines.length - 1 ? "\n" : null}
                  </Fragment>
                ))}
              </pre>
            )}
          </div>
        );
      })}
    </div>
  );
}

const COLLAPSED_WIDGET_KEYS_STORAGE = "pidance.collapsedWidgetKeys.v1";

function loadCollapsedWidgetKeys(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(COLLAPSED_WIDGET_KEYS_STORAGE);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    if (Array.isArray(parsed)) {
      return new Set(parsed.filter((item): item is string => typeof item === "string"));
    }
  } catch {
    /* 损坏忽略 */
  }
  return new Set();
}

function saveCollapsedWidgetKeys(keys: Set<string>): void {
  try {
    window.localStorage.setItem(COLLAPSED_WIDGET_KEYS_STORAGE, JSON.stringify([...keys]));
  } catch {
    /* 隐私模式忽略 */
  }
}

type PersistedActivityItem = { key: string; activity: SessionActivity; timestamp?: number };

function NoticeIconButton({ label, active = false, onClick, children }: { label: string; active?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" aria-label={label} title={label} onClick={onClick} style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 28, height: 28, padding: 0, flexShrink: 0, border: "none", borderRadius: 7, background: active ? "var(--bg-selected)" : "transparent", color: active ? "var(--text)" : "var(--text-dim)", cursor: "pointer" }}>
      {children}
    </button>
  );
}

function noticeAccentColor(type: NoticeItem["type"]): string {
  switch (type) {
    case "error":
      return "var(--error-text)";
    case "warning":
      return "var(--warning)";
    case "success":
      return "var(--success)";
    default:
      return "var(--accent)";
  }
}

function noticeTypeLabelKey(type: NoticeItem["type"]): "notice_error" | "notice_warning" | "notice_success" | "notice_info" {
  switch (type) {
    case "error":
      return "notice_error";
    case "warning":
      return "notice_warning";
    case "success":
      return "notice_success";
    default:
      return "notice_info";
  }
}

function NoticeShelf({ notices, activities, onDismiss, onTogglePin, floating = false, align = "left" }: {
  notices: NoticeItem[];
  activities: PersistedActivityItem[];
  onDismiss: (id: string) => void;
  onTogglePin: (id: string) => void;
  floating?: boolean;
  align?: "left" | "right";
}) {
  const { t } = useI18n();
  const [historyOpen, setHistoryOpen] = useState(false);
  const [selectedRequestId, setSelectedRequestId] = useState<string | null>(null);
  // 默认折叠：仅记录展开的 id；不在 state 中的视为折叠（逻辑层未改）
  const [expandedIds, setExpandedIds] = useState<Record<string, boolean>>({});
  const [copiedId, setCopiedId] = useState<string | null>(null);

  if (notices.length === 0 && activities.length === 0) return null;
  const orderedNotices = [...notices].sort((a, b) => Number(b.pinned) - Number(a.pinned));
  const visibleActivities = selectedRequestId ? activities.filter((item) => item.activity.requestId === selectedRequestId) : activities;

  const toggleExpanded = (id: string) => {
    setExpandedIds((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const copyNotice = async (notice: NoticeItem) => {
    try {
      await navigator.clipboard.writeText(notice.message);
      setCopiedId(notice.id);
      window.setTimeout(() => {
        setCopiedId((current) => (current === notice.id ? null : current));
      }, 1200);
    } catch {
      // 剪贴板不可用时静默失败，不改 notice 逻辑
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: align === "right" ? "flex-end" : "stretch", gap: 7, width: "100%", marginBottom: floating ? 0 : 10, pointerEvents: "auto" }}>
      {activities.length > 0 && (
        <button type="button" onClick={() => { setSelectedRequestId(null); setHistoryOpen((open) => !open); }} aria-expanded={historyOpen} style={{ display: "flex", alignItems: "center", gap: 7, padding: "5px 9px", border: "1px solid var(--border)", borderRadius: 10, background: "var(--bg-panel)", color: "var(--text-muted)", cursor: "pointer", fontSize: 11 }}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v6h6"/><path d="M12 7v5l3 2"/></svg>
          {t("notice_activityHistory", { count: activities.length })}
        </button>
      )}
      {historyOpen && (
        <section aria-label={t("notice_activityHistoryTitle")} style={{ width: "min(100%, 620px)", maxHeight: 360, overflow: "auto", border: "1px solid var(--border)", borderRadius: 12, background: "var(--bg)", boxShadow: "0 16px 40px color-mix(in srgb, var(--text) 14%, transparent)" }}>
          <div style={{ position: "sticky", top: 0, zIndex: 1, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, padding: "9px 10px 9px 12px", borderBottom: "1px solid var(--border)", background: "var(--bg-panel)" }}>
            <div>
              <div style={{ color: "var(--text)", fontSize: 12, fontWeight: 650 }}>{t("notice_activityHistoryTitle")}</div>
              <div style={{ color: "var(--text-dim)", fontSize: 10 }}>{t("notice_activityHistoryDescription")}</div>
            </div>
            <NoticeIconButton label={t("notice_close")} onClick={() => setHistoryOpen(false)}><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg></NoticeIconButton>
          </div>
          {visibleActivities.length > 0 ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: 10 }}>
              {[...visibleActivities].reverse().map(({ key, activity, timestamp }) => (
                <article key={key} style={{ border: "1px solid var(--border)", borderLeft: `3px solid ${activity.kind === "warning" || activity.kind === "error" ? "var(--warning)" : "var(--accent)"}`, borderRadius: 10, background: "var(--bg-panel)", padding: "9px 10px" }}>
                  <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 5 }}>
                    <span style={{ color: "var(--text)", fontSize: 12, fontWeight: 650 }}>{activity.title}</span>
                    {timestamp ? <time style={{ marginLeft: "auto", color: "var(--text-dim)", fontSize: 10 }}>{new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time> : null}
                  </div>
                  <div style={{ color: "var(--text-muted)", fontSize: 12, lineHeight: 1.55, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{activity.content}</div>
                </article>
              ))}
            </div>
          ) : <div style={{ padding: 16, color: "var(--text-muted)", fontSize: 12 }}>{t("notice_activityPending")}</div>}
        </section>
      )}
      {orderedNotices.map((notice) => {
        const important = notice.tier === "important";
        const color = noticeAccentColor(notice.type);
        const expanded = expandedIds[notice.id] === true;
        const typeLabel = t(noticeTypeLabelKey(notice.type));
        return (
          <div
            key={notice.id}
            className="notice-shelf-item"
            role={notice.type === "error" ? "alert" : "status"}
            style={{
              display: "flex",
              alignItems: expanded ? "flex-start" : "center",
              gap: 6,
              minHeight: expanded ? (important ? 64 : 40) : 36,
              borderRadius: 10,
              border: `1px solid color-mix(in srgb, ${color} 42%, var(--border))`,
              borderLeft: `3px solid ${color}`,
              background: `color-mix(in srgb, ${color} ${important ? 12 : 8}%, var(--bg-panel))`,
              color: "var(--text-muted)",
              width: "min(100%, 620px)",
              maxWidth: "min(100%, 620px)",
              boxShadow: floating ? "0 12px 32px color-mix(in srgb, var(--text) 13%, transparent)" : "0 8px 24px color-mix(in srgb, var(--text) 8%, transparent)",
              fontSize: important ? 13 : 12,
              lineHeight: 1.45,
              transformOrigin: "top right",
              animation: notice.exiting ? "notice-shelf-out 0.18s ease-in forwards" : "notice-shelf-in 0.18s ease-out both",
              padding: "5px 6px 5px 6px",
            }}
          >
            <NoticeIconButton
              label={expanded ? t("notice_collapse") : t("notice_expand")}
              active={expanded}
              onClick={() => toggleExpanded(notice.id)}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                {expanded
                  ? <path d="m6 9 6 6 6-6" />
                  : <path d="m9 6 6 6-6 6" />}
              </svg>
            </NoticeIconButton>
            <div style={{ minWidth: 0, flex: 1, paddingTop: expanded ? 4 : 0 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
                <span style={{ color, fontFamily: "var(--font-mono)", fontSize: 10, fontWeight: 700, letterSpacing: 0.6, textTransform: "uppercase", flexShrink: 0 }}>
                  {typeLabel}{notice.pinned ? ` · ${t("notice_pinned")}` : ""}
                </span>
                {!expanded && (
                  <span style={{ color: "var(--text-muted)", fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>
                    {notice.message.replace(/\s+/g, " ").trim()}
                  </span>
                )}
              </div>
              {expanded && (
                <>
                  <div style={{ marginTop: 4, color: important ? "var(--text)" : "var(--text-muted)", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{notice.message}</div>
                  {important && notice.activityRecord && (
                    <button
                      type="button"
                      onClick={() => { setSelectedRequestId(notice.id); setHistoryOpen(true); }}
                      style={{ marginTop: 7, padding: 0, border: "none", background: "transparent", color: "var(--accent)", cursor: "pointer", fontSize: 11, fontWeight: 600 }}
                    >
                      {t("notice_viewActivity")} →
                    </button>
                  )}
                </>
              )}
            </div>
            <NoticeIconButton
              label={copiedId === notice.id ? t("notice_copied") : t("notice_copy")}
              active={copiedId === notice.id}
              onClick={() => { void copyNotice(notice); }}
            >
              {copiedId === notice.id ? (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M20 6 9 17l-5-5" /></svg>
              ) : (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h10" /></svg>
              )}
            </NoticeIconButton>
            {important && (
              <NoticeIconButton label={notice.pinned ? t("notice_unpin") : t("notice_pin")} active={notice.pinned} onClick={() => onTogglePin(notice.id)}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill={notice.pinned ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="m15 4 5 5-4 2-3 5-2 4-1-6-6-6 4-1 5-3 2-4Z" /><path d="m4 20 5-5" /></svg>
              </NoticeIconButton>
            )}
            <NoticeIconButton label={t("notice_close")} onClick={() => onDismiss(notice.id)}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12" /></svg>
            </NoticeIconButton>
          </div>
        );
      })}
    </div>
  );
}

function renderAnsiLine(line: string, keyPrefix: string): ReactNode[] {
  return parseAnsiLine(line).map((segment, index) => (
    Object.keys(segment.style).length > 0
      ? <span key={`${keyPrefix}-${index}`} style={segment.style}>{segment.text}</span>
      : segment.text
  ));
}


