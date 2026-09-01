"use client";

import { createContext, useContext, useEffect, useLayoutEffect, useState, useCallback, useMemo, useRef } from "react";
import { createPortal } from "react-dom";
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
  moveProjectInOrder,
  pickProjectRootAfterClose,
  projectHasRunningSession,
  sortSidebarProjects,
  type SidebarProjectNode,
  type SidebarWorktreeGroup,
} from "./session-sidebar-model";
import {
  applySyncedSidebarUi,
  loadSidebarPreferences,
  saveSidebarPreferences,
  sidebarUiFromPrefs,
  type ProjectAliases,
  type ProjectSortMode,
  type SidebarDisplayMode,
  type SidebarPreferences,
} from "@/lib/ui-preferences";
import { loadCachedSessionList, saveCachedSessionList } from "@/lib/session-list-cache";
import { flushServerPrefs, getServerPref, setServerPref, useServerPreferences } from "@/lib/server-preferences";
import {
  bumpGroupVisibleCount,
  derivePinnedSessions,
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
} from "./session-sidebar-state";
import { getSessionCapabilities } from "./session-capabilities";
import { useProjectActions, useProjectIdentity } from "./ProjectProvider";

import { useI18n } from "@/lib/i18n";
import {
  applyRunningUnreadStateTransition,
  loadUnreadSessionIds,
  markSessionRead,
  mergeUnreadSessionState,
  parseUnreadSessionState,
  pruneUnreadSessionState,
  saveUnreadSessionIds,
  shouldApplyRunningReconciliation,
  unreadIdsFromState,
  type UnreadSessionState,
} from "@/lib/unread-sessions-storage";

import {
  AnimatedDropdown,
  ArchiveIcon,
  BranchIcon,
  BranchPlusIcon,
  ChatPlusIcon,
  CheckIcon,
  ChevronButton,
  DisplayMenuItem,
  FolderIcon,
  HistoryIcon,
  PinIcon,
  FolderPlusIcon,
  formatRelativeTime,
  GroupPagination,
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
import { AddProjectDialog } from "@/components/session-sidebar/AddProjectDialog";
import { EditProjectDialog } from "@/components/session-sidebar/EditProjectDialog";
import { ArchiveView } from "@/components/ArchiveView";
import { canArchiveSession } from "./session-capabilities";
import { archiveSession, archiveFailureKind } from "@/lib/session-archive-client";
import { useWorktreePreload } from "@/hooks/useWorktreePreload";
import { useSidebarWorktreeActions } from "@/hooks/useSidebarWorktreeActions";
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
  /** 服务器权威列表是否已应用（区分 localStorage 缓存首帧与服务器完整列表）。 */
  const [serverListLoaded, setServerListLoaded] = useState(false);
  const serverSessionsRef = useRef<SessionInfo[]>([]);
  const [pendingById, setPendingById] = useState<Map<string, SessionInfo>>(() => new Map());
  const [pendingIds, setPendingIds] = useState<Set<string>>(() => new Set());
  const [deletedIds, setDeletedIds] = useState<Set<string>>(() => new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const sessionListFetchGenRef = useRef(0);
  const { cwd: selectedCwd, projectRoot: selectedProjectRoot } = useProjectIdentity();
  const { setIdentity, getIdentitySnapshot } = useProjectActions();
  const [homeDir, setHomeDir] = useState<string>("");
  const [customPathOpen, setCustomPathOpen] = useState(false);
  // 项目行三点菜单：同一时刻仅一个打开（root 标识）
  const [openProjectMenuRoot, setOpenProjectMenuRoot] = useState<string | null>(null);
  const [editProjectRoot, setEditProjectRoot] = useState<string | null>(null);
  const mountedRef = useRef(true);
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
  const [unreadState, setUnreadState] = useState<UnreadSessionState>(() => {
    const ids = loadUnreadSessionIds();
    return parseUnreadSessionState([...ids]);
  });
  const unreadHydratedRef = useRef(false);
  const unreadSessionIds = useMemo(() => {
    const ids = unreadIdsFromState(unreadState);
    for (const id of effectiveRunningSessionIds) ids.delete(id);
    return ids;
  }, [unreadState, effectiveRunningSessionIds]);
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
  const [displayMenuPosition, setDisplayMenuPosition] = useState<{ top: number; right: number } | null>(null);
  const displayMenuRef = useRef<HTMLDivElement>(null);
  const displayMenuBodyRef = useRef<HTMLDivElement>(null);
  const displayMenuAnchorRef = useRef<{ top: number; bottom: number; right: number } | null>(null);
  // 渲染后按实际菜单高度校正：底部空间不足时向上翻转（估算高度会造成偏差）。
  useEffect(() => {
    if (!displayMenuOpen || !displayMenuAnchorRef.current) return;
    const frame = requestAnimationFrame(() => {
      const menu = displayMenuBodyRef.current;
      const anchor = displayMenuAnchorRef.current;
      if (!menu || !anchor) return;
      const height = menu.offsetHeight;
      if (anchor.bottom + 4 + height <= window.innerHeight) return;
      setDisplayMenuPosition((prev) => (prev ? { ...prev, top: Math.max(8, anchor.top - height - 4) } : prev));
    });
    return () => cancelAnimationFrame(frame);
  }, [displayMenuOpen]);
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
  const prevSelectedScrollIdRef = useRef<string | null>(null);
  const previousRunningSessionIdsRef = useRef<Set<string>>(new Set());
  const previousEffectiveRunningSessionIdsRef = useRef<Set<string>>(new Set());
  // SSE 或 /api/agent/running 一旦返回，旧 /api/sessions 快照不得再覆盖运行态。
  const runningSnapshotAuthoritativeRef = useRef(false);
  // 任一较新运行快照都会使在途 GET 失效；请求序号同时处理多个恢复请求乱序。
  const runningSnapshotRevisionRef = useRef(0);
  const runningReconciliationRequestRef = useRef(0);
  const sessionRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const commitRunningSnapshot = useCallback((ids: Iterable<string>) => {
    runningSnapshotRevisionRef.current += 1;
    setRunningSessionIds(new Set(ids));
  }, []);

  /** 偏好更新唯一入口：内存态与 localStorage 同步写。 */
  const updatePrefs = useCallback((updater: (prev: SidebarPreferences) => SidebarPreferences) => {
    setPrefs((prev) => {
      const next = updater(prev);
      if (next !== prev) {
        // sidebarWidth 的唯一 owner 是 AppShell；保存其它偏好时保留存储中的
        // 当前宽度，避免侧栏内存里的过期副本回写覆盖最近一次拖拽结果。
        const stored = { ...next, sidebarWidth: loadSidebarPreferences().sidebarWidth };
        saveSidebarPreferences(stored);
        setServerPref("sidebarUi", sidebarUiFromPrefs(stored));
      }
      return next;
    });
  }, []);

  // 项目名别名跨客户端同步：服务端为权威（键级覆盖），localStorage 兜底。
  // 写路径双写（updatePrefs + setServerPref），保证本机无闪回、他端刷新生效。
  const serverPrefs = useServerPreferences();
  const projectAliases = useMemo<Record<string, string>>(() => {
    const server = serverPrefs.projectAliases;
    const serverMap =
      typeof server === "object" && server !== null && !Array.isArray(server)
        ? (server as Record<string, string>)
        : {};
    return { ...prefs.projectAliases, ...serverMap };
  }, [prefs.projectAliases, serverPrefs]);

  useEffect(() => {
    const remote = serverPrefs.sidebarUi;
    if (remote === undefined) return;
    setPrefs((prev) => {
      const next = applySyncedSidebarUi(prev, remote);
      if (JSON.stringify(sidebarUiFromPrefs(prev)) === JSON.stringify(sidebarUiFromPrefs(next))) {
        return prev;
      }
      saveSidebarPreferences({ ...next, sidebarWidth: loadSidebarPreferences().sidebarWidth });
      return next;
    });
  }, [serverPrefs]);

  const displayMode = prefs.displayMode;
  const showRecentSessions = prefs.showRecentSessions;
  // 最近区分页：池 20、默认显示 5、每次 +5
  const [recentVisibleCount, setRecentVisibleCount] = useState(RECENT_SESSIONS_INITIAL_VISIBLE);

  const collapsedProjectRoots = useMemo(() => new Set(prefs.collapsedProjectRoots), [prefs.collapsedProjectRoots]);
  const collapsedWorktreePaths = useMemo(() => new Set(prefs.collapsedWorktreePaths), [prefs.collapsedWorktreePaths]);
  // 已关闭项目集合：仅影响侧栏可见性与自动选择，绝不触碰会话/目录/Git 数据
  const closedRoots = useMemo(() => new Set(prefs.closedProjectRoots), [prefs.closedProjectRoots]);

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
      // 服务器权威列表已应用：URL 恢复可据此判定目标会话真实存在与否（localStorage
      // 缓存只存最近 50 条，旧会话刷新时缓存缺失是常态，不能就此放弃恢复）。
      setServerListLoaded(true);
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
      // 仅作首次 fallback；实时 running 端点已有快照后，慢列表响应不可复活旧状态。
      if (!runningSnapshotAuthoritativeRef.current) {
        commitRunningSnapshot(data.runningSessionIds ?? []);
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
      setUnreadState((prev) => {
        const keep = new Set([...existingIds, ...pendingSnapshot]);
        return pruneUnreadSessionState(prev, keep);
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
      // 服务器列表获取失败（网络/认证）：也视为“完整列表已判定”，
      // 否则 URL 恢复会永远停留在等待态，聊天区既不恢复也不显示占位。
      setServerListLoaded(true);
    } finally {
      if (
        mountedRef.current
        && shouldApplySessionListResponse(gen, sessionListFetchGenRef.current)
        && showLoading
      ) {
        setLoading(false);
      }
    }
  }, [commitRunningSnapshot]);
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
  // pending:<intent> 占位被父层撤掉后，这里同步删掉，避免与真实 sid 双行。
  useEffect(() => {
    const liveOptimistic = new Set((optimisticSessions ?? []).map((s) => s.id).filter(Boolean));
    setPendingById((prev) => {
      let next: Map<string, SessionInfo> | null = null;
      for (const id of prev.keys()) {
        if (!id.startsWith("pending:") || liveOptimistic.has(id)) continue;
        if (!next) next = new Map(prev);
        next.delete(id);
      }
      return next ?? prev;
    });
    setPendingIds((prev) => {
      let next: Set<string> | null = null;
      for (const id of prev) {
        if (!id.startsWith("pending:") || liveOptimistic.has(id)) continue;
        if (!next) next = new Set(prev);
        next.delete(id);
      }
      return next ?? prev;
    });
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
    getIdentitySnapshot,
    mountedRef,
  });

  // 未读：时钟结构跨端按较新时间戳合并，避免后写者把已读覆盖成未读。
  useEffect(() => {
    const remoteState = getServerPref<unknown>("unreadSessionState");
    const remoteLegacy = getServerPref<unknown>("unreadSessionIds");
    if (remoteState === undefined && !Array.isArray(remoteLegacy)) return;
    unreadHydratedRef.current = true;
    const remote = mergeUnreadSessionState(
      parseUnreadSessionState(remoteState),
      parseUnreadSessionState(remoteLegacy),
    );
    setUnreadState((prev) => mergeUnreadSessionState(prev, remote));
  }, [serverPrefs]);

  useEffect(() => {
    const ids = unreadIdsFromState(unreadState);
    saveUnreadSessionIds(ids);
    if (!unreadHydratedRef.current) return;
    setServerPref("unreadSessionState", unreadState);
    setServerPref("unreadSessionIds", [...ids]);
    flushServerPrefs();
  }, [unreadState]);

  useEffect(() => {
    // Live running status via SSE — no polling. The server pushes the current
    // set of running session ids whenever any session starts/stops working.
    const source = new EventSource("/api/agent/running/events");

    source.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data) as { type?: string; runningSessionIds?: string[] };
        if (data.type === "running") {
          runningSnapshotAuthoritativeRef.current = true;
          commitRunningSnapshot(
            (data.runningSessionIds ?? []).filter((id): id is string => typeof id === "string"),
          );
        }
      } catch {
        // ignore malformed frames
      }
    };

    // On error EventSource auto-reconnects; keep the last known state meanwhile.
    return () => source.close();
  }, [commitRunningSnapshot]);

  // 后台标签页会漏 SSE：聚焦时用 GET 对齐运行集（同机多浏览器可见）。
  // 请求发出后若已收到更新快照，丢弃晚到结果，避免仍在运行的会话被误判完成。
  useEffect(() => {
    const refreshRunning = () => {
      if (document.visibilityState !== "visible") return;
      const requestId = ++runningReconciliationRequestRef.current;
      const requestRevision = runningSnapshotRevisionRef.current;
      void fetch("/api/agent/running", { cache: "no-store" })
        .then((r) => r.json())
        .then((d: { runningSessionIds?: unknown }) => {
          if (!Array.isArray(d.runningSessionIds)) return;
          if (!mountedRef.current || !shouldApplyRunningReconciliation(
            requestRevision,
            runningSnapshotRevisionRef.current,
            requestId,
            runningReconciliationRequestRef.current,
          )) return;
          runningSnapshotAuthoritativeRef.current = true;
          commitRunningSnapshot(
            d.runningSessionIds.filter((id): id is string => typeof id === "string"),
          );
        })
        .catch(() => undefined);
    };
    window.addEventListener("focus", refreshRunning);
    document.addEventListener("visibilitychange", refreshRunning);
    return () => {
      window.removeEventListener("focus", refreshRunning);
      document.removeEventListener("visibilitychange", refreshRunning);
    };
  }, [commitRunningSnapshot]);

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
    const previousRunning = previousRunningSessionIdsRef.current;
    const previousEffectiveRunning = previousEffectiveRunningSessionIdsRef.current;
    const newlyRunning = [...effectiveRunningSessionIds].filter((id) => !previousEffectiveRunning.has(id));

    // 未读只由服务器 running 快照的真实移除生成；切换聊天导致 optimistic running
    // 消失时，服务端 host 仍可能在执行，不能把局部 UI 状态当成完成事件。
    setUnreadState((prev) =>
      applyRunningUnreadStateTransition(
        prev,
        previousRunning,
        runningSessionIds,
        selectedSessionId,
        new Date().toISOString(),
      ),
    );

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

    previousRunningSessionIdsRef.current = new Set(runningSessionIds);
    previousEffectiveRunningSessionIdsRef.current = new Set(effectiveRunningSessionIds);
  }, [effectiveRunningSessionIds, runningSessionIds, selectedSessionId]);

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
    setUnreadState((prev) => markSessionRead(prev, selectedSessionId, new Date().toISOString()));
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
  const {
    wtNewForProject,
    setWtNewForProject,
    wtNewBranch,
    setWtNewBranch,
    wtError,
    setWtError,
    wtErrorRoot,
    setWtErrorRoot,
    wtBusy,
    wtConfirmRemove,
    setWtConfirmRemove,
    handleCreateWorktree,
    handleRemoveWorktree,
  } = useSidebarWorktreeActions({
    selectedCwd,
    selectCwd: (cwd, projectRoot) => selectCwd(cwd, projectRoot),
    commitWorktreeSnapshots,
    setWtRefreshKey,
  });

  // Auto-select cwd and restore session from URL on first load
  useEffect(() => {
    if (allSessions.length === 0 || skipInitialProjectSelection) return;

    // URL 恢复必须优先于 cwd 自动选择；requestedCwd 已先建立身份时，
    // selectedCwd 不再为空，但仍不能跳过目标会话恢复。
    if (initialSessionId && !restoredRef.current) {
      const target = allSessions.find((s) => s.id === initialSessionId);
      if (typeof window !== "undefined") {
      }
      if (target) {
        restoredRef.current = true;
        // URL 恢复同样走 handleSelectSession 统一路径：suppress → setIdentity
        // → setSelectedSession 原子完成，watcher 不会清空恢复中的会话。
        onSelectSession(target, true);
        return;
      }
      // 首帧 localStorage 缓存只保留最近 50 条，旧会话缺失是常态：必须等
      // 服务器完整列表到达后再判定目标会话不存在，否则刷新旧会话/分享链接
      // 会直接掉进空聊天/引导页（此前 restoredRef 一旦置位永不重试）。
      if (!serverListLoaded) return;
      // Session not found — notify parent so it can show the placeholder
      restoredRef.current = true;
      onInitialRestoreDone?.();
    }
    if (selectedCwd === null) {
      // 已关闭项目不参与自动选择：全部关闭时保持空工作区，而不是复活已关闭项目。
      const projects = getRecentProjects(allSessions);
      const next = projects.find((root) => !closedRoots.has(root));
      if (next) selectCwd(next);
    }
  }, [allSessions, selectedCwd, initialSessionId, skipInitialProjectSelection, onSelectSession, onInitialRestoreDone, selectCwd, closedRoots, serverListLoaded]);

  const closeCustomPathPanel = useCallback(() => {
    setCustomPathOpen(false);
  }, []);

  /** 重新打开已关闭项目：仅移除关闭标记，不触碰任何项目数据。 */
  const restoreClosedProject = useCallback((root: string) => {
    updatePrefs((prev) => prev.closedProjectRoots.includes(root)
      ? { ...prev, closedProjectRoots: prev.closedProjectRoots.filter((item) => item !== root) }
      : prev);
  }, [updatePrefs]);

  const handleProjectAdded = useCallback((cwd: string, root: string) => {
    // 只追加项目列表并恢复关闭态，不切换当前项目/会话（避免覆盖用户正在看的项目）。
    updatePrefs((prev) =>
      prev.addedProjectRoots.includes(root)
        ? prev
        : { ...prev, addedProjectRoots: [...prev.addedProjectRoots, root] },
    );
    restoreClosedProject(root);
    closeCustomPathPanel();
    onProjectAdded?.(root);
  }, [updatePrefs, restoreClosedProject, closeCustomPathPanel, onProjectAdded]);

  const openAddProjectDialog = useCallback(() => {
    setCustomPathOpen(true);
  }, []);

  // 点击外部关闭显示模式菜单
  useEffect(() => {
    if (!displayMenuOpen) return;
    const handler = (e: MouseEvent) => {
      // 菜单 portal 到 body：菜单本体（菜单项）不算外部，避免 mousedown 先关闭
      // 菜单导致菜单项 click 丢失。
      if (
        displayMenuRef.current
        && !displayMenuRef.current.contains(e.target as Node)
        && !displayMenuBodyRef.current?.contains(e.target as Node)
      ) {
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
  // identity 切换统一由 AppShell.handleSelectSession 在 suppress 之后完成：
  // ProjectContext 的 store 更新（useSyncExternalStore）同步触发身份 watcher，
  // 若在此处先 selectCwd，watcher 会在 suppress 生效前清空刚选中的会话 →
  // 掉进引导页。worktree 预加载随后修正权威 projectRoot。
  const handleSelectSessionFromList = useCallback((s: SessionInfo) => {
    onSelectSession(s);
  }, [onSelectSession]);

  /** 会话删除收口：树与最近区共用同一处理（乐观删除 + 回流刷新）。 */
  const handleSessionDeletedLocal = useCallback((id: string) => {
    updatePrefs((prev) => (
      prev.pinnedSessionIds.includes(id)
        ? { ...prev, pinnedSessionIds: prev.pinnedSessionIds.filter((x) => x !== id) }
        : prev
    ));
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
  }, [onSessionDeleted, loadSessions, updatePrefs]);

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
      // 归档后不再显示于列表：同步清理置顶，避免残留。
      updatePrefs((prev) => (
        prev.pinnedSessionIds.includes(sessionId)
          ? { ...prev, pinnedSessionIds: prev.pinnedSessionIds.filter((x) => x !== sessionId) }
          : prev
      ));
      loadSessions();
    } catch (e) {
      setArchiveError(e instanceof Error ? e.message : String(e));
    } finally {
      setArchiveBusyId(null);
    }
  }, [archiveBusyId, loadSessions, t, updatePrefs]);

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

  /** 置顶会话 id 集合：置顶会话从最近区排除（不重复出现）。 */
  const pinnedIds = useMemo(() => new Set(prefs.pinnedSessionIds), [prefs.pinnedSessionIds]);

  /** 置顶会话：按置顶顺序（最新置顶在前）；仅显示仍存在、可见的会话。 */
  const pinnedSessions = useMemo(
    () => derivePinnedSessions({ sessions: allSessions, pinnedSessionIds: prefs.pinnedSessionIds, closedProjectRoots: closedRoots }),
    [allSessions, prefs.pinnedSessionIds, closedRoots],
  );

  /** 置顶/取消置顶：唯一写入入口经偏好 seam；新置顶插到最前。 */
  const togglePinSession = useCallback((sessionId: string) => {
    updatePrefs((prev) => {
      if (prev.pinnedSessionIds.includes(sessionId)) {
        return { ...prev, pinnedSessionIds: prev.pinnedSessionIds.filter((id) => id !== sessionId) };
      }
      return { ...prev, pinnedSessionIds: [sessionId, ...prev.pinnedSessionIds] };
    });
  }, [updatePrefs]);

  /** 最近会话：按 modified 降序取 top 20 候选；UI 默认展示 5、每次加载更多 5。 */
  const recentSessions = useMemo(
    () => deriveRecentSessions({ sessions: allSessions, closedProjectRoots: closedRoots, excludeIds: pinnedIds, limit: RECENT_SESSIONS_LIMIT }),
    [allSessions, closedRoots, pinnedIds],
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
  const sortedOpenTree = useMemo(
    () => sortSidebarProjects(openTree, {
      mode: prefs.projectSort,
      order: prefs.projectOrder,
      aliases: projectAliases,
      selectedRoot: selectedProject,
    }),
    [openTree, prefs.projectSort, prefs.projectOrder, projectAliases, selectedProject],
  );
  const visibleTree = useMemo(
    () => filterSidebarTree(
      sortedOpenTree,
      fulltextModeActive ? "" : normalizedSessionQuery,
      projectAliases,
      fulltextMatchIds,
    ),
    [sortedOpenTree, normalizedSessionQuery, projectAliases, fulltextMatchIds, fulltextModeActive],
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
    const selectionChanged = prevSelectedScrollIdRef.current !== selectedSessionId;
    prevSelectedScrollIdRef.current = selectedSessionId;
    const listRect = list.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    const outsideViewport = rowRect.top < listRect.top || rowRect.bottom > listRect.bottom;
    // 展开/折叠会改列表高度，不因此 scrollIntoView，否则滚动条乱跳。
    if (isInitialRestore || (selectionChanged && outsideViewport)) row.scrollIntoView({ block: "nearest" });
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
    // 运行中关项目会藏掉控制面：拒绝关闭，与归档 running→409 对齐。
    if (projectHasRunningSession(allSessions, effectiveRunningSessionIds, root)) {
      setError(t("sidebar_closeProjectRunning"));
      return;
    }
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
  }, [prefs.closedProjectRoots, selectedProject, sidebarTree, updatePrefs, selectCwd, onNewSession, allSessions, effectiveRunningSessionIds, t]);

  /** 打开编辑项目弹窗：名称初值为 alias 或路径显示名。 */
  const handleOpenEditProject = useCallback((root: string) => {
    setOpenProjectMenuRoot(null);
    setEditProjectRoot(root);
  }, []);

  /** 保存项目 alias：与文件夹名相同则清除 alias，回到默认显示；local + 服务端双写。 */
  const handleSaveProjectAlias = useCallback((name: string) => {
    if (!editProjectRoot) return;
    const trimmed = name.trim();
    if (!trimmed) return;
    const root = editProjectRoot;
    setEditProjectRoot(null);
    const nextAliases = { ...projectAliases };
    if (trimmed === projectDisplayName(root)) delete nextAliases[root];
    else nextAliases[root] = trimmed;
    updatePrefs((prev) => ({ ...prev, projectAliases: nextAliases }));
    setServerPref("projectAliases", nextAliases);
  }, [editProjectRoot, projectAliases, updatePrefs]);

  const setDisplayMode = useCallback((mode: SidebarDisplayMode) => {
    updatePrefs((prev) => (prev.displayMode === mode ? prev : { ...prev, displayMode: mode }));
  }, [updatePrefs]);

  const setProjectSort = useCallback((mode: ProjectSortMode) => {
    updatePrefs((prev) => {
      if (prev.projectSort === mode && mode !== "fixed") return prev;
      const order = mode === "fixed"
        ? (prev.projectOrder.length > 0 ? prev.projectOrder : visibleTree.map((p) => p.root))
        : prev.projectOrder;
      return { ...prev, projectSort: mode, projectOrder: order };
    });
  }, [updatePrefs, visibleTree]);

  const handleProjectDrop = useCallback((fromRoot: string, toRoot: string) => {
    if (!fromRoot || !toRoot || fromRoot === toRoot) return;
    updatePrefs((prev) => {
      const base = prev.projectSort === "fixed" && prev.projectOrder.length > 0
        ? [...prev.projectOrder]
        : visibleTree.map((p) => p.root);
      for (const project of visibleTree) {
        if (!base.includes(project.root)) base.push(project.root);
      }
      if (!base.includes(fromRoot)) base.push(fromRoot);
      if (!base.includes(toRoot)) base.push(toRoot);
      return {
        ...prev,
        projectSort: "fixed",
        projectOrder: moveProjectInOrder(base, fromRoot, toRoot),
      };
    });
  }, [updatePrefs, visibleTree]);

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
                onClick={() => {
                  const next = !displayMenuOpen;
                  setDisplayMenuOpen(next);
                  if (next) {
                    const rect = displayMenuRef.current?.getBoundingClientRect();
                    if (rect) {
                      // 侧栏 header 固定不随列表滚动，但视口较矮时向下展开仍会
                      // 超出显示区域：fixed 定位，渲染后按实际高度翻转校正。
                      displayMenuAnchorRef.current = { top: rect.top, bottom: rect.bottom, right: rect.right };
                      setDisplayMenuPosition({ top: rect.bottom + 4, right: Math.max(8, window.innerWidth - rect.right) });
                    }
                  }
                }}
              >
                <SlidersIcon size={18} />
              </SidebarIconButton>
              {displayMenuOpen && createPortal(
                <AnimatedDropdown
                  open={displayMenuOpen}
                  style={{
                    position: "fixed",
                    top: displayMenuPosition?.top ?? 0,
                    right: displayMenuPosition?.right ?? 0,
                    zIndex: 600,
                    background: "var(--bg)",
                    border: "1px solid var(--border)",
                    borderRadius: 8,
                    boxShadow: "0 6px 20px rgba(0,0,0,0.10)",
                    overflow: "hidden",
                    minWidth: 168,
                  }}
                >
                  <div ref={displayMenuBodyRef} onKeyDown={(e) => { if (e.key === "Escape") setDisplayMenuOpen(false); }}>
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
                  <div style={{ padding: "6px 10px 2px", fontSize: 10, fontWeight: 600, color: "var(--text-dim)", letterSpacing: "0.04em" }}>
                    {t("sidebar_projectSort")}
                  </div>
                  <DisplayMenuItem
                    label={t("sidebar_projectSortRecent")}
                    checked={prefs.projectSort === "recent"}
                    onClick={() => { setProjectSort("recent"); setDisplayMenuOpen(false); }}
                  />
                  <DisplayMenuItem
                    label={t("sidebar_projectSortAz")}
                    checked={prefs.projectSort === "az"}
                    onClick={() => { setProjectSort("az"); setDisplayMenuOpen(false); }}
                  />
                  <DisplayMenuItem
                    label={t("sidebar_projectSortZa")}
                    checked={prefs.projectSort === "za"}
                    onClick={() => { setProjectSort("za"); setDisplayMenuOpen(false); }}
                  />
                  <DisplayMenuItem
                    label={t("sidebar_projectSortFixed")}
                    checked={prefs.projectSort === "fixed"}
                    onClick={() => { setProjectSort("fixed"); setDisplayMenuOpen(false); }}
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
                </AnimatedDropdown>,
                document.body,
              )}
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
        {/* 置顶会话区：最近会话区上方的常驻快捷入口；置顶会话已从最近区排除。
            搜索激活时隐藏；不参与树的分组/折叠状态，选中态/运行/未读与树内同源。 */}
        {!searchActive && pinnedSessions.length > 0 && (
          <div style={{ paddingBottom: 5, borderBottom: "1px solid var(--border)", marginBottom: 5 }}>
            <div
              data-sidebar-depth={0}
              className="sidebar-row"
              style={{
                display: "flex", alignItems: "center", gap: 6, height: 32,
                margin: "1px 6px", paddingLeft: sidebarRowPaddingLeft(0), paddingRight: 8,
                color: "var(--text-muted)", fontSize: 12.5, fontWeight: 600,
                position: "relative", borderRadius: 6,
              }}
            >
              <span aria-hidden="true" className="sidebar-indicator-icon" style={{ position: "absolute", left: sidebarIndicatorLeft(0), top: "50%", display: "flex", width: SIDEBAR_INDICATOR_SLOT, height: 20, alignItems: "center", justifyContent: "center", transform: "translateY(-50%)", color: "var(--text-dim)" }}><PinIcon size={13} /></span>
              <span style={{ flex: 1, fontSize: 12.5, fontWeight: 600 }}>{t("sidebar_pinnedSessions")}</span>
            </div>
            {pinnedSessions.map((s) => {
              const node = sessionNodeById.get(s.id);
              // 置顶区行与项目树同一渲染：有子会话时折叠/展开显示子会话。
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
                  isSessionPinned={(id) => pinnedIds.has(id)}
                  onTogglePin={togglePinSession}
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
                  isPinned={pinnedIds.has(s.id)}
                  onTogglePin={() => togglePinSession(s.id)}
                  depth={0}
                  displayMode={displayMode}
                />
              );
            })}
          </div>
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
                    isSessionPinned={(id) => pinnedIds.has(id)}
                    onTogglePin={togglePinSession}
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
                    isPinned={pinnedIds.has(s.id)}
                    onTogglePin={() => togglePinSession(s.id)}
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
            projectAliases={projectAliases}
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
            isSessionPinned={(id) => pinnedIds.has(id)}
            onTogglePin={togglePinSession}
            onProjectDrop={searchActive ? undefined : handleProjectDrop}
           />
         ))}
       </div>
       </>
      )}


      <AddProjectDialog
        open={customPathOpen}
        onClose={closeCustomPathPanel}
        resolveProjectRoot={(cwd) => projectRootFor(cwd) ?? cwd}
        onAdded={handleProjectAdded}
      />
      <EditProjectDialog
        projectRoot={editProjectRoot}
        initialName={editProjectRoot ? (projectAliases[editProjectRoot] ?? projectDisplayName(editProjectRoot)) : ""}
        onClose={() => setEditProjectRoot(null)}
        onSaveName={handleSaveProjectAlias}
      />
      </div>
    </RunningTimeContext.Provider>
    );
  }
