import type { SessionInfo } from "./types";

/**
 * 顶栏子会话谱系（纯函数，浏览器侧共用）。
 *
 * 只认 subagent 关系（工具结果发现的直接父子），不把 Pi fork
 * （SessionInfo.parentSessionId）算进谱系：fork 有自己的分支树入口。
 */

const MAX_DESCENDANTS = 512;
const DEFAULT_TITLE_LENGTH = 32;

/** parentId → 直接子会话 */
export type LineageIndex = Map<string, SessionInfo[]>;

export type LineageNode = {
  session: SessionInfo;
  /** 相对根会话的层级，直接子会话为 1 */
  depth: number;
};

export function subagentParentId(session: SessionInfo): string | null {
  return session.subagent?.parentSessionId ?? null;
}

/** 按父会话分组；同级按 modified 倒序（同时间按 id，保证渲染稳定）。 */
export function buildLineageIndex(sessions: readonly SessionInfo[]): LineageIndex {
  const index: LineageIndex = new Map();
  for (const session of sessions) {
    const parentId = subagentParentId(session);
    if (!parentId || parentId === session.id) continue;
    const bucket = index.get(parentId);
    if (bucket) bucket.push(session);
    else index.set(parentId, [session]);
  }
  for (const bucket of index.values()) {
    bucket.sort((a, b) => b.modified.localeCompare(a.modified) || a.id.localeCompare(b.id));
  }
  return index;
}

/**
 * 谱系根 → 当前会话的链（含两端）。
 * 父会话缺失（已删除）或成环时，在断点截断而不是丢整条链。
 */
export function lineagePath(sessions: readonly SessionInfo[], currentId: string): SessionInfo[] {
  const byId = new Map(sessions.map((session) => [session.id, session]));
  const chain: SessionInfo[] = [];
  const seen = new Set<string>();
  let current = byId.get(currentId);
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    chain.push(current);
    const parentId = subagentParentId(current);
    current = parentId ? byId.get(parentId) : undefined;
  }
  return chain.reverse();
}

/** 后代按父在子前的顺序展开（前序遍历），防环、限量。 */
export function collectLineageDescendants(index: LineageIndex, rootId: string): LineageNode[] {
  const out: LineageNode[] = [];
  const seen = new Set<string>([rootId]);
  const stack: LineageNode[] = [];
  const pushChildren = (parentId: string, depth: number) => {
    const children = index.get(parentId) ?? [];
    for (let i = children.length - 1; i >= 0; i -= 1) stack.push({ session: children[i], depth });
  };
  pushChildren(rootId, 1);
  while (stack.length > 0 && out.length < MAX_DESCENDANTS) {
    const node = stack.pop()!;
    if (seen.has(node.session.id)) continue;
    seen.add(node.session.id);
    out.push(node);
    pushChildren(node.session.id, node.depth + 1);
  }
  return out;
}

/** 折叠感知的可见行（前序）：折叠节点本身保留，跳过其后代。 */
export function visibleLineageNodes(
  index: LineageIndex,
  rootId: string,
  collapsed: ReadonlySet<string>,
): LineageNode[] {
  const out: LineageNode[] = [];
  const seen = new Set<string>([rootId]);
  const walk = (parentId: string, depth: number) => {
    for (const child of index.get(parentId) ?? []) {
      if (out.length >= MAX_DESCENDANTS) return;
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      out.push({ session: child, depth });
      if (!collapsed.has(child.id)) walk(child.id, depth + 1);
    }
  };
  walk(rootId, 1);
  return out;
}

/** 首条消息缺失时服务端写下的占位符（子代理会话都是这个）。 */
const MISSING_FIRST_MESSAGE = "(no messages)";
/**
 * 顶栏面包屑的可见段：窄屏超过两段时只留首尾，中间用 "gap" 占位
 * （否则段名会把当前会话挤出可视区）。
 */
export function visibleCrumbEntries(
  crumbs: readonly SessionInfo[],
  options: { compact: boolean },
): Array<SessionInfo | "gap"> {
  if (!options.compact || crumbs.length <= 2) return [...crumbs];
  return [crumbs[0], "gap", crumbs[crumbs.length - 1]];
}

/** 顶栏短标题：name → 首条消息首行 → id（与 CommandPalette 同一约定），单行截断。 */
/** 单行截断：超长时保留 maxLength-1 个字符 + 省略号。 */
export function truncateTitle(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(1, maxLength - 1))}…`;
}

export function shortSessionTitle(session: SessionInfo, maxLength = DEFAULT_TITLE_LENGTH): string {
  // 子代理会话的服务端投影没有 name、firstMessage 是占位符，直接退回 id
  // （下拉行与子会话页头优先用 run step 的 label/agent，见 SessionLineage）。
  const fallbackMessage = session.subagent ? "" : session.firstMessage;
  const source = session.name?.trim()
    || (fallbackMessage.trim() === MISSING_FIRST_MESSAGE ? "" : fallbackMessage)
    || session.id;
  const firstLine = source
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  return truncateTitle(firstLine || session.id, maxLength);
}
