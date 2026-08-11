"use client";

import { useState, useCallback, useRef, useEffect, useMemo, useReducer, type CSSProperties } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useGlobalKeyboardShortcuts } from "@/hooks/useKeyboardShortcuts";
import { SessionSidebar } from "./SessionSidebar";
import { ChatWindow } from "./ChatWindow";
import { FileViewer } from "./FileViewer";
import type { Tab } from "./TabBar";
import { RightPanel } from "./RightPanel";
import { ChangesPanel } from "./ChangesPanel";
import { SessionInfoPanel } from "./SessionInfoPanel";
import { SettingsView } from "./SettingsView";
import { CommandPalette } from "./CommandPalette";
import type { SettingsPageId } from "./settings-nav";
import { AboutDialog } from "./AboutDialog";
import { UpdateBanner } from "./UpdateBanner";
import { BranchNavigator } from "./BranchNavigator";
import { useTheme } from "@/hooks/useTheme";
import { useIsMobile } from "@/hooks/useIsMobile";
import { setDraft } from "@/lib/draft-store";
import { encodeFilePathForApi, getFileName } from "@/lib/file-paths";
import {
  EMPTY_FILE_EDITOR_STATE,
  fileEditorReducer,
  getBuffer,
  hasDirtyBuffers,
  makeFileBufferKey,
} from "@/lib/file-editor-state";
import { buildAtMentionText, buildFileAtMentionsText } from "@/lib/file-fuzzy";
import { getInitialNavigation } from "@/lib/initial-navigation";
import type { SessionInfo, SessionTreeNode } from "@/lib/types";
import { loadCachedSessionList, saveCachedSessionList } from "@/lib/session-list-cache";
import type { BranchActions } from "@/lib/branch-bookmarks";
import type { ChatInputHandle } from "./ChatInput";
import type { SessionStatsInfo } from "@/lib/pi-types";
import { ProjectProvider, useProjectActions, useProjectIdentity } from "./ProjectProvider";
import {
  CHANGES_PANEL_WIDTH_DEFAULT,
  CHANGES_PANEL_WIDTH_MAX,
  CHANGES_PANEL_WIDTH_MIN,
  CHANGES_PANEL_WIDTH_OPEN_MIN,
  RIGHT_PANEL_WIDTH_DEFAULT,
  SIDEBAR_WIDTH_DEFAULT,
  SIDEBAR_WIDTH_MAX,
  SIDEBAR_WIDTH_MIN,
  clampChangesPanelWidth,
  clampRightPanelWidth,
  clampSidebarWidth,
  loadSidebarPreferences,
  saveChangesPanelPreferences,
  saveRightPanelPreferences,
  saveSidebarWidth,
} from "@/lib/ui-preferences";
import { useI18n } from "@/lib/i18n";
import { hydrateSessionById } from "@/lib/session-hydrate";
import {
  createNewSessionIntent,
  shouldApplyHydratedSession,
  shouldPromoteSessionCreated,
  type NewSessionIntent,
} from "@/lib/new-session-intent";

export function AppShell() {
  return <ProjectProvider><AppShellInner /></ProjectProvider>;
}

function AppShellInner() {
  const { t } = useI18n();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [initialNavigation] = useState(() => getInitialNavigation(searchParams));
  const { isDark, toggleTheme } = useTheme();
  const isMobile = useIsMobile();
  const [selectedSession, setSelectedSession] = useState<SessionInfo | null>(null);
  const [initialCwdStatus, setInitialCwdStatus] = useState<"idle" | "validating" | "ready" | "error">(
    () => initialNavigation.requestedCwd ? "validating" : "idle",
  );
  const [initialCwdError, setInitialCwdError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  /** 当前聊天会话的 agentRunning（含冷启动窗口）；侧栏合并进 running 集合 */
  const [clientRunningSessionId, setClientRunningSessionId] = useState<string | null>(null);
  const [sessionKey, setSessionKey] = useState(0);
  const [explorerRefreshKey, setExplorerRefreshKey] = useState(0);
  /** 受影响文件路径集合（P1-3 diff 定向刷新）：
   *  文件保存等明确知道路径的事件写入具体路径；agent 结束置 null（无文件信息，
   *  打开文件的 diff 由各自 SSE watch 定向刷新，不再全仓重抓）。 */
  const [gitAffectedPaths, setGitAffectedPaths] = useState<string[] | null>(null);
  /** 新建会话客户端意图：点击新会话只建 intent，首次写操作才 POST /api/agent/new。 */
  const [newSessionIntent, setNewSessionIntent] = useState<NewSessionIntent | null>(null);
  const newSessionIntentRef = useRef<NewSessionIntent | null>(null);
  const newSessionIntentGenerationRef = useRef(0);
  /** 新会话引导页的默认目标项目（本次入口解析的目标 cwd；null = 回落 localStorage 上次项目） */
  const [guideDefaultCwd, setGuideDefaultCwd] = useState<string | null>(null);
  const selectedSessionIdRef = useRef<string | null>(null);
  const hydrateAbortRef = useRef<AbortController | null>(null);
  /**
   * 侧栏乐观 pending（按真实 id）：快速 A/B 创建时多条并存，
   * 迟到 intent 不选中但必须保留到 server 回流/显式删除。
   */
  const [optimisticPendingById, setOptimisticPendingById] = useState<Map<string, SessionInfo>>(
    () => new Map(),
  );
  const optimisticPendingSessions = useMemo(
    () => [...optimisticPendingById.values()],
    [optimisticPendingById],
  );
  const upsertOptimisticPending = useCallback((session: SessionInfo) => {
    setOptimisticPendingById((prev) => {
      const next = new Map(prev);
      next.set(session.id, session);
      return next;
    });
  }, []);
  const removeOptimisticPending = useCallback((sessionId: string) => {
    setOptimisticPendingById((prev) => {
      if (!prev.has(sessionId)) return prev;
      const next = new Map(prev);
      next.delete(sessionId);
      return next;
    });
  }, []);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsInitialPage, setSettingsInitialPage] = useState<SettingsPageId | null>(null);
  /** Ctrl/Cmd+K 命令面板 */
  /** Ctrl/Cmd+K 命令面板 */
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [modelsRefreshKey, setModelsRefreshKey] = useState(0);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [mobileSidebarReady, setMobileSidebarReady] = useState(false);
  // ── 右侧工具区：图标栏桌面常驻；此状态控制内容面板/移动端整组抽屉 ──
  const [rightPanelOpen, setRightPanelOpen] = useState(false);
  const [rightPanelWidth, setRightPanelWidth] = useState(RIGHT_PANEL_WIDTH_DEFAULT);
  // 二级面板只由「打开文件」驱动（需求 6），初始/刷新后均为关闭态，不落盘恢复。
  const [changesPanelOpen, setChangesPanelOpen] = useState(false);
  const [changesPanelWidth, setChangesPanelWidth] = useState(CHANGES_PANEL_WIDTH_DEFAULT);
  const [secondaryPanelMode, setSecondaryPanelMode] = useState<"content" | "diff">("content");
  const [changesPanelDragging, setChangesPanelDragging] = useState(false);
  const changesPanelDragRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const [mobileWorkspaceReady, setMobileWorkspaceReady] = useState(false);
  // ── 桌面会话栏调宽：AppShell 是宽度唯一 owner（布局 owner），从偏好恢复并即时落盘 ──
  // 首次客户端渲染必须与 SSR 一致；挂载后再恢复浏览器持久化宽度。
  const [sidebarWidth, setSidebarWidth] = useState(SIDEBAR_WIDTH_DEFAULT);
  const [sidebarDragging, setSidebarDragging] = useState(false);
  const sidebarDragRef = useRef<{ startX: number; startWidth: number } | null>(null);

  const applySidebarWidth = useCallback((width: number) => {
    const clamped = clampSidebarWidth(width);
    setSidebarWidth(clamped);
    saveSidebarWidth(clamped);
  }, []);

  const handleSidebarResizeStart = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (isMobile) return;
    e.preventDefault();
    sidebarDragRef.current = { startX: e.clientX, startWidth: sidebarWidth };
    setSidebarDragging(true);
    e.currentTarget.setPointerCapture(e.pointerId);
  }, [isMobile, sidebarWidth]);

  const handleSidebarResizeMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const drag = sidebarDragRef.current;
    if (!drag) return;
    // 手柄在会话栏右缘：向右拖增宽、向左拖收窄。
    applySidebarWidth(drag.startWidth + (e.clientX - drag.startX));
  }, [applySidebarWidth]);

  const handleSidebarResizeEnd = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!sidebarDragRef.current) return;
    sidebarDragRef.current = null;
    setSidebarDragging(false);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  }, []);

  // 键盘可达：ArrowLeft/Right 微调（Shift 大步），Home/End 直达边界，双击回默认。
  const handleSidebarResizeKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 32 : 8;
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      applySidebarWidth(sidebarWidth - step);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      applySidebarWidth(sidebarWidth + step);
    } else if (e.key === "Home") {
      e.preventDefault();
      applySidebarWidth(SIDEBAR_WIDTH_MIN);
    } else if (e.key === "End") {
      e.preventDefault();
      applySidebarWidth(SIDEBAR_WIDTH_MAX);
    }
  }, [applySidebarWidth, sidebarWidth]);

  const handleSidebarResizeReset = useCallback(() => {
    applySidebarWidth(SIDEBAR_WIDTH_DEFAULT);
  }, [applySidebarWidth]);

  useEffect(() => {
    const prefs = loadSidebarPreferences();
    setSidebarWidth(prefs.sidebarWidth);
    setRightPanelOpen(prefs.rightPanelOpen);
    setRightPanelWidth(prefs.rightPanelWidth);
    // changesPanelOpen 由文件 tab 唯一驱动，不从偏好恢复（刷新后 fileTabs 恒为空）。
    setChangesPanelWidth(prefs.changesPanelWidth);
  }, []);

  // 右栏内容宽度/桌面开关的唯一写入口：AppShell 是布局 owner，变更即时落盘。
  const applyRightPanelWidth = useCallback((width: number) => {
    const clamped = clampRightPanelWidth(width);
    setRightPanelWidth(clamped);
    saveRightPanelPreferences({ width: clamped });
  }, []);

  const applyRightPanelOpen = useCallback((open: boolean) => {
    setRightPanelOpen(open);
    saveRightPanelPreferences({ open });
  }, []);

  const applyChangesPanelWidth = useCallback((width: number) => {
    const clamped = clampChangesPanelWidth(width);
    setChangesPanelWidth(clamped);
    saveChangesPanelPreferences({ width: clamped });
  }, []);

  const applyChangesPanelOpen = useCallback((open: boolean) => {
    setChangesPanelOpen(open);
    saveChangesPanelPreferences({ open });
  }, []);

  const handleChangesPanelResizeStart = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    changesPanelDragRef.current = { startX: event.clientX, startWidth: changesPanelWidth };
    setChangesPanelDragging(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  }, [changesPanelWidth]);

  const handleChangesPanelResizeMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const drag = changesPanelDragRef.current;
    if (!drag) return;
    applyChangesPanelWidth(drag.startWidth + drag.startX - event.clientX);
  }, [applyChangesPanelWidth]);

  const handleChangesPanelResizeEnd = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!changesPanelDragRef.current) return;
    changesPanelDragRef.current = null;
    setChangesPanelDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }, []);

  const handleChangesPanelResizeKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 32 : 8;
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      applyChangesPanelWidth(changesPanelWidth + step);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      applyChangesPanelWidth(changesPanelWidth - step);
    } else if (event.key === "Home") {
      event.preventDefault();
      applyChangesPanelWidth(CHANGES_PANEL_WIDTH_MIN);
    } else if (event.key === "End") {
      event.preventDefault();
      applyChangesPanelWidth(CHANGES_PANEL_WIDTH_MAX);
    }
  }, [applyChangesPanelWidth, changesPanelWidth]);

  // On mobile the sidebar is an overlay drawer; hide it by default so the chat
  // is visible on load. Runs once the breakpoint resolves after hydration.
  // 移动端抽屉显隐不落盘，避免覆盖桌面端持久化偏好。
  useEffect(() => {
    if (isMobile) {
      setSidebarOpen(false);
      setRightPanelOpen(false);
    } else {
      // 从移动断点返回桌面时恢复内容面板偏好；移动抽屉关闭不覆盖桌面选择。
      setRightPanelOpen(loadSidebarPreferences().rightPanelOpen);
    }
  }, [isMobile]);
  useEffect(() => {
    setMobileSidebarReady(true);
    setMobileWorkspaceReady(true);
  }, []);
  const chatInputRef = useRef<ChatInputHandle | null>(null);

  // Branch navigator state — populated by ChatWindow via onBranchDataChange
  const [branchTree, setBranchTree] = useState<SessionTreeNode[]>([]);
  const [branchActiveLeafId, setBranchActiveLeafId] = useState<string | null>(null);
  const branchLeafChangeFnRef = useRef<((leafId: string | null) => void) | null>(null);
  // D3 分支书签/摘要动作（可写门禁、带选项切换、set_label），由 useAgentSession 下发。
  const [branchActions, setBranchActions] = useState<BranchActions | null>(null);

  const handleBranchDataChange = useCallback((tree: SessionTreeNode[], activeLeafId: string | null, onLeafChange: (leafId: string | null) => void, actions: BranchActions) => {
    setBranchTree(tree);
    setBranchActiveLeafId(activeLeafId);
    branchLeafChangeFnRef.current = onLeafChange;
    setBranchActions(actions);
  }, []);

  const handleBranchLeafChange = useCallback((leafId: string | null) => {
    branchLeafChangeFnRef.current?.(leafId);
  }, []);

  const [systemPrompt, setSystemPrompt] = useState<string | null>(null);

  const handleSystemPromptChange = useCallback((prompt: string | null) => {
    setSystemPrompt(prompt);
  }, []);

  // Session stats (tokens + cost) — populated by ChatWindow, displayed in top bar
  const [sessionStats, setSessionStats] = useState<SessionStatsInfo | null>(null);
  const activeSessionIdRef = useRef<string | null>(selectedSession?.id ?? null);
  activeSessionIdRef.current = selectedSession?.id ?? null;
  const handleSessionStatsChange = useCallback((stats: SessionStatsInfo | null) => {
    setSessionStats(stats);
  }, []);

  // Context usage — populated by ChatWindow, displayed in top bar
  const [contextUsage, setContextUsage] = useState<{ percent: number | null; contextWindow: number; tokens: number | null } | null>(null);
  const handleContextUsageChange = useCallback((usage: { percent: number | null; contextWindow: number; tokens: number | null } | null) => {
    setContextUsage(usage);
  }, []);

  const handleSidebarToggle = useCallback(() => {
    if (isMobile) {
      setRightPanelOpen(false);
    }
    setSidebarOpen((open) => !open);
  }, [isMobile]);

  const handleRightPanelToggle = useCallback(() => {
    if (isMobile) {
      setSidebarOpen(false);
      // 移动端抽屉显隐不落盘（见 isMobile effect 注释）。
      setRightPanelOpen((open) => !open);
    } else {
      applyRightPanelOpen(!rightPanelOpen);
    }
  }, [applyRightPanelOpen, isMobile, rightPanelOpen]);

  // 右栏文件预览 tabs：与固定图标导航（branch/info/files/git）共用同一活跃态。
  const [fileTabs, setFileTabs] = useState<Tab[]>([]);
  /** 一级右栏活跃导航 id："branch" | "files" | "git" | "info"。文件 tab 选中独立于导航。 */
  const [activeRightTabId, setActiveRightTabId] = useState<string>("files");
  /** 二级右栏活跃文件 tab id（`file:<bufferKey>`）；null = 无文件选中。 */
  const [activeFileTabId, setActiveFileTabId] = useState<string | null>(null);
  const [pendingCloseTabId, setPendingCloseTabId] = useState<string | null>(null);
  const [fileEditorState, dispatchFileEditor] = useReducer(fileEditorReducer, EMPTY_FILE_EDITOR_STATE);
  const fileEditorStateRef = useRef(fileEditorState);
  fileEditorStateRef.current = fileEditorState;
  const dispatchFileEditorAction = useCallback((action: Parameters<typeof fileEditorReducer>[1]) => {
    // 同步镜像让异步保存回调能看到尚未经过 React render 的最新键入 revision。
    fileEditorStateRef.current = fileEditorReducer(fileEditorStateRef.current, action);
    dispatchFileEditor(action);
  }, []);

  useEffect(() => {
    if (!hasDirtyBuffers(fileEditorState)) return;
    const protectDirtyBuffers = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", protectDirtyBuffers);
    return () => window.removeEventListener("beforeunload", protectDirtyBuffers);
  }, [fileEditorState]);

  const saveFileBuffer = useCallback(async (key: string): Promise<boolean> => {
    const buffer = getBuffer(fileEditorStateRef.current, key);
    if (!buffer || !buffer.sourceSessionId || !buffer.dirty || buffer.saveState === "saving") return false;
    const requestId = globalThis.crypto?.randomUUID?.()
      ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    const requestRevision = buffer.revision;
    const requestedContent = buffer.content;
    dispatchFileEditorAction({ type: "markSaving", key, requestId, requestRevision });
    try {
      const encoded = encodeFilePathForApi(buffer.filePath);
      const params = new URLSearchParams({ type: "save", sessionId: buffer.sourceSessionId });
      const response = await fetch(`/api/files/${encoded}?${params.toString()}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: requestedContent, baseline: buffer.baseline }),
      });
      const body = await response.json().catch(() => ({})) as {
        error?: string;
        size?: number;
        mtimeMs?: number;
        baseline?: { size: number; mtimeMs: number };
      };
      if (response.status === 409) {
        dispatchFileEditorAction({
          type: "saveConflict",
          key,
          requestId,
          baseline: body.baseline,
          message: body.error ?? t("viewer_externalChange"),
        });
        return false;
      }
      if (!response.ok || typeof body.size !== "number" || typeof body.mtimeMs !== "number") {
        throw new Error(body.error ?? t("app_saveFailed", { status: response.status }));
      }
      dispatchFileEditorAction({
        type: "saveSuccess",
        key,
        requestId,
        requestRevision,
        savedContent: requestedContent,
        baseline: { size: body.size, mtimeMs: body.mtimeMs },
      });
      setExplorerRefreshKey((value) => value + 1);
      // diff 定向失效：只携带本次保存的文件路径（新数组引用保证连续保存也触发）。
      setGitAffectedPaths((prev) => [...new Set([...(prev ?? []), buffer.filePath])]);
      // 若保存过程中继续输入，服务器保存成功但 tab 仍有新草稿，不能用于“保存并关闭”。
      const latest = getBuffer(fileEditorStateRef.current, key);
      return Boolean(latest && latest.revision === requestRevision && !latest.dirty);
    } catch (error) {
      dispatchFileEditorAction({
        type: "saveError",
        key,
        requestId,
        message: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }, [dispatchFileEditorAction, t]);

  // Same @mention format as the chat input's @ autocomplete, so the agent's
  // read tool resolves it the same way (it strips the @ prefix).
  const handleAtMention = useCallback((relativePath: string, isDir: boolean) => {
    chatInputRef.current?.insertText(buildAtMentionText(relativePath, isDir));
  }, []);

  const handleAtMentions = useCallback((relativePaths: string[]) => {
    const mentions = buildFileAtMentionsText(relativePaths);
    if (mentions) chatInputRef.current?.insertText(mentions);
  }, []);

  const initialSessionId = initialNavigation.sessionId;
  const identity = useProjectIdentity();
  const { setIdentity, getIdentitySnapshot } = useProjectActions();
  const activeCwd = identity.cwd;
  // True once the initial ?session= URL param has been resolved (or confirmed absent)
  const [initialSessionRestored, setInitialSessionRestored] = useState<boolean>(() => !initialSessionId);
  // URL 恢复和首次身份建立不应清理当前聊天。
  const suppressSessionResetRef = useRef(false);

  // selectedSessionIdRef / newSessionIntentRef 在事件路径即时写入；
  // effect 仅作 state 回流后的兜底同步（同 tick 读必须走事件路径）。
  useEffect(() => {
    selectedSessionIdRef.current = selectedSession?.id ?? null;
  }, [selectedSession?.id]);

  useEffect(() => {
    newSessionIntentRef.current = newSessionIntent;
  }, [newSessionIntent]);

  const invalidateHydrate = useCallback(() => {
    hydrateAbortRef.current?.abort();
    hydrateAbortRef.current = null;
  }, []);

  useEffect(() => {
    const requestedCwd = initialNavigation.requestedCwd;
    if (!requestedCwd) return;

    const controller = new AbortController();
    setInitialCwdStatus("validating");
    setInitialCwdError(null);

    void fetch("/api/cwd/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: requestedCwd }),
      signal: controller.signal,
    })
      .then(async (response) => {
        const data = await response.json().catch(() => ({})) as { cwd?: string; error?: string };
        if (!response.ok || !data.cwd) {
          throw new Error(data.error ?? `HTTP ${response.status}`);
        }

        // The sidebar will notify us when it adopts this cwd. Avoid remounting
        // the just-created empty chat during that initial synchronization.
        suppressSessionResetRef.current = true;
        setIdentity({ cwd: data.cwd, projectRoot: data.cwd, status: "ready", error: null });
        setInitialCwdStatus("ready");
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setInitialCwdError(error instanceof Error ? error.message : String(error));
        setInitialCwdStatus("error");
      });

    return () => controller.abort();
  }, [initialNavigation, setIdentity]);

  const previousProjectIdentityRef = useRef({ cwd: identity.cwd, projectRoot: identity.projectRoot });
  useEffect(() => {
    const previous = previousProjectIdentityRef.current;
    const current = { cwd: identity.cwd, projectRoot: identity.projectRoot };
    previousProjectIdentityRef.current = current;
    const cwdChanged = previous.cwd !== current.cwd;
    const projectChanged = previous.projectRoot !== current.projectRoot;
    if (!cwdChanged && !projectChanged) return;
    if (suppressSessionResetRef.current) {
      suppressSessionResetRef.current = false;
      return;
    }
    if (previous.cwd === null && previous.projectRoot === null) {
      // 首次建立 identity：若尚无选中会话，建立新会话 intent（仅客户端，不 POST）。
      if (!selectedSession && current.cwd) {
        newSessionIntentGenerationRef.current += 1;
        const intent = createNewSessionIntent(current.cwd, newSessionIntentGenerationRef.current);
        newSessionIntentRef.current = intent;
        setNewSessionIntent(intent);
      }
      return;
    }
    if (selectedSession && (selectedSession.projectRoot ?? selectedSession.cwd) === current.projectRoot) return;
    if (selectedSession) {
      selectedSessionIdRef.current = null;
      setSelectedSession(null);
    }
    if (!selectedSession && !cwdChanged) return;
    invalidateHydrate();
    // 切换 project/worktree：只建客户端 intent，禁止调用 /api/agent/new。
    // 不清空 multi-pending：其它项目下已创建的真实 id 仍保留至各自回流/删除。
    if (current.cwd) {
      newSessionIntentGenerationRef.current += 1;
      const intent = createNewSessionIntent(current.cwd, newSessionIntentGenerationRef.current);
      newSessionIntentRef.current = intent;
      setNewSessionIntent(intent);
    } else {
      newSessionIntentRef.current = null;
      setNewSessionIntent(null);
    }
    setSessionKey((key) => key + 1);
    setBranchTree([]);
    setBranchActiveLeafId(null);
    setSystemPrompt(null);
    router.replace("/", { scroll: false });
  }, [identity.cwd, identity.projectRoot, router, selectedSession, invalidateHydrate]);

  const handleSelectSession = useCallback((session: SessionInfo, isRestore = false) => {
    invalidateHydrate();
    // 选中已有会话：使新建 intent 失效，迟到 ensure 不得覆盖当前 chat。
    // 不清理 optimistic pending map：其它真实 id 须保留至 server 回流/显式删除。
    setNewSessionIntent(null);
    newSessionIntentRef.current = null;
    selectedSessionIdRef.current = session.id;
    setSelectedSession(session);
    setSessionKey((k) => k + 1);
    setSystemPrompt(null);
    setInitialSessionRestored(true);
    // On mobile, collapse the overlay drawer so the chat is revealed after pick.
    if (isMobile && !isRestore) setSidebarOpen(false);
    if (isRestore) {
      // URL session 恢复会同时建立项目身份；跳过紧随其后的身份 watcher。
      suppressSessionResetRef.current = true;
    }
    // Skip router.replace when restoring from URL — the param is already correct
    // and calling replace in production Next.js triggers a Suspense remount loop
    if (!isRestore) {
      router.replace(`?session=${encodeURIComponent(session.id)}`, { scroll: false });
    }
  }, [router, isMobile, invalidateHydrate]);

  const handleNewSession = useCallback((targetCwd?: string) => {
    // 侧栏行内入口（项目行/非主 worktree 行）显式给出目标 cwd；其点击路径已先把
    // ProjectContext identity 切到目标 cwd（含 projectRoot）。这里仅兜底：identity
    // 尚未落在目标 cwd 时补齐（projectRoot 缺省由 store 回填为 cwd，随后由
    // worktree 数据权威修正），保证 lazy 新会话落到正确项目。
    const cwd = targetCwd ?? getIdentitySnapshot().cwd;
    if (!cwd) return;
    // 引导页默认选中本次入口的目标项目（顶部新建 = 当前选中项目；项目行 = 对应项目）
    setGuideDefaultCwd(cwd);
    if (getIdentitySnapshot().cwd !== cwd) {
      setIdentity({ cwd, status: "ready", error: null });
    }
    // 本路径已建立 intent + remount；跳过 identity watcher 的二次 intent。
    suppressSessionResetRef.current = true;

    suppressSessionResetRef.current = true;
    invalidateHydrate();
    newSessionIntentGenerationRef.current += 1;
    const intent = createNewSessionIntent(cwd, newSessionIntentGenerationRef.current);
    newSessionIntentRef.current = intent;
    setNewSessionIntent(intent);
    // 不清理其它真实 id 的 pending；仅清空当前选中，进入新 intent 空 chat。
    selectedSessionIdRef.current = null;
    setSelectedSession(null);
    setSessionKey((k) => k + 1);
    setBranchTree([]);
    setBranchActiveLeafId(null);
    setSystemPrompt(null);
    if (isMobile) setSidebarOpen(false);
    router.replace("/", { scroll: false });
  }, [router, isMobile, getIdentitySnapshot, setIdentity, invalidateHydrate]);

  // Global keyboard shortcuts (handles Esc, Ctrl+Alt+N etc.)
  useGlobalKeyboardShortcuts({
    onNewSession: () => handleNewSession(),
    activeCwd,
    disabled: settingsOpen || aboutOpen,
  });

  // Ctrl/Cmd+K 打开命令面板
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        if (settingsOpen || aboutOpen) return;
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [settingsOpen, aboutOpen]);

  /**
   * 按真实 session id 精确补水（有界重试），不再全量 GET /api/sessions 后 find。
   * fork 与 new-session 共用；new-intent 门禁仅在 apply 到当前 chat 时检查。
   */
  const hydrateSelectedSession = useCallback((sessionId: string, options?: { intentId?: string | null; forFork?: boolean }) => {
    invalidateHydrate();
    const controller = new AbortController();
    hydrateAbortRef.current = controller;
    const intentId = options?.intentId ?? null;
    const forFork = options?.forFork === true;

    void hydrateSessionById<SessionInfo>({
      sessionId,
      signal: controller.signal,
      maxAttempts: 5,
      baseDelayMs: 200,
      isCurrent: () => {
        if (controller.signal.aborted) return false;
        if (selectedSessionIdRef.current !== sessionId) return false;
        if (!forFork && intentId) {
          const active = newSessionIntentRef.current;
          if (active && active.id !== intentId) return false;
        }
        return true;
      },
      fetchSession: (id, signal) =>
        fetch(`/api/sessions/${encodeURIComponent(id)}/info`, { signal }),
      parseBody: (body) => {
        const session = (body as { session?: SessionInfo } | null)?.session;
        return session?.id === sessionId ? session : null;
      },
    }).then((result) => {
      if (!result.ok) return;
      if (!shouldApplyHydratedSession({
        selectedSessionId: selectedSessionIdRef.current,
        hydratedId: result.value.id,
        intentId,
        activeIntentId: forFork ? intentId : newSessionIntentRef.current?.id,
      })) {
        return;
      }
      setSelectedSession((prev) => {
        if (!prev || prev.id !== sessionId) return prev;
        // 补全 projectRoot 等服务端字段；已有完整字段时仍可刷新 path/name。
        return { ...prev, ...result.value };
      });
      // 服务端完整字段也可替换侧栏 pending map 中的同 id 条目。
      setOptimisticPendingById((prev) => {
        if (!prev.has(sessionId)) return prev;
        const next = new Map(prev);
        next.set(sessionId, result.value);
        return next;
      });
    }).catch(() => {});
  }, [invalidateHydrate]);

  // ChatWindow：Pi 返回真实 id 后 promote；仅当前 intent 可写当前 chat。
  // 迟到旧 intent 的 session 仍 upsert 进 pending map，不销毁、不选中。
  const handleSessionCreated = useCallback((session: SessionInfo, intentId?: string | null) => {
    const promote = shouldPromoteSessionCreated({
      currentIntentId: newSessionIntentRef.current?.id,
      eventIntentId: intentId,
      selectedSessionId: selectedSessionIdRef.current,
      createdSessionId: session.id,
    });

    // 无论是否仍选中当前 intent：乐观 upsert 进侧栏 multi-pending。
    upsertOptimisticPending(session);
    // 立即并入本地缓存：刷新后 SWR 秒渲染新会话（不等 fetch），避免"新会话消失"
    const cached = loadCachedSessionList();
    if (cached) {
      const merged = [session, ...cached.filter((s) => s.id !== session.id)].slice(0, 50);
      saveCachedSessionList(merged);
    }
    // 仅 session list 刷新；不得带动 worktree preload generation。
    setRefreshKey((k) => k + 1);
  }, [router, hydrateSelectedSession, upsertOptimisticPending]);

  const handleAgentEnd = useCallback(() => {
    setRefreshKey((k) => k + 1);
    // status 全量刷新（聚合视图，服务端有短 TTL 防抖）；
    // 打开文件的 diff 不再全仓重抓——由各 FileViewer 的 SSE watch 定向刷新，
    // gitAffectedPaths 置 null 表示本 run 无明确的文件路径信息。
    setExplorerRefreshKey((k) => k + 1);
    setGitAffectedPaths(null);
  }, []);

  const handleAgentRunningChange = useCallback((running: boolean, sessionId: string | null) => {
    setClientRunningSessionId(running && sessionId ? sessionId : null);
  }, []);

  const handleSessionForked = useCallback((newSessionId: string, prefill?: string) => {
    // fork/新会话成功后切换：预填文本直接注入新会话 draft（新 ChatWindow 挂载时同步读取）。
    if (prefill !== undefined) {
      setDraft(newSessionId, { value: prefill, images: [] });
    }
    invalidateHydrate();
    setNewSessionIntent(null);
    newSessionIntentRef.current = null;
    setRefreshKey((k) => k + 1);
    setSessionKey((k) => k + 1);
    // 用函数式 prev 保留 fork 前会话字段；同时 upsert pending map。
    setSelectedSession((prev) => {
      const forked: SessionInfo = {
        ...(prev ?? { path: "", cwd: activeCwd ?? "", created: "", modified: "", messageCount: 0, firstMessage: "" }),
        id: newSessionId,
      };
      upsertOptimisticPending(forked);
      return forked;
    });
    selectedSessionIdRef.current = newSessionId;
    // fork 复用 targeted hydration，不套 new-intent 门禁。
    hydrateSelectedSession(newSessionId, { forFork: true });
    router.replace(`?session=${encodeURIComponent(newSessionId)}`, { scroll: false });
  }, [router, hydrateSelectedSession, invalidateHydrate, activeCwd, upsertOptimisticPending]);

  const handleInitialRestoreDone = useCallback(() => {
    setInitialSessionRestored(true);
  }, []);

  const handleSessionDeleted = useCallback((sessionId: string) => {
    setRefreshKey((k) => k + 1);
    removeOptimisticPending(sessionId);
    if (selectedSession?.id === sessionId) {
      invalidateHydrate();
      setNewSessionIntent(null);
      newSessionIntentRef.current = null;
      selectedSessionIdRef.current = null;
      setSelectedSession(null);
      setSessionKey((k) => k + 1);
      setBranchTree([]);
      setBranchActiveLeafId(null);
      setSystemPrompt(null);
      router.replace("/", { scroll: false });
    }
  }, [selectedSession, router, invalidateHydrate, removeOptimisticPending]);

  const handleOpenFile = useCallback((filePath: string, fileName: string, sourceSessionId?: string | null, writable = false, mode: "content" | "diff" = "content") => {
    const bufferKey = makeFileBufferKey(filePath, sourceSessionId);
    const tabId = `file:${bufferKey}`;
    setFileTabs((prev) => {
      const existing = prev.find((t) => t.id === tabId);
      if (!existing) return [...prev, { id: tabId, label: fileName, filePath, sourceSessionId, bufferKey, writable, readOnly: !writable, kind: "file" as const }];
      return prev;
    });
    setPendingCloseTabId(null);
    // 文件选中走独立 activeFileTabId；一级右栏 activeRightTabId 保持最后导航，不再被 file:* 占用。
    setActiveFileTabId(tabId);
    setSecondaryPanelMode(mode);
    applyChangesPanelOpen(true);
    // 打开文件时抬升编辑区宽度，避免默认过窄只剩「一小条」。
    setChangesPanelWidth((prev) => {
      const next = clampChangesPanelWidth(Math.max(prev, CHANGES_PANEL_WIDTH_OPEN_MIN));
      if (next !== prev) saveChangesPanelPreferences({ width: next });
      return next;
    });
    // 文件详情属于二级右栏；一级右栏保持导航，聊天主区始终可见。
    // 移动端右栏为全屏 overlay 抽屉：关闭会话侧栏避免三层覆盖。
    if (isMobile) {
      setSidebarOpen(false);
      setRightPanelOpen(true);
    } else {
      applyRightPanelOpen(true);
    }
  }, [applyChangesPanelOpen, applyRightPanelOpen, isMobile]);

  const handleOpenLinkedFile = useCallback((filePath: string) => {
    handleOpenFile(filePath, getFileName(filePath), selectedSession?.id ?? null, Boolean(selectedSession?.id && selectedSession.readOnly !== true));
  }, [handleOpenFile, selectedSession?.id, selectedSession?.readOnly]);

  const closeFileTabNow = useCallback((tabId: string, removeBuffer = true) => {
    const tab = fileTabs.find((item) => item.id === tabId);
    if (removeBuffer && tab?.bufferKey) dispatchFileEditorAction({ type: "remove", key: tab.bufferKey });
    const remaining = fileTabs.filter((t) => t.id !== tabId);
    setFileTabs(remaining);
    // 活跃文件 tab 关闭：回退到最后一个文件 tab，否则无文件 → 二级面板自动关闭（需求 4）。
    if (remaining.length === 0) {
      setActiveFileTabId(null);
      applyChangesPanelOpen(false);
    } else {
      setActiveFileTabId((cur) => (cur !== tabId ? cur : remaining[remaining.length - 1].id));
    }
    setPendingCloseTabId((current) => current === tabId ? null : current);
  }, [applyChangesPanelOpen, dispatchFileEditorAction, fileTabs]);

  const handleCloseFileTab = useCallback((tabId: string) => {
    const tab = fileTabs.find((item) => item.id === tabId);
    const buffer = tab?.bufferKey ? getBuffer(fileEditorStateRef.current, tab.bufferKey) : undefined;
    if (buffer?.dirty) {
      setActiveFileTabId(tabId);
      setPendingCloseTabId(tabId);
      return;
    }
    closeFileTabNow(tabId);
  }, [closeFileTabNow, fileTabs]);

  /** 关闭全部文件（需求 5）：tab 行右侧按钮。全部干净时清空 fileTabs + 关面板；
   *  存在未保存修改时不批量丢弃——原子取消，转入第一个 dirty tab 的既有确认流。 */
  const handleCloseAllFileTabs = useCallback(() => {
    const dirtyTab = fileTabs.find((tab) => {
      if (!tab.bufferKey) return false;
      const buffer = getBuffer(fileEditorStateRef.current, tab.bufferKey);
      return buffer?.dirty === true;
    });
    if (dirtyTab) {
      setActiveFileTabId(dirtyTab.id);
      setPendingCloseTabId(dirtyTab.id);
      return;
    }
    for (const tab of fileTabs) {
      if (tab.bufferKey) dispatchFileEditorAction({ type: "remove", key: tab.bufferKey });
    }
    setFileTabs([]);
    setActiveFileTabId(null);
    setPendingCloseTabId(null);
    applyChangesPanelOpen(false);
  }, [applyChangesPanelOpen, dispatchFileEditorAction, fileTabs]);

  const handleSaveAndClose = useCallback(async () => {
    const tab = fileTabs.find((item) => item.id === pendingCloseTabId);
    if (!tab?.bufferKey) return;
    if (await saveFileBuffer(tab.bufferKey)) closeFileTabNow(tab.id);
  }, [closeFileTabNow, fileTabs, pendingCloseTabId, saveFileBuffer]);

  const handleDiscardAndClose = useCallback(() => {
    const tab = fileTabs.find((item) => item.id === pendingCloseTabId);
    if (!tab) return;
    if (tab.bufferKey) {
      dispatchFileEditorAction({ type: "discard", key: tab.bufferKey });
      dispatchFileEditorAction({ type: "remove", key: tab.bufferKey });
    }
    closeFileTabNow(tab.id, false);
  }, [closeFileTabNow, dispatchFileEditorAction, fileTabs, pendingCloseTabId]);

  // 一级右栏只保留固定图标导航；文件预览 tab 迁移到二级右栏。
  const rightTabs = useMemo<Tab[]>(() => [
    { id: "branch", label: t("branches"), filePath: "", kind: "branch" },
    { id: "info", label: t("app_sessionInfo"), filePath: "", kind: "info" },
    { id: "files", label: t("workspace_files"), filePath: "", kind: "files" },
    { id: "git", label: t("workspace_gitChanges"), filePath: "", kind: "git" },
  ], [t]);

  const handleSelectRightTab = useCallback((tabId: string) => {
    // activeRightTabId 恒为一级导航 id（文件选中已解耦到 activeFileTabId）。
    const activeNavigationId = activeRightTabId;
    if (rightPanelOpen && tabId === activeNavigationId) {
      if (isMobile) setRightPanelOpen(false);
      else applyRightPanelOpen(false);
      return;
    }
    setPendingCloseTabId(null);
    setActiveRightTabId(tabId);
    if (isMobile) {
      setSidebarOpen(false);
      setRightPanelOpen(true);
    } else {
      applyRightPanelOpen(true);
    }
  }, [activeRightTabId, applyRightPanelOpen, isMobile, rightPanelOpen]);

  // 顶栏 stats / ChatWindow /session 命令入口：打开右栏并切到「会话信息」Tab。
  const openSessionInfoTab = useCallback(() => {
    if (isMobile) {
      setSidebarOpen(false);
      setRightPanelOpen(true);
    } else {
      applyRightPanelOpen(true);
    }
    setPendingCloseTabId(null);
    setActiveRightTabId("info");
  }, [applyRightPanelOpen, isMobile]);

  // 新会话 cwd 来自 intent 捕获值，不从随后可能变化的 activeCwd 裸推导。
  const effectiveNewSessionCwd =
    selectedSession === null ? (newSessionIntent?.cwd ?? null) : null;
  const showChat = selectedSession !== null || effectiveNewSessionCwd !== null;
  // While restoring initial session from URL, don't show the placeholder
  const showPlaceholder = initialSessionRestored && !showChat;

  const activeFileTab = activeFileTabId
    ? fileTabs.find((t) => t.id === activeFileTabId) ?? null
    : null;
  const activeCwdName = activeCwd ? getFileName(activeCwd) || activeCwd : null;
  const windowTitle = activeCwdName ? `${activeCwdName} - Pidance` : "Pidance";

  useEffect(() => {
    const syncWindowTitle = () => {
      if (document.title !== windowTitle) document.title = windowTitle;
    };

    syncWindowTitle();
    const observer = new MutationObserver(syncWindowTitle);
    observer.observe(document.head, { childList: true, subtree: true, characterData: true });
    return () => observer.disconnect();
  }, [windowTitle]);

  const sidebarContent = (
    <>
      <SessionSidebar
        selectedSessionId={selectedSession?.id ?? null}
        onSelectSession={handleSelectSession}
        onNewSession={handleNewSession}
        initialSessionId={initialSessionId}
        skipInitialProjectSelection={initialNavigation.requestedCwd !== null}
        onInitialRestoreDone={handleInitialRestoreDone}
        refreshKey={refreshKey}
        onSessionDeleted={handleSessionDeleted}
        onProjectAdded={(cwd) => handleNewSession(cwd)}
        optimisticSessions={optimisticPendingSessions}
        clientRunningSessionId={clientRunningSessionId}
      />
      {/* 底部 Settings / About：同规格图标按钮（24×24），不显示永久文字标签。登录管理在 设置 → 通用。 */}
      <div style={{ padding: "6px 8px", flexShrink: 0, display: "flex", alignItems: "center", gap: 4 }}>
        <button
          type="button"
          onClick={() => setSettingsOpen(true)}
          data-tooltip={t("app_settings")}
          aria-label={t("app_settings")}
          className="sidebar-icon-btn tooltip-up"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.83 2.83-.06-.06a1.7 1.7 0 0 0-1.88-.34 1.7 1.7 0 0 0-1.03 1.56V21h-4v-.08A1.7 1.7 0 0 0 8.95 19.4a1.7 1.7 0 0 0-1.88.34l-.06.06-2.83-2.83.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.56-1.03H3v-4h.08A1.7 1.7 0 0 0 4.6 8.95a1.7 1.7 0 0 0-.34-1.88l-.06-.06 2.83-2.83.06.06A1.7 1.7 0 0 0 8.95 4.6 1.7 1.7 0 0 0 9.97 3.04V3h4v.08A1.7 1.7 0 0 0 15 4.6a1.7 1.7 0 0 0 1.88-.34l.06-.06 2.83 2.83-.06.06A1.7 1.7 0 0 0 19.4 9c.12.42.52.98 1.56 1.03H21v4h-.08A1.7 1.7 0 0 0 19.4 15Z" />
          </svg>
        </button>
        <button
          type="button"
          onClick={() => setAboutOpen(true)}
          data-tooltip={t("app_about")}
          aria-label={t("app_about")}
          className={`sidebar-icon-btn tooltip-up${aboutOpen ? " sidebar-icon-btn--active" : ""}`}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="10" />
            <path d="M12 16v-4" />
            <path d="M12 8h.01" />
          </svg>
        </button>
      </div>
    </>
  );

  return (
    <>
    <style>{`
      @media (max-width: 640px) {
        .sidebar-overlay-backdrop.sidebar-mobile-pending {
          opacity: 0 !important;
          pointer-events: none !important;
        }
        .sidebar-container.sidebar-mobile-pending.sidebar-open {
          transform: translateX(-100%);
          box-shadow: none;
        }
        .workspace-overlay-backdrop.workspace-mobile-pending {
          opacity: 0 !important;
          pointer-events: none !important;
        }
        .workspace-container.workspace-mobile-pending.workspace-open {
          transform: translateX(100%);
          box-shadow: none;
        }
      }
    `}</style>
    <div style={{ display: "flex", height: "100dvh", overflow: "hidden", background: "var(--bg)" }}>
      {/* Mobile overlay backdrop */}
      <div
        className={`sidebar-overlay-backdrop${mobileSidebarReady ? "" : " sidebar-mobile-pending"}`}
        onClick={() => setSidebarOpen(false)}
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 199,
          background: "var(--overlay)",
          opacity: sidebarOpen ? 1 : 0,
          pointerEvents: sidebarOpen ? "auto" : "none",
          transition: "opacity 0.25s ease",
        }}
      />

      {/* Left sidebar */}
      <div
        className={`sidebar-container${sidebarOpen ? " sidebar-open" : " sidebar-closed"}${mobileSidebarReady ? "" : " sidebar-mobile-pending"}${sidebarDragging ? " sidebar-dragging" : ""}`}
        style={{
          background: "var(--bg-panel)",
          borderRight: "1px solid var(--border)",
          display: "flex",
          flexDirection: "column",
          flexShrink: 0,
          zIndex: 200,
          "--sidebar-width": `${sidebarWidth}px`,
        } as CSSProperties}
      >
        <div className="sidebar-inner">
          {sidebarContent}
        </div>
        {/* 桌面调宽手柄：pointer-capture 拖拽 + 键盘（Arrow/Home/End）；移动端不渲染且 CSS 隐藏 */}
        {sidebarOpen && !isMobile && (
          <div
            className={`sidebar-resize-handle${sidebarDragging ? " dragging" : ""}`}
            role="separator"
            aria-orientation="vertical"
            tabIndex={0}
            title={t("app_sidebarResizeHandle")}
            aria-label={t("app_sidebarResizeHandle")}
            aria-valuenow={sidebarWidth}
            aria-valuemin={SIDEBAR_WIDTH_MIN}
            aria-valuemax={SIDEBAR_WIDTH_MAX}
            onPointerDown={handleSidebarResizeStart}
            onPointerMove={handleSidebarResizeMove}
            onPointerUp={handleSidebarResizeEnd}
            onPointerCancel={handleSidebarResizeEnd}
            onKeyDown={handleSidebarResizeKeyDown}
            onDoubleClick={handleSidebarResizeReset}
          />
        )}
      </div>

      {/* Center: chat */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", minWidth: 0 }}>
        {/* Top bar with sidebar toggle */}
        <div className="app-top-bar">
          <button
            onClick={handleSidebarToggle}
            title={sidebarOpen ? t("app_hideSidebar") : t("app_showSidebar")}
            data-tooltip={sidebarOpen ? t("app_hideSidebar") : t("app_showSidebar")}
            className="instant-tooltip"
            aria-label={sidebarOpen ? t("app_hideSidebar") : t("app_showSidebar")}
            style={{
              display: "flex", alignItems: "center", justifyContent: "center",
              width: 36, height: 36, padding: 0,
              background: "none", border: "none", borderRight: "1px solid var(--border)",
              color: "var(--text-muted)", cursor: "pointer", flexShrink: 0, transition: "color 0.12s",
            }}
            onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-muted)"; }}
          >
            {sidebarOpen ? (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="18" height="18" rx="2" /><line x1="9" y1="3" x2="9" y2="21" />
              </svg>
            ) : (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <line x1="3" y1="6" x2="21" y2="6" /><line x1="3" y1="12" x2="21" y2="12" /><line x1="3" y1="18" x2="21" y2="18" />
              </svg>
            )}
          </button>
          {/* Session stats — right-aligned in top bar */}
          {showChat && (sessionStats || contextUsage) && (() => {
            const fmt = (n: number) => n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(0)}k` : String(n);

            let ctxColor = "var(--text-muted)";
            let ctxStr: string | null = null;
            if (contextUsage?.contextWindow) {
              const pct = contextUsage.percent;
              if (pct !== null && pct > 90) ctxColor = "var(--status-danger)";
              else if (pct !== null && pct > 70) ctxColor = "var(--status-warning)";
              // 手机顶栏空间紧：只显示百分比；完整「pct / window」放 tooltip。
              ctxStr = pct !== null
                ? (isMobile ? `${pct.toFixed(0)}%` : `${pct.toFixed(0)}% / ${fmt(contextUsage.contextWindow)}`)
                : (isMobile ? "?" : `? / ${fmt(contextUsage.contextWindow)}`);
            }

            // 用量统计（词元/费用）已移除；顶栏只保留上下文信息
            const tooltip = contextUsage?.contextWindow
              ? (() => {
                  const pct = contextUsage.percent;
                  return t("app_contextTooltip", { pct: pct !== null ? pct.toFixed(1) + "%" : t("app_unknown"), total: contextUsage.contextWindow.toLocaleString() });
                })()
              : null;

            const infoTabActive = rightPanelOpen && activeRightTabId === "info";
            return (
              <button
                type="button"
                onClick={openSessionInfoTab}
                title={tooltip || t("app_sessionInfo")}
                data-tooltip={tooltip || t("app_sessionInfo")}
                className="instant-tooltip app-top-bar-stats"
                aria-label={t("app_sessionInfo")}
                aria-pressed={infoTabActive}
                style={{
                  marginLeft: "auto",
                  display: "flex", alignItems: "center", gap: isMobile ? 4 : 10,
                  paddingLeft: isMobile ? 8 : 12,
                  paddingRight: isMobile ? 8 : 12,
                  height: "100%",
                  minWidth: 0,
                  maxWidth: isMobile ? "48vw" : undefined,
                  overflow: "hidden",
                  background: infoTabActive ? "var(--bg-selected)" : "none",
                  border: "none",
                  borderTop: infoTabActive ? "2px solid var(--accent)" : "2px solid transparent",
                  fontSize: isMobile ? 12 : 11, color: "var(--text-muted)",
                  whiteSpace: "nowrap", cursor: "pointer",
                  fontVariantNumeric: "tabular-nums",
                  transition: "color 0.1s, background 0.1s",
                }}
                onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.color = infoTabActive ? "var(--text)" : "var(--text-muted)"; }}
              >
                {isMobile && (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <circle cx="12" cy="12" r="10" /><line x1="12" y1="16" x2="12" y2="12" /><line x1="12" y1="8" x2="12.01" y2="8" />
                  </svg>
                )}
                {ctxStr && (
                  <span style={{ display: "flex", alignItems: "center", gap: 4, color: ctxColor }}>
                    <svg width="12" height="12" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M1 9 L1 5 Q1 1 5 1 Q9 1 9 5 L9 9" /><line x1="1" y1="9" x2="9" y2="9" />
                    </svg>
                    {ctxStr}
                  </span>
                )}
              </button>
            );
          })()}
          {/* 右栏（文件/diff/会话信息面板）开关；stats 按钮缺省时自身右对齐 */}
          {isMobile && <button
            type="button"
            onClick={handleRightPanelToggle}
            title={rightPanelOpen ? t("app_hidePanel") : t("app_showPanel")}
            data-tooltip={rightPanelOpen ? t("app_hidePanel") : t("app_showPanel")}
            className="instant-tooltip"
            aria-label={rightPanelOpen ? t("app_hidePanel") : t("app_showPanel")}
            aria-pressed={rightPanelOpen}
            style={{
              marginLeft: showChat && (sessionStats || contextUsage) ? 0 : "auto",
              display: "flex", alignItems: "center", justifyContent: "center",
              width: 36, height: 36, padding: 0,
              background: rightPanelOpen ? "var(--bg-selected)" : "none",
              border: "none", borderLeft: "1px solid var(--border)",
              color: rightPanelOpen ? "var(--text)" : "var(--text-muted)",
              cursor: "pointer", flexShrink: 0,
              transition: "background 0.12s, color 0.12s",
            }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <line x1="15" y1="3" x2="15" y2="21" />
            </svg>
          </button>}
        </div>

        {/* Chat 固定主区：打开文件/diff/会话信息只展开右栏，Chat 始终可见且保持挂载，
            SSE/流式状态与滚动不丢失（P1 分屏语义，不再有互斥隐藏）。 */}
        <div style={{ flex: 1, overflow: "hidden", position: "relative" }}>
          <div style={{ height: "100%", overflow: "hidden", position: "relative" }}>
            {showChat ? (
              <ChatWindow
                key={sessionKey}
                session={selectedSession}
                newSessionCwd={effectiveNewSessionCwd}
                newSessionIntentId={newSessionIntent?.id ?? null}
                guideDefaultCwd={guideDefaultCwd}
                onAgentEnd={handleAgentEnd}
                onAgentRunningChange={handleAgentRunningChange}
                onSessionCreated={handleSessionCreated}
                onSessionForked={handleSessionForked}
                modelsRefreshKey={modelsRefreshKey}
                chatInputRef={chatInputRef}
                onBranchDataChange={handleBranchDataChange}
                onSystemPromptChange={handleSystemPromptChange}
                onSessionStatsChange={handleSessionStatsChange}
                onSessionStatsPanelOpen={openSessionInfoTab}
                onContextUsageChange={handleContextUsageChange}
                onOpenFile={handleOpenLinkedFile}
              />
            ) : initialCwdStatus === "validating" ? (
              <div role="status" style={{ height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8, padding: 24, color: "var(--text-muted)", textAlign: "center" }}>
                <div style={{ fontSize: 14, color: "var(--text)" }}>{t("app_openWorkspace")}</div>
                <div style={{ maxWidth: "min(720px, 100%)", overflowWrap: "anywhere", fontFamily: "var(--font-mono)", fontSize: 12 }}>{initialNavigation.requestedCwd}</div>
              </div>
            ) : initialCwdStatus === "error" ? (
              <div role="alert" style={{ height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8, padding: 24, color: "var(--text-muted)", textAlign: "center" }}>
                <div style={{ fontSize: 14, color: "var(--status-danger)" }}>{t("app_workspaceUnavailable")}</div>
                <div style={{ maxWidth: "min(720px, 100%)", overflowWrap: "anywhere", fontFamily: "var(--font-mono)", fontSize: 12 }}>{initialNavigation.requestedCwd}</div>
                <div style={{ maxWidth: 720, fontSize: 12 }}>{initialCwdError}</div>
              </div>
            ) : showPlaceholder ? (
              activeCwd ? (
                <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-muted)", fontSize: 15 }}>{t("app_selectSessionFromSidebar")}</div>
              ) : (
                <div style={{ position: "absolute", top: 12, left: 12, display: "flex", alignItems: "flex-start", gap: 8, userSelect: "none", pointerEvents: "none" }}>
                  <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.7, flexShrink: 0 }}>
                    <line x1="20" y1="12" x2="4" y2="12" /><polyline points="10 6 4 12 10 18" />
                  </svg>
                  <div>
                    <div style={{ fontSize: 18, fontWeight: 600, color: "var(--text)", marginBottom: 8 }}>{t("app_getStarted")}</div>
                    <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.8 }}>
                      <span style={{ color: "var(--text-dim)", marginRight: 6 }}>1.</span>{t("app_setupSelectProject")}<br />
                      <span style={{ color: "var(--text-dim)", marginRight: 6 }}>2.</span>{t("app_setupAddModel")}
                    </div>
                  </div>
                </div>
              )
            ) : null}
          </div>
        </div>
      </div>

      {changesPanelOpen && (
        <aside className="changes-panel" style={{ width: changesPanelWidth, height: "100%", minHeight: 0, display: "flex", flexDirection: "column" }} aria-label={t("changes_title")}>
          <div
            className={`changes-panel-resize-handle${changesPanelDragging ? " dragging" : ""}`}
            role="separator"
            aria-orientation="vertical"
            tabIndex={0}
            title={t("changes_resizeHandle")}
            aria-label={t("changes_resizeHandle")}
            aria-valuenow={changesPanelWidth}
            aria-valuemin={CHANGES_PANEL_WIDTH_MIN}
            aria-valuemax={CHANGES_PANEL_WIDTH_MAX}
            onPointerDown={handleChangesPanelResizeStart}
            onPointerMove={handleChangesPanelResizeMove}
            onPointerUp={handleChangesPanelResizeEnd}
            onPointerCancel={handleChangesPanelResizeEnd}
            onKeyDown={handleChangesPanelResizeKeyDown}
            onDoubleClick={() => applyChangesPanelWidth(CHANGES_PANEL_WIDTH_DEFAULT)}
          />
          <ChangesPanel open={changesPanelOpen} width={changesPanelWidth} onWidthChange={applyChangesPanelWidth} cwd={activeCwd} isMobile={isMobile} mobileReady={mobileWorkspaceReady} tabs={fileTabs} activeTabId={activeFileTabId ?? ""} onSelectTab={(tabId) => { setPendingCloseTabId(null); setActiveFileTabId(tabId); }} onCloseTab={handleCloseFileTab} onCloseAllTabs={handleCloseAllFileTabs} pendingCloseTabLabel={pendingCloseTabId ? fileTabs.find((tab) => tab.id === pendingCloseTabId)?.label ?? null : null} onSaveAndClose={() => void handleSaveAndClose()} onDiscardAndClose={handleDiscardAndClose} onCancelClose={() => setPendingCloseTabId(null)} activeMode={secondaryPanelMode} gitAffectedPaths={gitAffectedPaths} fileViewerContent={activeFileTab?.filePath ? <div style={{ flex: "1 1 auto", minHeight: 0, height: "100%", overflow: "hidden", display: "flex", flexDirection: "column" }}><FileViewer filePath={activeFileTab.filePath} cwd={activeCwd ?? undefined} sourceSessionId={activeFileTab.sourceSessionId} writable={activeFileTab.writable === true} buffer={activeFileTab.bufferKey ? getBuffer(fileEditorState, activeFileTab.bufferKey) : undefined} dispatchBuffer={dispatchFileEditorAction} onSave={activeFileTab.bufferKey ? () => saveFileBuffer(activeFileTab.bufferKey!) : undefined} gitAffectedPaths={gitAffectedPaths} onOpenFile={(filePath) => handleOpenFile(filePath, getFileName(filePath), activeFileTab.sourceSessionId, activeFileTab.writable === true)} /></div> : null} />
        </aside>
      )}

      {/* 移动端遮罩：点击关闭右栏 */}
      <div
        className={`sidebar-overlay-backdrop workspace-overlay-backdrop${mobileWorkspaceReady ? "" : " workspace-mobile-pending"}`}
        onClick={() => setRightPanelOpen(false)}
        style={{
          position: "fixed", inset: 0, zIndex: 199,
          background: "var(--overlay)",
          opacity: isMobile && rightPanelOpen ? 1 : 0,
          pointerEvents: isMobile && rightPanelOpen ? "auto" : "none",
          transition: "opacity 0.25s ease",
        }}
      />

      <RightPanel
        open={rightPanelOpen}
        width={rightPanelWidth}
        onWidthChange={applyRightPanelWidth}
        onClose={() => isMobile ? setRightPanelOpen(false) : applyRightPanelOpen(false)}
        cwd={activeCwd}
        isMobile={isMobile}
        mobileReady={mobileWorkspaceReady}
        tabs={rightTabs}
        activeTabId={activeRightTabId}
        onSelectTab={handleSelectRightTab}
        sessionInfoContent={(
          <SessionInfoPanel
            session={selectedSession}
            sessionStats={sessionStats}
            contextUsage={contextUsage}
            systemPrompt={systemPrompt}
          />
        )}
        branchContent={(
          <BranchNavigator
            tree={branchTree}
            activeLeafId={branchActiveLeafId}
            onLeafChange={handleBranchLeafChange}
            branchActions={branchActions}
            hasSession={showChat}
            panel
          />
        )}
        onOpenFile={(filePath, fileName, mode) => handleOpenFile(filePath, fileName, selectedSession?.id ?? null, Boolean(selectedSession?.id && selectedSession.readOnly !== true), mode)}
        fileRefreshKey={explorerRefreshKey}
        gitRefreshKey={explorerRefreshKey}
        onAtMention={handleAtMention}
        onAtMentions={handleAtMentions}
      />
    </div>
    {settingsOpen && (
      <SettingsView
        initialPage={settingsInitialPage}
        cwd={activeCwd ?? selectedSession?.cwd ?? null}
        sessionId={selectedSession?.id ?? null}
        onClose={() => {
          setSettingsOpen(false);
          setModelsRefreshKey((key) => key + 1);
        }}
        onModelsChanged={() => {
          setSettingsOpen(false);
          setModelsRefreshKey((key) => key + 1);
        }}
        onAuthStateChange={() => setModelsRefreshKey((key) => key + 1)}
        onPluginsReloaded={() => setSessionKey((key) => key + 1)}
      />
    )}
    <UpdateBanner />
    <AboutDialog open={aboutOpen} onClose={() => setAboutOpen(false)} />
    <CommandPalette
      open={paletteOpen}
      onClose={() => setPaletteOpen(false)}
      onSelectSession={(session) => handleSelectSession(session)}
      onNewSession={() => handleNewSession()}
      onOpenFile={(filePath, fileName) => handleOpenFile(filePath, fileName, selectedSession?.id ?? null, Boolean(selectedSession?.id && selectedSession.readOnly !== true), "content")}
      onOpenSettings={(page) => {
        setSettingsOpen(true);
        setSettingsInitialPage(page);
      }}
      onToggleTheme={toggleTheme}
      cwd={activeCwd ?? selectedSession?.cwd ?? null}
    />
    </>
  );
}
