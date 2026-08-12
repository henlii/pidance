"use client";

import { createContext, useContext, useEffect, useLayoutEffect, useState, useCallback, useMemo, useRef } from "react";
import type { SessionInfo } from "@/lib/types";
import { displayCwd, getRecentProjects, projectDisplayName } from "@/lib/project-context";
import {
  isSessionNodeEffectivelyCollapsed,
  normalizeSessionQuery,
  type SessionDisplayNode,
  type SessionRelationKind,
} from "./session-tree";
import {
  buildSidebarTree,
  collectAllCollapseIds,
  collectSubagentParentIdsFromSidebarTree,
  filterClosedProjects,
  filterSidebarTree,
  locateSessionInSidebarTree,
  pickProjectRootAfterClose,
  type SidebarProjectNode,
  type SidebarWorktreeGroup,
} from "./session-sidebar-model";
import {
  loadSidebarPreferences,
  saveSidebarPreferences,
  type ProjectAliases,
  type SidebarDisplayMode,
  type SidebarPreferences,
} from "@/lib/ui-preferences";
import { loadCachedSessionList, saveCachedSessionList } from "@/lib/session-list-cache";
import { ProjectAssetsEditor } from "./ProjectAssetsEditor";
import {
  bumpGroupVisibleCount,
  deriveRecentSessions,
  RECENT_SESSIONS_LIMIT,
  RECENT_SESSIONS_INITIAL_VISIBLE,
  RECENT_SESSIONS_LOAD_MORE,
  getGroupVisibleCount,
  getVisibleTopLevelNodes,
  mergeOptimisticSessions,
  reconcilePendingSessionIds,
  resetGroupVisibleCount,
  shouldApplySessionListResponse,
  upsertProjectWorktreeSnapshot,
} from "./session-sidebar-state";
import { getSessionCapabilities } from "./session-capabilities";
import { useProjectActions, useProjectIdentity } from "./ProjectProvider";
import { ViewportDialog } from "./ui/ViewportDialog";

import { useI18n } from "@/lib/i18n";
import { loadUnreadSessionIds, saveUnreadSessionIds } from "@/lib/unread-sessions-storage";
import {
  AnimatedDropdown,
  ArchiveIcon,
  BranchIcon,
  BranchPlusIcon,
  ChatPlusIcon,
  CheckIcon,
  ChevronButton,
  DialogButton,
  DisplayMenuItem,
  FolderIcon,
  HistoryIcon,
  FolderPlusIcon,
  formatRelativeTime,
  GroupPagination,
  HomeIcon,
  PathLabel,
  PiWebTitle,
  RefreshIcon,
  RunningDurationText,
  RunningSessionIndicator,
  SearchIcon,
  SidebarIconButton,
  SlidersIcon,
  TrashIcon,
  UnreadSessionIndicator,
  WorktreeActions,
  XIcon,
} from "@/components/session-sidebar/display";
import { ProjectSection, WorktreeGroupSection, SessionTreeItem, SessionItem } from "@/components/session-sidebar/sections";
import { ProjectRowMenu, SessionRowMenu } from "@/components/session-sidebar/menus";
import { ArchiveView } from "@/components/ArchiveView";
import { canArchiveSession } from "./session-capabilities";
import { archiveSession, archiveFailureKind } from "@/lib/session-archive-client";
import { useWorktreePreload } from "@/hooks/useWorktreePreload";
import { trackRunningStartedAt } from "@/lib/running-duration";

/**
 * 共享运行计时上下文（P1-5）：
 * - startedAt：sessionId → 首次见到 running 的时刻（first-seen 近似）；
 *   刷新后 SSE 重建、无记录时，行内回退显示「运行中」而非伪造时长。
 * - now：共享 1Hz ticker 的最新时间；无 running 会话时 ticker 停止。
 * 每个展开会话行经 context 读取，不逐行建 interval。
 */
// 统一侧栏树几何：指示器固定在 gutter，每深入一层只增加一个 14px 步进；
// 行内容从 BASE_LEFT 开始。叶子行仍渲染透明指示器槽，避免内容横向跳动。
const SIDEBAR_GUTTER = 6;
/** 图标列槽位：需容纳运行中圆环（约 18px）与折叠箭头。 */
const SIDEBAR_INDICATOR_SLOT = 20;
const SIDEBAR_INDICATOR_GAP = 6;
const SIDEBAR_DEPTH_STEP = 14;
// 文字起点 = gutter + 指示器槽位 + 间距（图标/chevron 与文字相邻，同 openchamber）。
// 同深度行图标/文字各自对齐；子会话（depth>0）逐层缩进以区分层级。
const SIDEBAR_BASE_LEFT = SIDEBAR_GUTTER + SIDEBAR_INDICATOR_SLOT + SIDEBAR_INDICATOR_GAP;
const sidebarRowPaddingLeft = (depth: number) => SIDEBAR_BASE_LEFT + depth * SIDEBAR_DEPTH_STEP;
const sidebarIndicatorLeft = (depth: number) => SIDEBAR_GUTTER + depth * SIDEBAR_DEPTH_STEP;

import { RunningTimeContext } from "@/components/session-sidebar/running-time";


declare global {
  interface Window {
    piDesktop?: {
      selectDirectory: () => Promise<string | null>;
    };
  }
}

interface Props {
  selectedSessionId: string | null;
  onSelectSession: (session: SessionInfo, isRestore?: boolean) => void;
  onNewSession?: (cwd?: string) => void;
  initialSessionId?: string | null;
  skipInitialProjectSelection?: boolean;
  onInitialRestoreDone?: () => void;
  refreshKey?: number;
  onSessionDeleted?: (sessionId: string) => void;
  /** 添加项目成功：通知上层进入引导页并选中新项目 */
  onProjectAdded?: (cwd: string) => void;
  /**
   * 真实 id 已返回、列表尚未回流的乐观会话列表（多 id）。
   * 内部按 id upsert 进 pending map，与 server 列表 merge。
   */
  optimisticSessions?: readonly SessionInfo[];
  /** 当前聊天会话 agentRunning（含冷启动窗口，比 SSE 更早） */
  clientRunningSessionId?: string | null;
}


// ── 主组件 ─────────────────────────────────────────────────────────────────

export function SessionSidebar({ selectedSessionId, onSelectSession, onNewSession, initialSessionId, skipInitialProjectSelection, onInitialRestoreDone, refreshKey, onSessionDeleted, onProjectAdded, optimisticSessions, clientRunningSessionId }: Props) {
  const { t } = useI18n();
  const [serverSessions, setServerSessions] = useState<SessionInfo[]>([]);
  const serverSessionsRef = useRef<SessionInfo[]>([]);
  const [pendingById, setPendingById] = useState<Map<string, SessionInfo>>(() => new Map());
  const [pendingIds, setPendingIds] = useState<Set<string>>(() => new Set());
  const [deletedIds, setDeletedIds] = useState<Set<string>>(() => new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const sessionListFetchGenRef = useRef(0);
  const { cwd: selectedCwd, projectRoot: selectedProjectRoot } = useProjectIdentity();
  const { setIdentity } = useProjectActions();
  const [homeDir, setHomeDir] = useState<string>("");
  // 添加项目弹窗（ViewportDialog；原生目录选择仅在弹窗内填充输入，不直接提交）
  const [customPathOpen, setCustomPathOpen] = useState(false);
  const [customPathValue, setCustomPathValue] = useState("");
  const [customPathError, setCustomPathError] = useState<string | null>(null);
  const [customPathValidating, setCustomPathValidating] = useState(false);
  const customPathInputRef = useRef<HTMLInputElement>(null);
  // 目录选择（对齐上游 pi-web 0.8.6 directory-picker：手动 Go/Enter 浏览、
  // Select 只选已浏览路径；保留 OpenChamber 式 git 状态徽标）
  const [browseEntries, setBrowseEntries] = useState<Array<{ name: string; path: string }>>([]);
  const [browseGit, setBrowseGit] = useState<{ isRepo: boolean; branch: string | null } | null>(null);
  const [browseLoading, setBrowseLoading] = useState(false);
  const [browseMissing, setBrowseMissing] = useState(false);
  /** 已浏览确认的路径（服务器 browse 响应的 path）；Select 只允许提交它 */
  const [browsePath, setBrowsePath] = useState<string | null>(null);
  /** 服务器返回的 parentPath（.. 导航目标；根目录为 null） */
  const [browseParentPath, setBrowseParentPath] = useState<string | null>(null);
  // 桌面端原生目录选择器可用性（仅客户端探测，避免 SSR 水合不一致）
  const [desktopPickerAvailable, setDesktopPickerAvailable] = useState(false);
  // 项目行三点菜单：同一时刻仅一个打开（root 标识）
  const [openProjectMenuRoot, setOpenProjectMenuRoot] = useState<string | null>(null);
  // 编辑项目弹窗：目标项目根 + 名称草稿（打开时由 alias/路径显示名初始化）
  const [editProjectRoot, setEditProjectRoot] = useState<string | null>(null);
  const [editProjectValue, setEditProjectValue] = useState("");
  const [editProjectTab, setEditProjectTab] = useState<"name" | "rules" | "skills">("name");
  const editProjectInputRef = useRef<HTMLInputElement>(null);
  const mountedRef = useRef(true);
  const [wtNewForProject, setWtNewForProject] = useState<string | null>(null);
  const [wtNewBranch, setWtNewBranch] = useState("");
  const [wtError, setWtError] = useState<string | null>(null);
  // worktree 错误归属的项目根：避免同一条错误在每个项目行重复显示。
  const [wtErrorRoot, setWtErrorRoot] = useState<string | null>(null);
  const [wtBusy, setWtBusy] = useState(false);
  const [wtConfirmRemove, setWtConfirmRemove] = useState<string | null>(null);
  const wtNewInputRef = useRef<HTMLInputElement>(null);
  const [sessionRefreshDone, setSessionRefreshDone] = useState(false);
  const [runningSessionIds, setRunningSessionIds] = useState<Set<string>>(() => new Set());
  // SSE running ∪ 当前聊天冷启动 agentRunning（发送瞬间即可显示运行中/时长）
  const effectiveRunningSessionIds = useMemo(() => {
    if (!clientRunningSessionId) return runningSessionIds;
    if (runningSessionIds.has(clientRunningSessionId)) return runningSessionIds;
    const next = new Set(runningSessionIds);
    next.add(clientRunningSessionId);
    return next;
  }, [runningSessionIds, clientRunningSessionId]);
  // ── 归档（P0-2）：服务端返回的归档列表/计数 + Archive 视图开关 + 动作状态 ──
  const [archivedSessions, setArchivedSessions] = useState<SessionInfo[]>([]);
  const [archivedCount, setArchivedCount] = useState(0);
  const [archiveViewOpen, setArchiveViewOpen] = useState(false);
  const [archiveBusyId, setArchiveBusyId] = useState<string | null>(null);
  const [archiveError, setArchiveError] = useState<string | null>(null);
  // subagent 活跃运行（子会话 + 等待中的主会话）；由 /api/subagent-runs 推导。
  const [subagentRunningIds, setSubagentRunningIds] = useState<Set<string>>(() => new Set());
  const subagentPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // ── P1-5 共享运行计时：1Hz ticker + first-seen 时间跟踪（见 RunningTimeContext）──
  const [runningNow, setRunningNow] = useState(() => Date.now());
  const [runningStartedAt, setRunningStartedAt] = useState<ReadonlyMap<string, number>>(() => new Map());
  const hasRunningSessions = effectiveRunningSessionIds.size > 0 || subagentRunningIds.size > 0;
  useEffect(() => {
    if (!hasRunningSessions) return;
    const timer = setInterval(() => setRunningNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [hasRunningSessions]);
  useEffect(() => {
    const now = Date.now();
    setRunningNow(now);
    setRunningStartedAt((prev) =>
      trackRunningStartedAt(prev, [...effectiveRunningSessionIds, ...subagentRunningIds], now),
    );
  }, [effectiveRunningSessionIds, subagentRunningIds]);
  const [unreadSessionIds, setUnreadSessionIds] = useState<Set<string>>(() => loadUnreadSessionIds());
  // 搜索：查询与开关均为组件瞬时态，不写入偏好
  const [sessionQuery, setSessionQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  /** meta = 名称/首消息；fulltext = 消息正文（服务端 FTS/JSONL）。 */
  const [searchMode, setSearchMode] = useState<"meta" | "fulltext">("meta");
  const [fulltextHits, setFulltextHits] = useState<Array<{
    sessionId: string;
    snippet: string;
    timestamp: string;
    role?: string;
  }>>([]);
  const [fulltextSessionIds, setFulltextSessionIds] = useState<string[]>([]);
  const [fulltextSource, setFulltextSource] = useState<"fts" | "jsonl" | "none" | null>(null);
  const [fulltextLoading, setFulltextLoading] = useState(false);
  const [fulltextError, setFulltextError] = useState<string | null>(null);
  const fulltextRequestSeqRef = useRef(0);
  const searchInputRef = useRef<HTMLInputElement>(null);
  // 显示模式菜单
  const [displayMenuOpen, setDisplayMenuOpen] = useState(false);
  const displayMenuRef = useRef<HTMLDivElement>(null);
  // 跨刷新偏好：显示模式 + 项目/worktree 折叠集合（独立 seam）
  const [prefs, setPrefs] = useState<SidebarPreferences>(() => loadSidebarPreferences());
  // 每个主仓/非主 worktree group 的展开条数均为瞬时态，不写偏好。
  const [groupVisibleCounts, setGroupVisibleCounts] = useState<Record<string, number>>({});
  // 会话级 child 折叠：保持瞬时（沿用原行为）
  const [collapsedSessionIds, setCollapsedSessionIds] = useState<Set<string>>(() => new Set());
  // 用户已手动展开/折叠过的会话 id：默认 subagent 收起不得覆盖这些显式选择
  const userTouchedSessionCollapseRef = useRef<Set<string>>(new Set());
  const sessionListRef = useRef<HTMLDivElement>(null);
  const initialSelectionScrollDoneRef = useRef(false);
  const previousRunningSessionIdsRef = useRef<Set<string>>(new Set());
  // Once the SSE stream has delivered a frame it is the source of truth for
  // running state; late /api/sessions responses must not overwrite it.
  const sseAuthoritativeRef = useRef(false);
  const sessionRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** 偏好更新唯一入口：内存态与 localStorage 同步写。 */
  const updatePrefs = useCallback((updater: (prev: SidebarPreferences) => SidebarPreferences) => {
    setPrefs((prev) => {
      const next = updater(prev);
      if (next !== prev) {
        // sidebarWidth 的唯一 owner 是 AppShell；保存其它偏好时保留存储中的
        // 当前宽度，避免侧栏内存里的过期副本回写覆盖最近一次拖拽结果。
        saveSidebarPreferences({ ...next, sidebarWidth: loadSidebarPreferences().sidebarWidth });
      }
      return next;
    });
  }, []);

  const displayMode = prefs.displayMode;
  const showRecentSessions = prefs.showRecentSessions;
  // 最近区分页：池 20、默认显示 5、每次 +5
  const [recentVisibleCount, setRecentVisibleCount] = useState(RECENT_SESSIONS_INITIAL_VISIBLE);

  const collapsedProjectRoots = useMemo(() => new Set(prefs.collapsedProjectRoots), [prefs.collapsedProjectRoots]);
  const collapsedWorktreePaths = useMemo(() => new Set(prefs.collapsedWorktreePaths), [prefs.collapsedWorktreePaths]);
  // 已关闭项目集合：仅影响侧栏可见性与自动选择，绝不触碰会话/目录/Git 数据
  const closedRoots = useMemo(() => new Set(prefs.closedProjectRoots), [prefs.closedProjectRoots]);

  useEffect(() => {
    setDesktopPickerAvailable(typeof window !== "undefined" && Boolean(window.piDesktop?.selectDirectory));
  }, []);

  const pendingIdsRef = useRef(pendingIds);
  pendingIdsRef.current = pendingIds;

  const loadSessions = useCallback(async (showLoading = false) => {
    const gen = ++sessionListFetchGenRef.current;
    // OpenChamber SWR：首次冷启动先用本地缓存秒渲染侧栏（stale-while-
    // revalidate），服务器刷新成功后覆盖；fetch 失败时缓存内容保持可见。
    if (showLoading && serverSessionsRef.current.length === 0) {
      const cached = loadCachedSessionList();
      if (cached && cached.length > 0) {
        if (!mountedRef.current || !shouldApplySessionListResponse(gen, sessionListFetchGenRef.current)) return;
        setServerSessions(cached);
        serverSessionsRef.current = cached;
        setLoading(false);
      }
    }
    try {
      if (showLoading && serverSessionsRef.current.length === 0) setLoading(true);
      const res = await fetch("/api/sessions");
      // 仅最新代际可写 serverSessions / loading / error / refresh done / unread 清理。
      // 卸载后不得 setState。
      if (!mountedRef.current || !shouldApplySessionListResponse(gen, sessionListFetchGenRef.current)) return;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as { sessions: SessionInfo[]; runningSessionIds?: string[]; runningStartedAt?: Record<string, number>; archivedSessions?: SessionInfo[]; archivedCount?: number };
      if (!mountedRef.current || !shouldApplySessionListResponse(gen, sessionListFetchGenRef.current)) return;
      setServerSessions(data.sessions);
      serverSessionsRef.current = data.sessions;
      saveCachedSessionList(data.sessions);
      setArchivedSessions(data.archivedSessions ?? []);
      setArchivedCount(data.archivedCount ?? 0);
      setPendingIds((prev) => reconcilePendingSessionIds(prev, data.sessions));
      setPendingById((prev) => {
        if (prev.size === 0) return prev;
        const next = new Map(prev);
        let changed = false;
        for (const s of data.sessions) {
          if (next.has(s.id)) {
            next.delete(s.id);
            changed = true;
          }
        }
        return changed ? next : prev;
      });
      // Treat the fetched running set as an initial fallback only. Once SSE is
      // live it owns this state, so a slow fetch can't revive a stale snapshot.
      if (!sseAuthoritativeRef.current) {
        setRunningSessionIds(new Set(data.runningSessionIds ?? []));
      }
      // 服务端真实开始时间播种：刷新后运行计时不从头重算（first-seen 仅在无记录时生效）
      if (data.runningStartedAt) {
        setRunningStartedAt((prev) => {
          const next = new Map(prev);
          let changed = false;
          for (const [id, ts] of Object.entries(data.runningStartedAt ?? {})) {
            if (!next.has(id) && typeof ts === "number") {
              next.set(id, ts);
              changed = true;
            }
          }
          return changed ? next : prev;
        });
      }
      // Drop unread markers for sessions that no longer exist (e.g. deleted).
      // pending 仍在的 id 不得因 stale server 列表被清掉。
      const existingIds = new Set(data.sessions.map((s) => s.id));
      const pendingSnapshot = pendingIdsRef.current;
      setUnreadSessionIds((prev) => {
        if (prev.size === 0) return prev;
        const next = new Set(
          [...prev].filter((id) => existingIds.has(id) || pendingSnapshot.has(id)),
        );
        return next.size === prev.size ? prev : next;
      });
      setError(null);
      if (!showLoading) {
        setSessionRefreshDone(true);
        if (sessionRefreshTimerRef.current) clearTimeout(sessionRefreshTimerRef.current);
        sessionRefreshTimerRef.current = setTimeout(() => {
          if (mountedRef.current) setSessionRefreshDone(false);
        }, 2000);
      }
    } catch (e) {
      if (!mountedRef.current || !shouldApplySessionListResponse(gen, sessionListFetchGenRef.current)) return;
      setError(String(e));
    } finally {
      if (
        mountedRef.current
        && shouldApplySessionListResponse(gen, sessionListFetchGenRef.current)
        && showLoading
      ) {
        setLoading(false);
      }
    }
  }, []);
  const initialLoadDone = useRef(false);
  useEffect(() => {
    const isFirst = !initialLoadDone.current;
    initialLoadDone.current = true;
    loadSessions(isFirst);
  }, [loadSessions, refreshKey]);

  // 会话列表刷新为事件驱动（新会话/agent_end/删除/fork 经 refreshKey 触发；
  // 窗口重新聚焦时补一次），不做定时轮询（openchamber 同语义）。
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") loadSessions(false);
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [loadSessions]);

  // 真实 id 乐观 upsert（多条）：立即进入 pending map，不等全量列表。
  // 父层以 id map/list 传入；单槽覆盖会丢尚未回流的其它真实 session。
  useEffect(() => {
    if (!optimisticSessions || optimisticSessions.length === 0) return;
    const batch = optimisticSessions.filter((s) => s?.id);
    if (batch.length === 0) return;
    setDeletedIds((prev) => {
      let next: Set<string> | null = null;
      for (const s of batch) {
        if (!prev.has(s.id)) continue;
        if (!next) next = new Set(prev);
        next.delete(s.id);
      }
      return next ?? prev;
    });
    setPendingIds((prev) => {
      let next: Set<string> | null = null;
      for (const s of batch) {
        if (prev.has(s.id)) continue;
        if (!next) next = new Set(prev);
        next.add(s.id);
      }
      return next ?? prev;
    });
    setPendingById((prev) => {
      let next: Map<string, SessionInfo> | null = null;
      for (const s of batch) {
        const existing = prev.get(s.id);
        if (existing === s) continue;
        if (!next) next = new Map(prev);
        next.set(s.id, s);
      }
      return next ?? prev;
    });
  }, [optimisticSessions]);

  const allSessions = useMemo(
    () => mergeOptimisticSessions({
      serverSessions,
      pendingSessions: [...pendingById.values()],
      pendingIds,
      deletedIds,
    }),
    [serverSessions, pendingById, pendingIds, deletedIds],
  );

  const {
    worktreeSnapshots,
    worktreeSnapshotsRef,
    worktreeMetadata,
    setWtRefreshKey,
    commitWorktreeSnapshots,
  } = useWorktreePreload({
    allSessions,
    selectedCwd,
    selectedProjectRoot,
    setIdentity,
    mountedRef,
  });

  // Persist unread markers so they survive a browser refresh before the user
  // has actually opened the completed session.
  useEffect(() => {
    saveUnreadSessionIds(unreadSessionIds);
  }, [unreadSessionIds]);

  useEffect(() => {
    // Live running status via SSE — no polling. The server pushes the current
    // set of running session ids whenever any session starts/stops working.
    const source = new EventSource("/api/agent/running/events");

    source.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data) as { type?: string; runningSessionIds?: string[] };
        if (data.type === "running") {
          sseAuthoritativeRef.current = true;
          setRunningSessionIds(new Set(data.runningSessionIds ?? []));
        }
      } catch {
        // ignore malformed frames
      }
    };

    // On error EventSource auto-reconnects; keep the last known state meanwhile.
    return () => source.close();
  }, []);

  // subagent 活跃运行轮询：异步子会话运行中 → 子会话 + 其主会话显示 running。
  // 数据源 /api/subagent-runs（read-only），30s 轮询 + 会话列表刷新时同步拉取。
  const refreshSubagentRunning = useCallback(async () => {
    try {
      const res = await fetch("/api/subagent-runs?limit=50");
      if (!res.ok) return;
      const data = await res.json() as { runs?: Array<{
        state?: string;
        steps?: Array<{ sessionId?: string }>;
      }> };
      const active = (data.runs ?? []).filter((r) =>
        r.state === "running" || r.state === "queued" || r.state === "paused",
      );
      const childIds = new Set<string>();
      for (const run of active) {
        for (const step of run.steps ?? []) {
          if (step.sessionId) childIds.add(step.sessionId);
        }
      }
      // 主会话等待中：子会话的 parent 也显示 running。
      // 经 ref 读取最新会话列表（不把 setState updater 当数据源用）。
      const parentIds = new Set<string>();
      if (childIds.size > 0) {
        for (const s of serverSessionsRef.current) {
          if (s.subagent?.parentSessionId && childIds.has(s.id)) {
            parentIds.add(s.subagent.parentSessionId);
          }
        }
      }
      setSubagentRunningIds(new Set([...childIds, ...parentIds]));
    } catch {
      // 轮询失败静默：保持上次状态。
    }
  }, []);

  useEffect(() => {
    void refreshSubagentRunning();
    subagentPollRef.current = setInterval(() => void refreshSubagentRunning(), 30_000);
    return () => {
      if (subagentPollRef.current) clearInterval(subagentPollRef.current);
    };
  }, [refreshSubagentRunning]);

  // 会话列表刷新后同步拉一次 subagent 状态（子会话刚被发现时）。
  useEffect(() => {
    if (sessionRefreshDone) void refreshSubagentRunning();
  }, [sessionRefreshDone, refreshSubagentRunning]);
  useEffect(() => {
    const previous = previousRunningSessionIdsRef.current;
    const completedInBackground = [...previous].filter((id) => !effectiveRunningSessionIds.has(id) && id !== selectedSessionId);
    const newlyRunning = [...effectiveRunningSessionIds].filter((id) => !previous.has(id));

    if (completedInBackground.length > 0 || newlyRunning.length > 0) {
      setUnreadSessionIds((prev) => {
        const next = new Set(prev);
        newlyRunning.forEach((id) => next.delete(id));
        completedInBackground.forEach((id) => next.add(id));
        return next;
      });
    }

    // 新进入 running（含冷启动 clientRunning）：立刻乐观抬升 modified 并重排，
    // 不等 agent_end / 列表轮询。不在此处 loadSessions——发送瞬间缓存可能仍旧。
    if (newlyRunning.length > 0) {
      const nowIso = new Date().toISOString();
      setServerSessions((prev) => {
        let changed = false;
        const next = prev.map((s) => {
          if (!newlyRunning.includes(s.id)) return s;
          if (s.modified >= nowIso) return s;
          changed = true;
          return { ...s, modified: nowIso };
        });
        if (!changed) return prev;
        const sorted = [...next].sort((a, b) => (a.modified < b.modified ? 1 : a.modified > b.modified ? -1 : 0));
        serverSessionsRef.current = sorted;
        saveCachedSessionList(sorted);
        return sorted;
      });
    }

    previousRunningSessionIdsRef.current = new Set(effectiveRunningSessionIds);
  }, [effectiveRunningSessionIds, selectedSessionId]);

  // SSE 确认 running（prompt 已接受并 invalidate 列表缓存）后再拉服务端列表对齐。
  const prevSseRunningRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const prev = prevSseRunningRef.current;
    const newlyFromSse = [...runningSessionIds].filter((id) => !prev.has(id));
    prevSseRunningRef.current = new Set(runningSessionIds);
    if (newlyFromSse.length > 0) void loadSessions(false);
  }, [runningSessionIds, loadSessions]);

  useEffect(() => {
    if (!selectedSessionId) return;
    setUnreadSessionIds((prev) => {
      if (!prev.has(selectedSessionId)) return prev;
      const next = new Set(prev);
      next.delete(selectedSessionId);
      return next;
    });
  }, [selectedSessionId]);

  useEffect(() => {
    fetch("/api/home").then((r) => r.json()).then((d: { home?: string }) => {
      if (d.home) setHomeDir(d.home);
    }).catch(() => {});
  }, []);

  const restoredRef = useRef(false);

  useEffect(() => () => {
    mountedRef.current = false;
  }, []);

  /** 从最新本地数据乐观解析项目根；服务端响应仍是权威来源。 */
  const projectRootFor = useCallback((cwd: string | null): string | null => {
    if (!cwd) return null;
    if (selectedCwd === cwd && selectedProjectRoot) return selectedProjectRoot;
    for (const [root, snapshot] of Object.entries(worktreeSnapshotsRef.current)) {
      if (snapshot.worktrees.some((worktree) => worktree.path === cwd)) return root;
    }
    const match = allSessions.find((s) => s.cwd === cwd);
    return match?.projectRoot ?? cwd;
  }, [selectedCwd, selectedProjectRoot, allSessions]);
  const selectCwd = useCallback((cwd: string | null, explicitRoot?: string | null) => {
    const root = cwd === null ? null : explicitRoot ?? projectRootFor(cwd) ?? cwd;
    setIdentity({ cwd, projectRoot: root, status: cwd ? "ready" : "idle", error: null });
  }, [projectRootFor, setIdentity]);
  const selectedProject = selectedProjectRoot ?? projectRootFor(selectedCwd);

  // 切换项目时收起未完成的 worktree 操作行，避免状态串到别的项目。
  useEffect(() => {
    setWtNewForProject(null);
    setWtNewBranch("");
    setWtError(null);
    setWtErrorRoot(null);
    setWtConfirmRemove(null);
  }, [selectedCwd]);

  // Auto-select cwd and restore session from URL on first load
  useEffect(() => {
    if (allSessions.length === 0 || skipInitialProjectSelection) return;

    // URL 恢复必须优先于 cwd 自动选择；requestedCwd 已先建立身份时，
    // selectedCwd 不再为空，但仍不能跳过目标会话恢复。
    if (initialSessionId && !restoredRef.current) {
      restoredRef.current = true;
      const target = allSessions.find((s) => s.id === initialSessionId);
      if (target) {
        selectCwd(target.cwd, target.projectRoot ?? target.cwd);
        onSelectSession(target, true);
        return;
      }
      // Session not found — notify parent so it can show the placeholder
      onInitialRestoreDone?.();
    }
    if (selectedCwd === null) {
      // 已关闭项目不参与自动选择：全部关闭时保持空工作区，而不是复活已关闭项目。
      const projects = getRecentProjects(allSessions);
      const next = projects.find((root) => !closedRoots.has(root));
      if (next) selectCwd(next);
    }
  }, [allSessions, selectedCwd, initialSessionId, skipInitialProjectSelection, onSelectSession, onInitialRestoreDone, selectCwd, closedRoots]);

  const closeCustomPathPanel = useCallback(() => {
    setCustomPathOpen(false);
    setCustomPathValue("");
    setCustomPathError(null);
  }, []);

  /** 重新打开已关闭项目：仅移除关闭标记，不触碰任何项目数据。 */
  const restoreClosedProject = useCallback((root: string) => {
    updatePrefs((prev) => prev.closedProjectRoots.includes(root)
      ? { ...prev, closedProjectRoots: prev.closedProjectRoots.filter((item) => item !== root) }
      : prev);
  }, [updatePrefs]);

  /** 手动浏览目录（对齐上游 directory-picker：Go/Enter/目录点击/.. 触发）。
   *  空路径 → 服务器默认 homedir（上游打开弹窗即浏览 home）。 */
  const browseDirectory = useCallback(async (rawPath: string) => {
    const cancelled = { current: false };
    setBrowseLoading(true);
    setBrowseMissing(false);
    setCustomPathError(null);
    try {
      const res = await fetch(`/api/cwd/browse?path=${encodeURIComponent(rawPath)}`);
      if (cancelled.current) return;
      if (!res.ok) {
        setBrowseEntries([]);
        setBrowseGit(null);
        setBrowseMissing(true);
        setBrowsePath(null);
        setBrowseParentPath(null);
        return;
      }
      const data = (await res.json()) as {
        path?: string;
        parentPath?: string | null;
        entries?: Array<{ name: string; path: string }>;
        git?: { isRepo: boolean; branch: string | null };
      };
      if (cancelled.current) return;
      setCustomPathValue(data.path ?? rawPath);
      setBrowsePath(data.path ?? rawPath);
      setBrowseParentPath(data.parentPath ?? null);
      setBrowseEntries(data.entries ?? []);
      setBrowseGit(data.git ?? null);
      setBrowseMissing(false);
    } catch {
      if (!cancelled.current) {
        setBrowseEntries([]);
        setBrowseGit(null);
        setBrowseMissing(true);
        setBrowsePath(null);
        setBrowseParentPath(null);
      }
    } finally {
      if (!cancelled.current) setBrowseLoading(false);
    }
    // 竞态防护：本次浏览完成后若已有更新的请求，不覆盖其状态。
    return () => {
      cancelled.current = true;
    };
  }, []);

  /** 上级目录（.. 导航）：直接取服务器返回的 parentPath（0.8.6 对齐） */
  const browseParent = browseParentPath;
  const commitCustomPath = useCallback(async (candidate?: string) => {
    // 上游语义：Select 提交"已浏览"的路径；候选为空时用已浏览路径
    const path = (candidate ?? browsePath ?? customPathValue).trim();
    if (!path || customPathValidating) return;

    setCustomPathValidating(true);
    setCustomPathError(null);
    try {
      const res = await fetch("/api/cwd/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: path }),
      });
      const data = await res.json().catch(() => ({})) as { cwd?: string; error?: string };
      if (!res.ok || data.error) {
        setCustomPathError(data.error ?? `HTTP ${res.status}`);
        return;
      }
      const resolvedCwd = data.cwd ?? path;
      // 重复添加：已打开项目仅切换选中；已关闭项目移除关闭标记后恢复。
      const root = projectRootFor(resolvedCwd) ?? resolvedCwd;
      // 持久化「主动添加的项目」：即使无会话也持续显示（项目独立于会话）。
      updatePrefs((prev) =>
        prev.addedProjectRoots.includes(root)
          ? prev
          : { ...prev, addedProjectRoots: [...prev.addedProjectRoots, root] },
      );
      restoreClosedProject(root);
      selectCwd(resolvedCwd, root);
      closeCustomPathPanel();
      // 添加项目成功：进入引导页并选中新项目
      onProjectAdded?.(root);
    } catch (e) {
      setCustomPathError(e instanceof Error ? e.message : String(e));
    } finally {
      setCustomPathValidating(false);
    }
  }, [browsePath, customPathValue, customPathValidating, projectRootFor, restoreClosedProject, selectCwd, closeCustomPathPanel, onProjectAdded]);

  /** 添加项目按钮：总是打开弹窗，不直接拉起原生目录选择器。 */
  const openAddProjectDialog = useCallback(() => {
    setCustomPathError(null);
    setCustomPathValue("");
    setBrowsePath(null);
    setBrowseParentPath(null);
    setBrowseEntries([]);
    setBrowseGit(null);
    setBrowseMissing(false);
    setCustomPathOpen(true);
    // 上游 directory-picker：打开即浏览默认（home）目录
    void browseDirectory("");
  }, [browseDirectory]);

  /** 弹窗内「选择目录」：仅调用原生选择器填充输入框，不直接提交。 */
  const handlePickDirectory = useCallback(async () => {
    const desktop = window.piDesktop;
    if (!desktop) return;
    try {
      setCustomPathError(null);
      const path = await desktop.selectDirectory();
      if (path !== null) {
        setCustomPathValue(path);
        void browseDirectory(path);
      }
    } catch (e) {
      setCustomPathError(e instanceof Error ? e.message : String(e));
    }
  }, [browseDirectory]);

  const handleDefaultCwd = useCallback(async () => {
    if (customPathValidating) return;
    setCustomPathValidating(true);
    setCustomPathError(null);
    try {
      const res = await fetch("/api/default-cwd", { method: "POST" });
      const data = await res.json().catch(() => ({})) as { cwd?: string; error?: string };
      if (!res.ok || data.error || !data.cwd) {
        setCustomPathError(data.error ?? `HTTP ${res.status}`);
        return;
      }
      const root = projectRootFor(data.cwd) ?? data.cwd;
      restoreClosedProject(root);
      selectCwd(data.cwd, root);
      closeCustomPathPanel();
      onProjectAdded?.(root);
    } catch (e) {
      setCustomPathError(e instanceof Error ? e.message : String(e));
    } finally {
      setCustomPathValidating(false);
    }
  }, [customPathValidating, projectRootFor, restoreClosedProject, selectCwd, closeCustomPathPanel]);

  const handleCreateWorktree = useCallback(async () => {
    // 目标项目以「打开输入行的项目」为准，而非当前选中项目：
    // 未选中项目的 worktree 管理入口同样可用。
    const projectRoot = wtNewForProject;
    const branch = wtNewBranch.trim();
    if (!branch || wtBusy || !projectRoot) return;
    setWtBusy(true);
    setWtError(null);
    setWtErrorRoot(null);
    try {
      const res = await fetch("/api/worktrees", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: projectRoot, branch }),
      });
      const data = await res.json().catch(() => ({})) as { path?: string; error?: string };
      if (!res.ok || data.error || !data.path) {
        setWtError(data.error ?? `HTTP ${res.status}`);
        setWtErrorRoot(projectRoot);
        return;
      }
      setWtNewForProject(null);
      setWtNewBranch("");
      // Optimistically register the new worktree so projectRootFor() resolves
      // it to the main repo before the refetch lands (keeps AppShell from
      // treating the new cwd as a different project).
      commitWorktreeSnapshots((prev) => upsertProjectWorktreeSnapshot(prev, projectRoot, {
        status: "ready",
        worktrees: [...(prev[projectRoot]?.worktrees ?? []), { path: data.path!, branch, isMain: false }],
      }));
      selectCwd(data.path, projectRoot);
      setWtRefreshKey((k) => k + 1);
    } catch (e) {
      setWtError(e instanceof Error ? e.message : String(e));
      setWtErrorRoot(projectRoot);
    } finally {
      setWtBusy(false);
    }
  }, [wtNewForProject, wtNewBranch, wtBusy, commitWorktreeSnapshots, selectCwd]);

  const handleRemoveWorktree = useCallback(async (projectRoot: string, path: string, force: boolean) => {
    // 与创建同理：以分组所属项目根为请求目标，不要求该项目处于选中态。
    if (wtBusy) return;
    setWtBusy(true);
    setWtError(null);
    setWtErrorRoot(null);
    try {
      const res = await fetch("/api/worktrees", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: projectRoot, path, force }),
      });
      const data = await res.json().catch(() => ({})) as { error?: string; dirty?: boolean };
      if (!res.ok) {
        if (data.dirty && !force) {
          // Dirty worktree — ask the user to confirm a force removal
          setWtConfirmRemove(path);
          return;
        }
        setWtError(data.error ?? `HTTP ${res.status}`);
        setWtErrorRoot(projectRoot);
        return;
      }
      setWtConfirmRemove(null);
      if (selectedCwd === path) selectCwd(projectRoot, projectRoot);
      setWtRefreshKey((k) => k + 1);
    } catch (e) {
      setWtError(e instanceof Error ? e.message : String(e));
      setWtErrorRoot(projectRoot);
    } finally {
      setWtBusy(false);
    }
  }, [wtBusy, selectedCwd, selectCwd]);

  // 点击外部关闭显示模式菜单
  useEffect(() => {
    if (!displayMenuOpen) return;
    const handler = (e: MouseEvent) => {
      if (displayMenuRef.current && !displayMenuRef.current.contains(e.target as Node)) {
        setDisplayMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [displayMenuOpen]);

  // Clicking a session moves the effective cwd to that session's worktree.
  // Done on the click path (not via the selectedCwd prop sync) so it also
  // works when the prop value won't change — e.g. re-clicking the already
  // open session after manually switching worktrees.
  const handleSelectSessionFromList = useCallback((s: SessionInfo) => {
    if (s.cwd) selectCwd(s.cwd, s.projectRoot ?? s.cwd);
    onSelectSession(s);
  }, [onSelectSession, selectCwd]);

  /** 会话删除收口：树与最近区共用同一处理（乐观删除 + 回流刷新）。 */
  const handleSessionDeletedLocal = useCallback((id: string) => {
    setDeletedIds((prev) => {
      const next = new Set(prev);
      next.add(id);
      return next;
    });
    setPendingIds((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    setPendingById((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Map(prev);
      next.delete(id);
      return next;
    });
    onSessionDeleted?.(id);
    loadSessions();
  }, [onSessionDeleted, loadSessions]);

  /** 归档收口：菜单动作 → POST archive → 成功后统一重拉 /api/sessions。
   *  409（running）/ 403（readOnly）等失败按分类展示 i18n 文案。 */
  const handleArchiveSession = useCallback(async (sessionId: string) => {
    if (archiveBusyId !== null) return;
    setArchiveBusyId(sessionId);
    setArchiveError(null);
    try {
      const result = await archiveSession(sessionId);
      if (!result.ok) {
        const kind = archiveFailureKind(result);
        setArchiveError(
          kind === "running" ? t("archive_runningConflict")
            : kind === "readOnly" ? t("archive_readOnlyForbidden")
              : kind === "network" ? t("archive_networkError")
                : result.error ?? t("archive_unknownError"),
        );
        return;
      }
      loadSessions();
    } catch (e) {
      setArchiveError(e instanceof Error ? e.message : String(e));
    } finally {
      setArchiveBusyId(null);
    }
  }, [archiveBusyId, loadSessions, t]);

  /** Archive 视图开/关：打开时清空上次错误；数据刷新由 ArchiveView 挂载 effect 承担。 */
  const toggleArchiveView = useCallback(() => {
    setArchiveViewOpen((open) => {
      if (!open) setArchiveError(null);
      return !open;
    });
  }, []);

  /** 「最近会话」区开/关：唯一写入入口经偏好 seam。 */
  const setShowRecentSessions = useCallback((show: boolean) => {
    updatePrefs((prev) => (prev.showRecentSessions === show ? prev : { ...prev, showRecentSessions: show }));
  }, [updatePrefs]);

  /** 最近会话：按 modified 降序取 top 20 候选；UI 默认展示 5、每次加载更多 5。 */
  const recentSessions = useMemo(
    () => deriveRecentSessions({ sessions: allSessions, closedProjectRoots: closedRoots, limit: RECENT_SESSIONS_LIMIT }),
    [allSessions, closedRoots],
  );
  // 池变短时收敛可见条数，避免 slice 空档
  useEffect(() => {
    setRecentVisibleCount((n) => {
      if (recentSessions.length === 0) return RECENT_SESSIONS_INITIAL_VISIBLE;
      return Math.min(Math.max(n, RECENT_SESSIONS_INITIAL_VISIBLE), recentSessions.length);
    });
  }, [recentSessions.length]);


  const handleNewSession = useCallback((targetCwd = selectedCwd) => {
    if (!targetCwd) return;
    // Generate a temporary UUID client-side — no backend call needed.
    // Pi will be spawned lazily when the user sends the first message.
    selectCwd(targetCwd, projectRootFor(targetCwd));
    onNewSession?.(targetCwd);
  }, [selectedCwd, onNewSession, selectCwd, projectRootFor]);

  // 搜索行开关：打开自动聚焦；关闭同时清空瞬时查询与全文结果。
  const clearSearchState = useCallback(() => {
    setSessionQuery("");
    setFulltextHits([]);
    setFulltextSessionIds([]);
    setFulltextSource(null);
    setFulltextError(null);
    setFulltextLoading(false);
    fulltextRequestSeqRef.current += 1;
  }, []);

  const toggleSearch = useCallback(() => {
    if (searchOpen) {
      setSearchOpen(false);
      clearSearchState();
    } else {
      setSearchOpen(true);
      setTimeout(() => searchInputRef.current?.focus(), 0);
    }
  }, [searchOpen, clearSearchState]);

  // 全文模式：debounce 调用只读 API；忽略过期响应。
  useEffect(() => {
    if (!searchOpen || searchMode !== "fulltext") {
      setFulltextLoading(false);
      return;
    }
    const q = sessionQuery.trim();
    if (!q) {
      setFulltextHits([]);
      setFulltextSessionIds([]);
      setFulltextSource(null);
      setFulltextError(null);
      setFulltextLoading(false);
      return;
    }
    const seq = ++fulltextRequestSeqRef.current;
    setFulltextLoading(true);
    setFulltextError(null);
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const res = await fetch(`/api/sessions/search?q=${encodeURIComponent(q)}&limit=40`);
          const data = await res.json().catch(() => ({})) as {
            error?: string;
            hits?: Array<{ sessionId: string; snippet: string; timestamp: string; role?: string }>;
            sessionIds?: string[];
            source?: "fts" | "jsonl" | "none";
          };
          if (seq !== fulltextRequestSeqRef.current) return;
          if (!res.ok || data.error) {
            setFulltextError(data.error ?? `HTTP ${res.status}`);
            setFulltextHits([]);
            setFulltextSessionIds([]);
            setFulltextSource(null);
            return;
          }
          setFulltextHits(data.hits ?? []);
          setFulltextSessionIds(data.sessionIds ?? []);
          setFulltextSource(data.source ?? null);
        } catch (e) {
          if (seq !== fulltextRequestSeqRef.current) return;
          setFulltextError(e instanceof Error ? e.message : String(e));
          setFulltextHits([]);
          setFulltextSessionIds([]);
          setFulltextSource(null);
        } finally {
          if (seq === fulltextRequestSeqRef.current) setFulltextLoading(false);
        }
      })();
    }, 280);
    return () => clearTimeout(timer);
  }, [searchOpen, searchMode, sessionQuery]);

  // 当前有效项目根（由 selectedCwd 乐观解析；服务端 worktree 数据仍是权威）
  // 全项目树：分组/排序/空态补齐全部在纯模型内完成。
  const knownWorktreesByProject = useMemo(
    () => Object.fromEntries(Object.entries(worktreeSnapshots).map(([root, snapshot]) => [root, snapshot.worktrees])),
    [worktreeSnapshots],
  );
  const sidebarTree = useMemo(
    () => buildSidebarTree(allSessions, { selectedCwd, selectedProjectRoot: selectedProject, knownWorktreesByProject, addedProjectRoots: prefs.addedProjectRoots }),
    [allSessions, selectedCwd, selectedProject, knownWorktreesByProject, prefs.addedProjectRoots],
  );
  // 会话 id → 树节点映射（含 children）：最近区行用与项目树相同的
  // SessionTreeItem 渲染，折叠/展开行为完全一致（共享 collapsedSessionIds）。
  const sessionNodeById = useMemo(() => {
    const map = new Map<string, SessionDisplayNode>();
    const walk = (nodes: SessionDisplayNode[]) => {
      for (const node of nodes) {
        map.set(node.session.id, node);
        if (node.children.length > 0) walk(node.children);
      }
    };
    for (const project of sidebarTree) {
      walk(project.mainTree);
      for (const group of project.worktrees) walk(group.tree);
    }
    return map;
  }, [sidebarTree]);
  // 已关闭项目先从树中隐藏（纯 UI 过滤，不删数据），再进入搜索管线。
  const openTree = useMemo(
    () => filterClosedProjects(sidebarTree, closedRoots),
    [sidebarTree, closedRoots],
  );
  const normalizedSessionQuery = normalizeSessionQuery(sessionQuery);
  const fulltextModeActive = searchMode === "fulltext" && normalizedSessionQuery.length > 0;
  const fulltextMatchIds = useMemo(
    () => (fulltextModeActive ? new Set(fulltextSessionIds) : null),
    [fulltextModeActive, fulltextSessionIds],
  );
  const searchActive = fulltextModeActive
    ? fulltextSessionIds.length > 0 || fulltextLoading || Boolean(fulltextError)
    : normalizedSessionQuery.length > 0;
  // 项目 alias 参与元数据搜索；全文模式按命中 id 保留祖先链。
  const visibleTree = useMemo(
    () => filterSidebarTree(
      openTree,
      fulltextModeActive ? "" : normalizedSessionQuery,
      prefs.projectAliases,
      fulltextMatchIds,
    ),
    [openTree, normalizedSessionQuery, prefs.projectAliases, fulltextMatchIds, fulltextModeActive],
  );

  /** 全文命中深链：按 id 打开已加载会话；列表尚未包含时忽略（refresh 后可再点）。 */
  const openSessionById = useCallback((sessionId: string) => {
    const target = allSessions.find((s) => s.id === sessionId);
    if (!target) return;
    handleSelectSessionFromList(target);
  }, [allSessions, handleSelectSessionFromList]);

  // 默认收起「有 subagent 子节点」的父会话；不写 localStorage。
  // 用户手动展开/折叠过的 id 不覆盖；选中子会话时会展开祖先（见下）。
  useEffect(() => {
    const defaults = collectSubagentParentIdsFromSidebarTree(sidebarTree);
    if (defaults.length === 0) return;
    setCollapsedSessionIds((current) => {
      let changed = false;
      const next = new Set(current);
      for (const id of defaults) {
        if (userTouchedSessionCollapseRef.current.has(id)) continue;
        if (!next.has(id)) {
          next.add(id);
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [sidebarTree]);

  // 选中或 URL 恢复会话时自动展开 project/worktree/session 三级祖先，
  // 避免「已选中但列表里不可见」；这是显式选中驱动，与搜索强制展开无关。
  useEffect(() => {
    if (!selectedSessionId) return;
    const location = locateSessionInSidebarTree(sidebarTree, selectedSessionId);
    if (!location) return;
    updatePrefs((prev) => {
      const hasProject = prev.collapsedProjectRoots.includes(location.projectRoot);
      const hasWorktree = location.worktreePath !== null && prev.collapsedWorktreePaths.includes(location.worktreePath);
      if (!hasProject && !hasWorktree) return prev;
      return {
        ...prev,
        collapsedProjectRoots: hasProject ? prev.collapsedProjectRoots.filter((root) => root !== location.projectRoot) : prev.collapsedProjectRoots,
        collapsedWorktreePaths: hasWorktree ? prev.collapsedWorktreePaths.filter((path) => path !== location.worktreePath) : prev.collapsedWorktreePaths,
      };
    });
    if (location.ancestors.length > 0) {
      for (const id of location.ancestors) {
        userTouchedSessionCollapseRef.current.add(id);
      }
      setCollapsedSessionIds((current) => {
        if (!location.ancestors.some((id) => current.has(id))) return current;
        const next = new Set(current);
        location.ancestors.forEach((id) => next.delete(id));
        return next;
      });
    }
  }, [selectedSessionId, sidebarTree, updatePrefs]);

  // 仅首次 URL 恢复或目标确实超出可视区时滚动，不打断用户正常浏览位置。
  useLayoutEffect(() => {
    if (!selectedSessionId) return;
    const list = sessionListRef.current;
    if (!list) return;
    const row = Array.from(list.querySelectorAll<HTMLElement>("[data-session-id]"))
      .find((element) => element.dataset.sessionId === selectedSessionId);
    if (!row) return;

    const isInitialRestore = !initialSelectionScrollDoneRef.current
      && initialSessionId === selectedSessionId;
    const listRect = list.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    const outsideViewport = rowRect.top < listRect.top || rowRect.bottom > listRect.bottom;
    if (isInitialRestore || outsideViewport) row.scrollIntoView({ block: "nearest" });
    if (isInitialRestore) initialSelectionScrollDoneRef.current = true;
  }, [selectedSessionId, initialSessionId, visibleTree, collapsedProjectRoots, collapsedWorktreePaths, collapsedSessionIds]);

  const toggleSessionCollapse = useCallback((sessionId: string) => {
    userTouchedSessionCollapseRef.current.add(sessionId);
    setCollapsedSessionIds((current) => {
      const next = new Set(current);
      if (next.has(sessionId)) next.delete(sessionId);
      else next.add(sessionId);
      return next;
    });
  }, []);

  // 项目折叠：显式用户动作，写入偏好。
  const toggleProjectCollapse = useCallback((root: string) => {
    updatePrefs((prev) => ({
      ...prev,
      collapsedProjectRoots: prev.collapsedProjectRoots.includes(root)
        ? prev.collapsedProjectRoots.filter((item) => item !== root)
        : [...prev.collapsedProjectRoots, root],
    }));
  }, [updatePrefs]);

  const toggleWorktreeCollapse = useCallback((path: string) => {
    updatePrefs((prev) => ({
      ...prev,
      collapsedWorktreePaths: prev.collapsedWorktreePaths.includes(path)
        ? prev.collapsedWorktreePaths.filter((item) => item !== path)
        : [...prev.collapsedWorktreePaths, path],
    }));
  }, [updatePrefs]);

  /**
   * 关闭项目：仅把 root 写入 UI 偏好并从侧栏隐藏——绝不删除目录、会话、
   * AgentSession、worktree 或 Git 数据；重新添加同路径项目即可恢复。
   */
  const handleCloseProject = useCallback((root: string) => {
    setOpenProjectMenuRoot(null);
    const nextClosedRoots = new Set(prefs.closedProjectRoots);
    nextClosedRoots.add(root);
    updatePrefs((prev) => (prev.closedProjectRoots.includes(root)
      ? prev
      : { ...prev, closedProjectRoots: [...prev.closedProjectRoots, root] }));
    // 关闭当前项目：切换到下一个未关闭项目；无剩余则置空 cwd 并回到
    // 新会话/空工作区，避免继续显示已关闭项目的当前会话。
    if (selectedProject === root) {
      const next = pickProjectRootAfterClose(sidebarTree, root, nextClosedRoots);
      if (next) {
        selectCwd(next, next);
      } else {
        selectCwd(null);
        onNewSession?.();
      }
    }
  }, [prefs.closedProjectRoots, selectedProject, sidebarTree, updatePrefs, selectCwd, onNewSession]);

  /** 打开编辑项目弹窗：名称初值为 alias 或路径显示名。 */
  const handleOpenEditProject = useCallback((root: string) => {
    setOpenProjectMenuRoot(null);
    setEditProjectValue(prefs.projectAliases[root] ?? projectDisplayName(root));
    setEditProjectTab("name");
    setEditProjectRoot(root);
  }, [prefs.projectAliases, homeDir]);

  /** 保存项目 alias：与路径显示名相同则清除 alias，回到默认显示。 */
  const handleSaveProjectAlias = useCallback(() => {
    if (!editProjectRoot) return;
    const name = editProjectValue.trim();
    if (!name) return;
    const root = editProjectRoot;
    setEditProjectRoot(null);
    updatePrefs((prev) => {
      const nextAliases = { ...prev.projectAliases };
      if (name === projectDisplayName(root)) delete nextAliases[root];
      else nextAliases[root] = name;
      return { ...prev, projectAliases: nextAliases };
    });
  }, [editProjectRoot, editProjectValue, homeDir, updatePrefs]);

  const setDisplayMode = useCallback((mode: SidebarDisplayMode) => {
    updatePrefs((prev) => (prev.displayMode === mode ? prev : { ...prev, displayMode: mode }));
  }, [updatePrefs]);

  const collapseAll = useCallback(() => {
    const ids = collectAllCollapseIds(openTree);
    updatePrefs((prev) => ({
      ...prev,
      collapsedProjectRoots: ids.projectRoots,
      collapsedWorktreePaths: ids.worktreePaths,
    }));
  }, [openTree, updatePrefs]);

  const expandAll = useCallback(() => {
    updatePrefs((prev) => (prev.collapsedProjectRoots.length === 0 && prev.collapsedWorktreePaths.length === 0
      ? prev
      : { ...prev, collapsedProjectRoots: [], collapsedWorktreePaths: [] }));
  }, [updatePrefs]);

  // worktree 管理能力：所有已知项目均可显示/操作（快照缓存优先、后台预加载），
  // 不再要求项目处于选中态；可否创建/删除取决于该项目已加载的 git 顶层信息。
  const worktreeActionsFor = useCallback((projectRoot: string): WorktreeActions | null => {
    const snapshot = worktreeSnapshots[projectRoot];
    const metadata = worktreeMetadata[projectRoot];
    const canManage = Boolean(metadata?.isGit && metadata.isTopLevel);
    const createHint = canManage
      ? t("sidebar_createWorktree")
      : snapshot?.status === "loading" || !snapshot
        ? t("sidebar_checkingWorktree")
        : metadata?.isGit
          ? t("sidebar_worktreeOpenRoot")
          : t("sidebar_worktreeGitOnly");
    return { canManage, createHint, busy: wtBusy };
  }, [worktreeSnapshots, worktreeMetadata, wtBusy, t]);

  return (
    <RunningTimeContext.Provider value={{ startedAt: runningStartedAt, now: runningNow }}>
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      {/* Header：品牌 + 全图标工具栏（OpenChamber 规格 24×24 / 图标 18 / 6px 圆角） */}
      <div
        style={{
          padding: "10px 10px 8px",
          borderBottom: "1px solid var(--border)",
          flexShrink: 0,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <PiWebTitle />
          <div className="sidebar-toolbar" style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <SidebarIconButton
              label={t("sidebar_addProject")}
              onClick={openAddProjectDialog}
              active={customPathOpen}
            >
              <FolderPlusIcon size={18} />
            </SidebarIconButton>
            <SidebarIconButton
              label={selectedCwd ? t("sidebar_newSessionIn", { project: displayCwd(selectedCwd, homeDir) }) : t("sidebar_selectProject")}
              disabled={!selectedCwd}
              onClick={() => handleNewSession()}
            >
              <ChatPlusIcon size={18} />
            </SidebarIconButton>
            <SidebarIconButton
              label={t("sidebar_searchSessions")}
              active={searchOpen}
              expanded={searchOpen}
              onClick={toggleSearch}
            >
              <SearchIcon size={18} />
            </SidebarIconButton>
            <SidebarIconButton
              label={t("sidebar_archive")}
              active={archiveViewOpen}
              expanded={archiveViewOpen}
              onClick={toggleArchiveView}
            >
              <ArchiveIcon size={18} />
            </SidebarIconButton>
            <div ref={displayMenuRef} style={{ position: "relative" }}>
              <SidebarIconButton
                label={t("sidebar_displayOptions")}
                active={displayMenuOpen}
                expanded={displayMenuOpen}
                onClick={() => setDisplayMenuOpen((open) => !open)}
              >
                <SlidersIcon size={18} />
              </SidebarIconButton>
              <AnimatedDropdown
                open={displayMenuOpen}
                style={{
                  position: "absolute",
                  top: "calc(100% + 4px)",
                  right: 0,
                  zIndex: 100,
                  background: "var(--bg)",
                  border: "1px solid var(--border)",
                  borderRadius: 8,
                  boxShadow: "0 6px 20px rgba(0,0,0,0.10)",
                  overflow: "hidden",
                  minWidth: 168,
                }}
              >
                <div onKeyDown={(e) => { if (e.key === "Escape") setDisplayMenuOpen(false); }}>
                  <DisplayMenuItem
                    label={t("sidebar_standard")}
                    checked={displayMode === "standard"}
                    onClick={() => { setDisplayMode("standard"); setDisplayMenuOpen(false); }}
                  />
                  <DisplayMenuItem
                    label={t("sidebar_compact")}
                    checked={displayMode === "compact"}
                    onClick={() => { setDisplayMode("compact"); setDisplayMenuOpen(false); }}
                  />
                  <div style={{ borderTop: "1px solid var(--border)", margin: "2px 0" }} />
                  <DisplayMenuItem
                    label={t("sidebar_collapseAll")}
                    onClick={() => { collapseAll(); setDisplayMenuOpen(false); }}
                  />
                  <DisplayMenuItem
                    label={t("sidebar_expandAll")}
                    onClick={() => { expandAll(); setDisplayMenuOpen(false); }}
                  />
                  <div style={{ borderTop: "1px solid var(--border)", margin: "2px 0" }} />
                  <DisplayMenuItem
                    label={t("sidebar_recentSessions")}
                    checked={showRecentSessions}
                    onClick={() => { setShowRecentSessions(!showRecentSessions); setDisplayMenuOpen(false); }}
                  />
                </div>
              </AnimatedDropdown>
            </div>
            {/* 刷新按钮已移除：会话列表 30s 自动刷新（见下方轮询 effect） */}
        </div>
        </div>

        {/* 搜索行：第二行展示、自动聚焦、Esc 先清空再关闭；范围覆盖全部项目。
            Archive 视图打开时隐藏（归档列表自带查找语义，首版不叠加搜索）。 */}
        {!archiveViewOpen && searchOpen && (
          <div style={{ marginTop: 8 }}>
            <div style={{ display: "flex", gap: 4, marginBottom: 6 }}>
              <button
                type="button"
                onClick={() => setSearchMode("meta")}
                aria-pressed={searchMode === "meta"}
                style={{
                  flex: 1, height: 24, borderRadius: 6, border: "1px solid var(--border)",
                  background: searchMode === "meta" ? "var(--bg-selected)" : "var(--bg-panel)",
                  color: "var(--text)", fontSize: 11, cursor: "pointer",
                }}
              >
                {t("sidebar_searchModeMeta")}
              </button>
              <button
                type="button"
                onClick={() => setSearchMode("fulltext")}
                aria-pressed={searchMode === "fulltext"}
                style={{
                  flex: 1, height: 24, borderRadius: 6, border: "1px solid var(--border)",
                  background: searchMode === "fulltext" ? "var(--bg-selected)" : "var(--bg-panel)",
                  color: "var(--text)", fontSize: 11, cursor: "pointer",
                }}
              >
                {t("sidebar_searchModeFulltext")}
              </button>
            </div>
            <div style={{ position: "relative" }}>
              <span style={{ position: "absolute", left: 9, top: "50%", transform: "translateY(-50%)", color: "var(--text-dim)", pointerEvents: "none", display: "flex" }}>
                <SearchIcon size={13} />
              </span>
              <input
                ref={searchInputRef}
                type="search"
                value={sessionQuery}
                onChange={(event) => setSessionQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    event.stopPropagation();
                    if (sessionQuery) clearSearchState();
                    else {
                      setSearchOpen(false);
                      clearSearchState();
                    }
                  }
                }}
                placeholder={searchMode === "fulltext" ? t("sidebar_searchPlaceholderFulltext") : t("sidebar_searchPlaceholder")}
                aria-label={t("sidebar_searchSessions")}
                style={{
                  width: "100%", height: 30, boxSizing: "border-box", padding: "0 28px 0 29px",
                  border: "1px solid var(--border)", borderRadius: 7,
                  background: "var(--bg-panel)", color: "var(--text)",
                  fontSize: 11.5, outline: "none",
                }}
              />
              {sessionQuery && (
                <button
                  type="button"
                  onClick={() => clearSearchState()}
                  aria-label={t("sidebar_clearSearch")}
                  title={t("sidebar_clearSearch")}
                  style={{
                    position: "absolute", right: 4, top: "50%", transform: "translateY(-50%)",
                    width: 22, height: 22, display: "flex", alignItems: "center", justifyContent: "center",
                    padding: 0, border: "none", borderRadius: 5, background: "none",
                    color: "var(--text-dim)", cursor: "pointer",
                  }}
                >
                  <XIcon size={13} />
                </button>
              )}
            </div>
            {searchMode === "fulltext" && sessionQuery.trim() && (
              <div style={{ marginTop: 6, fontSize: 10.5, color: "var(--text-dim)", display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                {fulltextLoading && <span>{t("sidebar_searchFulltextLoading")}</span>}
                {!fulltextLoading && fulltextSource === "fts" && (
                  <span>{t("sidebar_searchFulltextSourceFts")} · {t("sidebar_searchFulltextHits", { count: fulltextHits.length })}</span>
                )}
                {!fulltextLoading && fulltextSource === "jsonl" && (
                  <span>{t("sidebar_searchFulltextSourceJsonl")} · {t("sidebar_searchFulltextHits", { count: fulltextHits.length })}</span>
                )}
                {fulltextError && <span style={{ color: "var(--status-danger)" }}>{fulltextError}</span>}
              </div>
            )}
          </div>
        )}

      </div>

      {/* 全文命中片段：点击深链打开对应会话 */}
      {!archiveViewOpen && searchOpen && searchMode === "fulltext" && fulltextHits.length > 0 && (
        <div style={{
          flex: "0 0 auto", maxHeight: 160, overflowY: "auto", overflowX: "hidden",
          borderBottom: "1px solid var(--border)", padding: "4px 0",
        }}>
          {fulltextHits.slice(0, 12).map((hit, index) => (
            <button
              key={`${hit.sessionId}-${hit.timestamp}-${index}`}
              type="button"
              onClick={() => openSessionById(hit.sessionId)}
              title={t("sidebar_searchFulltextSnippet")}
              style={{
                display: "block", width: "100%", textAlign: "left",
                padding: "6px 12px", border: "none", background: "transparent",
                color: "var(--text)", cursor: "pointer", fontSize: 11, lineHeight: 1.4,
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
            >
              <div style={{ color: "var(--text-dim)", fontSize: 10, marginBottom: 2 }}>
                {(hit.role ?? "message")} · {hit.sessionId.slice(0, 8)}
              </div>
              <div style={{
                overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 2,
                WebkitBoxOrient: "vertical", whiteSpace: "normal",
              }}>
                {hit.snippet}
              </div>
            </button>
          ))}
        </div>
      )}

      {/* Archive 视图：侧栏内替换项目树（首版列表 + 恢复 + 删除；打开只读浏览为后续）。
          数据源为 /api/sessions 默认响应的 archivedSessions/archivedCount。 */}
      {archiveViewOpen ? (
        <ArchiveView
          sessions={archivedSessions}
          count={archivedCount}
          homeDir={homeDir}
          loading={loading}
          onRefresh={loadSessions}
          onBack={() => setArchiveViewOpen(false)}
        />
      ) : (
        <>
        {archiveError && (
          <div role="alert" style={{ padding: "6px 12px", borderBottom: "1px solid var(--border)", background: "var(--status-danger-bg)", color: "var(--status-danger)", fontSize: 11, lineHeight: 1.4, overflowWrap: "anywhere", flexShrink: 0 }}>
            {archiveError}
          </div>
        )}
      {/* 项目树：Project → (非主 Worktree) → Session → child */}
      <div ref={sessionListRef} style={{ flex: "1 1 auto", overflowY: "auto", overflowX: "hidden", padding: "2px 0", minHeight: 80 }}>
        {loading && (
          <div style={{ padding: "16px 14px", color: "var(--text-muted)", fontSize: 12 }}>
            {t("sidebar_loading")}
          </div>
        )}
        {error && (
          <div style={{ padding: "12px 14px", color: "var(--status-danger)", fontSize: 12 }}>
            {error}
          </div>
        )}
        {!loading && !error && visibleTree.length === 0 && (
          (searchMode === "meta" ? normalizedSessionQuery.length > 0 : fulltextModeActive && !fulltextLoading) ? (
            <div style={{ padding: "18px 14px", color: "var(--text-muted)", fontSize: 12, lineHeight: 1.55 }}>
              {t("sidebar_searchEmpty", { query: sessionQuery.trim() })}
            </div>
          ) : (
            <div style={{ padding: "18px 14px", color: "var(--text-muted)", fontSize: 12, lineHeight: 1.7 }}>
              {t("sidebar_noProjects")}
              <div style={{ color: "var(--text-dim)", fontSize: 11 }}>
                {t("sidebar_addProject")}
              </div>
            </div>
          )
        )}
        {/* 最近会话区：项目列表上方的纯快捷入口（OpenChamber Recent zone 语义）。
            搜索激活时隐藏，只显示匹配树；不参与树的分组/折叠状态，
            选中态、运行/未读徽标与树内同会话共享同一数据源。 */}
        {!searchActive && recentSessions.length > 0 && (
          <div style={{ paddingBottom: 5, borderBottom: "1px solid var(--border)", marginBottom: 5 }}>
            <div
              data-sidebar-depth={0}
              role="button"
              tabIndex={0}
              aria-expanded={showRecentSessions}
              aria-label={showRecentSessions ? t("sidebar_collapseRecentSessions") : t("sidebar_expandRecentSessions")}
              onClick={() => setShowRecentSessions(!showRecentSessions)}
              onKeyDown={(event) => {
                if (event.key !== "Enter" && event.key !== " ") return;
                event.preventDefault();
                setShowRecentSessions(!showRecentSessions);
              }}
              className="sidebar-row"
              style={{
              display: "flex", alignItems: "center", gap: 6, height: 32,
              margin: "1px 6px", paddingLeft: sidebarRowPaddingLeft(0), paddingRight: 8,
              color: "var(--text-muted)", fontSize: 12.5, fontWeight: 600,
              position: "relative", cursor: "pointer", borderRadius: 6,
            }}
              onMouseEnter={(event) => { event.currentTarget.style.background = "var(--bg-hover)"; }}
              onMouseLeave={(event) => { event.currentTarget.style.background = "transparent"; }}
            >
              <ChevronButton
                collapsed={!showRecentSessions}
                label={showRecentSessions ? t("sidebar_collapseRecentSessions") : t("sidebar_expandRecentSessions")}
                left={sidebarIndicatorLeft(0)}
                onClick={(event) => { event.stopPropagation(); setShowRecentSessions(!showRecentSessions); }}
              />
              <span aria-hidden="true" className="sidebar-indicator-icon" style={{ position: "absolute", left: sidebarIndicatorLeft(0), top: "50%", display: "flex", width: SIDEBAR_INDICATOR_SLOT, height: 20, alignItems: "center", justifyContent: "center", transform: "translateY(-50%)", color: "var(--text-dim)" }}><HistoryIcon size={13} /></span>
              <span style={{ flex: 1, fontSize: 12.5, fontWeight: 600 }}>{t("sidebar_recentSessions")}</span>
            </div>
            {showRecentSessions && <div>
              {recentSessions.slice(0, recentVisibleCount).map((s) => {
                const node = sessionNodeById.get(s.id);
                // 最近区行与项目树同一渲染：有子会话时折叠/展开显示子会话。
                return node ? (
                  <SessionTreeItem
                    key={s.id}
                    node={node}
                    selectedSessionId={selectedSessionId}
                    runningSessionIds={effectiveRunningSessionIds}
                    subagentRunningIds={subagentRunningIds}
                    unreadSessionIds={unreadSessionIds}
                    onSelectSession={handleSelectSessionFromList}
                    onRenamed={loadSessions}
                    onSessionDeleted={handleSessionDeletedLocal}
                    onSessionArchive={handleArchiveSession}
                    depth={0}
                    collapsedSessionIds={collapsedSessionIds}
                    searchActive={searchActive}
                    onToggleCollapse={toggleSessionCollapse}
                    displayMode={displayMode}
                  />
                ) : (
                  <SessionItem
                    key={s.id}
                    session={s}
                    isSelected={s.id === selectedSessionId}
                    isRunning={effectiveRunningSessionIds.has(s.id) || subagentRunningIds.has(s.id)}
                    isUnread={unreadSessionIds.has(s.id)}
                    onClick={() => handleSelectSessionFromList(s)}
                    onRenamed={loadSessions}
                    onDeleted={handleSessionDeletedLocal}
                    onArchive={handleArchiveSession}
                    depth={0}
                    displayMode={displayMode}
                  />
                );
              })}
              {recentVisibleCount < recentSessions.length && (
                <div style={{ display: "flex", alignItems: "center", gap: 4, padding: "2px 8px 5px 28px" }}>
                  <button
                    type="button"
                    className="sidebar-pagination-btn"
                    onClick={() => setRecentVisibleCount((n) => Math.min(n + RECENT_SESSIONS_LOAD_MORE, recentSessions.length))}
                  >
                    {t("sidebar_showMore")}
                    <span aria-hidden="true">+{RECENT_SESSIONS_LOAD_MORE}</span>
                  </button>
                </div>
              )}
            </div>}
          </div>
        )}
        {visibleTree.map((project) => (
          <ProjectSection
            key={project.root}
            project={project}
            homeDir={homeDir}
            displayMode={displayMode}
            projectAliases={prefs.projectAliases}
            selectedSessionId={selectedSessionId}
            runningSessionIds={effectiveRunningSessionIds}
            subagentRunningIds={subagentRunningIds}
            unreadSessionIds={unreadSessionIds}
            collapsedProjectRoots={collapsedProjectRoots}
            collapsedWorktreePaths={collapsedWorktreePaths}
            collapsedSessionIds={collapsedSessionIds}
            searchActive={searchActive}
            onToggleProject={toggleProjectCollapse}
            onToggleWorktree={toggleWorktreeCollapse}
            onNewSession={handleNewSession}
            onSelectSession={handleSelectSessionFromList}
            menuOpen={openProjectMenuRoot === project.root}
            onMenuOpenChange={(open) => setOpenProjectMenuRoot(open ? project.root : null)}
            onEditProject={() => handleOpenEditProject(project.root)}
            onCloseProject={() => handleCloseProject(project.root)}
            onRenamed={loadSessions}
            onSessionDeleted={handleSessionDeletedLocal}
            onToggleCollapse={toggleSessionCollapse}
            groupVisibleCounts={groupVisibleCounts}
            onShowMore={(groupKey) => setGroupVisibleCounts((counts) => bumpGroupVisibleCount(counts, groupKey))}
            onShowFewer={(groupKey) => setGroupVisibleCounts((counts) => resetGroupVisibleCount(counts, groupKey))}
            worktreeActions={worktreeActionsFor(project.root)}
            wtNewOpen={wtNewForProject === project.root}
            wtNewBranch={wtNewBranch}
            wtError={wtErrorRoot === project.root ? wtError : null}
            wtConfirmRemove={wtConfirmRemove}
            wtNewInputRef={wtNewInputRef}
            onStartCreateWorktree={() => {
              setWtNewForProject(project.root);
              setWtError(null);
              setWtErrorRoot(null);
              setTimeout(() => wtNewInputRef.current?.focus(), 0);
            }}
            onWtNewBranchChange={(value) => {
              setWtNewBranch(value);
              setWtError(null);
              setWtErrorRoot(null);
            }}
            onSubmitCreateWorktree={() => void handleCreateWorktree()}
            onCancelCreateWorktree={() => {
              setWtNewForProject(null);
              setWtNewBranch("");
              setWtError(null);
              setWtErrorRoot(null);
            }}
            onRequestRemoveWorktree={(path) => void handleRemoveWorktree(project.root, path, false)}
            onConfirmRemoveWorktree={(path) => void handleRemoveWorktree(project.root, path, true)}
            onCancelRemoveWorktree={() => setWtConfirmRemove(null)}
            onSessionArchive={handleArchiveSession}
           />
         ))}
       </div>
       </>
      )}


      {/* 添加项目弹窗：总是经 ViewportDialog，不直接拉起原生选择器；
          「选择目录」仅填充输入，提交仍走 /api/cwd/validate。 */}
      <ViewportDialog
        open={customPathOpen}
        onClose={closeCustomPathPanel}
        title={t("sidebar_addProjectDialog")}
        width={440}
        closeLabel={t("dialog_close")}
        initialFocusRef={customPathInputRef}
        description={t("sidebar_addProjectDescription")}
        actions={
          <>
            <DialogButton onClick={closeCustomPathPanel}>{t("sidebar_cancel")}</DialogButton>
            {/* 上游 directory-picker：Select 只允许已浏览的路径（输入与浏览
                不一致时 disabled，title 提示先打开/浏览） */}
            <span
              title={
                !browsePath || customPathValue.trim() !== browsePath
                  ? t("sidebar_browseOpenBeforeSelect")
                  : undefined
              }
            >
              <DialogButton
                primary
                disabled={customPathValidating || !browsePath || customPathValue.trim() !== browsePath}
                onClick={() => void commitCustomPath()}
              >
                {customPathValidating ? t("sidebar_validating") : t("sidebar_add")}
              </DialogButton>
            </span>
          </>
        }
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            // 上游 directory-picker：Enter = 浏览输入路径；只有 Select 按钮提交
            const raw = customPathValue.trim();
            if (!raw || raw === browsePath) return;
            void browseDirectory(raw);
          }}
        >
          <label
            htmlFor="add-project-path"
            style={{ display: "block", fontSize: 12, fontWeight: 600, color: "var(--text)", marginBottom: 6 }}
          >
            {t("sidebar_projectPath")}
          </label>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <input
              id="add-project-path"
              ref={customPathInputRef}
              value={customPathValue}
              onChange={(e) => {
                setCustomPathValue(e.target.value);
                setCustomPathError(null);
              }}
              onKeyDown={(e) => {
                // Enter 走 form onSubmit（浏览）；仅 Esc 快速关闭
                if (e.key === "Escape" && !customPathValidating) {
                  e.preventDefault();
                  closeCustomPathPanel();
                }
              }}
              placeholder="/path/to/project"
              aria-label={t("sidebar_projectPath")}
              autoComplete="off"
              spellCheck={false}
              style={{
                flex: 1,
                minWidth: 0,
                height: 32,
                fontSize: 12,
                fontFamily: "var(--font-mono)",
                padding: "0 10px",
                border: "1px solid var(--border)",
                borderRadius: 7,
                outline: "none",
                background: "var(--bg-panel)",
                color: "var(--text)",
                boxSizing: "border-box",
              }}
            />
            <DialogButton
              disabled={browseLoading || !customPathValue.trim()}
              onClick={() => void browseDirectory(customPathValue.trim())}
            >
              {browseLoading ? t("sidebar_browseLoading") : t("sidebar_browseGo")}
            </DialogButton>
            {desktopPickerAvailable && (
              <DialogButton onClick={() => void handlePickDirectory()}>
                {t("sidebar_selectDirectory")}
              </DialogButton>
            )}
          </div>
          {/* 目录列表（上游 directory-picker：浏览结果区；git 徽标保留） */}
          {browsePath && (
            <div style={{ marginTop: 10 }}>
              {browseLoading && (
                <div style={{ fontSize: 11, color: "var(--text-dim)" }}>{t("sidebar_browseLoading")}</div>
              )}
              {!browseLoading && browseMissing && (
                <div style={{ fontSize: 11, color: "var(--text-dim)" }}>{t("sidebar_browseMissing")}</div>
              )}
              {!browseLoading && !browseMissing && browseGit && (
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    fontSize: 11,
                    marginBottom: 6,
                    color: browseGit.isRepo ? "var(--text-muted)" : "var(--text-dim)",
                  }}
                >
                  {browseGit.isRepo ? (
                    <>
                      <span style={{ color: "var(--accent)", fontWeight: 600 }}>{t("sidebar_browseGitRepo")}</span>
                      {browseGit.branch && (
                        <span style={{ fontFamily: "var(--font-mono)", fontSize: 10.5 }}>{browseGit.branch}</span>
                      )}
                    </>
                  ) : (
                    <span>{t("sidebar_browseNotGit")}</span>
                  )}
                </div>
              )}
              {!browseLoading && !browseMissing && (
                <div
                  style={{
                    maxHeight: 150,
                    overflowY: "auto",
                    overflowX: "hidden",
                    border: "1px solid var(--border)",
                    borderRadius: 7,
                    background: "var(--bg-panel)",
                    padding: 4,
                  }}
                >
                  {browseParent && (
                    <button
                      type="button"
                      disabled={browseLoading}
                      onClick={() => {
                        void browseDirectory(browseParent);
                      }}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 6,
                        width: "100%",
                        padding: "4px 8px",
                        border: "none",
                        background: "transparent",
                        color: "var(--text-muted)",
                        fontSize: 12,
                        cursor: "pointer",
                        borderRadius: 5,
                        fontFamily: "var(--font-mono)",
                      }}
                      onMouseEnter={(e) => (e.currentTarget.style.background = "var(--bg-hover)")}
                      onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                    >
                      ..
                    </button>
                  )}
                  {browseEntries.length === 0 ? (
                    <div style={{ padding: "6px 8px", fontSize: 11, color: "var(--text-dim)" }}>
                      {t("sidebar_browseEmpty")}
                    </div>
                  ) : (
                    browseEntries.map((entry) => (
                      <button
                        key={entry.path}
                        type="button"
                        disabled={browseLoading}
                        onClick={() => {
                          void browseDirectory(entry.path);
                        }}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 6,
                          width: "100%",
                          padding: "4px 8px",
                          border: "none",
                          background: "transparent",
                          color: "var(--text)",
                          fontSize: 12,
                          cursor: "pointer",
                          borderRadius: 5,
                          textAlign: "left",
                          fontFamily: "var(--font-mono)",
                        }}
                        onMouseEnter={(e) => (e.currentTarget.style.background = "var(--bg-hover)")}
                        onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                      >
                        <span style={{ color: "var(--text-dim)", fontSize: 10.5 }}>▸</span>
                        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {entry.name}
                        </span>
                      </button>
                    ))
                  )}
                </div>
              )}
            </div>
          )}
          {customPathError && (
            <div role="alert" style={{ marginTop: 8, color: "var(--status-danger)", fontSize: 12, lineHeight: 1.45, overflowWrap: "anywhere" }}>
              {customPathError}
            </div>
          )}
          {/* 次级动作：创建默认目录（~/pi-cwd-YYYYMMDD），同样只在弹窗内发起 */}
          <div style={{
            marginTop: 14,
            paddingTop: 12,
            borderTop: "1px solid var(--border)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 8,
          }}>
            <span style={{ fontSize: 11.5, color: "var(--text-dim)" }}>{t("sidebar_noExistingDirectory")}</span>
            <DialogButton disabled={customPathValidating} onClick={() => void handleDefaultCwd()}>
              <HomeIcon size={13} />
              {t("sidebar_createDefaultDirectory")}
            </DialogButton>
          </div>
        </form>
      </ViewportDialog>

      {/* 编辑项目弹窗：仅修改 Pidance 显示名 alias，不动 Pi schema/目录/Git */}
      <ViewportDialog
        open={editProjectRoot !== null}
        onClose={() => setEditProjectRoot(null)}
        title={t("sidebar_editProject")}
        width={720}
        height={620}
        closeLabel={t("dialog_close")}
        description={editProjectRoot
          ? t("sidebar_editProjectDescription", { path: editProjectRoot })
          : undefined}
      >
        {/* 编辑项目：名称 / 项目规则 / 项目技能 */}
        <div style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap" }}>
          {([
            ["name", t("sidebar_projectName")],
            ["rules", t("sidebar_projectRules")],
            ["skills", t("sidebar_projectSkills")],
          ] as const).map(([tabId, label]) => (
            <button
              key={tabId}
              type="button"
              onClick={() => setEditProjectTab(tabId)}
              style={{
                minHeight: 28, padding: "0 12px", borderRadius: 6,
                border: "1px solid var(--border)",
                background: editProjectTab === tabId ? "var(--bg-selected)" : "var(--bg-panel)",
                color: editProjectTab === tabId ? "var(--text)" : "var(--text-muted)",
                cursor: "pointer", fontSize: 12, fontWeight: editProjectTab === tabId ? 600 : 400,
              }}
              aria-current={editProjectTab === tabId ? "page" : undefined}
            >
              {label}
            </button>
          ))}
        </div>

        {editProjectTab === "name" ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              handleSaveProjectAlias();
            }}
          >
            <label
              htmlFor="edit-project-name"
              style={{ display: "block", fontSize: 12, fontWeight: 600, color: "var(--text)", marginBottom: 6 }}
            >
              {t("sidebar_projectName")}
            </label>
            <input
              id="edit-project-name"
              ref={editProjectInputRef}
              value={editProjectValue}
              onChange={(e) => setEditProjectValue(e.target.value)}
              placeholder={t("sidebar_projectName")}
              aria-label={t("sidebar_projectName")}
              aria-invalid={!editProjectValue.trim()}
              autoComplete="off"
              spellCheck={false}
              style={{
                width: "100%",
                height: 32,
                fontSize: 12.5,
                padding: "0 10px",
                border: "1px solid var(--border)",
                borderRadius: 7,
                outline: "none",
                background: "var(--bg-panel)",
                color: "var(--text)",
                boxSizing: "border-box",
              }}
            />
            {!editProjectValue.trim() && (
              <div style={{ marginTop: 6, fontSize: 11.5, color: "var(--status-danger)" }}>{t("sidebar_projectNameRequired")}</div>
            )}
            <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
              <button
                type="submit"
                disabled={!editProjectValue.trim()}
                style={{
                  minHeight: 30, padding: "0 14px", borderRadius: 7,
                  border: "1px solid var(--accent)", background: "var(--accent)",
                  color: "var(--accent-foreground)",
                  cursor: !editProjectValue.trim() ? "not-allowed" : "pointer",
                  fontSize: 12, fontWeight: 600,
                  opacity: !editProjectValue.trim() ? 0.6 : 1,
                }}
              >
                {t("sidebar_save")}
              </button>
              <button
                type="button"
                onClick={() => setEditProjectRoot(null)}
                style={{
                  minHeight: 30, padding: "0 12px", borderRadius: 7,
                  border: "1px solid var(--border)", background: "var(--bg-panel)",
                  color: "var(--text-muted)", cursor: "pointer", fontSize: 12,
                }}
              >
                {t("sidebar_cancel")}
              </button>
            </div>
          </form>
        ) : (
          editProjectRoot && (
            <ProjectAssetsEditor
              cwd={editProjectRoot}
              tab={editProjectTab === "skills" ? "skills" : "rules"}
            />
          )
        )}
      </ViewportDialog>
      </div>
    </RunningTimeContext.Provider>
    );
  }


// ── 项目分区（项目行 + 主仓会话 + 非主 worktree 分组） ──────────────────────

