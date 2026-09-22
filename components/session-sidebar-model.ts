/**
 * 会话栏树模型（纯函数，无副作用）。
 *
 * 层级固定：项目区（Project → Session → child）+ 底部未分组区（Session → child）。
 * - 项目 = 目录（一对一）：项目根就是会话 `cwd`，不再按 Git linked worktree 归并；
 * - 项目区**只列项目列表内的目录**；其余会话（从未加入过项目的目录、关闭项目后
 *   留下的会话）归未分组区，不再被隐藏（#53）；
 * - 组内会话树复用 buildSessionDisplayTree，fork/subagent child 语义、
 *   孤儿/循环降级原样保留，本文件绝不修改 SessionInfo 或 Pi schema。
 */
import type { SessionInfo } from "@/lib/types";
import type { ProjectAliases, ProjectSortMode } from "@/lib/ui-preferences";
import {
  buildSessionDisplayTree,
  filterSessionDisplayTree,
  getDisplayNodeAncestorIds,
  type SessionDisplayNode,
} from "./session-tree";

export interface SidebarProjectNode {
  /** 项目根路径，等于该项目下会话的 cwd。 */
  root: string;
  /** 会话展示树（fork/subagent 语义由 session-tree 保证）。 */
  tree: SessionDisplayNode[];
  /** 项目内最近会话修改时间；无会话项目为 ""。 */
  latestActivity: string;
}

export interface BuildSidebarTreeOptions {
  /**
   * 当前选中 cwd：仅用于「刚进入的空项目置顶」排序（列表内的项目才会有空项目行）。
   */
  selectedCwd?: string | null;
  /**
   * 侧栏项目根列表（持久化，唯一来源）：只有列表里的项目出现在项目区，无会话也显示
   * 为空项目行；不在列表内的目录，其会话归未分组区（见 buildUngroupedTree），不再隐藏。
   */
  projectRoots?: readonly string[];
  /**
   * 显式未分组标记（关闭项目时记录）：被标记的会话即使 `cwd` 在项目列表内也留在未分组区，
   * 即「重新添加该目录不回迁旧会话」。
   */
  ungroupedSessionIds?: ReadonlySet<string> | readonly string[];
}

/** 把 id 集合入参统一成 Set（数组/Set 均可，纯函数不修改入参）。 */
function toIdSet(ids: ReadonlySet<string> | readonly string[] | undefined): ReadonlySet<string> {
  if (!ids) return new Set<string>();
  return ids instanceof Set ? ids : new Set(ids);
}

function latestModified(sessions: SessionInfo[]): string {
  let latest = "";
  for (const session of sessions) {
    if (session.modified > latest) latest = session.modified;
  }
  return latest;
}

/**
 * 由全部会话构建项目树（**项目区**：只含项目列表内的目录）。
 *
 * 排序：项目按最近活动降序；唯一例外是无会话的 selectedCwd 空项目——
 * 它是用户当前上下文，置顶保证「刚添加的项目立即可见」。
 *
 * 不在项目列表内的会话一律不在这里出现：它们由 buildUngroupedTree 归入未分组区
 * （选中但未加入列表的目录也不再造空项目行——它的会话现在有归宿，不必靠临时行留住）。
 */
/** 侧栏里需要「命令语义」写入的集合字段（#66）：整值回写会丢并发加项。 */
export const SIDEBAR_COLLECTION_FIELDS: ReadonlySet<string> = new Set([
  "projectRoots",
  "pinnedSessionIds",
  "ungroupedSessionIds",
  "collapsedProjectRoots",
]);

export type PrefOp = { key: string; op: "add" | "remove" | "set"; value?: unknown };

export function buildSidebarTree(
  sessions: SessionInfo[],
  options: BuildSidebarTreeOptions = {},
): SidebarProjectNode[] {
  const { selectedCwd = null } = options;
  const listedRoots = new Set(options.projectRoots ?? []);
  const ungroupedIds = toIdSet(options.ungroupedSessionIds);

  const projectBuckets = new Map<string, SessionInfo[]>();
  for (const session of sessions) {
    // 显式未分组标记：即使目录仍在项目列表里也留在未分组区（不回迁）。
    if (ungroupedIds.has(session.id)) continue;
    if (!listedRoots.has(session.cwd)) continue;
    const bucket = projectBuckets.get(session.cwd);
    if (bucket) bucket.push(session);
    else projectBuckets.set(session.cwd, [session]);
  }
  // 项目列表里的项目：即使无会话也持续显示（项目独立于会话存在）。
  for (const root of listedRoots) {
    if (!projectBuckets.has(root)) projectBuckets.set(root, []);
  }

  const projects: SidebarProjectNode[] = [];
  for (const [root, groupSessions] of projectBuckets) {
    projects.push({
      root,
      tree: buildSessionDisplayTree(groupSessions),
      latestActivity: latestModified(groupSessions),
    });
  }

  projects.sort((a, b) => {
    // 无会话的选中项目（刚通过「添加项目」进入）置顶；其余按最近活动降序。
    if (!a.latestActivity && !b.latestActivity) return a.root.localeCompare(b.root);
    if (!a.latestActivity) return a.root === selectedCwd ? -1 : 1;
    if (!b.latestActivity) return b.root === selectedCwd ? 1 : -1;
    return b.latestActivity.localeCompare(a.latestActivity);
  });
  return projects;
}

// ── 未分组会话区（#53） ──────────────────────────────────────────────────

/**
 * 未分组区的 group key：折叠集合（collapsedProjectRoots）与分页 map 共用。
 * 它只作为 key 参与相等比较，不会被当成目录路径使用。
 */
export const UNGROUPED_GROUP_KEY = "__ungrouped__";

export interface UngroupedSessionsOptions {
  /** 侧栏项目根列表：不在其中的 `cwd` 即派生为未分组。 */
  projectRoots?: readonly string[];
  /** 显式未分组标记（关闭项目时记录）；与派生规则取并集。 */
  ungroupedSessionIds?: ReadonlySet<string> | readonly string[];
}

/**
 * 未分组会话集合（派生 ∪ 显式）：
 * - 派生：`cwd` 不在项目列表里的会话（覆盖从未加入过项目的目录、关闭项目后的目录）；
 * - 显式：关闭项目那一刻记录下来的会话 id —— 该目录被重新添加后它们仍留在未分组，
 *   而该目录下的新会话按派生规则回到项目区。
 *
 * 只做过滤与并集，不排序（顺序语义留给 buildSessionDisplayTree）；不改输入数组。
 */
export function collectUngroupedSessions(
  sessions: readonly SessionInfo[],
  options: UngroupedSessionsOptions = {},
): SessionInfo[] {
  const listedRoots = new Set(options.projectRoots ?? []);
  const ungroupedIds = toIdSet(options.ungroupedSessionIds);
  return sessions.filter((session) => ungroupedIds.has(session.id) || !listedRoots.has(session.cwd));
}

/**
 * 未分组区的展示树：与项目内会话同一套 fork/subagent 语义与排序（modified 降序），
 * subagent 标记的会话同样不进入展示树。
 */
export function buildUngroupedTree(
  sessions: readonly SessionInfo[],
  options: UngroupedSessionsOptions = {},
): SessionDisplayNode[] {
  return buildSessionDisplayTree(collectUngroupedSessions(sessions, options));
}

/**
 * 在未分组树中定位会话：命中返回其会话级祖先链（不含自身，可能为空数组），
 * 未找到返回 null。调用方据此展开未分组区与祖先层级——否则选中一个未分组会话时
 * 它可能在折叠的区里不可见。
 */
export function locateSessionInUngroupedTree(
  nodes: SessionDisplayNode[],
  sessionId: string,
): string[] | null {
  const ancestors = getDisplayNodeAncestorIds(nodes, sessionId);
  if (ancestors.length > 0) return ancestors;
  return nodes.some((node) => node.session.id === sessionId) ? [] : null;
}

const PROJECT_NAME_COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

function projectSortName(project: SidebarProjectNode, aliases?: Readonly<Record<string, string>>): string {
  if (aliases?.[project.root]) return aliases[project.root];
  const clean = project.root.replaceAll("\\", "/").replace(/\/+$/, "");
  const idx = clean.lastIndexOf("/");
  return (idx >= 0 ? clean.slice(idx + 1) : clean) || project.root;
}

/**
 * 按显示选项对项目树排序。recent 沿用 buildSidebarTree 的最近活动；
 * az/za 按显示名（alias 优先）；fixed 按 projectOrder，未入序的新项目跟在后面。
 */
export function sortSidebarProjects(
  projects: SidebarProjectNode[],
  options: {
    mode: ProjectSortMode;
    order?: readonly string[];
    aliases?: ProjectAliases;
    selectedRoot?: string | null;
  },
): SidebarProjectNode[] {
  const { mode, order = [], aliases, selectedRoot = null } = options;
  const copy = [...projects];
  if (mode === "az" || mode === "za") {
    copy.sort((a, b) => {
      const cmp = PROJECT_NAME_COLLATOR.compare(projectSortName(a, aliases), projectSortName(b, aliases));
      return mode === "az" ? cmp : -cmp;
    });
    return copy;
  }
  if (mode === "fixed") {
    const index = new Map(order.map((root, i) => [root, i]));
    copy.sort((a, b) => {
      const ia = index.has(a.root) ? index.get(a.root)! : Number.MAX_SAFE_INTEGER;
      const ib = index.has(b.root) ? index.get(b.root)! : Number.MAX_SAFE_INTEGER;
      if (ia !== ib) return ia - ib;
      return b.latestActivity.localeCompare(a.latestActivity);
    });
    return copy;
  }
  copy.sort((a, b) => {
    if (!a.latestActivity && !b.latestActivity) return a.root.localeCompare(b.root);
    if (!a.latestActivity) return a.root === selectedRoot ? -1 : 1;
    if (!b.latestActivity) return b.root === selectedRoot ? 1 : -1;
    return b.latestActivity.localeCompare(a.latestActivity);
  });
  return copy;
}

/** 把 fromRoot 挪到 toRoot 的位置（插入到目标处）。 */
export function moveProjectInOrder(order: readonly string[], fromRoot: string, toRoot: string): string[] {
  const next = [...order];
  const from = next.indexOf(fromRoot);
  const to = next.indexOf(toRoot);
  if (from < 0 || to < 0 || from === to) return next;
  next.splice(from, 1);
  next.splice(to, 0, fromRoot);
  return next;
}

// ── 项目关闭过滤（纯 UI 隐藏，不触碰任何会话数据） ─────────────────────────

/**
 * 项目是否还有运行中会话：只认该项目目录（cwd 精确相等）下的 running 会话。
 * 别处目录（含另一个 Git checkout）里的 running 不挡住关闭本项目。
 */
export function projectHasRunningSession(
  sessions: readonly SessionInfo[],
  runningIds: ReadonlySet<string> | readonly string[],
  root: string,
): boolean {
  const running = runningIds instanceof Set ? runningIds : new Set(runningIds);
  return sessions.some((session) => session.cwd === root && running.has(session.id));
}

/**
 * 关闭当前项目后的候选项目根：按树的展示顺序取第一个既非被关闭项目、
 * 也不在排除集合中的项目；无剩余项目返回 null（调用方据此置空 cwd）。
 */
export function pickProjectRootAfterClose(
  projects: SidebarProjectNode[],
  closedRoot: string,
  closedRoots: ReadonlySet<string>,
): string | null {
  for (const project of projects) {
    if (project.root === closedRoot) continue;
    if (closedRoots.has(project.root)) continue;
    return project.root;
  }
  return null;
}

// ── 全项目搜索 ────────────────────────────────────────────────────────────

/**
 * 搜索过滤项目树：命中 project 根路径或项目 alias 时保留整个项目；否则按会话字段
 * 过滤，命中 child 时保留完整 project → session 祖先链。返回全新对象，绝不变异输入。
 *
 * fulltextMatchIds 传入（含空 Set）时进入全文模式：只按 id 集合保留祖先链，
 * 不再按项目路径/alias/name/firstMessage 匹配。
 */
export function filterSidebarTree(
  projects: SidebarProjectNode[],
  normalizedQuery: string,
  projectAliases?: Readonly<Record<string, string>>,
  fulltextMatchIds?: ReadonlySet<string> | null,
): SidebarProjectNode[] {
  const fulltextMode = fulltextMatchIds != null;
  if (!fulltextMode && !normalizedQuery) return projects;

  const result: SidebarProjectNode[] = [];
  for (const project of projects) {
    // 全文模式不按项目路径/alias 整树保留——只展示命中会话的祖先链。
    if (!fulltextMode) {
      const alias = projectAliases?.[project.root];
      if (project.root.toLowerCase().includes(normalizedQuery)
        || (alias !== undefined && alias.toLowerCase().includes(normalizedQuery))) {
        result.push(project);
        continue;
      }
    }
    const tree = fulltextMode
      ? filterSessionDisplayTreeByIds(project.tree, fulltextMatchIds)
      : filterSessionDisplayTree(project.tree, normalizedQuery);
    if (tree.length > 0) result.push({ ...project, tree });
  }
  return result;
}

/**
 * 按会话 id 集合过滤展示树：命中节点保留，命中 child 时保留完整祖先链。
 * 返回全新节点对象，绝不变异原树。
 */
export function filterSessionDisplayTreeByIds(
  nodes: SessionDisplayNode[],
  matchIds: ReadonlySet<string>,
): SessionDisplayNode[] {
  if (matchIds.size === 0) return [];
  const result: SessionDisplayNode[] = [];
  for (const node of nodes) {
    const children = filterSessionDisplayTreeByIds(node.children, matchIds);
    if (matchIds.has(node.session.id) || children.length > 0) {
      result.push({ ...node, children });
    }
  }
  return result;
}

// ── 会话定位（选中/URL 恢复时自动展开祖先） ────────────────────────────────

export interface SidebarSessionLocation {
  projectRoot: string;
  /** 会话级祖先 id 链（自项目根向父，不含自身）。 */
  ancestors: string[];
}

/**
 * 在项目树中定位会话：返回其项目根与会话级祖先链。找不到返回 null。
 * 调用方据此把「已选中但被折叠隐藏」的祖先层级展开。
 */
export function locateSessionInSidebarTree(
  projects: SidebarProjectNode[],
  sessionId: string,
): SidebarSessionLocation | null {
  for (const project of projects) {
    const ancestors = getDisplayNodeAncestorIds(project.tree, sessionId);
    if (ancestors.length > 0) return { projectRoot: project.root, ancestors };
    if (project.tree.some((node) => node.session.id === sessionId)) {
      return { projectRoot: project.root, ancestors: [] };
    }
  }
  return null;
}

// ── 折叠集合操作（Collapse all / Expand all 的数据来源） ───────────────────
/**
 * 收集树中全部可折叠的项目根 id（Collapse all 写入偏好的内容）。
 * Expand all 无需 helper：直接清空集合。
 *
 * `includeUngrouped` 为真时把未分组区的 key 一并列入：Collapse all / Expand all
 * 对未分组区与项目区行为一致。
 */
export function collectAllCollapseIds(
  projects: SidebarProjectNode[],
  options: { includeUngrouped?: boolean } = {},
): { projectRoots: string[] } {
  const ids = projects.map((project) => project.root);
  if (options.includeUngrouped) ids.push(UNGROUPED_GROUP_KEY);
  return { projectRoots: ids };
}

