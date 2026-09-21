"use client";

import { createContext, useContext, useEffect, useLayoutEffect, useState, useCallback, useMemo, useRef } from "react";
import { createPortal } from "react-dom";
import type { SessionInfo } from "@/lib/types";
import { displayCwd, getRecentProjects, projectDisplayName } from "@/lib/project-context";
import {
  filterSessionDisplayTree,
  isSessionNodeEffectivelyCollapsed,
  normalizeSessionQuery,
  type SessionDisplayNode,
  type SessionRelationKind,
} from "./session-tree";
import {
  buildSidebarTree,
  buildUngroupedTree,
  collectAllCollapseIds,
  collectSubagentParentIdsFromSidebarTree,
  filterSessionDisplayTreeByIds,
  filterSidebarTree,
  locateSessionInSidebarTree,
  locateSessionInUngroupedTree,
  SIDEBAR_COLLECTION_FIELDS,
  type PrefOp,
  moveProjectInOrder,
  pickProjectRootAfterClose,
  projectHasRunningSession,
  sortSidebarProjects,
  UNGROUPED_GROUP_KEY,
  type SidebarProjectNode,
} from "./session-sidebar-model";
import {
  applySyncedSidebarUi,
  hasStoredSidebarPreferences,
  loadSidebarPreferences,
  saveSidebarPreferences,
  sidebarUiFromPrefs,
  type ProjectAliases,
  type ProjectSortMode,
  type SidebarDisplayMode,
  type SidebarPreferences,
} from "@/lib/ui-preferences";
import { loadCachedSessionList, saveCachedSessionList } from "@/lib/session-list-cache";
import { refreshSubagentActivity, useSubagentActivity } from "@/hooks/useSubagentActivity";
import { createActivationRecovery } from "@/lib/activation-recovery";
import { getServerPref, isServerPrefsLoaded, sendPrefOps, setServerPref, useServerPreferences } from "@/lib/server-preferences";
import {
  bumpGroupVisibleCount,
  derivePinnedSessions,
  deriveRecentSessions,
  nextRecentVisibleCount,
  planSubagentDiscoveryRefresh,
  RECENT_SESSIONS_LIMIT,
  RECENT_SESSIONS_INITIAL_VISIBLE,
  getGroupVisibleCount,
  getVisibleTopLevelNodes,
  resetGroupVisibleCount,
  shouldApplySessionListResponse,
} from "./session-sidebar-state";
import { getSessionCapabilities } from "./session-capabilities";
import { useProjectActions, useProjectIdentity } from "./ProjectProvider";

import { useI18n } from "@/lib/i18n";
import {
  loadUnreadSessionClock,
  mergeUnreadSessionState,
  markSessionRead,
  parseUnreadSessionState,
  pruneUnreadSessionState,
  saveUnreadSessionClock,
  shouldApplyRunningReconciliation,
  unreadIdsFromState,
  type UnreadSessionState,
} from "@/lib/unread-sessions-storage";

import {
  AnimatedDropdown,
  ArchiveIcon,

  ChatPlusIcon,
  CheckIcon,
  ChevronButton,
  DisplayMenuItem,
  FolderIcon,
  HistoryIcon,
  LayersIcon,
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
  UnreadSessionIndicator,
  XIcon,
} from "@/components/session-sidebar/display";
import { ProjectSection, SessionTreeItem, SessionItem } from "@/components/session-sidebar/sections";
import { ProjectRowMenu, SessionRowMenu } from "@/components/session-sidebar/menus";
import { AddProjectDialog } from "@/components/session-sidebar/AddProjectDialog";
import { EditProjectDialog } from "@/components/session-sidebar/EditProjectDialog";
import { ArchiveView } from "@/components/ArchiveView";
import { canArchiveSession } from "./session-capabilities";
import { archiveSession, archiveFailureKind } from "@/lib/session-archive-client";
import { mergeRunningStartedAt } from "@/lib/running-duration";
import { createSessionCatalogStore, type SessionCatalogStore } from "@/lib/session-catalog-store";
import { getOrCreateBrowserSessionRuntimeRegistry } from "@/lib/browser-session-runtime-registry";

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

import { RunningTimeContext, WaitingSessionIdsContext } from "@/components/session-sidebar/running-time";

interface Props {
  selectedSessionId: string | null;
  onSelectSession: (session: SessionInfo, isRestore?: boolean) => void;
  onNewSession?: (cwd?: string) => void;
  initialSessionId?: string | null;
  skipInitialProjectSelection?: boolean;
  onInitialRestoreDone?: (result?: { found?: boolean; error?: string }) => void;
  restoreNonce?: number;
  refreshKey?: number;
  onSessionDeleted?: (sessionId: string) => void;
  /** 添加项目成功：通知上层进入引导页并选中新项目 */
  onProjectAdded?: (cwd: string) => void;
  /** 项目列表变化：让上层（引导页）拿到同一份列表，避免各自解析偏好 */
  onProjectRootsChange?: (roots: readonly string[]) => void;
  /** AppShell 传入的唯一 catalog store；缺省时本组件自建（测试）。 */
  catalogStore?: SessionCatalogStore;
}


// ── 主组件 ─────────────────────────────────────────────────────────────────

function extractWaitingSessionIds(pending: unknown): Set<string> {
  const out = new Set<string>();
  if (!Array.isArray(pending)) return out;
  for (const item of pending) {
    if (item && typeof item === "object") {
      const sid = (item as { sessionId?: unknown }).sessionId;
      if (typeof sid === "string" && sid) out.add(sid);
    }
  }
  return out;
}

export function SessionSidebar({ selectedSessionId, onSelectSession, onNewSession, initialSessionId, skipInitialProjectSelection, onInitialRestoreDone, restoreNonce = 0, refreshKey, onSessionDeleted, onProjectAdded, onProjectRootsChange, catalogStore: catalogStoreProp }: Props) {
  const { t } = useI18n();
  const catalogStoreRef = useRef<SessionCatalogStore | null>(catalogStoreProp ?? null);
  if (!catalogStoreRef.current) catalogStoreRef.current = catalogStoreProp ?? createSessionCatalogStore();
  if (catalogStoreProp) catalogStoreRef.current = catalogStoreProp;
  const catalogStore = catalogStoreRef.current;
  const [catalogTick, setCatalogTick] = useState(0);
  const catalogSelectedRef = useRef(selectedSessionId);
  catalogSelectedRef.current = selectedSessionId;
  const catalogSnapshot = useMemo(
    () => catalogStore.getSnapshot(catalogSelectedRef.current),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [catalogTick, selectedSessionId],
  );
  const serverSessions = catalogSnapshot.sessions;
  const serverListLoaded = catalogSnapshot.serverListLoaded;
  const loading = catalogSnapshot.loading;
  const error = catalogSnapshot.error;
  const archivedSessions = catalogSnapshot.archivedSessions;
  const runningSessionIds = catalogSnapshot.runningIds;
  const serverSessionsRef = useRef<SessionInfo[]>(serverSessions);
  serverSessionsRef.current = serverSessions;
  const sessionListFetchGenRef = useRef(0);
  const { cwd: selectedCwd } = useProjectIdentity();
  const { setIdentity } = useProjectActions();
  const [homeDir, setHomeDir] = useState<string>("");
  const [customPathOpen, setCustomPathOpen] = useState(false);
  // 项目行三点菜单：同一时刻仅一个打开（root 标识）
  const [openProjectMenuRoot, setOpenProjectMenuRoot] = useState<string | null>(null);
  const [editProjectRoot, setEditProjectRoot] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const [sessionRefreshDone, setSessionRefreshDone] = useState(false);
  // SSE running ∪ 当前聊天冷启动 agentRunning（发送瞬间即可显示运行中/时长）
  const effectiveRunningSessionIds = catalogSnapshot.effectiveRunningIds;
  // ── 归档（P0-2）：服务端返回的归档列表/计数 + Archive 视图开关 + 动作状态 ──
  const [archiveViewOpen, setArchiveViewOpen] = useState(false);
  const [archiveBusyId, setArchiveBusyId] = useState<string | null>(null);
  const [archiveError, setArchiveError] = useState<string | null>(null);
  // subagent 活跃运行（子会话 + 等待中的主会话）：数据源是与顶栏谱系共用的
  // useSubagentActivity（单一 30s 轮询），这里只把子会话 id 映射成集合。
  const { runningChildIds: subagentChildRunningIds, bySessionId: subagentActivityBySession } = useSubagentActivity();
  const subagentChildIds = useMemo(
    () => [...subagentActivityBySession.keys()],
    [subagentActivityBySession],
  );
  const subagentRunningIds = useMemo(() => {
    const ids = new Set<string>(subagentChildRunningIds);
    for (const s of serverSessions) {
      if (s.subagent?.parentSessionId && subagentChildRunningIds.has(s.id)) {
        ids.add(s.subagent.parentSessionId);
      }
    }
    return ids;
  }, [subagentChildRunningIds, serverSessions]);
  // agent 询问用户中的会话（extension 弹窗/ask 暂停）：侧栏显示等待黄点。
  const [waitingUserIds, setWaitingUserIds] = useState<ReadonlySet<string>>(() => new Set());
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
      mergeRunningStartedAt(
        prev,
        [...effectiveRunningSessionIds, ...subagentRunningIds],
        catalogSnapshot.runningStartedAt,
        now,
      ),
    );
  }, [effectiveRunningSessionIds, subagentRunningIds, catalogSnapshot.runningStartedAt]);
  const unreadSessionIds = catalogSnapshot.unreadIds;
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
  // 跨刷新偏好：显示模式 + 项目折叠集合（独立 seam）
  const [prefs, setPrefs] = useState<SidebarPreferences>(() => loadSidebarPreferences());
  /**
   * 可否把侧栏偏好写回服务端。共享偏好里的 sidebarUi 是跨端数据，而客户端的这份可能
   * 还空着（全新浏览器、清过缓存）或还没从服务端水合：此时写回就等于用空列表覆盖别人
   * 的项目列表（#63 实测）。所以「本地本来就有持久化偏好」或「已经从服务端水合过」
   * 之前，只写 localStorage、不写服务端。
   */
  const serverWriteReadyRef = useRef<boolean>(hasStoredSidebarPreferences());
  /** 已经推给服务端的 readAt（避免每次 tick 重复 PUT 同一批时间戳）。 */
  const pushedReadAtRef = useRef<Record<string, string>>({});
  // 每个项目的展开条数均为瞬时态，不写偏好。
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

  const commitRunningSnapshot = useCallback((ids: Iterable<string>, runningStartedAt?: Record<string, number>) => {
    runningSnapshotRevisionRef.current += 1;
    const runningIds = [...ids];
    // 乐观 starting 标记只允许活在「本地 send 仍在本进程在途」的窗口里（registry 是
    // run 的 owner）：权威快照未含该 id 且 registry 已无在途 send → 回收标记。否则
    // 切走会话后 run 结束、快照不再含该 id，标记会永久残留（列表一直显示运行中）。
    const registry = getOrCreateBrowserSessionRuntimeRegistry();
    const localInFlightIds = [...catalogStore.getState().startingIds]
      .filter((id) => registry.getRunState(id)?.sendInFlight === true);
    catalogStore.applyRunningSnapshot({
      runningIds,
      runningStartedAt,
      selectedSessionId: catalogSelectedRef.current,
      localInFlightIds,
      now: Date.now(),
    });
  }, [catalogStore]);

  /** 偏好更新唯一入口：内存态与 localStorage 同步写。 */
  const updatePrefs = useCallback((updater: (prev: SidebarPreferences) => SidebarPreferences) => {
    setPrefs((prev) => {
      const next = updater(prev);
      if (next !== prev) {
        // sidebarWidth 的唯一 owner 是 AppShell；保存其它偏好时保留存储中的
        // 当前宽度，避免侧栏内存里的过期副本回写覆盖最近一次拖拽结果。
        const stored = { ...next, sidebarWidth: loadSidebarPreferences().sidebarWidth };
        saveSidebarPreferences(stored);
        // **字段级写入**：只发本次真正变了的子键。写整份 sidebarUi 会用本地这份覆盖共享的
        // 同名字段，而 projectRoots 之类是数组、服务端整值替换 —— 过期或空的一份就能把
        // 用户的项目列表清掉（#63），也会把 locale 这类字段带歪（#62）。
        if (serverWriteReadyRef.current) {
          const before = sidebarUiFromPrefs(prev) as Record<string, unknown>;
          const after = sidebarUiFromPrefs(stored) as Record<string, unknown>;
          const ops: PrefOp[] = [];
          for (const field of Object.keys(after)) {
            if (JSON.stringify(before[field]) === JSON.stringify(after[field])) continue;
            if (field === "projectOrder") {
              // 顺序是「位置语义」，整段替换才是对的
              ops.push({ key: `sidebarUi.${field}`, op: "set", value: after[field] });
              continue;
            }
            if (SIDEBAR_COLLECTION_FIELDS.has(field)) {
              // 集合类键发**命令**（#66）：服务端把「加一项/删一项」施加到当前内容上，
              // 于是两个客户端各自加一项不会互相覆盖（整值 patch 会丢其中一项）。
              const beforeList = Array.isArray(before[field]) ? (before[field] as string[]) : [];
              const afterList = Array.isArray(after[field]) ? (after[field] as string[]) : [];
              for (const value of afterList.filter((item) => !beforeList.includes(item))) {
                ops.push({ key: `sidebarUi.${field}`, op: "add", value });
              }
              for (const value of beforeList.filter((item) => !afterList.includes(item))) {
                ops.push({ key: `sidebarUi.${field}`, op: "remove", value });
              }
              continue;
            }
            setServerPref(`sidebarUi.${field}`, after[field] ?? null);
          }
          if (ops.length > 0) void sendPrefOps(ops);
        }
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
      // projectRootsMigrated 不在同步载荷里，但它的变化要放行：否则「远端仍是旧模型」
      // 这条迁移信号会被当成无变化丢掉，项目区就永远等不到种子。
      const samePayload = JSON.stringify(sidebarUiFromPrefs(prev)) === JSON.stringify(sidebarUiFromPrefs(next));
      // 服务端载荷到了：此后本地的列表就是「服务端的列表」，可以安全回写（见 #63）。
      serverWriteReadyRef.current = true;
      if (samePayload && prev.projectRootsMigrated === next.projectRootsMigrated) {
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

  // 项目列表上报给上层：引导页项目下拉与侧栏项目区共用同一份列表，
  // 不再各自解析 localStorage / 聚合会话 cwd。
  useEffect(() => {
    onProjectRootsChange?.(prefs.projectRoots);
  }, [prefs.projectRoots, onProjectRootsChange]);

  // Catalog 订阅：store 内任何变更同步触发本组件重渲（依赖 tick 触发 memo）。
  useEffect(() => {
    return catalogStore.subscribe(() => setCatalogTick((tick) => tick + 1));
  }, [catalogStore]);

  const loadSessions = useCallback(async (showLoading = false) => {
    const gen = ++sessionListFetchGenRef.current;
    if (showLoading && serverSessionsRef.current.length === 0 && !serverListLoaded) {
      const cached = loadCachedSessionList();
      if (cached && cached.length > 0) {
        if (!mountedRef.current || !shouldApplySessionListResponse(gen, sessionListFetchGenRef.current)) return;
        catalogStore.applyServerList({ sessions: cached, archivedSessions: [], archivedCount: 0, provisional: true });
      }
    }
    catalogStore.beginListLoad();
    try {
      const res = await fetch("/api/sessions");
      if (!mountedRef.current || !shouldApplySessionListResponse(gen, sessionListFetchGenRef.current)) return;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as { sessions: SessionInfo[]; runningSessionIds?: string[]; runningStartedAt?: Record<string, number>; archivedSessions?: SessionInfo[]; archivedCount?: number };
      if (!mountedRef.current || !shouldApplySessionListResponse(gen, sessionListFetchGenRef.current)) return;
      catalogStore.applyServerList({
        sessions: data.sessions,
        archivedSessions: data.archivedSessions ?? [],
        archivedCount: data.archivedCount ?? 0,
        runningSessionIds: data.runningSessionIds,
        runningStartedAt: data.runningStartedAt,
        selectedSessionId: catalogSelectedRef.current,
        now: Date.now(),
      });
      saveCachedSessionList(data.sessions);
      if (!showLoading) {
        setSessionRefreshDone(true);
        if (sessionRefreshTimerRef.current) clearTimeout(sessionRefreshTimerRef.current);
        sessionRefreshTimerRef.current = setTimeout(() => {
          if (mountedRef.current) setSessionRefreshDone(false);
        }, 2000);
      }
    } catch (e) {
      if (!mountedRef.current || !shouldApplySessionListResponse(gen, sessionListFetchGenRef.current)) return;
      catalogStore.applyListError(String(e));
      // 服务器列表获取失败（网络/认证）：也视为“完整列表已判定”，
      // 否则 URL 恢复会永远停留在等待态，聊天区既不恢复也不显示占位。
    }
  }, [catalogStore, serverListLoaded, serverSessionsRef]);
  // loadSessions 的身份会随 catalog 状态（serverListLoaded）变化，若把它列为依赖，
  // 首次加载完成会再次触发本 effect → 每次进入都重复拉一遍整份列表（实测 2 次）。
  // 只应由 mount 与 refreshKey 驱动，通过 ref 取最新实现。
  const loadSessionsRef = useRef(loadSessions);
  loadSessionsRef.current = loadSessions;
  const initialLoadDone = useRef(false);
  useEffect(() => {
    const isFirst = !initialLoadDone.current;
    initialLoadDone.current = true;
    loadSessionsRef.current(isFirst);
  }, [refreshKey]);

  // subagent 的子会话可能由本机独立 runner 进程写出（后台/异步 run），不会有本地
  // 事件，所以列表仍不认识 activity 已经报出的子会话时补一次刷新；刷新后即认识，
  // 同一批缺失 id 只催一次，避免轮询反复触发整表拉取。
  const subagentRefreshRef = useRef({ lastKey: "", attempts: 0, lastAttemptAt: 0 });
  useEffect(() => {
    const known = new Set(serverSessionsRef.current.map((session) => session.id));
    const missingIds = subagentChildIds.filter((id) => !known.has(id));
    const plan = planSubagentDiscoveryRefresh({
      missingIds,
      lastKey: subagentRefreshRef.current.lastKey,
      attempts: subagentRefreshRef.current.attempts,
      lastAttemptAt: subagentRefreshRef.current.lastAttemptAt,
      now: Date.now(),
    });
    subagentRefreshRef.current = {
      lastKey: plan.lastKey,
      attempts: plan.attempts,
      lastAttemptAt: plan.lastAttemptAt,
    };
    if (!plan.fire) return;
    loadSessionsRef.current(false);
  }, [subagentChildIds, serverSessions]);

  // 会话列表刷新为事件驱动（新会话/agent_end/删除/fork 经 refreshKey 触发；
  // 窗口重新聚焦时补一次），不做定时轮询（openchamber 同语义）。
  useEffect(() => {
    // 同一次激活的 focus + visibilitychange 合并成一次列表刷新（见 lib/activation-recovery）。
    const recovery = createActivationRecovery({ perform: () => loadSessionsRef.current(false) });
    const onActivate = () => {
      if (document.visibilityState === "visible") recovery.notify();
    };
    document.addEventListener("visibilitychange", onActivate);
    window.addEventListener("focus", onActivate);
    return () => {
      document.removeEventListener("visibilitychange", onActivate);
      window.removeEventListener("focus", onActivate);
      recovery.dispose();
    };
  }, []);

  const allSessions = serverSessions;

  /**
   * 一次性迁移（旧模型 added/closed → 单一 projectRoots）：列表本身已由
   * parseSidebarPreferences 按「added − closed」算好，这里只把它落地（localStorage +
   * 服务端）并把迁移标记收尾，**不并任何会话 cwd、也不看会话列表**。
   *
   * 原先这里拿 getRecentProjects(allSessions) 当种子，等于把「有历史会话的目录」当成
   * 用户添加的项目写进共享列表，项目列表与 trust.json 的信任面都会自己长（实测 8 → 11）。
   * 没有旧键时列表保持为空，等用户自己「添加项目」。
   */
  useEffect(() => {
    if (!prefs.projectRootsMigrated) return;
    // 先等服务端偏好到齐：远端已经是新模型（带 projectRoots）时，applySyncedSidebarUi 会把
    // 迁移标记清掉，这里就不该再用本地旧列表去覆盖共享列表（旧列表可能只有 added 的几条，
    // 甚至是空的）。服务端拉不到时保持待迁移，不写。
    if (!isServerPrefsLoaded()) return;
    updatePrefs((prev) => (prev.projectRootsMigrated
      ? { ...prev, projectRoots: prev.projectRoots, projectRootsMigrated: false }
      : prev));
    // serverPrefs 只作“加载完成/远端变化”的重跑信号，不读其内容。
  }, [prefs.projectRootsMigrated, serverPrefs, updatePrefs]);

  // 未读时钟改跨端（#65）：**服务端写 completedAt**（run 结束时，与本端是否开着无关），
  // **各端写自己的 readAt**；未读 ⟺ completedAt > readAt，两侧都是单调时间戳、取并集，
  // 天然不需要 CAS。本地那份降级为首屏缓存（旧的纯 id 列表会迁移成时钟）。
  useEffect(() => {
    const merged = mergeUnreadSessionState(
      loadUnreadSessionClock(window.localStorage),
      parseUnreadSessionState(getServerPref("unreadSessionState")),
    );
    catalogStore.replaceUnread(merged);
  }, [catalogStore, serverPrefs]);

  useEffect(() => {
    const unread = catalogStore.getState().unread;
    saveUnreadSessionClock(window.localStorage, unread);
    // 只有**本端产生的阅读时刻**要推给服务端：completedAt 的事实由服务端记录，
    // 客户端重复写同一事实没有意义（还会造成两边时间戳互相追着涨）。
    const pushed = pushedReadAtRef.current;
    for (const [id, at] of Object.entries(unread.readAt)) {
      if (pushed[id] === at) continue;
      // 只给**真实存在的会话**推：已删除的会话、以及新会话启动期的 `__new__…` 占位 id
      // 都不该在服务端时钟里留下条目（否则就是永远清不掉的死数据）。
      if (!allSessions.some((session) => session.id === id)) continue;
      pushed[id] = at;
      setServerPref(`unreadSessionState.readAt.${id}`, at);
    }
  }, [allSessions, catalogTick, catalogStore]);

  useEffect(() => {
    // Live running status via SSE — no polling. The server pushes the current
    // set of running session ids whenever any session starts/stops working.
    const source = new EventSource("/api/agent/running/events");

    source.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data) as {
          type?: string;
          runningSessionIds?: string[];
          runningStartedAt?: Record<string, number>;
          pendingExtensionUi?: unknown;
        };
        if (data.type === "running") {
          runningSnapshotAuthoritativeRef.current = true;
          commitRunningSnapshot(
            (data.runningSessionIds ?? []).filter((id): id is string => typeof id === "string"),
            data.runningStartedAt && typeof data.runningStartedAt === "object"
              ? data.runningStartedAt
              : undefined,
          );
          setWaitingUserIds(extractWaitingSessionIds(data.pendingExtensionUi));
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
        .then((d: { runningSessionIds?: unknown; runningStartedAt?: Record<string, number>; pendingExtensionUi?: unknown }) => {
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
            d.runningStartedAt && typeof d.runningStartedAt === "object"
              ? d.runningStartedAt
              : undefined,
          );
          setWaitingUserIds(extractWaitingSessionIds(d.pendingExtensionUi));
        })
        .catch(() => undefined);
    };
    // 同一批 focus + visibilitychange 合并成一次运行集对齐（见 lib/activation-recovery）。
    const recovery = createActivationRecovery({ perform: refreshRunning });
    const onActivate = () => {
      if (document.visibilityState === "visible") recovery.notify();
    };
    window.addEventListener("focus", onActivate);
    document.addEventListener("visibilitychange", onActivate);
    return () => {
      window.removeEventListener("focus", onActivate);
      document.removeEventListener("visibilitychange", onActivate);
      recovery.dispose();
    };
  }, [commitRunningSnapshot]);

  // 会话列表刷新后同步拉一次 subagent 状态（子会话刚被发现时）；定期轮询在
  // useSubagentActivity 内部（顶栏谱系与侧栏共用，不再各自轮询）。
  useEffect(() => {
    if (sessionRefreshDone) refreshSubagentActivity();
  }, [sessionRefreshDone]);
  useEffect(() => {
    // 未读只由服务器 running 快照的真实移除生成（catalog store 内部按 epoch 处理）；
    // 切换聊天导致 optimistic running 消失时，服务端 host 仍可能在执行，不能把
    // 局部 UI 状态当成完成事件——store 的 applyRunningSnapshot 只认证 server 变化。
    previousRunningSessionIdsRef.current = new Set(runningSessionIds);
    previousEffectiveRunningSessionIdsRef.current = new Set(effectiveRunningSessionIds);
  }, [effectiveRunningSessionIds, runningSessionIds]);

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
    catalogStore.markRead(selectedSessionId);
  }, [selectedSessionId, catalogStore]);

  useEffect(() => {
    fetch("/api/home").then((r) => r.json()).then((d: { home?: string }) => {
      if (d.home) setHomeDir(d.home);
    }).catch(() => {});
  }, []);

  const restoredRef = useRef(false);
  useEffect(() => {
    restoredRef.current = false;
  }, [restoreNonce]);

  useEffect(() => () => {
    mountedRef.current = false;
  }, []);

  /** 项目 = 目录：选中 cwd 就是项目根，identity 由 store 维持二者相等。 */
  const selectCwd = useCallback((cwd: string | null) => {
    setIdentity({ cwd, status: cwd ? "ready" : "idle", error: null });
  }, [setIdentity]);
  const selectedProject = selectedCwd;
  // 关闭项目被拒绝时的行内提示（运行中的会话必须先停）；换项目即清掉，不留陈旧提示。
  const [closeProjectError, setCloseProjectError] = useState<{ root: string; message: string } | null>(null);
  useEffect(() => {
    setCloseProjectError(null);
  }, [selectedCwd]);

  // Auto-select cwd and restore session from URL on first load
  useEffect(() => {
    if (skipInitialProjectSelection && !initialSessionId) return;

    // URL 恢复必须优先于 cwd 自动选择；空列表在 serverListLoaded 后视为 not-found。
    if (initialSessionId && !restoredRef.current) {
      if (error && serverListLoaded) {
        restoredRef.current = true;
        onInitialRestoreDone?.({ error });
        return;
      }
      if (!serverListLoaded) return;
      const target = allSessions.find((s) => s.id === initialSessionId);
      if (target) {
        restoredRef.current = true;
        onSelectSession(target, true);
        onInitialRestoreDone?.({ found: true });
        return;
      }
      restoredRef.current = true;
      onInitialRestoreDone?.({ found: false });
      return;
    }
    if (allSessions.length === 0) return;
    if (selectedCwd === null) {
      // 只从项目列表里自动选择：列表为空时保持空工作区，不复活未加入的项目。
      const projects = getRecentProjects(allSessions).filter((root) => prefs.projectRoots.includes(root));
      if (projects[0]) selectCwd(projects[0]);
    }
  }, [allSessions, selectedCwd, initialSessionId, skipInitialProjectSelection, onSelectSession, onInitialRestoreDone, selectCwd, prefs.projectRoots, serverListLoaded, error, restoreNonce]);

  const closeCustomPathPanel = useCallback(() => {
    setCustomPathOpen(false);
  }, []);

  const handleProjectAdded = useCallback((cwd: string) => {
    // 追加进项目列表（列表是项目区唯一来源）；然后把当前项目切到刚添加的项目并进入
    // 新会话空态（引导页）——引导页与侧栏共用同一 identity，避免「显示 A、实际建到 B」。
    updatePrefs((prev) =>
      prev.projectRoots.includes(cwd) ? prev : { ...prev, projectRoots: [...prev.projectRoots, cwd] },
    );
    closeCustomPathPanel();
    onProjectAdded?.(cwd);
    // 不从会话列表反推项目根（刚添加的项目可能还没有任何会话）。
    selectCwd(cwd);
    onNewSession?.(cwd);
  }, [updatePrefs, closeCustomPathPanel, onProjectAdded, selectCwd, onNewSession]);

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

  // Clicking a session moves the effective cwd to that session's directory.
  // Done on the click path (not via the selectedCwd prop sync) so it also
  // works when the prop value won't change — e.g. re-clicking an already
  // open session.
  // identity 切换统一由 AppShell.handleSelectSession 在 suppress 之后完成：
  // ProjectContext 的 store 更新（useSyncExternalStore）同步触发身份 watcher，
  // 若在此处先 selectCwd，watcher 会在 suppress 生效前清空刚选中的会话 →
  // 掉进引导页。
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
    catalogStore.markDeleted(id);
    onSessionDeleted?.(id);
    loadSessions();
  }, [catalogStore, onSessionDeleted, loadSessions, updatePrefs]);

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

  /** 显式未分组标记：关闭项目时记下的会话 id；重新添加目录也不回迁（#53）。 */
  const ungroupedSessionIds = useMemo(() => new Set(prefs.ungroupedSessionIds), [prefs.ungroupedSessionIds]);

  /**
   * 归档视图列出全部归档会话（不再按目录过滤）：归档是用户显式动作，
   * 归档时可见的会话不该因为项目被关闭就失去恢复/删除入口（#53 D5）。
   */

  /** 置顶会话：按置顶顺序（最新置顶在前）；仅显示仍存在的会话（不按目录过滤）。 */
  const pinnedSessions = useMemo(
    () => derivePinnedSessions({ sessions: allSessions, pinnedSessionIds: prefs.pinnedSessionIds }),
    [allSessions, prefs.pinnedSessionIds],
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
    () => deriveRecentSessions({ sessions: allSessions, excludeIds: pinnedIds, limit: RECENT_SESSIONS_LIMIT }),
    [allSessions, pinnedIds],
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
    selectCwd(targetCwd);
    onNewSession?.(targetCwd);
  }, [selectedCwd, onNewSession, selectCwd]);

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

  // 项目区树：分组/排序/空态补齐全部在纯模型内完成（项目 = cwd 目录，只列项目列表）。
  const sidebarTree = useMemo(
    () => buildSidebarTree(allSessions, {
      selectedCwd,
      projectRoots: prefs.projectRoots,
      ungroupedSessionIds,
    }),
    [allSessions, selectedCwd, prefs.projectRoots, ungroupedSessionIds],
  );
  /**
   * 未分组区树（派生 ∪ 显式）：不在项目列表里的会话与关闭项目时标记的会话。
   * 与项目区同级放在侧栏底部；为空时不渲染。
   */
  const ungroupedTree = useMemo(
    () => buildUngroupedTree(allSessions, {
      projectRoots: prefs.projectRoots,
      ungroupedSessionIds,
    }),
    [allSessions, prefs.projectRoots, ungroupedSessionIds],
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
    for (const project of sidebarTree) walk(project.tree);
    // 未分组区的行也用同一渲染（最近/置顶区取出节点时可展开其 fork 子会话）。
    walk(ungroupedTree);
    return map;
  }, [sidebarTree, ungroupedTree]);
  // 项目区已只包含列表内项目（buildSidebarTree 负责），搜索管线直接用树。
  const openTree = sidebarTree;
  const normalizedSessionQuery = normalizeSessionQuery(sessionQuery);
  const fulltextModeActive = searchMode === "fulltext" && normalizedSessionQuery.length > 0;
  const fulltextMatchIds = useMemo(
    () => (fulltextModeActive ? new Set(fulltextSessionIds) : null),
    [fulltextModeActive, fulltextSessionIds],
  );
  const searchActive = fulltextModeActive
    ? fulltextSessionIds.length > 0 || fulltextLoading || Boolean(fulltextError)
    : normalizedSessionQuery.length > 0;

  /**
   * 全文命中片段：服务端全盘搜索结果原样展示，不再按目录过滤——命中未分组区的会话
   * 也要能点开（#53 D4）。命中行点击走 openSessionById（按 id 打开，与目录无关）。
   */
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
  /**
   * 未分组区的搜索过滤：与项目区同规则（元搜索按会话字段；全文按命中 id 保留祖先链）。
   * 项目路径/别名命中只作用于项目区——未分组区没有项目身份可匹配。
   */
  const visibleUngroupedTree = useMemo(
    () => (fulltextModeActive
      ? filterSessionDisplayTreeByIds(ungroupedTree, fulltextMatchIds ?? new Set<string>())
      : filterSessionDisplayTree(ungroupedTree, normalizedSessionQuery)),
    [ungroupedTree, fulltextModeActive, fulltextMatchIds, normalizedSessionQuery],
  );
  /** 未分组区折叠状态与项目区同一套持久化（collapsedProjectRoots 里的保留 key），搜索期强制展开。 */
  const ungroupedCollapsed = isSessionNodeEffectivelyCollapsed(
    collapsedProjectRoots,
    UNGROUPED_GROUP_KEY,
    searchActive,
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
    const defaults = collectSubagentParentIdsFromSidebarTree(sidebarTree, [ungroupedTree]);
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
  }, [sidebarTree, ungroupedTree]);

  // 选中或 URL 恢复会话时自动展开 project/session 两级祖先，
  // 避免「已选中但列表里不可见」；这是显式选中驱动，与搜索强制展开无关。
  useEffect(() => {
    if (!selectedSessionId) return;
    const location = locateSessionInSidebarTree(sidebarTree, selectedSessionId);
    // 项目区没有就找未分组区：选中未分组会话时同样要展开折叠的区与祖先链。
    const ungroupedAncestors = location ? null : locateSessionInUngroupedTree(ungroupedTree, selectedSessionId);
    if (!location && ungroupedAncestors === null) return;
    const collapseKey = location ? location.projectRoot : UNGROUPED_GROUP_KEY;
    const ancestors = location ? location.ancestors : (ungroupedAncestors ?? []);
    updatePrefs((prev) => {
      if (!prev.collapsedProjectRoots.includes(collapseKey)) return prev;
      return {
        ...prev,
        collapsedProjectRoots: prev.collapsedProjectRoots.filter((root) => root !== collapseKey),
      };
    });
    if (ancestors.length > 0) {
      for (const id of ancestors) {
        userTouchedSessionCollapseRef.current.add(id);
      }
      setCollapsedSessionIds((current) => {
        if (!ancestors.some((id) => current.has(id))) return current;
        const next = new Set(current);
        ancestors.forEach((id) => next.delete(id));
        return next;
      });
    }
  }, [selectedSessionId, sidebarTree, ungroupedTree, updatePrefs]);

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
  }, [selectedSessionId, initialSessionId, visibleTree, collapsedProjectRoots, collapsedSessionIds]);

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

  /** 未分组区折叠：与项目折叠同一个偏好集合、同一条写入路径。 */
  const toggleUngroupedCollapse = useCallback(() => {
    toggleProjectCollapse(UNGROUPED_GROUP_KEY);
  }, [toggleProjectCollapse]);

  /**
   * 关闭项目：把 root 从项目列表移除（项目区与项目信任都据此收敛），同时把该目录下的
   * 会话 id 记入未分组显式集合——它们随后归到侧栏底部的未分组区，而不是消失；
   * 重新添加同路径目录时这些旧会话仍留在未分组（不回迁），该目录的新会话回到项目区。
   *
   * 只动偏好：绝不删除目录、会话、AgentSession 或 Git 数据。
   */
  const handleCloseProject = useCallback((root: string) => {
    setOpenProjectMenuRoot(null);
    // 运行中关项目会藏掉控制面：拒绝关闭，与归档 running→409 对齐。
    // 只检查该项目目录（cwd）下的 running；别处 checkout 的运行不挡住关闭。
    if (projectHasRunningSession(allSessions, effectiveRunningSessionIds, root)) {
      setCloseProjectError({ root, message: t("sidebar_closeProjectRunning") });
      return;
    }
    setCloseProjectError(null);
    // 记录与移除在同一次偏好更新里完成：不会出现「列表已移除、标记还没写」的中间态。
    const closingIds = allSessions.filter((session) => session.cwd === root).map((session) => session.id);
    updatePrefs((prev) => {
      if (!prev.projectRoots.includes(root) && closingIds.length === 0) return prev;
      const known = new Set(prev.ungroupedSessionIds);
      const added = closingIds.filter((id) => !known.has(id));
      return {
        ...prev,
        projectRoots: prev.projectRoots.filter((item) => item !== root),
        ungroupedSessionIds: added.length > 0
          ? [...prev.ungroupedSessionIds, ...added]
          : prev.ungroupedSessionIds,
      };
    });
    // 关闭当前项目：切换到列表里的下一个项目；无剩余则置空 cwd 并回到
    // 新会话/空工作区，避免继续显示已关闭项目的当前会话。
    if (selectedProject === root) {
      const next = pickProjectRootAfterClose(sidebarTree, root, new Set());
      if (next) {
        selectCwd(next);
      } else {
        selectCwd(null);
        onNewSession?.();
      }
    }
  }, [selectedProject, sidebarTree, updatePrefs, selectCwd, onNewSession, allSessions, effectiveRunningSessionIds, t]);

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
    const ids = collectAllCollapseIds(openTree, { includeUngrouped: visibleUngroupedTree.length > 0 });
    updatePrefs((prev) => ({ ...prev, collapsedProjectRoots: ids.projectRoots }));
  }, [openTree, visibleUngroupedTree, updatePrefs]);

  const expandAll = useCallback(() => {
    updatePrefs((prev) => (prev.collapsedProjectRoots.length === 0
      ? prev
      : { ...prev, collapsedProjectRoots: [] }));
  }, [updatePrefs]);

  return (
    <RunningTimeContext.Provider value={{ startedAt: runningStartedAt, now: runningNow }}>
    <WaitingSessionIdsContext.Provider value={waitingUserIds}>
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
          数据源为 /api/sessions 默认响应的 archivedSessions，列全部归档会话（不按目录过滤）。 */}
      {archiveViewOpen ? (
        <ArchiveView
          sessions={archivedSessions}
          count={archivedSessions.length}
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
      {/* 项目树：Project → Session → child */}
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
        {!loading && !error && visibleTree.length === 0 && visibleUngroupedTree.length === 0 && (
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
              <GroupPagination
                groupKey="recent"
                total={recentSessions.length}
                visibleCount={recentVisibleCount}
                searchActive={false}
                onShowMore={() => setRecentVisibleCount((n) => nextRecentVisibleCount(n, recentSessions.length, "more"))}
                onShowFewer={() => setRecentVisibleCount((n) => nextRecentVisibleCount(n, recentSessions.length, "fewer"))}
              />
            </div>}
          </div>
        )}
        {visibleTree.map((project) => (
          <ProjectSection
            key={project.root}
            project={project}
            displayMode={displayMode}
            projectAliases={projectAliases}
            selectedSessionId={selectedSessionId}
            runningSessionIds={effectiveRunningSessionIds}
            subagentRunningIds={subagentRunningIds}
            unreadSessionIds={unreadSessionIds}
            collapsedProjectRoots={collapsedProjectRoots}
            collapsedSessionIds={collapsedSessionIds}
            searchActive={searchActive}
            onToggleProject={toggleProjectCollapse}
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
            actionError={closeProjectError?.root === project.root ? closeProjectError.message : null}
            onSessionArchive={handleArchiveSession}
            isSessionPinned={(id) => pinnedIds.has(id)}
            onTogglePin={togglePinSession}
            onProjectDrop={searchActive ? undefined : handleProjectDrop}
           />
         ))}
        {/* 未分组会话区（#53）：不在项目列表里的目录（从未加入过的、关闭项目后的）会话
            与项目区同级放在底部：同样可折叠、有分页与搜索过滤、行渲染同源；无会话不渲染。 */}
        {visibleUngroupedTree.length > 0 && (
          <div style={{ borderTop: "1px solid var(--border)", marginTop: 5, paddingTop: 5 }}>
            <div
              className="sidebar-row"
              data-sidebar-depth={0}
              role="button"
              tabIndex={0}
              aria-expanded={!ungroupedCollapsed}
              aria-label={ungroupedCollapsed ? t("sidebar_expandUngroupedSessions") : t("sidebar_collapseUngroupedSessions")}
              onClick={toggleUngroupedCollapse}
              onKeyDown={(event) => {
                if (event.target !== event.currentTarget || (event.key !== "Enter" && event.key !== " ")) return;
                event.preventDefault();
                toggleUngroupedCollapse();
              }}
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
                collapsed={ungroupedCollapsed}
                label={ungroupedCollapsed ? t("sidebar_expandUngroupedSessions") : t("sidebar_collapseUngroupedSessions")}
                left={sidebarIndicatorLeft(0)}
                onClick={(event) => { event.stopPropagation(); toggleUngroupedCollapse(); }}
              />
              <span aria-hidden="true" className="sidebar-indicator-icon" style={{ position: "absolute", left: sidebarIndicatorLeft(0), top: "50%", display: "flex", width: SIDEBAR_INDICATOR_SLOT, height: 20, alignItems: "center", justifyContent: "center", transform: "translateY(-50%)", color: "var(--text-dim)" }}><LayersIcon size={13} /></span>
              <span style={{ flex: 1, fontSize: 12.5, fontWeight: 600 }}>{t("sidebar_ungroupedSessions")}</span>
            </div>
            {!ungroupedCollapsed && (
              <div>
                {getVisibleTopLevelNodes(
                  visibleUngroupedTree,
                  getGroupVisibleCount(groupVisibleCounts, UNGROUPED_GROUP_KEY),
                  searchActive,
                ).map((node) => (
                  <SessionTreeItem
                    key={node.session.id}
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
                ))}
                <GroupPagination
                  groupKey={UNGROUPED_GROUP_KEY}
                  total={visibleUngroupedTree.length}
                  visibleCount={getGroupVisibleCount(groupVisibleCounts, UNGROUPED_GROUP_KEY)}
                  searchActive={searchActive}
                  onShowMore={(groupKey) => setGroupVisibleCounts((counts) => bumpGroupVisibleCount(counts, groupKey))}
                  onShowFewer={(groupKey) => setGroupVisibleCounts((counts) => resetGroupVisibleCount(counts, groupKey))}
                />
              </div>
            )}
          </div>
        )}
       </div>
       </>
      )}


      <AddProjectDialog
        open={customPathOpen}
        onClose={closeCustomPathPanel}
        onAdded={handleProjectAdded}
      />
      <EditProjectDialog
        projectRoot={editProjectRoot}
        initialName={editProjectRoot ? (projectAliases[editProjectRoot] ?? projectDisplayName(editProjectRoot)) : ""}
        onClose={() => setEditProjectRoot(null)}
        onSaveName={handleSaveProjectAlias}
      />
      </div>
    </WaitingSessionIdsContext.Provider>
    </RunningTimeContext.Provider>
    );
  }
