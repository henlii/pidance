/**
 * 会话栏 UI 偏好 seam（跨刷新持久化）。
 *
 * 只放跨刷新偏好：显示模式、项目折叠集合、侧栏宽度。
 * 搜索查询、搜索框开关、会话级 child 折叠、可见条数均为组件瞬时态，绝不写入这里。
 * 读写容错：localStorage 不可用（隐私模式/SSR）时静默回退默认值。
 */

export type SidebarDisplayMode = "standard" | "compact";
export type ProjectSortMode = "recent" | "az" | "za" | "fixed";

/** 项目显示名 alias：projectRoot → 用户命名。纯 UI 层数据，与 Pi schema/磁盘/Git 无关。 */
export type ProjectAliases = Record<string, string>;

/** 桌面侧栏可调宽边界：与右侧工作区同档，避免过窄挤压会话或过宽占屏。 */
export const SIDEBAR_WIDTH_MIN = 240;
export const SIDEBAR_WIDTH_MAX = 520;
export const SIDEBAR_WIDTH_DEFAULT = 300;

/** 右侧内容面板可调宽边界；不包含最右侧常驻 44px 图标栏。 */
export const RIGHT_PANEL_WIDTH_MIN = 320;
export const RIGHT_PANEL_WIDTH_MAX = 720;
export const RIGHT_PANEL_WIDTH_DEFAULT = 400;

/** 二级文件编辑/预览侧栏可调宽边界（打开文件时的主阅读区，宜明显宽于文件树）。 */
export const CHANGES_PANEL_WIDTH_MIN = 320;
export const CHANGES_PANEL_WIDTH_MAX = 960;
export const CHANGES_PANEL_WIDTH_DEFAULT = 560;
/** 打开文件时若当前宽度低于此值则抬到此宽度，避免编辑区过窄。 */
export const CHANGES_PANEL_WIDTH_OPEN_MIN = 480;

/**
 * 文件树按 cwd 记忆的展开路径与滚动位置（跨刷新持久化）。
 * key = cwd 绝对路径；expanded 为已展开目录完整路径；scrollTop 为滚动容器像素。
 * 属于跨刷新偏好，写入本 seam；搜索/临时高亮等瞬时态禁止入内。
 */
export type FileExplorerState = Record<string, { expanded: string[]; scrollTop: number }>;

/**
 * 将任意输入钳到侧栏宽度合法范围；非有限数回退默认。
 * 解析与写入共用，保证持久化值始终可渲染。
 */
export function clampSidebarWidth(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return SIDEBAR_WIDTH_DEFAULT;
  return Math.min(SIDEBAR_WIDTH_MAX, Math.max(SIDEBAR_WIDTH_MIN, Math.round(value)));
}

/**
 * 将任意输入钳到右栏宽度合法范围；非有限数回退默认。
 * 解析与写入共用，保证持久化值始终可渲染。
 */
export function clampRightPanelWidth(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return RIGHT_PANEL_WIDTH_DEFAULT;
  return Math.min(RIGHT_PANEL_WIDTH_MAX, Math.max(RIGHT_PANEL_WIDTH_MIN, Math.round(value)));
}

/** 将任意输入钳到 Git 变更侧栏宽度合法范围；非有限数回退默认。 */
export function clampChangesPanelWidth(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return CHANGES_PANEL_WIDTH_DEFAULT;
  return Math.min(CHANGES_PANEL_WIDTH_MAX, Math.max(CHANGES_PANEL_WIDTH_MIN, Math.round(value)));
}

/** 容错解析右栏开/关：仅接受显式 boolean true，其余（含旧数据缺字段）一律关闭。 */
export function parseRightPanelOpen(value: unknown): boolean {
  return value === true;
}

/** Git 变更侧栏旧数据缺字段时默认打开；仅显式 false 关闭。 */
export function parseChangesPanelOpen(value: unknown): boolean {
  return value !== false;
}

/**
 * 容错解析「最近会话」区开/关：默认开启；仅显式 boolean false 才关闭。
 * 旧数据缺字段 / 脏数据（0、"false" 等）一律保持默认开启。
 */
export function parseShowRecentSessions(value: unknown): boolean {
  return value !== false;
}

/**
 * 容错解析文件树状态：仅接受纯对象；逐项过滤脏数据。
 * - key 为 cwd 绝对路径（trim 非空）
 * - 每项仅接受 { expanded: string[], scrollTop: number } 结构
 * - expanded 过滤非 string 项；scrollTop 仅接受有限非负数字，否则 0
 * 绝不抛异常。
 */
export function parseFileExplorerState(value: unknown): FileExplorerState {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  const result: FileExplorerState = {};
  for (const [rawCwd, rawState] of Object.entries(value as Record<string, unknown>)) {
    const cwd = rawCwd.trim();
    if (!cwd) continue;
    if (rawState === null || typeof rawState !== "object" || Array.isArray(rawState)) continue;
    const state = rawState as Record<string, unknown>;
    const expanded = Array.isArray(state.expanded)
      ? state.expanded.filter((item): item is string => typeof item === "string")
      : [];
    const scrollTop = typeof state.scrollTop === "number" && Number.isFinite(state.scrollTop) && state.scrollTop > 0
      ? Math.round(state.scrollTop)
      : 0;
    result[cwd] = { expanded, scrollTop };
  }
  return result;
}

export interface SidebarPreferences {
  displayMode: SidebarDisplayMode;
  /** 已折叠项目根路径（projectRoot）。 */
  collapsedProjectRoots: string[];
  /** 项目显示名 alias（projectRoot → 名称）；项目行与搜索共用。 */
  projectAliases: ProjectAliases;
  /**
   * 侧栏项目根列表（唯一来源）：只有列表里的项目会显示在侧栏（无会话也显示为
   * 空项目行），也只有它们写入项目信任（subagent 走 pi CLI 时需要）。
   * 关闭项目 = 从列表移除；重新添加同路径即恢复。不删除任何目录/会话/Git 数据。
   */
  projectRoots: string[];
  /**
   * 是否由旧模型迁移而来（存储里只有 added/closed 两个数组）。调用方据此做一次性
   * 种子：把当前可见的项目写进列表，避免升级后项目区突然空掉。
   */
  projectRootsMigrated: boolean;
  /** 桌面侧栏宽度（px）；损坏/越界值解析时 clamp。 */
  sidebarWidth: number;
  /** 右侧内容面板开/关；图标栏不受此偏好影响并始终常驻。 */
  rightPanelOpen: boolean;
  /** 右侧内容面板宽度（px，不含图标栏）；损坏/越界值解析时 clamp。 */
  rightPanelWidth: number;
  /** Git 变更侧栏开/关；与右侧内容面板互不影响。 */
  changesPanelOpen: boolean;
  /** Git 变更侧栏宽度（px）。 */
  changesPanelWidth: number;
  /** 「最近会话」区开/关（项目列表上方的快捷入口）；默认开启。 */
  showRecentSessions: boolean;
  /** 置顶会话 id（有序：最新置顶在前）。置顶会话从最近区排除，显示在最近区上方。 */
  pinnedSessionIds: string[];
  /**
   * 显式未分组会话 id（有序，最新记录在后）：关闭项目时把该项目目录下的会话记进来，
   * 之后重新添加该目录也不回迁（它们的 `cwd` 已在项目列表内，靠这份标记留在未分组区）。
   * 本期只增不减。
   */
  ungroupedSessionIds: string[];
  /** 文件树按 cwd 记忆的展开路径与滚动位置。 */
  fileExplorerState: FileExplorerState;
  /** 侧栏项目排序：近期 / 名称 / 固定。 */
  projectSort: ProjectSortMode;
  /** 固定排序时的项目根顺序；fixed 以外模式可为空。 */
  projectOrder: string[];
}
export const DEFAULT_SIDEBAR_PREFERENCES: SidebarPreferences = {
  displayMode: "standard",
  collapsedProjectRoots: [],
  projectAliases: {},
  projectRoots: [],
  projectRootsMigrated: false,
  sidebarWidth: SIDEBAR_WIDTH_DEFAULT,
  rightPanelOpen: false,
  rightPanelWidth: RIGHT_PANEL_WIDTH_DEFAULT,
  changesPanelOpen: true,
  changesPanelWidth: CHANGES_PANEL_WIDTH_DEFAULT,
  showRecentSessions: true,
  pinnedSessionIds: [],
  ungroupedSessionIds: [],
  fileExplorerState: {},
  projectSort: "recent",
  projectOrder: [],
};

export const STORAGE_KEY = "pidance:sidebar-preferences";

/** 可注入 storage，便于迁移单测。 */
export type StorageLike = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

/** 仅接受合法 string 数组，逐项过滤非 string 脏数据。 */
function parsePathList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

/**
 * 未分组会话显式标记的体积上限。本期集合只增不减（没有「移回项目」动作），
 * 靠上限兜住无界增长：超限时丢弃最早写入的标记——那些会话的目录通常也早已不在
 * 项目列表里，仍按派生规则留在未分组。
 */
export const UNGROUPED_SESSION_IDS_LIMIT = 1000;

/**
 * 容错解析会话 id 列表（未分组显式标记）：过滤非 string、trim、去空、保序去重，
 * 超限保留最后写入的部分。绝不抛异常。
 */
export function parseUngroupedSessionIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const id = item.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out.length > UNGROUPED_SESSION_IDS_LIMIT ? out.slice(-UNGROUPED_SESSION_IDS_LIMIT) : out;
}

/**
 * 容错解析项目 alias：仅接受纯对象；key 与 value 均 trim，
 * 过滤空 key、空 value 与任何非 string 项。绝不抛异常。
 */
export function parseProjectAliases(value: unknown): ProjectAliases {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  const result: ProjectAliases = {};
  for (const [rawKey, rawValue] of Object.entries(value as Record<string, unknown>)) {
    if (typeof rawValue !== "string") continue;
    const key = rawKey.trim();
    const alias = rawValue.trim();
    if (!key || !alias) continue;
    result[key] = alias;
  }
  return result;
}

/**
 * 容错解析持久化偏好：任何字段非法都回退该字段默认值，
 * 整体不是对象时回退完整默认。绝不抛异常。
 */
export function parseSidebarPreferences(raw: unknown): SidebarPreferences {
  if (raw === null || typeof raw !== "object") {
    return {
      ...DEFAULT_SIDEBAR_PREFERENCES,
      projectAliases: {},
      collapsedProjectRoots: [],
    };
  }
  const record = raw as Record<string, unknown>;
  return {
    displayMode: record.displayMode === "compact" || record.displayMode === "standard"
      ? record.displayMode
      : DEFAULT_SIDEBAR_PREFERENCES.displayMode,
    collapsedProjectRoots: parsePathList(record.collapsedProjectRoots),
    projectAliases: parseProjectAliases(record.projectAliases),
    ...parseProjectRoots(record),
    // 旧数据缺字段时 clamp 非数字 → 默认 300；越界/损坏一律钳入 [min, max]。
    sidebarWidth: clampSidebarWidth(record.sidebarWidth),
    // 旧数据无右栏字段：右栏默认关闭、宽度默认。
    rightPanelOpen: parseRightPanelOpen(record.rightPanelOpen),
    rightPanelWidth: clampRightPanelWidth(record.rightPanelWidth),
    changesPanelOpen: parseChangesPanelOpen(record.changesPanelOpen),
    changesPanelWidth: clampChangesPanelWidth(record.changesPanelWidth),
    // 旧数据无最近会话字段：默认开启（仅显式 false 关闭）。
    showRecentSessions: parseShowRecentSessions(record.showRecentSessions),
    // 旧数据无置顶字段：默认空列表。
    pinnedSessionIds: parsePathList(record.pinnedSessionIds),
    // 旧数据无未分组标记字段：默认空列表。
    ungroupedSessionIds: parseUngroupedSessionIds(record.ungroupedSessionIds),
    // 旧数据无文件树记忆字段：默认空表。
    fileExplorerState: parseFileExplorerState(record.fileExplorerState),
    projectSort: parseProjectSortMode(record.projectSort),
    projectOrder: parsePathList(record.projectOrder),
  };
}

/**
 * 项目根列表解析（含旧模型迁移）。
 *
 * 旧模型是两个数组：addedProjectRoots（显式加入）+ closedProjectRoots（隐藏），
 * 可见集合 = added − closed；合并成一个列表后就等于它。迁移只在存储里**没有**
 * `projectRoots` 时发生，并置 migrated 标记交调用方做一次性种子。
 */
/**
 * 旧模型迁移计划（纯函数）：旧模型是两个数组（`addedProjectRoots` 显式加入 +
 * `closedProjectRoots` 隐藏），可见集合 = added − closed，合并成单一列表后就是它。
 *
 * **只迁这两个数组本身，绝不并会话 cwd**：把「有历史会话的目录」当成项目写进共享列表，
 * 会把项目列表和 `trust.json` 的信任面一起撑大（实测从 8 条涨到 11 条）。
 * 返回 null 表示没有可迁移的东西（已是新模型，或没有旧键）—— 此时不种任何东西。
 */
export function planLegacyProjectRootsMigration(input: {
  /** 旧键 addedProjectRoots 的原始值 */
  added: unknown;
  /** 旧键 closedProjectRoots 的原始值 */
  closed: unknown;
  /** 记录里是否已有新模型的 projectRoots 键 */
  hasProjectRoots: boolean;
}): { projectRoots: string[] } | null {
  if (input.hasProjectRoots) return null;
  const hadLegacyKeys = input.added !== undefined || input.closed !== undefined;
  if (!hadLegacyKeys) return null;
  const closed = new Set(parsePathList(input.closed));
  return {
    projectRoots: sanitizeProjectRoots(parsePathList(input.added).filter((root) => !closed.has(root))),
  };
}

function parseProjectRoots(
  record: Record<string, unknown>,
): Pick<SidebarPreferences, "projectRoots" | "projectRootsMigrated"> {
  if (record.projectRoots !== undefined) {
    return { projectRoots: sanitizeProjectRoots(parsePathList(record.projectRoots)), projectRootsMigrated: false };
  }
  const plan = planLegacyProjectRootsMigration({
    added: record.addedProjectRoots,
    closed: record.closedProjectRoots,
    hasProjectRoots: false,
  });
  return plan
    ? { projectRoots: plan.projectRoots, projectRootsMigrated: true }
    : { projectRoots: [], projectRootsMigrated: false };
}

/**
 * 项目列表清洗：trim、去空、去重（保序）。
 * 它是侧栏项目区与项目信任的共同来源，一条重复或空串会直接变成一行空项目 / 一条
 * 无意义的信任条目，所以在这里就收敛掉。
 */
function sanitizeProjectRoots(roots: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const root of roots) {
    const trimmed = root.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function parseProjectSortMode(value: unknown): ProjectSortMode {
  return value === "az" || value === "za" || value === "fixed" || value === "recent"
    ? value
    : DEFAULT_SIDEBAR_PREFERENCES.projectSort;
}

export function serializeSidebarPreferences(prefs: SidebarPreferences): string {
  return JSON.stringify({
    displayMode: prefs.displayMode,
    collapsedProjectRoots: prefs.collapsedProjectRoots,
    projectAliases: prefs.projectAliases,
    projectRoots: prefs.projectRoots,
    sidebarWidth: clampSidebarWidth(prefs.sidebarWidth),
    rightPanelOpen: parseRightPanelOpen(prefs.rightPanelOpen),
    rightPanelWidth: clampRightPanelWidth(prefs.rightPanelWidth),
    changesPanelOpen: parseChangesPanelOpen(prefs.changesPanelOpen),
    changesPanelWidth: clampChangesPanelWidth(prefs.changesPanelWidth),
    showRecentSessions: parseShowRecentSessions(prefs.showRecentSessions),
    pinnedSessionIds: parsePathList(prefs.pinnedSessionIds),
    ungroupedSessionIds: parseUngroupedSessionIds(prefs.ungroupedSessionIds),
    fileExplorerState: parseFileExplorerState(prefs.fileExplorerState),
    projectSort: parseProjectSortMode(prefs.projectSort),
    projectOrder: parsePathList(prefs.projectOrder),
  });
}

/**
 * 从 storage 加载侧栏偏好：仅读规范键；损坏输入安全回退默认。
 */
export function loadSidebarPreferencesFromStorage(storage: StorageLike): SidebarPreferences {
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (raw === null) return parseSidebarPreferences(null);
    try {
      return parseSidebarPreferences(JSON.parse(raw) as unknown);
    } catch {
      return parseSidebarPreferences(null);
    }
  } catch {
    return parseSidebarPreferences(null);
  }
}

/** SSR / 无 localStorage 环境安全返回默认值。 */
export function loadSidebarPreferences(): SidebarPreferences {
  if (typeof window === "undefined") return parseSidebarPreferences(null);
  return loadSidebarPreferencesFromStorage(window.localStorage);
}

export function saveSidebarPreferences(prefs: SidebarPreferences): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, serializeSidebarPreferences(prefs));
  } catch {
    // 忽略存储配额 / 隐私模式错误
  }
}

/** 跨客户端同步的侧栏偏好（不含宽度等视口相关字段）。 */
export type SyncedSidebarUi = {
  displayMode: SidebarDisplayMode;
  collapsedProjectRoots: string[];
  projectRoots: string[];
  showRecentSessions: boolean;
  pinnedSessionIds: string[];
  projectSort: ProjectSortMode;
  projectOrder: string[];
  ungroupedSessionIds: string[];
};

export function sidebarUiFromPrefs(prefs: SidebarPreferences): SyncedSidebarUi {
  return {
    displayMode: prefs.displayMode,
    collapsedProjectRoots: prefs.collapsedProjectRoots,
    projectRoots: prefs.projectRoots,
    showRecentSessions: prefs.showRecentSessions,
    pinnedSessionIds: prefs.pinnedSessionIds,
    projectSort: prefs.projectSort,
    projectOrder: prefs.projectOrder,
    ungroupedSessionIds: prefs.ungroupedSessionIds,
  };
}

export function applySyncedSidebarUi(prefs: SidebarPreferences, remote: unknown): SidebarPreferences {
  if (typeof remote !== "object" || remote === null || Array.isArray(remote)) return prefs;
  const parsed = parseSidebarPreferences({ ...prefs, ...remote });
  // 远端载荷本身是否已带新模型的 projectRoots（本地默认值会遮蔽合并后的解析结果，
  // 所以必须看远端自己的键）。
  const remoteHasProjectRoots = (remote as Record<string, unknown>).projectRoots !== undefined;
  // 服务端还是旧模型且本地还没有列表：用**旧模型的可见集合**（added − closed）起一次种子。
  // 远端既没有 projectRoots 也没有旧键时 plan 为 null —— 以前这里会被当成「待迁移」，
  // 让旧 localStorage 的客户端把会话 cwd 并进共享列表（列表与信任面一起被撑大）。
  const remoteLegacyPlan = remoteHasProjectRoots
    ? null
    : planLegacyProjectRootsMigration({
      added: (remote as Record<string, unknown>).addedProjectRoots,
      closed: (remote as Record<string, unknown>).closedProjectRoots,
      hasProjectRoots: false,
    });
  const seedFromRemoteLegacy = remoteLegacyPlan !== null && prefs.projectRoots.length === 0;
  return {
    ...prefs,
    displayMode: parsed.displayMode,
    collapsedProjectRoots: parsed.collapsedProjectRoots,
    projectRoots: seedFromRemoteLegacy ? remoteLegacyPlan.projectRoots : parsed.projectRoots,
    // 迁移只由「确实存在旧键」触发：远端带了 projectRoots 就结束迁移；否则沿用本地的
    // 待迁移标记，或由远端旧键起种子。没有旧键一律不迁移。
    projectRootsMigrated: remoteHasProjectRoots
      ? false
      : prefs.projectRootsMigrated || seedFromRemoteLegacy,
    showRecentSessions: parsed.showRecentSessions,
    pinnedSessionIds: parsed.pinnedSessionIds,
    projectSort: parsed.projectSort,
    projectOrder: parsed.projectOrder,
    ungroupedSessionIds: parsed.ungroupedSessionIds,
  };
}

/**
 * 只更新存储中的 sidebarWidth（read-modify-write），其余字段原样保留。
 * sidebarWidth 的唯一 owner 是 AppShell（布局 owner）；侧栏其它偏好写入不得经此函数。
 */
export function saveSidebarWidthToStorage(storage: StorageLike, width: number): void {
  try {
    const current = loadSidebarPreferencesFromStorage(storage);
    storage.setItem(STORAGE_KEY, serializeSidebarPreferences({
      ...current,
      sidebarWidth: clampSidebarWidth(width),
    }));
  } catch {
    // 忽略存储配额 / 隐私模式错误
  }
}

/** SSR / 无 localStorage 环境安全 no-op。 */
export function saveSidebarWidth(width: number): void {
  if (typeof window === "undefined") return;
  saveSidebarWidthToStorage(window.localStorage, width);
}

/**
 * 只更新存储中的右栏开/关与宽度（read-modify-write），其余字段原样保留。
 * 右栏偏好的唯一 owner 是 AppShell（布局 owner）；其它写入不得经此函数。
 */
export function saveRightPanelPreferencesToStorage(
  storage: StorageLike,
  patch: { open?: boolean; width?: number },
): void {
  try {
    const current = loadSidebarPreferencesFromStorage(storage);
    storage.setItem(STORAGE_KEY, serializeSidebarPreferences({
      ...current,
      rightPanelOpen: patch.open === undefined ? current.rightPanelOpen : parseRightPanelOpen(patch.open),
      rightPanelWidth: patch.width === undefined ? current.rightPanelWidth : clampRightPanelWidth(patch.width),
    }));
  } catch {
    // 忽略存储配额 / 隐私模式错误
  }
}

/** SSR / 无 localStorage 环境安全 no-op。 */
export function saveRightPanelPreferences(patch: { open?: boolean; width?: number }): void {
  if (typeof window === "undefined") return;
  saveRightPanelPreferencesToStorage(window.localStorage, patch);
}

/** 只更新 Git 变更侧栏开/关与宽度，其余偏好保持不变。 */
export function saveChangesPanelPreferencesToStorage(
  storage: StorageLike,
  patch: { open?: boolean; width?: number },
): void {
  try {
    const current = loadSidebarPreferencesFromStorage(storage);
    storage.setItem(STORAGE_KEY, serializeSidebarPreferences({
      ...current,
      changesPanelOpen: patch.open === undefined ? current.changesPanelOpen : parseChangesPanelOpen(patch.open),
      changesPanelWidth: patch.width === undefined ? current.changesPanelWidth : clampChangesPanelWidth(patch.width),
    }));
  } catch {
    // 忽略存储配额 / 隐私模式错误
  }
}

/** SSR / 无 localStorage 环境安全 no-op。 */
export function saveChangesPanelPreferences(patch: { open?: boolean; width?: number }): void {
  if (typeof window === "undefined") return;
  saveChangesPanelPreferencesToStorage(window.localStorage, patch);
}

/**
 * 只更新存储中某 cwd 的文件树状态（展开路径 + 滚动位置），其余偏好原样保留。
 * 写入方：FileExplorer（唯一 owner）；cwd 切换时保存旧 cwd、恢复新 cwd。
 */
export function saveFileExplorerStateToStorage(
  storage: StorageLike,
  cwd: string,
  state: { expanded: string[]; scrollTop: number },
): void {
  try {
    const current = loadSidebarPreferencesFromStorage(storage);
    const next = parseFileExplorerState(current.fileExplorerState);
    if (cwd.trim()) next[cwd] = {
      expanded: parseFileExplorerState({ [cwd]: state })[cwd]?.expanded ?? [],
      scrollTop: Math.max(0, Math.round(Number.isFinite(state.scrollTop) ? state.scrollTop : 0)),
    };
    storage.setItem(STORAGE_KEY, serializeSidebarPreferences({ ...current, fileExplorerState: next }));
  } catch {
    // 忽略存储配额 / 隐私模式错误
  }
}

/** SSR / 无 localStorage 环境安全 no-op。 */
export function saveFileExplorerState(cwd: string, state: { expanded: string[]; scrollTop: number }): void {
  if (typeof window === "undefined") return;
  saveFileExplorerStateToStorage(window.localStorage, cwd, state);
}

// ── 流式期回车默认动作（桌面；手机端回车仅换行）──────────────────────────────

/**
 * Agent 运行中桌面 Enter 的默认动作：
 * - followUp（默认）：排队跟进；Ctrl/Cmd+Enter → 引导（steer）
 * - steer：立即引导；Ctrl/Cmd+Enter → 排队
 * 发送按钮始终走 followUp（队列）。
 */
export type StreamingEnterAction = "followUp" | "steer";

export const STREAMING_ENTER_STORAGE_KEY = "pidance.streamingEnterDefault";
export const DEFAULT_STREAMING_ENTER_ACTION: StreamingEnterAction = "followUp";

export function parseStreamingEnterAction(value: unknown): StreamingEnterAction {
  return value === "steer" ? "steer" : "followUp";
}

export function loadStreamingEnterActionFromStorage(storage: StorageLike): StreamingEnterAction {
  try {
    const raw = storage.getItem(STREAMING_ENTER_STORAGE_KEY);
    if (raw === null) return DEFAULT_STREAMING_ENTER_ACTION;
    try {
      return parseStreamingEnterAction(JSON.parse(raw) as unknown);
    } catch {
      // 兼容直接存字符串
      return parseStreamingEnterAction(raw);
    }
  } catch {
    return DEFAULT_STREAMING_ENTER_ACTION;
  }
}

export function loadStreamingEnterAction(): StreamingEnterAction {
  if (typeof window === "undefined") return DEFAULT_STREAMING_ENTER_ACTION;
  return loadStreamingEnterActionFromStorage(window.localStorage);
}

export function saveStreamingEnterActionToStorage(storage: StorageLike, action: StreamingEnterAction): void {
  try {
    storage.setItem(STREAMING_ENTER_STORAGE_KEY, JSON.stringify(parseStreamingEnterAction(action)));
  } catch {
    // 忽略存储配额 / 隐私模式错误
  }
}

export function saveStreamingEnterAction(action: StreamingEnterAction): void {
  if (typeof window === "undefined") return;
  saveStreamingEnterActionToStorage(window.localStorage, action);
}


/** 打开页面是否自动检测 Pidance 更新（默认开启）。 */
export const AUTO_UPDATE_CHECK_STORAGE_KEY = "pidance.autoUpdateCheck";
export const DEFAULT_AUTO_UPDATE_CHECK = true;

export function parseAutoUpdateCheck(value: unknown): boolean {
  // 仅显式 false / "0" / "false" 关闭；缺省与脏数据保持开启
  if (value === false || value === 0 || value === "0" || value === "false") return false;
  return true;
}

export function loadAutoUpdateCheckFromStorage(storage: StorageLike): boolean {
  try {
    const raw = storage.getItem(AUTO_UPDATE_CHECK_STORAGE_KEY);
    if (raw === null) return DEFAULT_AUTO_UPDATE_CHECK;
    try {
      return parseAutoUpdateCheck(JSON.parse(raw) as unknown);
    } catch {
      return parseAutoUpdateCheck(raw);
    }
  } catch {
    return DEFAULT_AUTO_UPDATE_CHECK;
  }
}

export function loadAutoUpdateCheck(): boolean {
  if (typeof window === "undefined") return DEFAULT_AUTO_UPDATE_CHECK;
  return loadAutoUpdateCheckFromStorage(window.localStorage);
}

export function saveAutoUpdateCheckToStorage(storage: StorageLike, enabled: boolean): void {
  try {
    storage.setItem(AUTO_UPDATE_CHECK_STORAGE_KEY, JSON.stringify(parseAutoUpdateCheck(enabled)));
  } catch {
    // 忽略存储配额 / 隐私模式错误
  }
}

export function saveAutoUpdateCheck(enabled: boolean): void {
  if (typeof window === "undefined") return;
  saveAutoUpdateCheckToStorage(window.localStorage, enabled);
}
