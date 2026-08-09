import { closeSync, openSync, readSync, statSync } from "fs";
import { normalize as normalizePath } from "path";
import type { AgentMessage, SessionEntry, SessionHeader, SessionInfo, SessionContext } from "./types";
import {
  scanSessionFiles,
  scanSessionFileFast,
  loadSessionMetadataCache,
  scheduleSessionMetadataCacheSave,
  type CachedSessionInfo,
  type CachedDiscoveredChild,
  type SessionCacheRecord,
  type DiscoveryCacheRecord,
} from "./session-metadata-cache";
import { normalizeToolCalls } from "./normalize";
import {
  PIDANCE_ACTIVITY_CUSTOM_TYPE,
  activityToUiMessage,
  parseActivityData,
} from "./session-activity";
import { resolveProject, type ProjectInfo } from "./worktree";
import { discoverSubagentSessions } from "./subagent-sessions";
import { getAgentDir } from "./pi-paths";
import { openSessionFile } from "./session-file";

export { getAgentDir };

/** 本地 entry 形状（不再依赖 pi-coding-agent 类型） */
type PiSessionEntry = {
  id: string;
  type: string;
  parentId?: string | null;
  message?: unknown;
  [key: string]: unknown;
};

export function markExistingSubagentRelation(
  session: SessionInfo,
  child: CachedDiscoveredChild,
): SessionInfo {
  session.subagent = {
    parentSessionId: child.parentSessionId,
    runId: child.runId,
    runIndex: child.runIndex,
    ...(child.agent ? { agent: child.agent } : {}),
  };
  session.readOnly = true;
  return session;
}

async function loadAllSessions(): Promise<SessionInfo[]> {
  // 磁盘元数据缓存（OpenChamber persist-cache 语义的服务端对应）：
  // 顶层会话文件按 (path, mtimeMs, size) 键控，命中则免读免解析；
  // 只有变更/新增文件走轻量流式扫描（scanSessionFileFast）。
  const files = await scanSessionFiles();
  const diskCache = loadSessionMetadataCache();
  const sessionRecords = new Map<string, SessionCacheRecord>();
  if (diskCache) {
    for (const [path, record] of Object.entries(diskCache.sessions)) {
      sessionRecords.set(path, record);
    }
  }

  const changedFiles = files.filter((f) => {
    const record = sessionRecords.get(f.path);
    return !record || record.m !== f.mtimeMs || record.s !== f.size;
  });
  let cacheDirty = changedFiles.length > 0;

  // 并发轻量扫描变更文件（readline 流式，不整读；大文件不阻塞事件循环）。
  const freshInfos = new Map<string, CachedSessionInfo>();
  await Promise.all(
    changedFiles.map(async (f) => {
      const info = await scanSessionFileFast(f.path, f);
      if (info) freshInfos.set(f.path, info);
    }),
  );
  for (const f of changedFiles) {
    const info = freshInfos.get(f.path);
    if (!info) {
      // 非会话文件（header 缺失/损坏）不再缓存，避免重复扫描
      sessionRecords.delete(f.path);
      continue;
    }
    sessionRecords.set(f.path, { m: f.mtimeMs, s: f.size, i: info });
  }
  // 磁盘上有而磁盘中已删除的文件：从记录中剔除
  const livePaths = new Set(files.map((f) => f.path));
  let removed = 0;
  for (const path of [...sessionRecords.keys()]) {
    if (!livePaths.has(path)) {
      sessionRecords.delete(path);
      removed++;
    }
  }
  if (removed > 0) cacheDirty = true;

  const piSessions: Array<{
    path: string;
    id: string;
    cwd: string;
    name?: string;
    parentSessionPath?: string;
    created: string;
    modified: string;
    messageCount: number;
    firstMessage: string;
  }> = [...sessionRecords.entries()]
    .map(([path, record]) => ({ path, ...record.i }))
    .filter((info): info is (typeof info & { path: string; id: string }) => Boolean(info && info.id));

  const pathToId = new Map<string, string>();
  const idToPath = new Map<string, string>();
  for (const s of piSessions) {
    const path = normalizePath(s.path);
    if (!pathToId.has(path) && !idToPath.has(s.id)) {
      pathToId.set(path, s.id);
      idToPath.set(s.id, path);
    }
  }

  // Resolve each unique cwd to its project root (main repo shared by all
  // worktrees). resolveProject caches per-cwd, so this is cheap after warmup.
  const uniqueCwds = [...new Set(piSessions.map((s) => s.cwd).filter(Boolean))];
  const projectByCwd = new Map<string, ProjectInfo>();
  await Promise.all(uniqueCwds.map(async (cwd) => {
    projectByCwd.set(cwd, await resolveProject(cwd));
  }));

  const resultPaths = new Set<string>();
  const resultIds = new Set<string>();
  const sessions: SessionInfo[] = piSessions
    .sort((a, b) => (a.modified < b.modified ? 1 : a.modified > b.modified ? -1 : 0))
    .flatMap((s): SessionInfo[] => {
      const path = normalizePath(s.path);
      if (resultPaths.has(path) || resultIds.has(s.id)) return [];
      resultPaths.add(path); resultIds.add(s.id);
      cacheSessionPath(s.id, s.path);
      const project = s.cwd ? projectByCwd.get(s.cwd) : undefined;
      return [{
        path: s.path,
        id: s.id,
        cwd: s.cwd,
        name: s.name,
        created: s.created,
        modified: s.modified,
        messageCount: s.messageCount,
        firstMessage: s.firstMessage || "(no messages)",
        parentSessionId: s.parentSessionPath ? pathToId.get(normalizePath(s.parentSessionPath)) : undefined,
        projectRoot: project?.projectRoot ?? s.cwd,
        ...(project?.isWorktree && project.branch ? { worktreeBranch: project.branch } : {}),
      }];
    });

  const existingByPath = new Map(sessions.map((session) => [normalizePath(session.path), session]));
  const existingById = new Map(sessions.map((session) => [session.id, session]));
  const acceptedChildPaths = new Set<string>();
  const acceptedChildIds = new Set<string>();
  const subagents: Array<{ child: CachedDiscoveredChild }> = [];
  const discoveryRecords = new Map<string, DiscoveryCacheRecord>();
  if (diskCache) {
    for (const [path, record] of Object.entries(diskCache.discovery)) {
      discoveryRecords.set(path, record);
    }
  }
  const queue = sessions.map((parent) => ({ parent, depth: 0 }));
  while (queue.length && acceptedChildIds.size < 256) {
    const current = queue.shift()!;
    if (current.depth >= 16) continue;
    const children = getCachedDiscovery(current.parent.path, current.parent.id, discoveryRecords, sessionRecords, (path, id) => {
      cacheDirty = true;
      return discoverSubagentSessions(path, id).map((c) => ({
        path: c.path,
        id: c.header.id,
        cwd: c.header.cwd,
        timestamp: c.header.timestamp,
        parentSessionId: c.parentSessionId,
        runId: c.runId,
        runIndex: c.runIndex,
        ...(c.agent ? { agent: c.agent } : {}),
      }));
    });
    for (const child of children) {
      const path = normalizePath(child.path);
      if (acceptedChildPaths.has(path) || acceptedChildIds.has(child.id)) continue;
      acceptedChildPaths.add(path); acceptedChildIds.add(child.id);
      const existingByPathEntry = existingByPath.get(path);
      const existingByIdEntry = existingById.get(child.id);
      if ((existingByPathEntry && existingByPathEntry.id !== child.id) ||
        (existingByIdEntry && normalizePath(existingByIdEntry.path) !== path)) continue;
      const existing = existingByPathEntry ?? existingByIdEntry;
      if (existing) {
        markExistingSubagentRelation(existing, child);
        queue.push({ parent: existing, depth: current.depth + 1 });
        continue;
      }
      if (resultPaths.has(path) || resultIds.has(child.id)) continue;
      resultPaths.add(path);
      resultIds.add(child.id);
      pathToId.set(path, child.id);
      subagents.push({ child });
      queue.push({ parent: {
        path: child.path, id: child.id, cwd: child.cwd, created: child.timestamp,
        modified: child.timestamp, messageCount: 0, firstMessage: "(no messages)", projectRoot: child.cwd,
      }, depth: current.depth + 1 });
    }
  }
  const childInfos = await Promise.all(subagents.map(async ({ child }) => {
    const project = await resolveProject(child.cwd);
    let modified = child.timestamp;
    try { modified = statSync(child.path).mtime.toISOString(); } catch { /* 使用 header 时间 */ }
    cacheSessionPath(child.id, child.path);
    return {
      path: child.path,
      id: child.id,
      cwd: child.cwd,
      created: child.timestamp,
      modified,
      messageCount: 0,
      firstMessage: "(no messages)",
      projectRoot: project?.projectRoot ?? child.cwd,
      ...(project?.isWorktree && project.branch ? { worktreeBranch: project.branch } : {}),
      subagent: { parentSessionId: child.parentSessionId, runId: child.runId, runIndex: child.runIndex, ...(child.agent ? { agent: child.agent } : {}) },
      readOnly: true as const,
    } satisfies SessionInfo;
  }));

  if (cacheDirty) {
    scheduleSessionMetadataCacheSave(sessionRecords, discoveryRecords);
  }
  return [...sessions, ...childInfos];
}

/**
 * subagent 发现的磁盘缓存：子会话文件不在顶层扫描里，但同样按
 * (path, mtimeMs, size) 键控，避免每次列表扫描都对每个 parent 重新
 * 读文件/扫目录（之前 ~400ms 全量成本的主要来源之一）。
 */
function getCachedDiscovery(
  parentPath: string,
  parentId: string,
  discoveryRecords: Map<string, DiscoveryCacheRecord>,
  sessionRecords: Map<string, SessionCacheRecord>,
  discover: (path: string, id: string) => CachedDiscoveredChild[],
): CachedDiscoveredChild[] {
  try {
    const st = statSync(parentPath);
    const record = discoveryRecords.get(parentPath);
    if (record && record.m === st.mtimeMs && record.s === st.size) {
      return record.c;
    }
    // 父文件变更/新增：重新发现并更新缓存记录（含 mtime/size 锚）
    const children = discover(parentPath, parentId);
    discoveryRecords.set(parentPath, { m: st.mtimeMs, s: st.size, c: children });
    return children;
  } catch {
    // 父文件不可 stat（已删除）：清掉缓存记录，返回空
    discoveryRecords.delete(parentPath);
    return [];
  }
}

export async function listAllSessions(): Promise<SessionInfo[]> {
  const generation = globalThis.__piSessionListGeneration ?? 0;

  // Return cached result if still fresh (avoids re-scanning session files
  // and re-spawning git processes on every page load).
  if (globalThis.__piSessionListCache && Date.now() - globalThis.__piSessionListCache.ts < SESSION_LIST_CACHE_TTL_MS) {
    return globalThis.__piSessionListCache.data;
  }

  // Coalescing dedup: concurrent callers share the same in-flight promise
  // only while it belongs to the current cache generation.
  if (globalThis.__piSessionListPromise && globalThis.__piSessionListPromiseGeneration === generation) {
    return globalThis.__piSessionListPromise;
  }

  const loadPromise = loadAllSessions().then((data) => {
    // An invalidation may happen while the scan is in flight. Do not let that
    // older result repopulate the cache after a session mutation.
    if ((globalThis.__piSessionListGeneration ?? 0) === generation) {
      globalThis.__piSessionListCache = { data, ts: Date.now() };
    }
    return data;
  });
  const trackedPromise = loadPromise.finally(() => {
    if (globalThis.__piSessionListPromise === trackedPromise) {
      globalThis.__piSessionListPromise = undefined;
      globalThis.__piSessionListPromiseGeneration = undefined;
    }
  });

  globalThis.__piSessionListPromise = trackedPromise;
  globalThis.__piSessionListPromiseGeneration = generation;
  return trackedPromise;
}

// ============================================================================
// Session path caches, stored in globalThis for hot-reload safety.
// ============================================================================
declare global {
  var __piSessionPathCache: Map<string, string> | undefined;
  var __piPathToSessionIdCache: Map<string, string> | undefined;
  var __piSessionListPromise: Promise<SessionInfo[]> | undefined;
  var __piSessionListPromiseGeneration: number | undefined;
  var __piSessionListGeneration: number | undefined;
  var __piSessionListCache: { data: SessionInfo[]; ts: number } | undefined;
}

const SESSION_LIST_CACHE_TTL_MS = 30_000;

export function invalidateSessionListCache(): void {
  globalThis.__piSessionListGeneration = (globalThis.__piSessionListGeneration ?? 0) + 1;
  globalThis.__piSessionListCache = undefined;
}

function getPathCache(): Map<string, string> {
  if (!globalThis.__piSessionPathCache) globalThis.__piSessionPathCache = new Map();
  return globalThis.__piSessionPathCache;
}

function getPathToIdCache(): Map<string, string> {
  if (!globalThis.__piPathToSessionIdCache) globalThis.__piPathToSessionIdCache = new Map();
  return globalThis.__piPathToSessionIdCache;
}

export async function resolveSessionPath(sessionId: string): Promise<string | null> {
  const cached = getPathCache().get(sessionId);
  if (cached) return cached;

  // Cache miss: scan all sessions to populate cache, then retry
  await listAllSessions();
  return getPathCache().get(sessionId) ?? null;
}

export async function resolveSessionIdByPath(filePath: string): Promise<string | undefined> {
  const pathKey = normalizePath(filePath);
  const cached = getPathToIdCache().get(pathKey);
  if (cached) return cached;

  await listAllSessions();
  return getPathToIdCache().get(pathKey);
}

export function cacheSessionPath(sessionId: string, filePath: string): void {
  const pathKey = normalizePath(filePath);
  const pathCache = getPathCache();
  const reverseCache = getPathToIdCache();
  const previousPath = pathCache.get(sessionId);
  const previousSessionId = reverseCache.get(pathKey);
  if (previousPath && previousPath !== pathKey && reverseCache.get(previousPath) === sessionId) {
    reverseCache.delete(previousPath);
  }
  if (previousSessionId && previousSessionId !== sessionId && pathCache.get(previousSessionId) === pathKey) {
    pathCache.delete(previousSessionId);
  }
  pathCache.set(sessionId, pathKey);
  reverseCache.set(pathKey, sessionId);
}

export function invalidateSessionPathCache(sessionId: string): void {
  const pathCache = getPathCache();
  const reverseCache = getPathToIdCache();
  const filePath = pathCache.get(sessionId);
  pathCache.delete(sessionId);
  if (filePath && reverseCache.get(filePath) === sessionId) {
    reverseCache.delete(filePath);
  }
}

export function readSessionHeader(filePath: string): SessionHeader | null {
  const fd = openSync(filePath, "r");
  try {
    const chunks: Buffer[] = [];
    const maxHeaderBytes = 64 * 1024;
    let position = 0;
    let foundNewline = false;

    while (position < maxHeaderBytes && !foundNewline) {
      const buffer = Buffer.allocUnsafe(Math.min(4096, maxHeaderBytes - position));
      const bytesRead = readSync(fd, buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      const data = buffer.subarray(0, bytesRead);
      const newlineIndex = data.indexOf(0x0a);
      chunks.push(newlineIndex === -1 ? data : data.subarray(0, newlineIndex));
      position += bytesRead;
      foundNewline = newlineIndex !== -1;
    }

    if (!foundNewline && position >= maxHeaderBytes) return null;
    const firstLine = Buffer.concat(chunks).toString("utf8").trimEnd();
    if (!firstLine) return null;
    try {
      const header = JSON.parse(firstLine) as SessionHeader;
      return header.type === "session" ? header : null;
    } catch {
      return null;
    }
  } finally {
    closeSync(fd);
  }
}

export function getSessionEntries(filePath: string): SessionEntry[] {
  const entries = openSessionFile(filePath).getEntries();
  return entries as unknown as SessionEntry[];
}

/**
 * 只读 GET 用的 SessionManager 视图（磁盘 open 或 live wrapper 的 inner.sessionManager）。
 * 不创建 AgentSession，不写盘。
 */
export type SessionManagerReadView = {
  getEntries(): unknown[];
  getLeafId(): string | null;
  getTree(): Array<{
    entry: { id: string; type: string };
    children: unknown[];
    label?: string;
  }>;
  getHeader(): SessionHeader | null | undefined;
  getSessionName(): string | undefined;
};

export type LiveSessionReadSource = {
  isAlive(): boolean;
  inner: { sessionManager: SessionManagerReadView };
};

/**
 * 选择 sessions GET 的权威读视图：
 * - 有存活 live 且含 inner.sessionManager 时用 live（inprocess 遗留）
 * - 否则 openSessionFile（自有 JSONL，不依赖 pi npm）
 * 不 start 新会话、不 mutate live 状态。
 */
export function resolveSessionManagerForRead(options: {
  filePath: string;
  liveSession?: LiveSessionReadSource | null;
  openFromDisk?: (filePath: string) => SessionManagerReadView;
}): SessionManagerReadView {
  const live = options.liveSession;
  if (live?.isAlive() && live.inner?.sessionManager) {
    return live.inner.sessionManager;
  }
  const open =
    options.openFromDisk ??
    ((path: string) => {
      const sm = openSessionFile(path);
      // SessionFile 无 getTree：用 entries 拼浅树
      return {
        getEntries: () => sm.getEntries(),
        getLeafId: () => sm.getLeafId(),
        getTree: () => buildShallowTreeFromEntries(sm.getEntries()),
        getHeader: () => sm.getHeader(),
        getSessionName: () => sm.getSessionName(),
      } as SessionManagerReadView;
    });
  return open(options.filePath);
}

/** 从扁平 entries 建浅树（parentId 链），供导航投影 */
function buildShallowTreeFromEntries(
  entries: Array<{ id: string; type: string; parentId?: string | null; [k: string]: unknown }>,
): Array<{ entry: { id: string; type: string }; children: unknown[]; label?: string }> {
  const byId = new Map<string, { entry: { id: string; type: string }; children: unknown[]; label?: string }>();
  const roots: Array<{ entry: { id: string; type: string }; children: unknown[]; label?: string }> = [];
  for (const e of entries) {
    if (!e?.id) continue;
    byId.set(e.id, { entry: { id: e.id, type: e.type }, children: [] });
  }
  for (const e of entries) {
    if (!e?.id) continue;
    const node = byId.get(e.id)!;
    if (e.type === "label" && typeof e.label === "string" && typeof e.targetId === "string") {
      const target = byId.get(e.targetId as string);
      if (target) target.label = e.label as string;
    }
    const parentId = e.parentId;
    if (parentId && byId.has(parentId)) {
      byId.get(parentId)!.children.push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
}

/**
 * 从权威 SessionManager 构建导航投影（derived leaf + strip label + shallow tree + context）。
 */
export function buildSessionNavigationSnapshot(
  sm: SessionManagerReadView,
  options: { deferThinking?: boolean; deferToolResultImages?: boolean } = {},
): {
  entries: SessionEntry[];
  leafId: string | null;
  tree: ReturnType<typeof projectTreeForResponse>;
  context: SessionContext;
  header: SessionHeader | null | undefined;
  sessionName: string | undefined;
} {
  const entries = sm.getEntries() as SessionEntry[];
  const leafId = resolveNavigationLeafId(
    entries as Array<{ id: string; type: string; parentId: string | null }>,
    sm.getLeafId(),
  );
  const tree = projectTreeForResponse(
    stripLabelMetadataNodes(sm.getTree() as Parameters<typeof stripLabelMetadataNodes>[0]),
  );
  const context = buildSessionContext(entries, leafId, options);
  return {
    entries,
    leafId,
    tree,
    context,
    header: sm.getHeader(),
    sessionName: sm.getSessionName(),
  };
}

// BranchNavigator still traverses recursively, so keep the response tree shallow.
const MAX_PROJECTED_TREE_DEPTH = 200;

/**
 * SDK 的 label entry 会推进 leaf，且出现在 getTree 中。
 * 导航 API 将尾部连续 label 元数据上溯到第一个非 label 祖先，
 * 作为 BranchNavigator 的 active leaf（书签附着在 target 上，不是新分支）。
 */
export function resolveNavigationLeafId(
  entries: ReadonlyArray<{ id: string; type: string; parentId: string | null }>,
  leafId: string | null | undefined,
): string | null {
  if (leafId == null) return null;
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  let current = byId.get(leafId);
  if (!current) return leafId;
  while (current?.type === "label") {
    if (!current.parentId) return null;
    current = byId.get(current.parentId);
  }
  return current?.id ?? null;
}

/**
 * 从导航树中移除 type=label 元数据节点，将其子节点提升到父级。
 * 目标 entry 上的 node.label（由 SessionManager.getTree 解析）保持不变；
 * JSONL 中的历史 label entry 不删除。
 */
export function stripLabelMetadataNodes<T extends {
  entry: { id: string; type: string };
  children: T[];
}>(nodes: T[]): T[] {
  const hoist = (children: T[]): T[] => {
    const result: T[] = [];
    for (const child of children) {
      if (child.entry.type === "label") {
        result.push(...hoist(child.children));
      } else {
        result.push({
          ...child,
          children: hoist(child.children),
        });
      }
    }
    return result;
  };
  return hoist(nodes);
}

/** 有书签 label 的节点不得在投影中被压缩掉。 */
export function hasBookmarkLabel(node: { label?: string }): boolean {
  return typeof node.label === "string" && node.label.length > 0;
}

/**
 * 将会话树投影为发给客户端的浅导航树。
 * 保留根、分支点、叶子与带 label 的书签目标；压缩无 label 的单子链。
 * 被压缩的 entry id 挂到下一可见节点，便于 UI 识别链内活跃 leaf。
 * 调用方应先 stripLabelMetadataNodes，避免 label 元数据成为可点击假分支。
 */
export function projectTreeForResponse<T extends {
  entry: { id: string };
  children: T[];
  label?: string;
  compressedEntryIds?: string[];
}>(
  nodes: T[]
): T[] {
  const keep = new Set<T>();
  const roots = new Set(nodes);
  const seen = new Set<T>();
  const stack = [...nodes];

  while (stack.length > 0) {
    const node = stack.pop()!;
    if (seen.has(node)) continue;
    seen.add(node);

    if (
      roots.has(node) ||
      node.children.length !== 1 ||
      hasBookmarkLabel(node)
    ) {
      keep.add(node);
    }

    for (const child of node.children) {
      stack.push(child);
    }
  }

  const cloneNode = (node: T, compressedEntryIds?: string[]): T => ({
    ...node,
    children: [],
    ...(compressedEntryIds?.length ? { compressedEntryIds } : {}),
  });
  const projectedRoots = nodes.map((node) => cloneNode(node));
  const tasks = nodes.map((source, index) => ({
    source,
    projected: projectedRoots[index],
    depth: 1,
  }));

  const appendFlattenedKeptDescendants = (source: T, projectedParent: T) => {
    const pending = [{ node: source, compressedEntryIds: [] as string[] }];
    const flattenedSeen = new Set<T>();

    while (pending.length > 0) {
      const { node, compressedEntryIds } = pending.pop()!;
      if (flattenedSeen.has(node)) continue;
      flattenedSeen.add(node);

      if (keep.has(node)) {
        projectedParent.children.push(cloneNode(node, compressedEntryIds));
      }

      for (let i = node.children.length - 1; i >= 0; i--) {
        pending.push({
          node: node.children[i],
          compressedEntryIds: keep.has(node)
            ? []
            : [...compressedEntryIds, node.entry.id],
        });
      }
    }
  };

  while (tasks.length > 0) {
    const { source, projected, depth } = tasks.pop()!;

    for (const sourceChild of source.children) {
      let child = sourceChild;

      if (depth >= MAX_PROJECTED_TREE_DEPTH) {
        appendFlattenedKeptDescendants(child, projected);
        continue;
      }

      const compressedEntryIds: string[] = [];
      while (!keep.has(child) && child.children.length === 1) {
        compressedEntryIds.push(child.entry.id);
        child = child.children[0];
      }

      if (!keep.has(child)) {
        continue;
      }

      const projectedChild = cloneNode(child, compressedEntryIds);
      projected.children.push(projectedChild);
      tasks.push({ source: child, projected: projectedChild, depth: depth + 1 });
    }
  }

  return projectedRoots;
}

/**
 * 从 entries 构建 root→leaf 路径（不依赖 pi npm）。
 * leafId 缺省时取文件中最后一条有 id 的 entry。
 */
function buildSessionPathLocal(
  entries: SessionEntry[],
  leafId?: string | null,
): SessionEntry[] {
  // 显式 null leaf → 空路径（无活动分支）
  if (leafId === null) return [];

  const byId = new Map<string, SessionEntry>();
  let lastId: string | null = null;
  for (const e of entries) {
    if (e?.id) {
      byId.set(e.id, e);
      lastId = e.id;
    }
  }
  // undefined → 回退文件末 entry；string → 指定 leaf
  let current: string | null | undefined = leafId !== undefined ? leafId : lastId;
  const path: SessionEntry[] = [];
  const guard = new Set<string>();
  while (current && !guard.has(current)) {
    guard.add(current);
    const entry = byId.get(current);
    if (!entry) break;
    path.unshift(entry);
    current = (entry as { parentId?: string | null }).parentId ?? null;
  }
  return path;
}

/**
 * 压缩感知的可见 entry 列表（对齐 pi buildContextEntries）。
 */
function buildContextEntriesLocal(
  entries: SessionEntry[],
  leafId?: string | null,
): SessionEntry[] {
  const path = buildSessionPathLocal(entries, leafId);
  let compaction: (SessionEntry & { firstKeptEntryId?: string }) | null = null;
  for (const entry of path) {
    if (entry.type === "compaction") {
      compaction = entry as SessionEntry & { firstKeptEntryId?: string };
    }
  }
  if (!compaction) return path;
  const compactionIdx = path.findIndex((e) => e.id === compaction!.id);
  if (compactionIdx < 0) return path;
  const contextEntries: SessionEntry[] = [compaction];
  let foundFirstKept = false;
  for (let i = 0; i < compactionIdx; i++) {
    const entry = path[i];
    if (entry.id === compaction.firstKeptEntryId) foundFirstKept = true;
    if (foundFirstKept) contextEntries.push(entry);
  }
  contextEntries.push(...path.slice(compactionIdx + 1));
  return contextEntries;
}

function getSessionContextSettingsLocal(path: SessionEntry[]): {
  thinkingLevel?: string;
  model?: { provider?: string; modelId?: string; id?: string };
} {
  let thinkingLevel: string | undefined;
  let model: { provider?: string; modelId?: string; id?: string } | undefined;
  for (const e of path) {
    if (e.type === "thinking_level_change" && typeof (e as { thinkingLevel?: string }).thinkingLevel === "string") {
      thinkingLevel = (e as { thinkingLevel: string }).thinkingLevel;
    }
    if (e.type === "model_change") {
      const m = e as { provider?: string; modelId?: string };
      if (m.provider && m.modelId) {
        model = { provider: m.provider, modelId: m.modelId, id: m.modelId };
      }
    }
  }
  return { thinkingLevel, model };
}

export function buildSessionContext(
  entries: SessionEntry[],
  leafId?: string | null,
  options: { deferThinking?: boolean; deferToolResultImages?: boolean } = {},
): SessionContext {
  const path = buildSessionPathLocal(entries, leafId);
  const settings = getSessionContextSettingsLocal(path);
  const contextEntries = buildContextEntriesLocal(entries, leafId);

  // Convert the selected context entries and their IDs together. This keeps
  // fork/navigation targets aligned while preserving compaction ordering.
  const messages: AgentMessage[] = [];
  const entryIds: string[] = [];
  for (const entry of contextEntries) {
    const m = entryToUiMessage(entry, options);
    if (m) {
      messages.push(m);
      entryIds.push(entry.id);
    }
  }

  return {
    messages,
    entryIds,
    thinkingLevel: settings.thinkingLevel ?? "off",
    model: settings.model as SessionContext["model"],
  };
}

function parseEntryTimestamp(timestamp: string): number | undefined {
  const parsed = Date.parse(timestamp);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function base64ImageInfo(block: unknown): { bytes: number; mime?: string } | null {
  if (!isRecord(block) || block.type !== "image") return null;

  let data: string | undefined;
  let mime: string | undefined;
  if (typeof block.data === "string") {
    data = block.data;
    mime = typeof block.mimeType === "string" ? block.mimeType : undefined;
  } else if (isRecord(block.source) && block.source.type === "base64" && typeof block.source.data === "string") {
    data = block.source.data;
    mime = typeof block.source.media_type === "string" ? block.source.media_type : undefined;
  }
  if (!data) return null;

  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return { bytes: Math.max(0, Math.floor(data.length * 3 / 4) - padding), mime };
}

function omitToolResultBase64Images(message: AgentMessage): AgentMessage {
  if (message.role !== "toolResult") return message;

  let omitted = 0;
  let bytes = 0;
  const mimes = new Set<string>();
  const content = message.content.filter((block) => {
    const image = base64ImageInfo(block);
    if (!image) return true;
    omitted += 1;
    bytes += image.bytes;
    if (image.mime) mimes.add(image.mime);
    return false;
  });
  if (omitted === 0) return message;

  const mimeText = mimes.size > 0 ? `: ${[...mimes].join(", ")}` : "";
  content.push({
    type: "text",
    text: `[${omitted} tool result image${omitted === 1 ? "" : "s"} omitted from initial history payload${mimeText}, ~${bytes} bytes]`,
  });
  return { ...message, content };
}

/**
 * 初始历史载荷剥离 toolResult.details 中的大字段（edit/write 的 diff/patch 等）。
 * 与 deferThinking 同理：首屏只带轻量摘要，展开工具卡时再按需拉取完整 details。
 *
 * 只剥离白名单大字段，保留 tasks（todo）、results（subagent）等 UI 依赖字段。
 */
const HEAVY_TOOL_RESULT_DETAIL_KEYS = new Set([
  "diff",
  "patch",
  "diffData",
  // readSeek_* 工具把 seek 状态塞进 details，体积常达数 KB～数十 KB
  "readSeekValue",
]);

/** details 上标记「有重字段被延迟」；客户端据此按 toolCallId 懒加载。 */
export const TOOL_RESULT_DETAILS_DEFERRED_FLAG = "deferredHeavy" as const;

export function isToolResultDetailsDeferred(details: unknown): boolean {
  return isRecord(details) && details[TOOL_RESULT_DETAILS_DEFERRED_FLAG] === true;
}

function omitHeavyToolResultDetails(message: AgentMessage): AgentMessage {
  if (message.role !== "toolResult") return message;
  if (!isRecord(message.details)) return message;

  let changed = false;
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(message.details)) {
    if (key === TOOL_RESULT_DETAILS_DEFERRED_FLAG) continue;
    if (HEAVY_TOOL_RESULT_DETAIL_KEYS.has(key)) {
      changed = true;
      continue;
    }
    next[key] = value;
  }
  if (!changed) return message;
  return {
    ...message,
    details: { ...next, [TOOL_RESULT_DETAILS_DEFERRED_FLAG]: true },
  };
}

// Convert a session entry on the active branch into a UI message.
// Returns null for entries that do not map to chat history (metadata, non-message types).
function entryToUiMessage(
  entry: SessionEntry,
  options: { deferThinking?: boolean; deferToolResultImages?: boolean },
): AgentMessage | null {
  // Supported message roles: user, assistant, toolResult, bashExecution.
  // bashExecution messages enter the case "message" branch (entry.type === "message").
  // The early return at line below ("!options.deferThinking || message.role !== "assistant"")
  // passes non-assistant messages — including bashExecution — through unchanged.
  // normalizeToolCalls is a secondary guard (returns non-assistant messages as-is).
  switch (entry.type) {
    case "message": {
      let message = normalizeToolCalls(entry.message);
      // deferMedia：剥离 toolResult 内嵌 base64 图 + 重 details（diff/patch 等）
      if (options.deferToolResultImages) {
        message = omitToolResultBase64Images(message);
        message = omitHeavyToolResultDetails(message);
      }
      if (!options.deferThinking || message.role !== "assistant") return message;
      return {
        ...message,
        content: message.content.map((block) => (
          block.type === "thinking" && block.thinking.trim() !== ""
            ? { ...block, thinking: "", deferred: true }
            : block
        )),
      };
    }
    case "compaction":
      return {
        role: "custom",
        customType: "compaction",
        content: entry.summary,
        display: true,
        details: {
          tokensBefore: entry.tokensBefore,
          firstKeptEntryId: entry.firstKeptEntryId,
        },
        timestamp: parseEntryTimestamp(entry.timestamp),
      };
    case "branch_summary":
      if (!entry.summary) return null;
      // usage 存在于 Pi SDK 原生 entry，本地 BranchSummaryEntry 未声明；按需读取。
      const branchUsage = (entry as SessionEntry & { usage?: unknown }).usage;
      return {
        role: "custom",
        customType: "branch_summary",
        content: entry.summary,
        display: true,
        details: {
          fromId: entry.fromId,
          details: entry.details,
          usage: branchUsage,
          fromHook: entry.fromHook,
        },
        timestamp: parseEntryTimestamp(entry.timestamp),
      };
    case "custom_message":
      return {
        role: "custom",
        customType: entry.customType,
        content: entry.content,
        display: entry.display,
        details: entry.details,
        timestamp: parseEntryTimestamp(entry.timestamp),
      };
    case "custom": {
      // type:"custom" 不进入 LLM；仅投影合法 pidance.activity 到 UI timeline。
      // 其它 customType（om / workspace-history 等）保持侧栏投影，不进聊天气泡。
      // 非法/未知 version 安全跳过。压缩语义跟随 piBuildContextEntries 可见集：
      // 被压缩掉的普通消息前的 activity 不复活。
      if (entry.customType !== PIDANCE_ACTIVITY_CUSTOM_TYPE) return null;
      const activity = parseActivityData(entry.data);
      if (!activity) return null;
      return activityToUiMessage(activity, parseEntryTimestamp(entry.timestamp));
    }
    default:
      return null;
  }
}
