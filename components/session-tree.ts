import type { SessionInfo } from "@/lib/types";

/** 子节点与父节点的关系：fork = 普通 Pi 分叉；subagent = 工具结果发现的直接父子。 */
export type SessionRelationKind = "fork" | "subagent";

export interface SessionDisplayNode {
  session: SessionInfo;
  /** 与父节点的关系；根节点为 null（含父缺失/成环降级来的根）。 */
  relation: SessionRelationKind | null;
  children: SessionDisplayNode[];
}

/**
 * 会话展示树：同一父会话下同时嵌套普通 fork 与 subagent 子会话（含嵌套 subagent）。
 *
 * 关系语义与后端契约严格一致，绝不混淆：
 * - **session.parentSessionId（普通 Pi fork）不再建父子关系**：fork 出来的会话是
 *   **独立会话**（可写、有未读、能发送），侧栏平铺显示、与父平级，不嵌套在父行下
 *   （2026-09-22 决定）。此前把它嵌到父行下，会让「同一份标题被复制」的 fork 看起来
 *   像同一个会话显示了好几行。
 * - session.subagent.parentSessionId 只表示工具结果发现的直接父子，不做链式
 *   上溯：父会话不在集合内即降级为根项；
 * - 本函数绝不修改 SessionInfo，更不会把 subagent.parentSessionId 写进
 *   parentSessionId 字段。
 *
 * 子会话不展示（Pidance 针对 Pi 主体，不绑特定插件）：
 * - 所有 session.subagent 标记的会话（pi-subagents 插件产物）在入口整体跳过，
 *   不创建树节点；其嵌套 subagent 后代同样被跳过，一并隐藏；
 * - subagent 下挂的普通 fork 子会话不丢失：沿 parentSessionId 链自动上溯
 *   重挂到集合内最近祖先（fork 链解析天然覆盖）；
 * - 磁盘会话文件、发现逻辑与父会话的 subagent 运行徽标不受影响（本函数
 *   只影响树投影）。
 *
 * 安全降级：父缺失、关系成环（含 fork/subagent 混合环）的节点一律降级为
 * 可访问根项——任何会话都不会从列表中丢失。
 *
 * 排序：同一父节点下 fork 子会话按 modified 降序；根层按 modified 降序。
 */
export function buildSessionDisplayTree(sessions: SessionInfo[]): SessionDisplayNode[] {
  // 子会话不进入展示树（见上注释）：跳过全部 subagent 标记会话。
  // fork 链上溯会自动把挂在 subagent 下的 fork 子会话重挂到最近集合内祖先。
  const displaySessions = sessions.filter((session) => !session.subagent);
  const byId = new Map<string, SessionDisplayNode>();
  for (const session of displaySessions) {
    byId.set(session.id, { session, relation: null, children: [] });
  }

  // fork 不建父子关系（见上）：没有任何节点因 parentSessionId 挂到别的节点下，
  // 所以这里不需要 fork 链解析，也不存在 fork 成环的问题。
  const effectiveParent = new Map<string, { parentId: string; relation: SessionRelationKind }>();

  // 全局环检测：沿生效父链走，重访任意节点即成环（fork 已不参与，纯防御）。
  const createsCycle = (id: string): boolean => {
    const visited = new Set<string>([id]);
    let current = effectiveParent.get(id)?.parentId;
    while (current) {
      if (visited.has(current)) return true;
      visited.add(current);
      current = effectiveParent.get(current)?.parentId;
    }
    return false;
  };

  const roots: SessionDisplayNode[] = [];
  for (const node of byId.values()) {
    const link = effectiveParent.get(node.session.id);
    const parent = link ? byId.get(link.parentId) : undefined;
    if (!link || !parent || createsCycle(node.session.id)) {
      // 父缺失或成环：降级为可访问根项，不丢会话。
      roots.push(node);
      continue;
    }
    node.relation = link.relation;
    parent.children.push(node);
  }

  const byModifiedDesc = (a: SessionDisplayNode, b: SessionDisplayNode) =>
    b.session.modified.localeCompare(a.session.modified);
  const sortLevel = (nodes: SessionDisplayNode[], isRoot: boolean) => {
    if (isRoot) {
      nodes.sort(byModifiedDesc);
    } else {
      // subagent 子会话按 run 次序在前（fork 已不嵌套，不会出现在这里）。
      const subagents = nodes
        .filter((node) => node.relation === "subagent")
        .sort((a, b) => (a.session.subagent?.runIndex ?? 0) - (b.session.subagent?.runIndex ?? 0));
      const forks = nodes.filter((node) => node.relation !== "subagent").sort(byModifiedDesc);
      nodes.splice(0, nodes.length, ...subagents, ...forks);
    }
    for (const node of nodes) sortLevel(node.children, false);
  };
  sortLevel(roots, true);
  return roots;
}

// ── 会话搜索 ──────────────────────────────────────────────────────────────

/** 查询归一化：搜索入口统一先经此处理，再传入 matches/filter 系列 helper。 */
export function normalizeSessionQuery(query: string): string {
  return query.trim().toLowerCase();
}

/** 会话的可搜索文本：name、firstMessage、id、subagent agent/run。 */
function sessionSearchableText(session: SessionInfo): string {
  const parts: string[] = [
    session.name ?? "",
    session.firstMessage,
    session.id,
  ];
  if (session.subagent) {
    parts.push(session.subagent.agent ?? "", session.subagent.runId);
    // 同时支持 "run 3"、"run-3" 与纯数字 "3" 三种直觉输入。
    parts.push(`run ${session.subagent.runIndex}`, `run-${session.subagent.runIndex}`, String(session.subagent.runIndex));
  }
  return parts.join("\n").toLowerCase();
}

export function sessionMatchesQuery(session: SessionInfo, normalizedQuery: string): boolean {
  if (!normalizedQuery) return true;
  return sessionSearchableText(session).includes(normalizedQuery);
}

/**
 * 搜索过滤展示树：命中节点保留，命中 child 时保留完整祖先链。
 * 返回全新节点对象（children 为新数组），绝不变异原树。
 */
export function filterSessionDisplayTree(
  nodes: SessionDisplayNode[],
  normalizedQuery: string,
): SessionDisplayNode[] {
  if (!normalizedQuery) return nodes;
  const result: SessionDisplayNode[] = [];
  for (const node of nodes) {
    const children = filterSessionDisplayTree(node.children, normalizedQuery);
    if (sessionMatchesQuery(node.session, normalizedQuery) || children.length > 0) {
      result.push({ ...node, children });
    }
  }
  return result;
}

/**
 * 节点在展示树中的祖先 id 链（不含自身，自根向父排序）；未找到返回空数组。
 * 用于选中/URL 恢复时自动展开祖先，不触碰用户的折叠偏好集合。
 */
export function getDisplayNodeAncestorIds(nodes: SessionDisplayNode[], targetId: string): string[] {
  const walk = (level: SessionDisplayNode[], trail: string[]): string[] | null => {
    for (const node of level) {
      if (node.session.id === targetId) return trail;
      const found = walk(node.children, [...trail, node.session.id]);
      if (found) return found;
    }
    return null;
  };
  return walk(nodes, []) ?? [];
}

/**
 * 折叠判定：搜索期间匹配路径强制展开，但只读折叠集合、不写入——
 * 清空搜索后用户的折叠偏好原样恢复。
 */
export function isSessionNodeEffectivelyCollapsed(
  collapsedIds: ReadonlySet<string>,
  sessionId: string,
  searchActive: boolean,
): boolean {
  return searchActive ? false : collapsedIds.has(sessionId);
}

