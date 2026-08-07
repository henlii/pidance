/**
 * 会话栏 UI 偏好 seam（跨刷新持久化）。
 *
 * 只放跨刷新偏好：显示模式、项目/worktree 折叠集合、侧栏宽度。
 * 搜索查询、搜索框开关、会话级 child 折叠、可见条数均为组件瞬时态，绝不写入这里。
 * 读写容错：localStorage 不可用（隐私模式/SSR）时静默回退默认值。
 */

export type SidebarDisplayMode = "standard" | "compact";

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
  /** 已折叠非主 worktree 路径。 */
  collapsedWorktreePaths: string[];
  /** 项目显示名 alias（projectRoot → 名称）；项目行与搜索共用。 */
  projectAliases: ProjectAliases;
  /** 已关闭项目根路径：仅从侧栏隐藏，不删除任何目录/会话/Git 数据。 */
  closedProjectRoots: string[];
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
  /** 文件树按 cwd 记忆的展开路径与滚动位置。 */
  fileExplorerState: FileExplorerState;
}

export const DEFAULT_SIDEBAR_PREFERENCES: SidebarPreferences = {
  displayMode: "standard",
  collapsedProjectRoots: [],
  collapsedWorktreePaths: [],
  projectAliases: {},
  closedProjectRoots: [],
  sidebarWidth: SIDEBAR_WIDTH_DEFAULT,
  rightPanelOpen: false,
  rightPanelWidth: RIGHT_PANEL_WIDTH_DEFAULT,
  changesPanelOpen: true,
  changesPanelWidth: CHANGES_PANEL_WIDTH_DEFAULT,
  showRecentSessions: true,
  fileExplorerState: {},
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
      closedProjectRoots: [],
      collapsedProjectRoots: [],
      collapsedWorktreePaths: [],
    };
  }
  const record = raw as Record<string, unknown>;
  return {
    displayMode: record.displayMode === "compact" || record.displayMode === "standard"
      ? record.displayMode
      : DEFAULT_SIDEBAR_PREFERENCES.displayMode,
    collapsedProjectRoots: parsePathList(record.collapsedProjectRoots),
    collapsedWorktreePaths: parsePathList(record.collapsedWorktreePaths),
    projectAliases: parseProjectAliases(record.projectAliases),
    closedProjectRoots: parsePathList(record.closedProjectRoots),
    // 旧数据缺字段时 clamp 非数字 → 默认 300；越界/损坏一律钳入 [min, max]。
    sidebarWidth: clampSidebarWidth(record.sidebarWidth),
    // 旧数据无右栏字段：右栏默认关闭、宽度默认。
    rightPanelOpen: parseRightPanelOpen(record.rightPanelOpen),
    rightPanelWidth: clampRightPanelWidth(record.rightPanelWidth),
    changesPanelOpen: parseChangesPanelOpen(record.changesPanelOpen),
    changesPanelWidth: clampChangesPanelWidth(record.changesPanelWidth),
    // 旧数据无最近会话字段：默认开启（仅显式 false 关闭）。
    showRecentSessions: parseShowRecentSessions(record.showRecentSessions),
    // 旧数据无文件树记忆字段：默认空表。
    fileExplorerState: parseFileExplorerState(record.fileExplorerState),
  };
}

export function serializeSidebarPreferences(prefs: SidebarPreferences): string {
  return JSON.stringify({
    displayMode: prefs.displayMode,
    collapsedProjectRoots: prefs.collapsedProjectRoots,
    collapsedWorktreePaths: prefs.collapsedWorktreePaths,
    projectAliases: prefs.projectAliases,
    closedProjectRoots: prefs.closedProjectRoots,
    sidebarWidth: clampSidebarWidth(prefs.sidebarWidth),
    rightPanelOpen: parseRightPanelOpen(prefs.rightPanelOpen),
    rightPanelWidth: clampRightPanelWidth(prefs.rightPanelWidth),
    changesPanelOpen: parseChangesPanelOpen(prefs.changesPanelOpen),
    changesPanelWidth: clampChangesPanelWidth(prefs.changesPanelWidth),
    showRecentSessions: parseShowRecentSessions(prefs.showRecentSessions),
    fileExplorerState: parseFileExplorerState(prefs.fileExplorerState),
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

