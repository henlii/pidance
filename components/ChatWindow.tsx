"use client";
import { registerAbortHandler } from "@/hooks/useKeyboardShortcuts";
import { Fragment, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { AgentMessage, BashExecutionMessage, ExtensionUiRequest, SessionInfo, SessionTreeNode, ToolResultMessage } from "@/lib/types";
import type { BranchActions } from "@/lib/branch-bookmarks";
import { normalizeCustomPanelLines, parseAnsiLine } from "@/lib/ansi";
import { asBracketedPaste, toTerminalKeyData } from "@/lib/terminal-input";
import { composeChatPlan, type ChatRenderItem } from "@/lib/chat-compositor";
import { MessageView } from "./MessageView";
import { ChatInput, type ChatInputHandle } from "./ChatInput";
import { ChatMinimap, useMessageRefs } from "./ChatMinimap";
import { ExtensionDialog } from "./ExtensionDialog";
import { NewSessionGuide } from "./NewSessionGuide";
import { TodoPanel } from "./TodoPanel";
import { useAgentSession, type AgentPhase, type NoticeItem } from "@/hooks/useAgentSession";
import { useAudio } from "@/hooks/useAudio";
import { useI18n } from "@/lib/i18n";
import { useDragDrop } from "@/hooks/useDragDrop";
import { useIsMobile } from "@/hooks/useIsMobile";
import type { SessionStatsInfo } from "@/lib/pi-types";
import type { SessionActivity } from "@/lib/session-activity";
import {
  captureScrollDistance,
  getNextVisibleCount,
  getVisibleRenderWindow,
  growVisibleCountOnAppend,
  resolveHistoryLoadAction,
  restoreScrollTop,
  shouldShowHistorySentinel,
  VISIBLE_PAGE_SIZE,
} from "@/lib/chat-lazy-load";

interface Props {
  session: SessionInfo | null;
  newSessionCwd: string | null;
  /** 新建意图 id，透传 useAgentSession 供 onSessionCreated 门禁。 */
  newSessionIntentId?: string | null;
  /** 新会话引导页默认目标项目（入口解析的 cwd；null = 回落 localStorage 上次项目） */
  guideDefaultCwd?: string | null;
  onAgentEnd?: () => void;
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
  onOpenFile?: (filePath: string) => void;
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

const CHAT_MINIMAP_WIDTH = 36;
const CHAT_COLUMN_PADDING = 16;
const CHAT_INPUT_RIGHT_PADDING = CHAT_COLUMN_PADDING + CHAT_MINIMAP_WIDTH;

// 过程详情默认持续展开（Issue #13）：外层不再默认隐藏整个 user→answer 过程；
// 用户仍可主动收起/展开，局部 thinking / tool 明细保持各自的按需折叠。
export function ProcessDetailsGroup({ messageCount, toolCallCount, children, t }: { messageCount: number; toolCallCount: number; children: ReactNode; t: ReturnType<typeof useI18n>["t"] }) {
  const [expanded, setExpanded] = useState(true);
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
      {expanded && (
        <div style={{ marginTop: 8 }}>
          {children}
        </div>
      )}
    </div>
  );
}

export function ChatWindow({ session, newSessionCwd, newSessionIntentId, guideDefaultCwd, onAgentEnd, onSessionCreated, onSessionForked, modelsRefreshKey, chatInputRef, onBranchDataChange, onSystemPromptChange, onSessionStatsChange, onSessionStatsPanelOpen, onContextUsageChange, onOpenFile }: Props) {
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
  const handleDraftTargetChange = useCallback((cwd: string | null) => {
    setDraftTargetCwd(cwd);
    try {
      if (cwd) {
        localStorage.setItem("pidance.draftTargetCwd", cwd);
      } else {
        localStorage.removeItem("pidance.draftTargetCwd");
      }
    } catch {
      // localStorage 不可用时仅内存生效
    }
  }, []);
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
    loading, historyLoading, hasMoreBefore, error, messages, entryIds, streamState,
    agentRunning, bashRunning, pendingBash, modelNames, modelList, modelAuthConfigured, modelThinkingLevels, modelThinkingLevelMaps, thinkingLevel,
    retryInfo, contextUsage, forkingEntryId,
    isCompacting, compactError, compactResult, displayModel: displayModelValue, sessionStats,
    slashCommands, slashCommandsLoading, queuedMessages,
    notices, liveNoticeActivities, dismissNotice, toggleNoticePin, extensionDialog, extensionCustomUi, extensionStatuses, extensionWidgets, respondToExtensionUi, dismissExtensionUiRequest, sendExtensionCustomInput,
    todos,
    isAutoModelSelection,
    agentPhase, toolExecutionSnapshots,
    isNew,
    sessionIdRef, scrollContainerRef,
    jumpButtonVisible, jumpToBottom, markExternalScrollWrite, notifyProgrammaticSmooth,
    loadOlderHistory,
    handleSend, handleAbort, handleModelChange,
    handleCompact, handleSteer, handleFollowUp, handlePromptWithStreamingBehavior, handleAbortCompaction,
    handleRecallQueue, handleSendQueueAsSteer,
    handleBuiltinSlashCommand,
    handleThinkingLevelChange, loadSlashCommands,
    handleBranchHere, handleBranchFromAssistant,
    handleNewSessionFromHere, handleNewSessionFromAnswer,
  } = useAgentSession({
    session, newSessionCwd: effectiveNewSessionCwd, newSessionIntentId, onAgentEnd: wrappedOnAgentEnd, onSessionCreated, onSessionForked,
    modelsRefreshKey, chatInputRef, onBranchDataChange, onSystemPromptChange, onSessionStatsPanelOpen,
    isMobile,
  });
  const sessionBusy = agentRunning || bashRunning;
  const [todosCollapsed, setTodosCollapsed] = useState(true);
  const todoCollapseScope = session?.id ?? (effectiveNewSessionCwd ? `new:${effectiveNewSessionCwd}` : "new-session");
  // Todo 展开状态只属于当前聊天视图；切换会话后恢复默认折叠。
  useEffect(() => {
    setTodosCollapsed(true);
  }, [todoCollapseScope]);

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
  // 1) 客户端 visibleCount：已加载消息内只渲染末 N 条
  // 2) 服务端 hasMoreBefore：滚到顶时 loadOlderHistory prepend 更旧页（OpenChamber 风格）
  // 3) 尾部追加时同步增大 visibleCount，避免自动跟随时 startIndex 前移卸载更早消息
  const [visibleCount, setVisibleCount] = useState(VISIBLE_PAGE_SIZE);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const prevScrollDistanceRef = useRef<number | null>(null);
  const prevPlanTotalRef = useRef<number | null>(null);
  // 会话切换时重置可见窗口与计划长度种子
  useEffect(() => {
    setVisibleCount(VISIBLE_PAGE_SIZE);
    prevPlanTotalRef.current = null;
  }, [session?.id]);

  // IntersectionObserver on the sentinel div at the top of the message list.
  // When it becomes visible, expand local window or fetch older pages from server.
  useEffect(() => {
    const sentinel = sentinelRef.current;
    const container = scrollContainerRef.current;
    if (!sentinel || !container) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries[0]?.isIntersecting) return;
        const action = resolveHistoryLoadAction({
          visibleCount,
          messagesLength: messages.length,
          hasMoreBefore,
          historyLoading,
        });
        if (action === "none") return;
        // Save distance from top before prepending to restore scroll later
        prevScrollDistanceRef.current = captureScrollDistance(container.scrollHeight, container.scrollTop);
        if (action === "expand-local") {
          setVisibleCount((prev) => getNextVisibleCount(prev));
          return;
        }
        // action === "load-server"：已到本地头，拉更旧页
        void loadOlderHistory().then((loaded) => {
          if (loaded) setVisibleCount((v) => getNextVisibleCount(v));
        });
      },
      { root: container, threshold: 0 },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [visibleCount, messages.length, scrollContainerRef, hasMoreBefore, historyLoading, loadOlderHistory]);

  // After visibleCount increases (more messages prepended), restore the
  // scroll position so the viewport doesn't jump.
  useEffect(() => {
    if (prevScrollDistanceRef.current == null) return;
    const container = scrollContainerRef.current;
    if (!container) return;
    // prepend 补偿是 auto-follow 之外的 scrollTop 写入：先标记，让随后的
    // scroll 事件不参与状态判定（用户在顶部阅读，绝不能被钉底逻辑拉走）。
    markExternalScrollWrite();
    container.scrollTop = restoreScrollTop(container.scrollHeight, prevScrollDistanceRef.current);
    prevScrollDistanceRef.current = null;
  }, [visibleCount, messages.length, scrollContainerRef, markExternalScrollWrite]);
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

  const onDrop = useCallback((files: File[]) => {
    if (sessionBusy || isReadOnly) return;
    chatInputRef?.current?.addImages(files);
  }, [sessionBusy, isReadOnly, chatInputRef]);

  const { isDragOver, handleDragEnter, handleDragOver, handleDragLeave, handleDrop } = useDragDrop(onDrop);

  const visibleMessages = messages.filter((m) => m.role === "user" || m.role === "assistant");
  const messageRefs = useMessageRefs(visibleMessages.length);

  // P3b：live streaming slot 进入统一渲染计划（compositor）——live 与磁盘消息同计划
  // 渲染，删除计划尾部的独立 MessageView；ChatMinimap 也消费同一计划。
  const liveSlot = streamState.isStreaming && streamState.streamingMessage
    ? { message: streamState.streamingMessage, isActive: true }
    : undefined;
const chatPlan = composeChatPlan({
    messages,
    isStreaming: streamState.isStreaming,
    agentOrBashRunning: sessionBusy,
    liveSlot,
  });
  // 计划变长（流式追加 / 新消息）时补齐 visibleCount，防止固定窗口把更早项卸出 DOM。
  // 切换会话时 prev 为 null，只播种不增长，保持首屏末 N 条。
  useEffect(() => {
    const nextTotal = chatPlan.length;
    const prevTotal = prevPlanTotalRef.current;
    if (prevTotal === null) {
      prevPlanTotalRef.current = nextTotal;
      return;
    }
    if (nextTotal === prevTotal) return;
    setVisibleCount((current) => growVisibleCountOnAppend(current, prevTotal, nextTotal));
    prevPlanTotalRef.current = nextTotal;
  }, [chatPlan.length]);

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
      {isReadOnly && session ? (
        <ReadOnlySessionBar session={session} isMobile={isMobile} />
      ) : (
        <ChatInput
      ref={chatInputRef}
      onSend={handleSend}
      onAbort={handleAbort}
      onSteer={agentRunning ? handleSteer : undefined}
      onFollowUp={agentRunning ? handleFollowUp : undefined}
      onPromptWithStreamingBehavior={agentRunning ? handlePromptWithStreamingBehavior : undefined}
      isStreaming={sessionBusy}
      model={displayModelValue}
      isAutoModelSelection={isAutoModelSelection}
      modelNames={modelNames}
      modelList={modelList}
      modelAuthConfigured={modelAuthConfigured}
      onModelChange={handleModelChange}
      onCompact={session || isNew ? handleCompact : undefined}
      onAbortCompaction={handleAbortCompaction}
      isCompacting={isCompacting}
      compactError={compactError}
      compactResult={compactResult}
      thinkingLevel={thinkingLevel}
      onThinkingLevelChange={session || isNew ? handleThinkingLevelChange : undefined}
      availableThinkingLevels={availableThinkingLevels}
      thinkingLevelMap={currentThinkingLevelMap}
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
      onAudioUnlock={unlockAudio}
      draftKey={session?.id ?? (effectiveNewSessionCwd ? `new:${effectiveNewSessionCwd}` : undefined)}
      cwd={session?.cwd ?? effectiveNewSessionCwd}
    />
      )}
    </>
  );

  const todoPanelElement = todos.length === 0 ? null : (
    <div
      style={{
        flexShrink: 0,
        padding: `0 ${CHAT_COLUMN_PADDING}px`,
        paddingRight: isMobile ? CHAT_COLUMN_PADDING : CHAT_INPUT_RIGHT_PADDING,
      }}
    >
      <div style={{ maxWidth: 820, margin: "0 auto" }}>
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
    <div
      className="relative flex h-full flex-col overflow-hidden"
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {isDragOver && !sessionBusy && !isReadOnly && (
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
                targetCwd={draftTargetCwd}
                onTargetChange={handleDraftTargetChange}
              />
            </div>
            {todoPanelElement}
            {chatInputElement}
          </div>
        </div>
      ) : (
      <>
      {/* 扩展阻塞请求弹窗（对齐 TUI modal；固定视口覆盖层） */}
      {extensionDialog && (
        <ExtensionDialog
          request={extensionDialog}
          disabled={isReadOnly || !sessionIdRef.current}
          onRespond={(response) => {
            void respondToExtensionUi(extensionDialog, response);
          }}
        />
      )}
      <div className="relative flex flex-1 overflow-hidden">
        <div
          style={{
            position: "absolute",
            top: 12,
            left: 0,
            right: isMobile ? 0 : CHAT_MINIMAP_WIDTH,
            zIndex: 40,
            padding: `0 ${CHAT_COLUMN_PADDING}px`,
            pointerEvents: "none",
          }}
        >
          <div style={{ maxWidth: 760, margin: "0 auto" }}>
            <NoticeShelf notices={notices} activities={visibleActivities} onDismiss={dismissNotice} onTogglePin={toggleNoticePin} floating align="right" />
          </div>
        </div>
        <div
          ref={scrollContainerRef}
          className="flex-1 overflow-y-auto pt-4 [scrollbar-width:none]"
          // overflow-anchor:none：钉底由自动跟随显式负责，浏览器不再自行锚定；
          // overscroll-behavior:contain：滚到底/顶不连锁滚动外层。
          style={{ overflowAnchor: "none", overscrollBehavior: "contain" }}
        >
          <div style={{ padding: `0 ${CHAT_COLUMN_PADDING}px` }}>
            <div style={{ maxWidth: 760, margin: "0 auto" }}>
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

              const renderMessage = (item: ChatRenderItem): ReactNode => {
                const isLive = item.source === "live";
                const idx = isLive ? -1 : (item.messageIndex as number);
                const msg = item.messageOverride ?? messages[idx];
                const isVisible = msg.role === "user" || msg.role === "assistant";
                const currentRefIdx = isLive ? undefined : visibleRefIndexByMessage.get(idx);
                const view = (
                  <MessageView
                    key={`${item.keyPrefix}-view-${idx}`}
                    message={msg}
                    toolResults={toolResultsMap}
                    toolExecutionSnapshots={toolExecutionSnapshots}
                    modelNames={modelNames}
                    cwd={messageCwd}
                    onOpenFile={onOpenFile}
                    isStreaming={isLive}
                    entryId={isLive ? undefined : entryIds[idx]}
                    // 只读/忙碌：分支写入口一律不下发（hook 侧另有 guard）；
                    // live 项无 entryId、不参与分支 action。
                    onBranchHere={!isLive && !sessionBusy && !isNew && !isReadOnly ? handleBranchHere : undefined}
                    onNewSessionFromHere={!isLive && !sessionBusy && !isNew && !isReadOnly ? handleNewSessionFromHere : undefined}
                    onBranchFromAssistant={!isLive && !sessionBusy && !isNew && !isReadOnly ? handleBranchFromAssistant : undefined}
                    onNewSessionFromAnswer={!isLive && !sessionBusy && !isNew && !isReadOnly ? handleNewSessionFromAnswer : undefined}
                    forking={!isLive && forkingEntryId === entryIds[idx]}
                    showTimestamp={item.showTimestamp}
                    prevTimestamp={!isLive && idx > 0 ? (messages[idx - 1] as AgentMessage & { timestamp?: number }).timestamp : undefined}
                    sessionId={session?.id ?? sessionIdRef.current ?? undefined}
                  />
                );
                if (!isVisible || !item.attachRef || currentRefIdx === undefined) return view;
                return (
                  <div key={`${item.keyPrefix}-${idx}`} ref={attachVisibleRef(idx, currentRefIdx)}>
                    {view}
                  </div>
                );
              };

              const rendered: ReactNode[] = [];
              const plan = chatPlan;
              for (const item of plan) {
                if (item.kind === "message") {
                  rendered.push(renderMessage(item));
                  continue;
                }
                const processRefIdx = item.attachRefMessageIndex === undefined ? undefined : visibleRefIndexByMessage.get(item.attachRefMessageIndex);
                const processGroup = (
                    <ProcessDetailsGroup
                      t={t}
                      messageCount={item.messageCount}
                      toolCallCount={item.toolCallCount}
                    >
                      {item.children.map((child) => renderMessage(child))}
                    </ProcessDetailsGroup>
                  );
                  rendered.push(
                    <div
                      key={`process-group-${item.userIdx}-${item.finalAssistantIdx}`}
                      ref={processRefIdx === undefined ? undefined : (el) => { messageRefs.current[processRefIdx] = el; }}
                    >
                      {processGroup}
                    </div>,
                  );
              }
              const { startIndex, hasMore: localHasMore } = getVisibleRenderWindow(rendered.length, visibleCount);
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

            {pendingBash && (
              <MessageView
                message={{
                  role: "bashExecution",
                  command: pendingBash.command,
                  output: "",
                  excludeFromContext: pendingBash.excludeFromContext,
                } as BashExecutionMessage}
                sessionId={session?.id ?? sessionIdRef.current ?? undefined}
              />
            )}

            {/* 扩展阻塞请求改为弹窗承载（对齐 TUI），不再内联进消息流。 */}

            {/* OpenChamber 风格底部常驻 spacer（桌面 10vh / 移动 40px）：给末端留呼吸感，
                取代旧的 agentRunning 整视口占位——跟随钉底由 useAgentSession 的自动跟随负责。 */}
            <div aria-hidden="true" style={{ height: isMobile ? 40 : "10vh" }} />
            </div>
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
        {isMobile ? null : (
          <ChatMinimap
            messages={messages}
            plan={chatPlan}
            scrollContainer={scrollContainerRef}
            messageRefs={messageRefs}
          />
        )}
      </div>

      <div className="relative">
        {/* aboveEditor widget（对齐 TUI：紧贴输入框上方） */}
        <div
          style={{
            padding: `0 ${CHAT_COLUMN_PADDING}px`,
            paddingRight: isMobile ? CHAT_COLUMN_PADDING : CHAT_INPUT_RIGHT_PADDING,
          }}
        >
          <div style={{ maxWidth: 820, margin: "0 auto" }}>
            <ExtensionWidgets widgets={aboveEditorWidgets} />
          </div>
        </div>
        {todoPanelElement}
        {chatInputElement}
        {/* belowEditor widget + footer 状态条（对齐 TUI：输入框下方） */}
        <div
          style={{
            padding: `0 ${CHAT_COLUMN_PADDING}px`,
            paddingRight: isMobile ? CHAT_COLUMN_PADDING : CHAT_INPUT_RIGHT_PADDING,
          }}
        >
          <div style={{ maxWidth: 820, margin: "0 auto" }}>
            <ExtensionWidgets widgets={belowEditorWidgets} />
            <ExtensionStatusBar statuses={extensionStatuses} />
          </div>
        </div>
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
function ReadOnlySessionBar({ session, isMobile }: { session: SessionInfo; isMobile: boolean }) {
  const { t } = useI18n();
  const sub = session.subagent;
  const identity = sub
    ? `${sub.agent ? t("chat_agentNamed", { name: sub.agent }) : t("chat_subagent")} · ${t("chat_subagentRun", { count: sub.runIndex })}`
    : null;
  return (
    // 与 ChatInput 相同的外边距节奏（桌面端右侧为 ChatMinimap 预留 36px）。
    <div style={{ flexShrink: 0, padding: "0 16px 8px", paddingRight: isMobile ? 16 : CHAT_INPUT_RIGHT_PADDING }}>
      <div style={{ maxWidth: 820, margin: "0 auto" }}>
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
  if (widgets.length === 0) return null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 10 }}>
      {widgets.map((widget) => (
        <div
          key={widget.key}
          style={{
            border: "1px solid var(--border)",
            borderRadius: 7,
            background: "var(--bg-panel)",
            overflow: "hidden",
          }}
        >
          <div style={{ padding: "5px 9px", borderBottom: "1px solid var(--border)", color: "var(--text-dim)", fontSize: 11, fontFamily: "var(--font-mono)" }}>
            {widget.key}
          </div>
          <pre style={{ margin: 0, padding: "8px 9px", color: "var(--text-muted)", fontSize: 12, lineHeight: 1.5, whiteSpace: "pre-wrap", wordBreak: "break-word", fontFamily: "var(--font-mono)" }}>
            {widget.lines.map((line, index, lines) => (
              <Fragment key={index}>
                {renderAnsiLine(line, `widget-${widget.key}-line-${index}`)}
                {index < lines.length - 1 ? "\n" : null}
              </Fragment>
            ))}
          </pre>
        </div>
      ))}
    </div>
  );
}

type PersistedActivityItem = { key: string; activity: SessionActivity; timestamp?: number };

function NoticeIconButton({ label, active = false, onClick, children }: { label: string; active?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" aria-label={label} title={label} onClick={onClick} style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 28, height: 28, padding: 0, flexShrink: 0, border: "none", borderRadius: 7, background: active ? "var(--bg-selected)" : "transparent", color: active ? "var(--text)" : "var(--text-dim)", cursor: "pointer" }}>
      {children}
    </button>
  );
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
  if (notices.length === 0 && activities.length === 0) return null;
  const orderedNotices = [...notices].sort((a, b) => Number(b.pinned) - Number(a.pinned));
  const visibleActivities = selectedRequestId ? activities.filter((item) => item.activity.requestId === selectedRequestId) : activities;

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: align === "right" ? "flex-end" : "stretch", gap: 7, width: "100%", marginBottom: floating ? 0 : 10, pointerEvents: "auto" }}>
      {activities.length > 0 && (
        <button type="button" onClick={() => { setSelectedRequestId(null); setHistoryOpen((open) => !open); }} aria-expanded={historyOpen} style={{ display: "flex", alignItems: "center", gap: 7, padding: "5px 9px", border: "1px solid var(--border)", borderRadius: 999, background: "var(--bg-panel)", color: "var(--text-muted)", cursor: "pointer", fontSize: 11 }}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v6h6"/><path d="M12 7v5l3 2"/></svg>
          {t("notice_activityHistory", { count: activities.length })}
        </button>
      )}
      {historyOpen && (
        <section aria-label={t("notice_activityHistoryTitle")} style={{ width: "min(100%, 620px)", maxHeight: 360, overflow: "auto", border: "1px solid var(--border)", borderRadius: 14, background: "var(--bg)", boxShadow: "0 16px 40px color-mix(in srgb, var(--text) 14%, transparent)" }}>
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
                <article key={key} style={{ border: "1px solid var(--border)", borderLeft: `3px solid ${activity.kind === "warning" || activity.kind === "error" ? "var(--warning)" : "var(--accent)"}`, borderRadius: 9, background: "var(--bg-panel)", padding: "9px 10px" }}>
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
        const color = important ? "var(--warning)" : "var(--accent)";
        return (
          <div key={notice.id} className="notice-shelf-item" role={notice.type === "error" ? "alert" : "status"} style={{ display: "flex", alignItems: important ? "flex-start" : "center", gap: important ? 9 : 8, minHeight: important ? 76 : 42, borderRadius: important ? 14 : 999, border: important ? `1px solid color-mix(in srgb, ${color} 38%, var(--border))` : "1px solid var(--border)", borderLeft: important ? `3px solid ${color}` : undefined, background: important ? "var(--bg-panel)" : "var(--bg)", color: "var(--text-muted)", width: important ? "min(100%, 620px)" : "fit-content", maxWidth: "min(100%, 620px)", boxShadow: floating ? "0 12px 32px color-mix(in srgb, var(--text) 13%, transparent)" : "0 8px 24px color-mix(in srgb, var(--text) 8%, transparent)", fontSize: important ? 13 : 12, lineHeight: 1.55, transformOrigin: "top right", animation: notice.exiting ? "notice-shelf-out 0.18s ease-in forwards" : "notice-shelf-in 0.18s ease-out both", padding: important ? "10px 8px 10px 11px" : "6px 7px 6px 11px" }}>
            <span style={{ width: 7, height: 7, borderRadius: "50%", background: color, flexShrink: 0, marginTop: important ? 6 : 0 }} />
            <div style={{ minWidth: 0, flex: 1 }}>
              {important && <div style={{ marginBottom: 3, color, fontFamily: "var(--font-mono)", fontSize: 10, fontWeight: 700, letterSpacing: 0.7, textTransform: "uppercase" }}>{t(notice.type === "error" ? "notice_error" : "notice_warning")}{notice.pinned ? ` · ${t("notice_pinned")}` : ""}</div>}
              <div style={{ color: important ? "var(--text)" : "var(--text-muted)", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{notice.message}</div>
              {important && notice.activityRecord && <button type="button" onClick={() => { setSelectedRequestId(notice.id); setHistoryOpen(true); }} style={{ marginTop: 7, padding: 0, border: "none", background: "transparent", color: "var(--accent)", cursor: "pointer", fontSize: 11, fontWeight: 600 }}>{t("notice_viewActivity")} →</button>}
            </div>
            {important && <NoticeIconButton label={notice.pinned ? t("notice_unpin") : t("notice_pin")} active={notice.pinned} onClick={() => onTogglePin(notice.id)}><svg width="14" height="14" viewBox="0 0 24 24" fill={notice.pinned ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="m15 4 5 5-4 2-3 5-2 4-1-6-6-6 4-1 5-3 2-4Z"/><path d="m4 20 5-5"/></svg></NoticeIconButton>}
            <NoticeIconButton label={t("notice_close")} onClick={() => onDismiss(notice.id)}><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg></NoticeIconButton>
          </div>
        );
      })}
    </div>
  );
}

type ExtensionCustomRequest = Extract<ExtensionUiRequest, { method: "custom" }>;

function renderAnsiLine(line: string, keyPrefix: string): ReactNode[] {
  return parseAnsiLine(line).map((segment, index) => (
    Object.keys(segment.style).length > 0
      ? <span key={`${keyPrefix}-${index}`} style={segment.style}>{segment.text}</span>
      : segment.text
  ));
}

function ExtensionCustomPanel({
  request,
  onInput,
}: {
  request: ExtensionCustomRequest;
  onInput: (request: ExtensionCustomRequest, data: string) => void;
}) {
  const { t } = useI18n();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const composingRef = useRef(false);
  const displayLines = normalizeCustomPanelLines(request.lines);

  useEffect(() => {
    inputRef.current?.focus();
  }, [request.id]);

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 95,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 20,
        background: "var(--overlay)",
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        onClick={(event) => {
          if (!(event.target as HTMLElement).closest("button")) inputRef.current?.focus();
        }}
        style={{
          position: "relative",
          width: "min(920px, 100%)",
          maxHeight: "min(760px, calc(100vh - 40px))",
          border: "1px solid var(--border)",
          borderRadius: 8,
          background: "var(--bg)",
          boxShadow: "0 20px 60px rgba(0,0,0,0.28)",
          overflow: "hidden",
          outline: "none",
        }}
      >
        <textarea
          ref={inputRef}
          aria-label={t("chat_extensionPanel")}
          autoCapitalize="off"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          onKeyDown={(event) => {
            if (composingRef.current || event.nativeEvent.isComposing) return;
            const data = toTerminalKeyData(event);
            if (!data) return;
            event.preventDefault();
            event.stopPropagation();
            onInput(request, data);
          }}
          onInput={(event) => {
            if (composingRef.current || event.nativeEvent.isComposing) return;
            const text = event.currentTarget.value;
            event.currentTarget.value = "";
            if (text) onInput(request, text);
          }}
          onCompositionStart={() => {
            composingRef.current = true;
          }}
          onCompositionEnd={(event) => {
            composingRef.current = false;
            const input = event.currentTarget;
            queueMicrotask(() => {
              const text = input.value;
              input.value = "";
              if (text) onInput(request, text);
            });
          }}
          onPaste={(event) => {
            event.preventDefault();
            const text = event.clipboardData.getData("text");
            if (text) onInput(request, asBracketedPaste(text));
          }}
          style={{
            position: "absolute",
            width: 1,
            height: 1,
            padding: 0,
            border: 0,
            opacity: 0,
            pointerEvents: "none",
          }}
        />
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "10px 12px", borderBottom: "1px solid var(--border)" }}>
          <div style={{ color: "var(--text)", fontSize: 13, fontWeight: 650 }}>{t("chat_extensionPanel")}</div>
          <button
            onClick={() => onInput(request, "\x03")}
            style={{
              padding: "5px 9px",
              borderRadius: 6,
              border: "1px solid var(--border)",
              background: "var(--bg-panel)",
              color: "var(--text-muted)",
              cursor: "pointer",
              fontSize: 12,
            }}
          >
            {t("chat_close")}
          </button>
        </div>
        <pre
          style={{
            margin: 0,
            padding: 14,
            maxHeight: "calc(min(760px, 100vh - 40px) - 48px)",
            overflow: "auto",
            background: "var(--bg-panel)",
            color: "var(--text)",
            fontFamily: "var(--font-mono)",
            fontSize: 13,
            lineHeight: 1.45,
            whiteSpace: "pre",
          }}
        >
          {(displayLines.length ? displayLines : [""]).map((line, index, allLines) => (
            <Fragment key={index}>
              {renderAnsiLine(line, `line-${index}`)}
              {index < allLines.length - 1 ? "\n" : null}
            </Fragment>
          ))}
        </pre>
      </div>
    </div>
  );
}
