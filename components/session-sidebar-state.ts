/**
 * 会话栏瞬时态纯模型（无 React / 无 IO / 不写 Pi schema）。
 *
 * 职责边界：
 * - 分组可见条数（show more / show fewer / 搜索全量）
 * - 乐观会话列表合并（server ↔ pending，stale 保护）
 * - 项目 worktree 快照 immutable upsert（按 projectRoot，loading/error 保留 last-known）
 *
 * 树投影仍由 session-sidebar-model 负责；本文件只产出可接入的状态切片，
 * 供后续 designer 无业务决策地接线。
 */

import type { SessionInfo } from "@/lib/types";
import type { WorktreeEntry } from "@/lib/project-context";

// ── 分组可见条数 ───────────────────────────────────────────────────────────

/** 每个 group key 默认展示的顶层会话节点数。 */
export const DEFAULT_GROUP_VISIBLE_COUNT = 5;
/** 每次「显示更多」递增步长。 */
export const GROUP_VISIBLE_PAGE_SIZE = 5;

/**
 * 读取某分组的可见条数：缺省为默认 5；搜索激活时调用方应改走 getVisibleTopLevelNodes。
 * 本 map 只存用户显式调大后的值，不持久化。
 */
export function getGroupVisibleCount(
  counts: Readonly<Record<string, number>>,
  groupKey: string,
): number {
  const raw = counts[groupKey];
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < DEFAULT_GROUP_VISIBLE_COUNT) {
    return DEFAULT_GROUP_VISIBLE_COUNT;
  }
  return Math.floor(raw);
}

/** 显示更多：当前值 +5（未记录过则从默认 5 起算）。 */
export function bumpGroupVisibleCount(
  counts: Readonly<Record<string, number>>,
  groupKey: string,
): Record<string, number> {
  const current = getGroupVisibleCount(counts, groupKey);
  return { ...counts, [groupKey]: current + GROUP_VISIBLE_PAGE_SIZE };
}

/** 显示更少：重置该分组到默认；若本就默认则返回原引用。 */
export function resetGroupVisibleCount(
  counts: Readonly<Record<string, number>>,
  groupKey: string,
): Record<string, number> {
  if (!(groupKey in counts)) return counts as Record<string, number>;
  const next = { ...counts };
  delete next[groupKey];
  return next;
}

/**
 * 从顶层节点列表截取可见窗口。
 * - searchActive：返回全部（引用相等）
 * - 否则取前 N 个顶层节点；每个节点连同其 child tree 完整保留，绝不半截 child
 */
export function getVisibleTopLevelNodes<T>(
  topLevelNodes: readonly T[],
  visibleCount: number,
  searchActive: boolean,
): readonly T[] {
  if (searchActive) return topLevelNodes;
  const n = Math.max(0, Math.floor(visibleCount));
  if (n >= topLevelNodes.length) return topLevelNodes;
  return topLevelNodes.slice(0, n);
}

/** 是否还能「显示更多」：搜索中不显示；否则顶层总数大于当前可见数。 */
export function canShowMoreTopLevel(
  totalTopLevel: number,
  visibleCount: number,
  searchActive: boolean,
): boolean {
  if (searchActive) return false;
  return totalTopLevel > Math.max(0, Math.floor(visibleCount));
}

/** 是否显示「显示更少」：搜索中不显示；否则当前可见数大于默认。 */
export function canShowFewerTopLevel(
  visibleCount: number,
  searchActive: boolean,
): boolean {
  if (searchActive) return false;
  return Math.floor(visibleCount) > DEFAULT_GROUP_VISIBLE_COUNT;
}

// ── 乐观会话合并 ───────────────────────────────────────────────────────────

/**
 * 会话排序：modified 降序；modified 相同则 created 降序；再相同按 id 升序稳定。
 * 与 SessionInfo 的 ISO 字符串字段语义一致（字典序 ≈ 时间序）。
 */
export function compareSessionsByActivity(a: SessionInfo, b: SessionInfo): number {
  const byModified = b.modified.localeCompare(a.modified);
  if (byModified !== 0) return byModified;
  const byCreated = b.created.localeCompare(a.created);
  if (byCreated !== 0) return byCreated;
  return a.id.localeCompare(b.id);
}

export interface MergeOptimisticSessionsInput {
  /** 服务端权威列表（可为空数组）。 */
  serverSessions: readonly SessionInfo[];
  /** 本地乐观/待确认会话（新建未回流等）。 */
  pendingSessions: readonly SessionInfo[];
  /**
   * 仍处于 pending 集合的 id：stale server 响应不得把它们删掉。
   * 缺省时用 pendingSessions 的 id 集合。
   */
  pendingIds?: ReadonlySet<string>;
  /** 用户已显式删除的 id：即使仍在 pending 也移除。 */
  deletedIds?: ReadonlySet<string>;
}

/**
 * 合并 server 列表与 pending 列表：
 * - 同 id：server 条目替换 pending（server 权威）
 * - pending 中 server 没有的 id：保留（乐观插入；stale 保护）
 * - deletedIds 中的 id：两侧均剔除
 * - 结果按 compareSessionsByActivity 稳定排序
 */
export function mergeOptimisticSessions(input: MergeOptimisticSessionsInput): SessionInfo[] {
  const {
    serverSessions,
    pendingSessions,
    pendingIds = new Set(pendingSessions.map((s) => s.id)),
    deletedIds,
  } = input;

  const byId = new Map<string, SessionInfo>();

  // server 权威：同 id 直接写入（覆盖后续不会再写的 pending）
  for (const session of serverSessions) {
    if (deletedIds?.has(session.id)) continue;
    byId.set(session.id, session);
  }

  // stale 保护：仍在 pendingIds 且 server 未带回、未显式删除的，保留 pending 副本
  for (const session of pendingSessions) {
    if (deletedIds?.has(session.id)) continue;
    if (byId.has(session.id)) continue;
    if (!pendingIds.has(session.id)) continue;
    byId.set(session.id, session);
  }

  return [...byId.values()].sort(compareSessionsByActivity);
}

/**
 * 从 pending 集合中移除已出现在 server 列表的 id（回流完成）。
 * 返回新 Set；无变化时返回原引用。
 */
export function reconcilePendingSessionIds(
  pendingIds: ReadonlySet<string>,
  serverSessions: readonly SessionInfo[],
): Set<string> {
  if (pendingIds.size === 0) return pendingIds as Set<string>;
  const serverIds = new Set(serverSessions.map((s) => s.id));
  let changed = false;
  const next = new Set<string>();
  for (const id of pendingIds) {
    if (serverIds.has(id)) {
      changed = true;
      continue;
    }
    next.add(id);
  }
  return changed ? next : (pendingIds as Set<string>);
}

/**
 * 会话列表 fetch 代际：仅当 responseGen === latestGen 时允许写 server/error/loading。
 * 乱序 R1 在 R2 之后返回时必须丢弃。
 */
export function shouldApplySessionListResponse(
  responseGen: number,
  latestGen: number,
): boolean {
  return responseGen === latestGen && responseGen > 0;
}

/**
 * worktree 预加载 generation 字符串：只依赖 wtRefreshKey，
 * 不得嵌入 session refreshKey（session list 刷新不得重抓 worktree）。
 */
export function buildWorktreePreloadGeneration(wtRefreshKey: number): string {
  return `wt:${Math.max(0, Math.floor(wtRefreshKey))}`;
}

// ── 最近会话区 ─────────────────────────────────────────────────────────────

/** 最近区候选池上限（按 modified 取最近 N 条）。 */
export const RECENT_SESSIONS_LIMIT = 20;
/** 最近区默认可见条数。 */
export const RECENT_SESSIONS_INITIAL_VISIBLE = 5;
/** 最近区每次「加载更多」追加条数。 */
export const RECENT_SESSIONS_LOAD_MORE = 5;

export interface DeriveRecentSessionsInput {
  /** 全量会话列表（服务端 + 乐观合并后）；排序语义由本函数内部保证。 */
  sessions: readonly SessionInfo[];
  /** 已关闭项目根集合：这些项目内的会话不进入最近区（用户已隐藏）。 */
  closedProjectRoots?: ReadonlySet<string>;
  /** 附加排除 id（如已删除、仅显示占位等）。 */
  excludeIds?: ReadonlySet<string>;
  /** 展示条数上限；损坏/负数回退默认 RECENT_SESSIONS_LIMIT（20）。 */
  limit?: number;
}

/**
 * 最近会话派生（OpenChamber Recent zone 语义的纯逻辑版）：
 * 按 modified 降序取最近 N 个会话（默认 N=20），作为项目列表上方的纯快捷入口。
 *
 * 排除规则：
 * - subagent 子会话（`session.subagent` 存在）——子会话只读、不参与最近区
 * - 已关闭项目（`closedProjectRoots`）内的会话——用户已从侧栏隐藏
 * - `excludeIds` 显式排除的 id
 *
 * 本函数不修改输入数组；输入是否已排序不影响结果（内部先稳定排序）。
 */
export function deriveRecentSessions(input: DeriveRecentSessionsInput): SessionInfo[] {
  const {
    sessions,
    closedProjectRoots,
    excludeIds,
    limit = RECENT_SESSIONS_LIMIT,
  } = input;
  const n = Math.max(0, Math.floor(limit));
  const filtered = sessions.filter((s) => {
    if (s.subagent) return false;
    if (excludeIds?.has(s.id)) return false;
    const projectRoot = s.projectRoot ?? s.cwd;
    if (projectRoot && closedProjectRoots?.has(projectRoot)) return false;
    return true;
  });
  const sorted = filtered.slice().sort(compareSessionsByActivity);
  return sorted.slice(0, n);
}

export interface DerivePinnedSessionsInput {
  /** 全量会话列表（服务端 + 乐观合并后）。 */
  sessions: readonly SessionInfo[];
  /** 置顶 id 顺序（最新置顶在前）；结果按此顺序输出。 */
  pinnedSessionIds: readonly string[];
  /** 已关闭项目根集合：这些项目内的会话不显示（用户已隐藏）。 */
  closedProjectRoots?: ReadonlySet<string>;
}

/**
 * 置顶会话派生（纯逻辑）：按 pinnedSessionIds 顺序输出仍存在且可见的会话。
 *
 * 排除规则：
 * - 已不在 sessions 中的 id（会话已删除/归档）——静默跳过
 * - subagent 子会话（只读、不参与置顶）
 * - 已关闭项目（closedProjectRoots）内的会话
 *
 * 本函数不修改输入数组；不存在/被排除的 id 不报错。
 */
export function derivePinnedSessions(input: DerivePinnedSessionsInput): SessionInfo[] {
  const { sessions, pinnedSessionIds, closedProjectRoots } = input;
  const byId = new Map<string, SessionInfo>();
  for (const s of sessions) {
    if (s.subagent) continue;
    const projectRoot = s.projectRoot ?? s.cwd;
    if (projectRoot && closedProjectRoots?.has(projectRoot)) continue;
    byId.set(s.id, s);
  }
  const result: SessionInfo[] = [];
  const seen = new Set<string>();
  for (const id of pinnedSessionIds) {
    const s = byId.get(id);
    if (s && !seen.has(id)) {
      seen.add(id);
      result.push(s);
    }
  }
  return result;
}

// ── 项目 worktree 快照 ─────────────────────────────────────────────────────

export type ProjectWorktreeStatus = "idle" | "loading" | "ready" | "error";

export interface ProjectWorktreeSnapshot {
  status: ProjectWorktreeStatus;
  worktrees: readonly WorktreeEntry[];
  error?: string;
}

/** 全表：projectRoot → 快照。不持久化到 Pi / session schema。 */
export type ProjectWorktreeSnapshots = Readonly<Record<string, ProjectWorktreeSnapshot>>;

export const EMPTY_PROJECT_WORKTREE_SNAPSHOT: ProjectWorktreeSnapshot = {
  status: "idle",
  worktrees: [],
};

/** 比较两条 worktree 列表是否语义相同（path/branch/isMain 顺序敏感）。 */
export function sameWorktreeList(
  a: readonly WorktreeEntry[],
  b: readonly WorktreeEntry[],
): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (x.path !== y.path || x.branch !== y.branch || x.isMain !== y.isMain) return false;
  }
  return true;
}

/** 比较两份快照是否可跳过更新。 */
export function sameProjectWorktreeSnapshot(
  a: ProjectWorktreeSnapshot | undefined,
  b: ProjectWorktreeSnapshot,
): boolean {
  if (!a) return false;
  if (a.status !== b.status) return false;
  if ((a.error ?? undefined) !== (b.error ?? undefined)) return false;
  return sameWorktreeList(a.worktrees, b.worktrees);
}

export type ProjectWorktreeUpsert =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; worktrees: readonly WorktreeEntry[] }
  | { status: "error"; error: string; worktrees?: readonly WorktreeEntry[] };

/**
 * 对单个 projectRoot 做 immutable upsert。
 * - loading / error：保留 last-known worktrees（除非本次显式给出 worktrees）
 * - ready：写入新列表
 * - idle：清空为默认空快照
 * - 语义不变时返回原 map 引用，避免无谓 re-render
 * 单项目错误不影响其他 projectRoot 条目。
 */
export function upsertProjectWorktreeSnapshot(
  map: ProjectWorktreeSnapshots,
  projectRoot: string,
  patch: ProjectWorktreeUpsert,
): ProjectWorktreeSnapshots {
  const prev = map[projectRoot];
  let next: ProjectWorktreeSnapshot;

  switch (patch.status) {
    case "idle":
      next = EMPTY_PROJECT_WORKTREE_SNAPSHOT;
      break;
    case "loading":
      next = {
        status: "loading",
        worktrees: prev?.worktrees ?? [],
      };
      break;
    case "ready":
      next = {
        status: "ready",
        worktrees: patch.worktrees,
      };
      break;
    case "error":
      next = {
        status: "error",
        worktrees: patch.worktrees ?? prev?.worktrees ?? [],
        error: patch.error,
      };
      break;
  }

  if (sameProjectWorktreeSnapshot(prev, next)) return map;
  return { ...map, [projectRoot]: next };
}

/**
 * 移除某项目快照；不存在时返回原引用。
 * 不影响其他项目。
 */
export function removeProjectWorktreeSnapshot(
  map: ProjectWorktreeSnapshots,
  projectRoot: string,
): ProjectWorktreeSnapshots {
  if (!(projectRoot in map)) return map;
  const next = { ...map };
  delete next[projectRoot];
  return next;
}

/**
 * 组装 worktree 预加载队列的项目根列表。
 *
 * 语义（修复侧栏把 worktree 路径误当项目根预加载的问题）：
 * - selectedProjectRoot 存在：只用它作为锚点——已在 roots 则返回原引用，
 *   否则 unshift 到队首；**不再**用 selectedCwd 兜底（点击 worktree 分组后
 *   selectedCwd 是 worktree 路径，混入队列会向 /api/worktrees?cwd=<worktree 路径>
 *   发起请求并污染快照 key）。
 * - selectedProjectRoot 为空：selectedCwd 不在 roots 时才 unshift 兜底。
 * 无变化时返回原引用，避免触发 useMemo/effect 无谓重跑。
 */
export function buildKnownProjectRoots(
  roots: readonly string[],
  selectedCwd: string | null,
  selectedProjectRoot: string | null,
): readonly string[] {
  if (selectedProjectRoot) {
    if (roots.includes(selectedProjectRoot)) return roots;
    return [selectedProjectRoot, ...roots];
  }
  if (selectedCwd && !roots.includes(selectedCwd)) return [selectedCwd, ...roots];
  return roots;
}

/**
 * 提交 worktree 响应到快照表，并按服务端权威 projectRoot（canonicalRoot）收敛 key。
 *
 * - canonicalRoot === requestRoot：等同 upsertProjectWorktreeSnapshot ready。
 * - canonicalRoot !== requestRoot：请求 root（如 worktree 路径）不得成为快照 key——
 *   先移除该 key（含此前预加载写入的 loading 条目，remove 对不存在的 key 是 no-op），
 *   再把 ready 快照写入 canonicalRoot。否则 buildSidebarTree 会把这个请求 root
 *   当成项目根创建项目桶并补 worktree 分组，侧栏多出「项目 + 工作树」。
 */
export function upsertCanonicalProjectWorktreeSnapshot(
  map: ProjectWorktreeSnapshots,
  requestRoot: string,
  canonicalRoot: string,
  worktrees: readonly WorktreeEntry[],
): ProjectWorktreeSnapshots {
  if (canonicalRoot === requestRoot) {
    return upsertProjectWorktreeSnapshot(map, requestRoot, { status: "ready", worktrees });
  }
  const withoutRequestRoot = removeProjectWorktreeSnapshot(map, requestRoot);
  return upsertProjectWorktreeSnapshot(withoutRequestRoot, canonicalRoot, { status: "ready", worktrees });
}
