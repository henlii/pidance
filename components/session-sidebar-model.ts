/**
 * OpenChamber 风格会话栏树模型（纯函数，无副作用）。
 *
 * 层级固定：Project → (非主 Worktree) → Session → child。
 * - 项目根 = session.projectRoot ?? session.cwd；
 * - 后端 resolveProject 仅把「非主 worktree 顶层」折叠回主仓，因此
 *   session.cwd !== root 精确等价于「该会话属于一个非主 worktree」；
 * - 主 worktree 隐式：主仓会话直接挂在项目下，不渲染额外 worktree 行；
 * - 组内会话树复用 buildSessionDisplayTree，fork/subagent child 语义、
 *   孤儿/循环降级原样保留，本文件绝不修改 SessionInfo 或 Pi schema。
 */
import type { SessionInfo } from "@/lib/types";
import {
  buildSessionDisplayTree,
  collectSubagentParentIds,
  filterSessionDisplayTree,
  getDisplayNodeAncestorIds,
  type SessionDisplayNode,
} from "./session-tree";

/** 非主 worktree 分组（主 worktree 永远不产生该结构）。 */
export interface SidebarWorktreeGroup {
  /** worktree 检出绝对路径，同时作为分组 id。 */
  path: string;
  /** 分支名；未知（如已移除 worktree 的推断分支缺失）时为 null。 */
  branch: string | null;
  /** 组内会话展示树（fork/subagent 语义由 session-tree 保证）。 */
  tree: SessionDisplayNode[];
  /** 组内最近会话修改时间；空组为 ""。 */
  latestActivity: string;
}

export interface SidebarProjectNode {
  /** 项目根路径（projectRoot）。 */
  root: string;
  /** 主仓（主 worktree）会话展示树，直接挂在项目下。 */
  mainTree: SessionDisplayNode[];
  /** 非主 worktree 分组，按最近活动降序、空组在后。 */
  worktrees: SidebarWorktreeGroup[];
  /** 项目内最近会话修改时间；无会话项目为 ""。 */
  latestActivity: string;
}

/** 当前项目已加载的完整 worktree 列表（含无会话的检出）。 */
export interface KnownWorktree {
  path: string;
  branch: string | null;
  isMain: boolean;
}

export interface BuildSidebarTreeOptions {
  /** 当前选中 cwd：无会话时也必须作为可用项目项出现。 */
  selectedCwd?: string | null;
  /** selectedCwd 解析出的项目根（未知时与 selectedCwd 相同）。 */
  selectedProjectRoot?: string | null;
  /** 当前项目的完整 worktree 列表，用于补齐无会话的空分组。 */
  knownWorktrees?: KnownWorktree[];
  /** 全部已知项目的 worktree 快照；用于补齐未选中项目的空 worktree 分组。 */
  knownWorktreesByProject?: Readonly<Record<string, readonly KnownWorktree[]>>;
  /** 用户主动添加的项目根（持久化）：无会话也持续显示为空项目行。 */
  addedProjectRoots?: readonly string[];
}

interface SessionBucket {
  sessions: SessionInfo[];
  branch: string | null;
}

function latestModified(sessions: SessionInfo[]): string {
  let latest = "";
  for (const session of sessions) {
    if (session.modified > latest) latest = session.modified;
  }
  return latest;
}

/**
 * 由全部会话构建项目树。
 *
 * 排序：项目按最近活动降序；唯一例外是无会话的 selectedCwd 空项目——
 * 它是用户当前上下文，置顶保证「刚添加的项目立即可见」。
 */
export function buildSidebarTree(
  sessions: SessionInfo[],
  options: BuildSidebarTreeOptions = {},
): SidebarProjectNode[] {
  const {
    selectedCwd = null,
    selectedProjectRoot = null,
    knownWorktrees = [],
    knownWorktreesByProject = {},
  } = options;

  // 第一遍：按项目根 → （主仓 | worktree 路径）两级分桶。
  const projectBuckets = new Map<string, { main: SessionInfo[]; worktrees: Map<string, SessionBucket> }>();
  for (const session of sessions) {
    const root = session.projectRoot ?? session.cwd;
    let bucket = projectBuckets.get(root);
    if (!bucket) {
      bucket = { main: [], worktrees: new Map() };
      projectBuckets.set(root, bucket);
    }
    if (session.cwd === root) {
      bucket.main.push(session);
    } else {
      let group = bucket.worktrees.get(session.cwd);
      if (!group) {
        group = { sessions: [], branch: null };
        bucket.worktrees.set(session.cwd, group);
      }
      group.sessions.push(session);
      // worktreeBranch 由服务端在「非主 worktree 且有分支」时给出。
      if (!group.branch && session.worktreeBranch) group.branch = session.worktreeBranch;
    }
  }

  // 已加载的 worktree 列表：补齐无会话的非主 worktree 空分组，
  // 让未选中项目以及「创建/切换到空 worktree」后仍可见、可点击。
  const selectedRoot = selectedProjectRoot ?? selectedCwd;
  const worktreesByProject: Readonly<Record<string, readonly KnownWorktree[]>> = selectedRoot
    ? { ...knownWorktreesByProject, [selectedRoot]: knownWorktreesByProject[selectedRoot] ?? knownWorktrees }
    : knownWorktreesByProject;
  for (const [projectRoot, projectWorktrees] of Object.entries(worktreesByProject)) {
    let bucket = projectBuckets.get(projectRoot);
    if (!bucket) {
      bucket = { main: [], worktrees: new Map() };
      projectBuckets.set(projectRoot, bucket);
    }
    for (const worktree of projectWorktrees) {
      if (worktree.isMain) continue; // 主 worktree 隐式，永不产生分组行
      if (!bucket.worktrees.has(worktree.path)) {
        bucket.worktrees.set(worktree.path, { sessions: [], branch: worktree.branch });
      }
    }
  }

  // 选中的空项目（无会话、无 worktree，刚通过「添加项目」加入）：创建空桶，
  // 让项目行可见并可开始新会话（渲染层已支持空态占位）。
  if (selectedRoot && !projectBuckets.has(selectedRoot)) {
    projectBuckets.set(selectedRoot, { main: [], worktrees: new Map() });
  }
  // 用户主动添加的项目：即使无会话、未被选中也持续显示（项目独立于会话存在）。
  for (const root of options.addedProjectRoots ?? []) {
    if (!projectBuckets.has(root)) {
      projectBuckets.set(root, { main: [], worktrees: new Map() });
    }
  }

  const projects: SidebarProjectNode[] = [];
  for (const [root, bucket] of projectBuckets) {
    const worktrees: SidebarWorktreeGroup[] = [...bucket.worktrees.entries()]
      .map(([path, group]) => ({
        path,
        branch: group.branch,
        tree: buildSessionDisplayTree(group.sessions),
        latestActivity: latestModified(group.sessions),
      }))
      .sort((a, b) => {
        // 有会话的组按最近活动降序在前，空组按路径字典序在后（稳定可预期）。
        if (a.latestActivity && b.latestActivity) return b.latestActivity.localeCompare(a.latestActivity);
        if (a.latestActivity) return -1;
        if (b.latestActivity) return 1;
        return a.path.localeCompare(b.path);
      });
    const allSessions = [...bucket.main, ...bucket.worktrees.values().flatMap((group) => group.sessions)];
    projects.push({
      root,
      mainTree: buildSessionDisplayTree(bucket.main),
      worktrees,
      latestActivity: latestModified(allSessions),
    });
  }

  projects.sort((a, b) => {
    // 无会话的选中项目（刚通过「添加项目」进入）置顶；其余按最近活动降序。
    if (!a.latestActivity && !b.latestActivity) return a.root.localeCompare(b.root);
    if (!a.latestActivity) return a.root === selectedRoot ? -1 : 1;
    if (!b.latestActivity) return b.root === selectedRoot ? 1 : -1;
    return b.latestActivity.localeCompare(a.latestActivity);
  });
  return projects;
}

// ── 项目关闭过滤（纯 UI 隐藏，不触碰任何会话数据） ─────────────────────────

/**
 * 从项目树中过滤已关闭项目。closedRoots 为空时原样返回（引用相等）。
 * 只读过滤：返回新数组，项目节点本身复用引用，绝不变异输入。
 */
export function filterClosedProjects(
  projects: SidebarProjectNode[],
  closedRoots: ReadonlySet<string>,
): SidebarProjectNode[] {
  if (closedRoots.size === 0) return projects;
  return projects.filter((project) => !closedRoots.has(project.root));
}

/**
 * 关闭当前项目后的候选项目根：按树的展示顺序取第一个既非被关闭项目、
 * 也不在已关闭集合中的项目；无剩余项目返回 null（调用方据此置空 cwd）。
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
 * 搜索过滤项目树：命中 project 根路径或项目 alias 时保留整个项目；命中
 * worktree 分支/路径时保留整个分组；否则按会话字段逐组过滤，命中 child
 * 时保留完整 project → worktree → session 祖先链。返回全新对象，绝不变异输入。
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
    const mainTree = fulltextMode
      ? filterSessionDisplayTreeByIds(project.mainTree, fulltextMatchIds)
      : filterSessionDisplayTree(project.mainTree, normalizedQuery);
    const worktrees: SidebarWorktreeGroup[] = [];
    for (const group of project.worktrees) {
      if (!fulltextMode) {
        const groupText = `${group.branch ?? ""}\n${group.path}`.toLowerCase();
        if (groupText.includes(normalizedQuery)) {
          worktrees.push(group);
          continue;
        }
      }
      const tree = fulltextMode
        ? filterSessionDisplayTreeByIds(group.tree, fulltextMatchIds)
        : filterSessionDisplayTree(group.tree, normalizedQuery);
      if (tree.length > 0) worktrees.push({ ...group, tree });
    }
    if (mainTree.length > 0 || worktrees.length > 0) {
      result.push({ ...project, mainTree, worktrees });
    }
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
  /** 位于非主 worktree 分组时为该分组路径；主仓会话为 null。 */
  worktreePath: string | null;
  /** 会话级祖先 id 链（自组内根向父，不含自身）。 */
  ancestors: string[];
}

/**
 * 在项目树中定位会话：返回其项目根、所属非主 worktree 分组与会话级祖先链。
 * 找不到返回 null。调用方据此把「已选中但被折叠隐藏」的祖先层级展开。
 */
export function locateSessionInSidebarTree(
  projects: SidebarProjectNode[],
  sessionId: string,
): SidebarSessionLocation | null {
  for (const project of projects) {
    if (project.mainTree.some((node) => node.session.id === sessionId)) {
      return { projectRoot: project.root, worktreePath: null, ancestors: [] };
    }
    const mainAncestors = getDisplayNodeAncestorIds(project.mainTree, sessionId);
    if (mainAncestors.length > 0) {
      return { projectRoot: project.root, worktreePath: null, ancestors: mainAncestors };
    }
    for (const group of project.worktrees) {
      if (group.tree.some((node) => node.session.id === sessionId)) {
        return { projectRoot: project.root, worktreePath: group.path, ancestors: [] };
      }
      const ancestors = getDisplayNodeAncestorIds(group.tree, sessionId);
      if (ancestors.length > 0) {
        return { projectRoot: project.root, worktreePath: group.path, ancestors };
      }
    }
  }
  return null;
}

// ── 折叠集合操作（Collapse all / Expand all 的数据来源） ───────────────────
/**
 * 收集树中全部可折叠 id（Collapse all 写入偏好的内容）。
 * Expand all 无需 helper：直接清空两个集合。
 */
export function collectAllCollapseIds(projects: SidebarProjectNode[]): {
  projectRoots: string[];
  worktreePaths: string[];
} {
  const projectRoots: string[] = [];
  const worktreePaths: string[] = [];
  for (const project of projects) {
    projectRoots.push(project.root);
    for (const group of project.worktrees) worktreePaths.push(group.path);
  }
  return { projectRoots, worktreePaths };
}

/**
 * 收集侧栏树中「默认应收起的 subagent 父会话」id。
 * 覆盖主仓树与各 worktree 组内树；只读、不写偏好。
 */
export function collectSubagentParentIdsFromSidebarTree(
  projects: SidebarProjectNode[],
): string[] {
  const ids: string[] = [];
  for (const project of projects) {
    ids.push(...collectSubagentParentIds(project.mainTree));
    for (const group of project.worktrees) {
      ids.push(...collectSubagentParentIds(group.tree));
    }
  }
  return ids;
}
