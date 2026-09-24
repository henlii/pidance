"use client";
import { registerAbortHandler } from "@/hooks/useKeyboardShortcuts";
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { AgentMessage, BashExecutionMessage, SessionInfo, SessionTreeNode, ToolResultMessage } from "@/lib/types";
import type { BranchActions } from "@/lib/branch-bookmarks";
import { parseAnsiLine } from "@/lib/ansi";
import { humanizeExtensionIdentifier } from "@/lib/extension-labels";
import { composeChatPlan, type ChatRenderItem } from "@/lib/chat-compositor";
import type { TurnMetrics } from "@/lib/browser-session-runtime-registry";
import { MessageView } from "./MessageView";
import { collectTurnWrittenFiles, isTurnFinalAssistantMessage } from "@/lib/turn-written-files";
import { ImagePreviewOverlay } from "./MessageImage";
import { ChatInput, type ChatInputHandle } from "./ChatInput";
import { ChatMinimap, useMessageRefs } from "./ChatMinimap";
import { MessageNavRail } from "./MessageNavRail";
import type { UserMessageOutlineItem } from "@/lib/session-outline";
import {
  extendOutlineWithLoadedUsers,
  lastUserEntryId,
  loadedUserOutlineSeeds,
  outlineForSession,
} from "@/lib/session-outline";
import { CHAT_BLOCK_MAX_HEIGHT, CHAT_BLOCK_MAX_HEIGHT_MOBILE, CHAT_COLUMN_MAX_WIDTH_CSS, CHAT_GUTTER } from "@/lib/chat-column";

/**
 * 输入区/面板/底栏的左右内边距：与消息列逐像素对齐。
 * 消息列的左右边距由两侧竖条（MessageNavRail / ChatMinimap，各 CHAT_GUTTER px）
 * 充当，所以输入区也要退同样宽度，否则两者左右边缘会差一个竖条。
 */
const CHAT_INPUT_SIDE_PADDING = CHAT_GUTTER;
const CHAT_INPUT_SIDE_PADDING_MOBILE = 16;
/** 本轮没有写入文件时的稳定空数组：保持引用不变，MessageView 的 memo 才不会被打破。 */
const NO_WRITTEN_FILES: string[] = [];
import { ExtensionDialog } from "./ExtensionDialog";
import { ExtensionCustomPanel } from "./ExtensionCustomPanel";
import { SubagentAsyncWidget } from "./SubagentAsyncWidget";
import { ASYNC_STATUS_SNAPSHOT_PREFIX, parseSubagentAsyncSnapshot, rewriteFleetStatusLines, subagentAsyncHeading } from "@/lib/subagent-async-widget";
import { NewSessionGuide } from "./NewSessionGuide";
import { TodoPanel } from "./TodoPanel";
import { useAgentSession, type AgentPhase, type NoticeItem } from "@/hooks/useAgentSession";
import { useAudio } from "@/hooks/useAudio";
import { useI18n } from "@/lib/i18n";
import { useDragDrop } from "@/hooks/useDragDrop";
import { useExtensionTerminalInput } from "@/hooks/useExtensionTerminalInput";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useMessageJump, type MessageJumpRailHandle } from "@/hooks/useMessageJump";
import { useRenderWidth } from "@/hooks/useRenderWidth";
import type { SessionStatsInfo } from "@/lib/pi-types";
import type { SessionActivity } from "@/lib/session-activity";
import { DEFAULT_SESSION_HISTORY_PAGE } from "@/lib/session-context-window";

interface Props {
  session: SessionInfo | null;
  newSessionCwd: string | null;
  /** 新建意图 id，透传 useAgentSession 供 onSessionCreated 门禁。 */
  newSessionIntentId?: string | null;
  /** 新会话引导页默认目标项目（入口解析的 cwd；null = 回落 localStorage 上次项目） */
  guideDefaultCwd?: string | null;
  /** 引导页改项目/工作树：同步到全局项目身份（文件栏、Git、标题） */
  onGuideTargetChange?: (cwd: string) => void;
  /** 侧栏新增项目后递增：引导页把新项目并入项目下拉（读 localStorage 只发生一次） */
  /** 侧栏项目列表（引导页项目下拉的唯一来源） */
  projectRoots?: readonly string[];
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
  /** 会话外发起的「定位到某条历史」请求（全文搜索命中）：切会话后由 ChatWindow 消费 */
  entryJumpRequest?: { sessionId: string; entryId: string; nonce: number } | null;
  /** 定位请求已消费（成功或重试超限）：AppShell 据此清掉，避免运行态变化反复重跳 */
  onEntryJumpHandled?: () => void;
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
  item: ChatRenderItem | undefined,
  messageKeys: readonly string[],
): string | null {
  if (!item) return null;
  if (item.source === "live") return "live";
  const idx = item.messageIndex;
  if (typeof idx !== "number") return item.keyPrefix ?? null;
  return messageKeys[idx] ?? `idx:${idx}`;
}

export function ChatWindow({ session, newSessionCwd, newSessionIntentId, guideDefaultCwd, projectRoots, onGuideTargetChange, onAgentEnd, onAgentRunningChange, onSessionCreated, onSessionForked, modelsRefreshKey, chatInputRef, onBranchDataChange, onSystemPromptChange, onSessionStatsChange, onSessionStatsPanelOpen, onContextUsageChange, onTurnMetricsChange, onOpenFile, entryJumpRequest, onEntryJumpHandled, footerCollapsed, onFooterToggle }: Props) {
  const { t } = useI18n();
  const { soundEnabled, onSoundToggle, playDoneSound, unlockAudio } = useAudio();
  const isMobile = useIsMobile();
  // 只读（subagent 持久化）会话：历史正常读，一切写入口关闭，编辑器换成只读提示。
  const isReadOnly = session?.readOnly === true;

  // OpenChamber draft-target 语义：空态引导页选中的目标目录（项目 = 目录）。
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
      // 只存本机（#65）：「我正要在哪个项目里建会话」是这台设备当下的动作，不是账号级偏好。
      // 跨端同步的后果是别人的引导目标被另一台设备（甚至一条空值）拽走，而收益为零。
      if (cwd) localStorage.setItem("pidance.draftTargetCwd", cwd);
      else localStorage.removeItem("pidance.draftTargetCwd");
    } catch {
      // localStorage 不可用时仅内存生效
    }
    if (cwd) onGuideTargetChange?.(cwd);
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
    notices, liveNoticeActivities, dismissNotice, toggleNoticePin, extensionDialog, extensionCustomUi, extensionStatuses, extensionWidgets, extensionTerminalInputListenerCount, extensionWorkingMessage, extensionWorkingVisible, extensionWorkingIndicator, respondToExtensionUi, dismissExtensionUiRequest, sendExtensionCustomInput, sendExtensionCustomMouse,
    todos,
    isAutoModelSelection,
    agentPhase, toolExecutionSnapshots,
    isNew,
    sessionIdRef, scrollContainerRef,
    jumpButtonVisible, jumpToBottom,
    loadOlderHistory,
    loadNewerHistory,
    jumpToEntry,
    notifyBrowsingHistory,
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

  // 插件把 custom 面板收起后，白名单按键仍要能到达它的全局监听器
  // （ctx.ui.onTerminalInput；如 rpiv-ask-user 的折叠键重新展开面板）。
  // 面板可见时不介入：那时按键归面板自己的 keytrap。
  useExtensionTerminalInput({
    sessionId: sessionIdRef.current,
    enabled: Boolean(extensionCustomUi?.hidden) && extensionTerminalInputListenerCount > 0,
  });

  // 插件组件按可用列数排版：视口变窄时让服务端重新渲染，而不是交给 CSS 硬断行
  // （硬断行会把方框/表格/选中条拆散，见 lib/render-width.ts）。
  useRenderWidth({
    sessionId: sessionIdRef.current,
    containerRef: scrollContainerRef,
    enabled: !isReadOnly,
  });
  /**
   * 会话全部用户消息大纲（左侧导航条「列出所有提问」）。
   * 只读接口：直接读完整 entry 列表，不受首屏懒加载窗口限制。
   * 刷新时机：切会话、消息数变化（新提问落盘）、agent 结束。
   */
  const [userOutline, setUserOutline] = useState<{ sessionId: string; items: UserMessageOutlineItem[] } | null>(null);
  /**
   * entryId → 消息 DOM 的解析器（由渲染层提供）。
   * 导航条跳转必须走这里：槽位映射（visibleRefIndexByMessage）是渲染层的知识，
   * 导航条自己算会指错消息（实测跳 2 号落到 1 号）。
   */
  const resolveMessageElementRef = useRef<((entryId: string) => HTMLElement | null) | null>(null);

  /**
   * 导航条把「重算高亮 + 即刻设当前项」注册进来（手机端不挂导航条，为空）。
   *
   * 定位机制住在 ChatWindow，因为它必须**始终挂载**：导航条在 ≤640px 不渲染、没有
   * 提问时自己也返回 null；消费逻辑留在导航条里就是「手机点搜索命中只切会话、不滚动」。
   */
  const railHandleRef = useRef<MessageJumpRailHandle | null>(null);
  const messageJump = useMessageJump({
    scrollContainer: scrollContainerRef,
    resolveMessageElementRef,
    jumpToEntry,
    railHandleRef,
    notifyBrowsingHistory,
  });

  /**
   * 待消费的外部定位请求（全文搜索命中）。
   *
   * 三个约束：
   * - 等 `loading` 落下再跳：首屏载荷与 jumpToEntry 共用 abort 通道，抢跑会把它
   *   取消掉（模型、分支树就不会落地）；
   * - 目标可能还没进时间线：短延时重试，最多 8 次（约 2s），不跟渲染频率耦合；
   * - 成功或超限都回报上层清掉请求 —— 实现身份会随 agentRunning 变化，请求只要还在
   *   就会被下一次渲染重新消费（实测：运行态一变就重跳）。
   *
   * 跳转实现只走 ref：本 effect 不绑 jumpTo 身份。
   */
  const jumpToRef = useRef(messageJump.jumpTo);
  const onEntryJumpHandledRef = useRef(onEntryJumpHandled);
  useEffect(() => {
    jumpToRef.current = messageJump.jumpTo;
    onEntryJumpHandledRef.current = onEntryJumpHandled;
  });
  useEffect(() => {
    if (!entryJumpRequest || entryJumpRequest.sessionId !== session?.id || loading) return;
    const entryId = entryJumpRequest.entryId;
    let cancelled = false;
    let attempt = 0;
    const done = () => { if (!cancelled) onEntryJumpHandledRef.current?.(); };
    const run = async () => {
      if (cancelled) return;
      const located = await jumpToRef.current(entryId);
      if (cancelled) return;
      if (located) { done(); return; }
      attempt += 1;
      if (attempt >= 8) { done(); return; }
      window.setTimeout(() => void run(), 250);
    };
    void run();
    return () => { cancelled = true; };
  }, [entryJumpRequest, session?.id, loading]);
  const outlineSessionId = session?.id ?? null;
  /**
   * 窗口里最后一条用户消息的 entryId。
   *
   * 刷新键不能只看 `messages.length`：乐观气泡落盘时条数不变、entryId 从空变成真值，
   * 只绑长度就不会重取大纲，导航条于是少掉最新那一格。
   */
  const lastUserId = lastUserEntryId(messages, entryIds);
  useEffect(() => {
    if (!outlineSessionId) {
      setUserOutline(null);
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
        // 连 sessionId 一起存：切会话后旧响应/旧 state 不能用在新会话上。
        setUserOutline({
          sessionId: outlineSessionId,
          items: Array.isArray(data.userMessages) ? data.userMessages : [],
        });
      })
      .catch(() => {
        // 只读投影失败：保持上一次大纲，不清空（避免导航条闪没）
      });
    return () => controller.abort();
  }, [outlineSessionId, messages.length, lastUserId, agentRunning]);
  /**
   * 导航条真正用的大纲：服务端投影 + 当前窗口里还没进投影的新提问。
   * 后者让新发的提问立刻成为末格（否则要等下一次投影回来）。
   */
  const railOutline = useMemo(
    () => extendOutlineWithLoadedUsers({
      outline: outlineForSession({
        sessionId: outlineSessionId,
        ownerId: userOutline?.sessionId ?? null,
        items: userOutline?.items ?? [],
      }),
      loadedUsers: loadedUserOutlineSeeds(messages, entryIds),
      isAtLiveTail: !hasMoreAfter,
    }),
    [outlineSessionId, userOutline, messages, entryIds, hasMoreAfter],
  );

  const writesDisabled = isReadOnly || lockedByOther;
  const sessionBusy = agentRunning || bashRunning || isCompacting;
  const liveSlot = streamState.isStreaming && streamState.streamingMessage
    ? { message: streamState.streamingMessage, isActive: true }
    : undefined;
  const chatPlan = composeChatPlan({
    messages,
    isStreaming: streamState.isStreaming,
    liveSlot,
  });

  /**
   * 运行阶段提示：**最多一行，且不与工具块重复**。
   *
   * - 工具执行中（agentPhase 是 running_tools / running_command）不显示：对应的工具块
   *   自己已经在「运行中」扫光，再挂一行文字是同一件事说两遍（用户实测过两行并存）。
   * - bash 有自己的执行块在渲染时（pendingBash）同样不显示。
   * - 真正需要一行文字的是「没有工具块可看」的阶段：等待模型（含请求重试）。
   */
  const runPhaseNotice = (() => {
    // 扩展可以用 setWorkingVisible(false) 藏掉整行，用 setWorkingMessage 换文案
    if (!extensionWorkingVisible) return null;
    if (bashRunning && !pendingBash) return `${t("chat_runningCommand")}...`;
    if (!agentRunning || streamState.streamingMessage) return null;
    const kind = agentPhase?.kind;
    if (kind === "running_tools" || kind === "running_command") return null;
    return extensionWorkingMessage ?? phaseLabel(agentPhase, t);
  })();

  // 扩展自定义的运行指示帧（setWorkingIndicator）：按 intervalMs 轮播；
  // frames 为 null = 用默认圆点，空数组 = 不要指示器（只留文案）。
  const workingFrames = extensionWorkingIndicator?.frames ?? null;
  const [workingFrameIndex, setWorkingFrameIndex] = useState(0);
  useEffect(() => {
    if (!workingFrames || workingFrames.length <= 1) return;
    const intervalMs = Math.max(16, extensionWorkingIndicator?.intervalMs ?? 120);
    const timer = window.setInterval(() => {
      setWorkingFrameIndex((index) => (index + 1) % workingFrames.length);
    }, intervalMs);
    return () => window.clearInterval(timer);
  }, [workingFrames, extensionWorkingIndicator?.intervalMs]);
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

  // --- 历史分页 ---
  // 已加载的消息**全部渲染**，不再有客户端「末尾 N 项」窗口：窗口一变就要卸载/挂载
  // 视口上方的内容，高度跟着变，而补偿只能靠猜 —— 那是滚动抖动与「内容突然折叠」
  // 的来源。向上滚到顶时只做一件事：向服务端要更旧的一页。
  //
  // 上方插入内容后的视口保持交给浏览器：`overflow-anchor` 在阅读态打开（见滚动容器
  // 的 style），跟随态才关掉（钉底必须由自动跟随独占 scrollTop）。
  const sentinelRef = useRef<HTMLDivElement>(null);
  /**
   * 向上加载更旧页后要恢复的「距底部距离」。
   *
   * 不猜高度：只记 scrollHeight - scrollTop，插入完成后按新高度反推 scrollTop，
   * 视口内容精确不变。不能指望浏览器锚定 —— 用户滚到顶时 scrollTop 已经是 0，
   * 上方没有可调整的空间，大量 DOM 一次性插入时 Chrome 也会放弃锚点。
   * 恢复同时让哨兵离开视口：否则插完哨兵还在视口里，会一页接一页自动加载到底。
   */
  const pendingPrependKeepRef = useRef<number | null>(null);
  // 切会话丢掉上一个会话的待恢复位置（不同时间线的距离没有意义）。
  useEffect(() => {
    pendingPrependKeepRef.current = null;
  }, [session?.id]);

  useEffect(() => {
    const sentinel = sentinelRef.current;
    const container = scrollContainerRef.current;
    if (!sentinel || !container) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries[0]?.isIntersecting) return;
        if (historyLoading || !hasMoreBefore) return;
        pendingPrependKeepRef.current = container.scrollHeight - container.scrollTop;
        void loadOlderHistory().then((loaded) => {
          if (!loaded) pendingPrependKeepRef.current = null;
        });
      },
      { root: container, threshold: 0 },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [scrollContainerRef, hasMoreBefore, historyLoading, loadOlderHistory]);

  // 更旧一页落进时间线后、绘制前恢复一次「距底部距离」：视口内容不动，哨兵随之离开。
  useLayoutEffect(() => {
    const keep = pendingPrependKeepRef.current;
    if (keep === null) return;
    const container = scrollContainerRef.current;
    if (!container) return;
    pendingPrependKeepRef.current = null;
    const top = Math.max(0, container.scrollHeight - keep);
    if (Math.abs(top - container.scrollTop) > 1) container.scrollTop = top;
  }, [messages.length, chatPlan.length, scrollContainerRef]);
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
          <div style={{ maxWidth: CHAT_COLUMN_MAX_WIDTH_CSS, margin: "0 auto" }}>
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
      sessionId={sessionIdRef.current}
      // 插件 widget 的按键窄口子：没有 custom 面板（有面板时按键归面板的 keytrap，
      // 收起那条路径由 useExtensionTerminalInput 负责）、该会话存在 widget、
      // 且有插件注册了全局按键监听。只读会话不参与。
      extensionWidgetKeysEnabled={
        !isReadOnly
        && !extensionCustomUi
        && extensionWidgets.length > 0
        && extensionTerminalInputListenerCount > 0
      }
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
      <div style={{ maxWidth: CHAT_COLUMN_MAX_WIDTH_CSS, margin: "0 auto" }}>
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
          onMouse={sendExtensionCustomMouse}
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
                projectRoots={projectRoots ?? []}
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
          <div style={{ maxWidth: CHAT_COLUMN_MAX_WIDTH_CSS, margin: "0 auto" }}>
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
              outline={railOutline}
              entryIds={entryIds}
              // 跳转机制归 ChatWindow（三端都在）：导航条只消费它做交互与视觉
              jumpTo={messageJump.jumpTo}
              jumpingTo={messageJump.jumpingTo}
              jumpPinRef={messageJump.jumpPinRef}
              railHandleRef={railHandleRef}
              isAtLiveTail={!hasMoreAfter}
            />
          </div>
        )}
        <div
          ref={scrollContainerRef}
          data-chat-scroller="true"
          className="min-h-0 flex-1 overflow-y-auto py-4 [scrollbar-width:none]"
          // overflow-anchor 由 useChatAutoFollow 按跟随状态直接写 DOM（阅读态 auto、
          // 跟随态 none），这里不能声明：React 会在重渲染时把它覆盖回去。
          // 内嵌消息块滚到边界后允许滚轮/触屏继续传给会话容器。
          // 左右内边距与输入栏同口径（两侧各让出 18px 竖条 / 移动端 16px），
          // 保证消息列、输入栏、扩展面板三者同宽同中心线。
          style={{
            overscrollBehavior: "auto",
            padding: `0 ${isMobile ? CHAT_INPUT_SIDE_PADDING_MOBILE : CHAT_INPUT_SIDE_PADDING}px`,
          }}
        >
          <div style={{ maxWidth: CHAT_COLUMN_MAX_WIDTH_CSS, margin: "0 auto" }}>
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
              // 命中的可能是 toolResult 等不可见条目（全文搜索按 JSONL entry 命中），
              // 此时上溯到最近的可见消息（同属这一轮），跳转才会落到用户看得到的位置。
              resolveMessageElementRef.current = (entryId: string) => {
                const index = entryIds.indexOf(entryId);
                if (index < 0) return null;
                for (let i = index; i >= 0; i--) {
                  const refIndex = visibleRefIndexByMessage.get(i);
                  if (refIndex !== undefined) return messageRefs.current[refIndex] ?? null;
                }
                return null;
              };

              const renderMessage = (item: ChatRenderItem): ReactNode => {
                const isLive = item.source === "live";
                const idx = isLive ? -1 : (item.messageIndex as number);
                const msg = item.messageOverride ?? messages[idx];
                // 本轮写入的文件只在收尾的 assistant 消息下汇总一次：中间的 assistant
                // step 也会写文件，但它们列一遍会让同一轮重复出现多张同样的卡片。
                const writtenFiles = msg.role === "assistant" && (isLive || isTurnFinalAssistantMessage(messages, idx))
                  ? collectTurnWrittenFiles({
                      messages,
                      index: isLive ? null : idx,
                      liveMessage: isLive ? msg : null,
                      toolResults: toolResultsMap,
                      cwd: messageCwd,
                    }).map((file) => file.filePath)
                  : NO_WRITTEN_FILES;
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
                    writtenFiles={writtenFiles}
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
              const plan = chatPlan;
              for (const item of plan) {
                rendered.push(renderMessage(item));
              }
              return (
                <>
                  {hasMoreBefore && (
                    <div ref={sentinelRef} className="py-3 text-center text-xs text-text-muted">
                      {historyLoading
                        ? t("chat_loadingSession")
                        : t("chat_loadEarlier", { count: DEFAULT_SESSION_HISTORY_PAGE })}
                    </div>
                  )}
                  {rendered}
                </>
              );
            })()}

            {runPhaseNotice && (
              <div className="flex items-center gap-2 py-2 text-[13px] text-text-muted">
                {workingFrames === null ? (
                  <span className="size-1.5 rounded-full bg-status-running" aria-hidden="true" />
                ) : workingFrames.length > 0 ? (
                  <span aria-hidden="true">
                    {renderAnsiLine(workingFrames[workingFrameIndex % workingFrames.length], "working-frame")}
                  </span>
                ) : null}
                <span>{runPhaseNotice}</span>
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
          <div style={{ maxWidth: CHAT_COLUMN_MAX_WIDTH_CSS, margin: "0 auto" }}>
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
            <div style={{ maxWidth: CHAT_COLUMN_MAX_WIDTH_CSS, margin: "0 auto" }}>
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
      <div style={{ maxWidth: CHAT_COLUMN_MAX_WIDTH_CSS, margin: "0 auto" }}>
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
      <div style={{ maxWidth: CHAT_COLUMN_MAX_WIDTH_CSS, margin: "0 auto" }}>
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

/**
 * widget key（kebab/snake）→ 可读标题：`subagent-async` → `Subagent Async`。
 *
 * 走共享的通用规则（lib/extension-labels.ts），**不为个别插件写特例**。
 * 已知机器载荷（能解析出结构化信息的）仍用它们自己的友好名，见下面的 heading。
 */
function ExtensionWidgets({ widgets }: { widgets: Array<{ key: string; lines: string[] }> }) {
  // 扩展可能发「机器载荷」widget（pi-subagents 的 subagent-async 在 rpc 模式下就是一整行
  // PI_SUBAGENT_ASYNC_JSON:{…}）。这类载荷要按数据渲染，绝不能当文本显示原样 JSON。
  const parsed = widgets.map((widget) => {
    const machinePayload = widget.lines.some((line) => typeof line === "string" && line.startsWith(ASYNC_STATUS_SNAPSHOT_PREFIX));
    // 子代理的 fleet 状态行由 TUI 组件渲染而来，尾部带终端键位提示（↓/← to inspect）：
    // 去掉提示段保留信息。**通用规则**：不按 widget key 闸门，函数自己按形状自检
    // （认不出键位提示就返回 null），任何插件产出的同类文本一视同仁。
    const rewritten = rewriteFleetStatusLines(widget.lines);
    return {
      widget: rewritten ? { ...widget, lines: rewritten } : widget,
      snapshot: machinePayload ? parseSubagentAsyncSnapshot(widget.lines) : null,
      machinePayload,
      drop: rewritten !== null && rewritten.length === 0,
    };
  });
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
      {parsed.map(({ widget, snapshot, machinePayload, drop }) => {
        if (drop) return null;
        // 机器载荷：解析成功就按数据渲染；解析失败说明格式变了，宁可什么都不显示，
        // 也不把载荷当文本糊在界面上。
        if (machinePayload && !snapshot) return null;
        const collapsed = collapsedKeys.has(widget.key);
        // **标题与副标题由槽位外壳决定**（折叠也是外壳的职责）：已认识的机器载荷用友好名，
        // 其余部件走通用的 key 美化（不为个别插件写特例）。
        const heading = snapshot ? subagentAsyncHeading(snapshot) : null;
        const title = heading
          ? (heading.singleLabel
            ? t("subagent_widgetSingle", { name: heading.singleLabel })
            : t("subagent_widgetTitle"))
          : humanizeExtensionIdentifier(widget.key);
        const subtitle = heading
          ? [
            t("subagent_widgetBackground"),
            heading.queued > 0 ? t("subagent_widgetQueued", { count: heading.queued }) : "",
            heading.hidden > 0 ? t("subagent_widgetMore", { count: heading.hidden }) : "",
            heading.byteLimitExceeded ? t("subagent_widgetTruncated") : "",
          ].filter(Boolean).join(" · ")
          : null;
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
            {/* 槽位外壳的标题行：任何插件用这个槽位都自带折叠（不用各自实现）。 */}
            <button
              type="button"
              onClick={() => toggleCollapse(widget.key)}
              aria-expanded={!collapsed}
              aria-label={collapsed ? t("extension_widgetExpand", { name: title }) : t("extension_widgetCollapse", { name: title })}
              title={collapsed ? t("extension_widgetExpand", { name: title }) : t("extension_widgetCollapse", { name: title })}
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
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{title}</span>
              {subtitle ? (
                <span style={{ color: "var(--text-dim)", fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{subtitle}</span>
              ) : null}
            </button>
            {!collapsed && (
              snapshot ? (
                <SubagentAsyncWidget snapshot={snapshot} />
              ) : (
                <pre style={{ margin: 0, padding: "8px 9px", color: "var(--text-muted)", fontSize: 12, lineHeight: 1.5, whiteSpace: "pre", fontFamily: "var(--font-mono)", maxHeight: bodyMaxHeight, overflow: "auto", overscrollBehavior: "auto", touchAction: "pan-y" }}>
                  {(Array.isArray(widget.lines) ? widget.lines : []).map((line, index, lines) => (
                    <Fragment key={index}>
                      {renderAnsiLine(line, `widget-${widget.key}-line-${index}`)}
                      {index < lines.length - 1 ? "\n" : null}
                    </Fragment>
                  ))}
                </pre>
              )
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


