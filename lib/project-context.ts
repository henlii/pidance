import type { SessionInfo } from "@/lib/types";

export interface ProjectSessionTreeNode {
  session: SessionInfo;
  children: ProjectSessionTreeNode[];
}

export interface WorktreeEntry {
  path: string;
  branch: string | null;
  isMain: boolean;
}

export interface WorktreeState {
  forCwd: string;
  projectRoot: string;
  isGit: boolean;
  isTopLevel: boolean;
  worktrees: WorktreeEntry[];
}

export function getRecentProjects(sessions: SessionInfo[]): string[] {
  const latest = new Map<string, string>();
  for (const session of sessions) {
    const root = session.projectRoot ?? session.cwd;
    const previous = latest.get(root);
    if (!previous || session.modified > previous) latest.set(root, session.modified);
  }
  return [...latest.entries()].sort((a, b) => b[1].localeCompare(a[1])).map(([root]) => root);
}

export function displayCwd(cwd: string, homeDir?: string): string {
  if (!homeDir) return cwd;
  const normalizedCwd = cwd.replaceAll("\\", "/");
  const normalizedHome = homeDir.replaceAll("\\", "/").replace(/\/$/, "");
  if (normalizedCwd === normalizedHome) return "~";
  if (normalizedCwd.startsWith(`${normalizedHome}/`)) return `~${normalizedCwd.slice(normalizedHome.length)}`;
  return cwd;
}

/** 项目显示名：取路径最后一段文件夹名（添加项目默认名；alias 优先于它）。 */
export function projectDisplayName(root: string): string {
  const clean = root.replaceAll("\\", "/").replace(/\/+$/, "");
  const idx = clean.lastIndexOf("/");
  const name = idx >= 0 ? clean.slice(idx + 1) : clean;
  return name || root;
}

export function buildSessionTree(sessions: SessionInfo[]): ProjectSessionTreeNode[] {
  const byId = new Map<string, ProjectSessionTreeNode>();
  for (const session of sessions) byId.set(session.id, { session, children: [] });
  const parentOf = new Map<string, string>();
  for (const session of sessions) if (session.parentSessionId) parentOf.set(session.id, session.parentSessionId);

  function resolveAncestor(id: string): string | null {
    let current = parentOf.get(id);
    const visited = new Set<string>();
    const chain: string[] = [];
    while (current) {
      if (visited.has(current) || current === id) return null;
      visited.add(current);
      chain.push(current);
      current = parentOf.get(current);
    }
    return chain.find((ancestor) => byId.has(ancestor)) ?? null;
  }

  const roots: ProjectSessionTreeNode[] = [];
  for (const node of byId.values()) {
    const ancestor = resolveAncestor(node.session.id);
    if (ancestor) byId.get(ancestor)!.children.push(node);
    else roots.push(node);
  }
  const sort = (nodes: ProjectSessionTreeNode[]) => {
    nodes.sort((a, b) => b.session.modified.localeCompare(a.session.modified));
    for (const node of nodes) sort(node.children);
  };
  sort(roots);
  return roots;
}

export type ProjectIdentityStatus = "idle" | "validating" | "ready" | "error";
export interface ProjectIdentitySnapshot {
  status: ProjectIdentityStatus;
  error: string | null;
  cwd: string | null;
  projectRoot: string | null;
  branch: string | null;
  isGit: boolean;
  isTopLevel: boolean;
}
export interface ProjectStoreInitial {
  identity?: Partial<ProjectIdentitySnapshot>;
}
type Listener = () => void;

const defaultIdentity: ProjectIdentitySnapshot = { status: "idle", error: null, cwd: null, projectRoot: null, branch: null, isGit: false, isTopLevel: false };

function normalizeIdentity(identity: ProjectIdentitySnapshot): ProjectIdentitySnapshot {
  if (identity.cwd !== null && identity.projectRoot !== null) return identity;
  return {
    ...identity,
    cwd: null,
    projectRoot: null,
    branch: null,
    isGit: false,
    isTopLevel: false,
  };
}

function sameIdentity(a: ProjectIdentitySnapshot, b: ProjectIdentitySnapshot): boolean {
  return a.status === b.status
    && a.error === b.error
    && a.cwd === b.cwd
    && a.projectRoot === b.projectRoot
    && a.branch === b.branch
    && a.isGit === b.isGit
    && a.isTopLevel === b.isTopLevel;
}

export function createProjectStore(initial: ProjectStoreInitial = {}) {
  let identity = normalizeIdentity({ ...defaultIdentity, ...initial.identity });
  const identityListeners = new Set<Listener>();
  let identitySnapshot = identity;
  const notifyIdentity = () => identityListeners.forEach((listener) => listener());
  const setIdentity = (patch: Partial<ProjectIdentitySnapshot>) => {
    const nextPatch = patch.cwd !== undefined && patch.projectRoot === undefined
      ? { ...patch, projectRoot: patch.cwd }
      : patch;
    const next = normalizeIdentity({ ...identity, ...nextPatch });
    if (sameIdentity(identity, next)) return;
    identity = next;
    identitySnapshot = identity;
    notifyIdentity();
  };
  const reset = () => {
    const identityChanged = !sameIdentity(identity, defaultIdentity);
    identity = defaultIdentity;
    identitySnapshot = identity;
    if (identityChanged) notifyIdentity();
  };
  return {
    getIdentitySnapshot: () => identitySnapshot,
    subscribeIdentity: (listener: Listener) => { identityListeners.add(listener); return () => identityListeners.delete(listener); },
    setIdentity, reset,
  };
}
