import { closeSync, type Dirent, existsSync, openSync, readdirSync, readSync, realpathSync, statSync } from "fs";
import { readdir, realpath } from "fs/promises";
import {
  isAbsolute,
  join as joinPath,
  normalize as normalizePath,
  relative,
  resolve as resolvePath,
  sep,
} from "path";
import type { AgentMessage, SessionEntry, SessionHeader, SessionInfo, SessionContext } from "./types";
import { PIDANCE_COMMAND_CUSTOM_TYPE, parseCommandEntryData } from "./session-command-entry";
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
import {
  PIDANCE_BINARY_CUSTOM_TYPE,
  binaryMessageToUiMessage,
  parseBinaryMessageData,
} from "./message-binary";
import { discoverSubagentSessions } from "./subagent-sessions";
import { getAgentDir } from "./pi-paths";
import { openSessionView } from "./pi-session-io";
import { openCachedSessionReadView } from "./session-read-manager-cache";
import { getThinkingText, isThinkingLikeType } from "./thinking-content";

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

  const resultPaths = new Set<string>();
  const resultIds = new Set<string>();
  const sessions: SessionInfo[] = piSessions
    .sort((a, b) => (a.modified < b.modified ? 1 : a.modified > b.modified ? -1 : 0))
    .flatMap((s): SessionInfo[] => {
      const path = normalizePath(s.path);
      if (resultPaths.has(path) || resultIds.has(s.id)) return [];
      resultPaths.add(path); resultIds.add(s.id);
      cacheSessionPath(s.id, s.path);
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
        // 一个目录就是一个项目：projectRoot 恒等于会话 cwd，不再折叠 linked worktree。
        projectRoot: s.cwd,
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
      projectRoot: child.cwd,
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
 * subagent 发现缓存除父 jsonl 的 mtime/size 外，还对 run 根做有界树戳：
 * 深度 2（根 / runId / run-N），最多 96 次 stat。子目录里新建或删除
 * session.jsonl 会改到 run-N 的 mtime，单层根 mtime 看不见。
 */
const RUN_TREE_STAMP_MAX_STATS = 96;

function stampPath(path: string, depth: number, budget: { n: number }): string {
  if (budget.n <= 0) return "";
  let st: ReturnType<typeof statSync>;
  try { st = statSync(path); } catch { return ""; }
  budget.n -= 1;
  if (!st.isDirectory()) return `${st.mtimeMs}:${st.size}`;
  let names: string[] = [];
  try { names = readdirSync(path); } catch { return `${st.mtimeMs}:${st.size}`; }
  const parts = [`${st.mtimeMs}:${st.size}`];
  if (depth <= 0) {
    for (const name of names.slice(0, 32)) parts.push(name);
    return parts.join("|");
  }
  for (const name of names.slice(0, 32)) {
    parts.push(`${name}=${stampPath(joinPath(path, name), depth - 1, budget)}`);
  }
  return parts.join("|");
}

export function computeParentRunTreeStamp(parentPath: string): string {
  if (!parentPath.endsWith(".jsonl")) return "";
  return stampPath(parentPath.slice(0, -6), 2, { n: RUN_TREE_STAMP_MAX_STATS });
}

function getCachedDiscovery(
  parentPath: string,
  parentId: string,
  discoveryRecords: Map<string, DiscoveryCacheRecord>,
  sessionRecords: Map<string, SessionCacheRecord>,
  discover: (path: string, id: string) => CachedDiscoveredChild[],
): CachedDiscoveredChild[] {
  try {
    const st = statSync(parentPath);
    const treeStamp = computeParentRunTreeStamp(parentPath);
    const record = discoveryRecords.get(parentPath);
    if (record && record.m === st.mtimeMs && record.s === st.size && record.d === treeStamp) {
      return record.c;
    }
    const children = discover(parentPath, parentId);
    discoveryRecords.set(parentPath, { m: st.mtimeMs, s: st.size, d: treeStamp, c: children });
    return children;
  } catch {
    // 父文件不可 stat（已删除）：清掉缓存记录，返回空
    discoveryRecords.delete(parentPath);
    return [];
  }
}

export async function listAllSessions(options: { allowStale?: boolean } = {}): Promise<SessionInfo[]> {
  const generation = globalThis.__piSessionListGeneration ?? 0;
  const cache = globalThis.__piSessionListCache;

  // Return cached result if still fresh (avoids re-scanning session files
  // and re-spawning git processes on every page load).
  if (cache && cache.generation === generation && Date.now() - cache.ts < SESSION_LIST_CACHE_TTL_MS) {
    return cache.data;
  }

  // 只消费会话元数据的调用方（搜索命中映射到侧栏行、归档范围过滤）可以先用
  // 上一轮扫描：agent 的活动本身就会不停作废缓存，而重建要重新读每个 fork/
  // subagent 会话（数百 ms），跟调用方的请求没有关系。代价：刚刚创建的会话
  // 在这几秒内搜不到。
  // 只允许目录扫描类调用方用 stale；会话存在性/权限判定不得走这里。
  if (options.allowStale && cache) {
    // 后台重建（经 listAllSessions 的合并去重，多个读者不会各扫一遍）
    void listAllSessions().catch(() => undefined);
    return cache.data;
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
      globalThis.__piSessionListCache = { data, ts: Date.now(), generation };
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
  /** generation 是扫描时的代际：失效只推 generation，旧数据留给 allowStale 读者。 */
  var __piSessionListCache: { data: SessionInfo[]; ts: number; generation: number } | undefined;
}

const SESSION_LIST_CACHE_TTL_MS = 30_000;

/**
 * 作废会话列表缓存：推进 generation 并保留上一轮扫描结果。
 * 保留不是为了普通读者（他们要 generation 相符才算新鲜），而是为了让
 * `listAllSessions({ allowStale: true })` 能直接用旧目录，不必同步重建。
 */
export function invalidateSessionListCache(): void {
  globalThis.__piSessionListGeneration = (globalThis.__piSessionListGeneration ?? 0) + 1;
}

function getPathCache(): Map<string, string> {
  if (!globalThis.__piSessionPathCache) globalThis.__piSessionPathCache = new Map();
  return globalThis.__piSessionPathCache;
}

function getPathToIdCache(): Map<string, string> {
  if (!globalThis.__piPathToSessionIdCache) globalThis.__piPathToSessionIdCache = new Map();
  return globalThis.__piPathToSessionIdCache;
}

/** 会话 id 允许的字符集（只用于拼文件名候选；权威校验仍是有界 header）。 */
const SESSION_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

function defaultSessionsDir(): string {
  return joinPath(getAgentDir(), "sessions");
}

/** 路径必须落在 sessions 根内（根自身与越界返回 null）。 */
function resolvePathWithinDefaultSessions(
  filePath: string,
  sessionsDir = resolvePath(defaultSessionsDir()),
): string | null {
  const candidatePath = resolvePath(filePath);
  const relativePath = relative(sessionsDir, candidatePath);
  return relativePath !== ""
    && relativePath !== ".."
    && !relativePath.startsWith(`..${sep}`)
    && !isAbsolute(relativePath)
    ? candidatePath
    : null;
}

/**
 * 按文件名 `*_<id>.jsonl` 有界定位会话文件（不做全目录扫描）。
 *
 * 文件名只是候选提示，仍读有界 header 校验 id；布局未知、候选损坏或同一 id
 * 有多个候选时返回 null，退回目录扫描的权威口径（不做负缓存）。
 * 深链首次打开、重启、多标签冷启动本来要等 2-7s 全扫。
 *
 * 边界：`resolvePathWithinDefaultSessions` 只做词法归一，挡不住符号链接。根外文件
 * 一旦被写进 path cache，之后的读写都会跟着走，所以候选还要按 realpath 复核；
 * 根外候选一律按「布局不可信」处理，交回目录扫描。
 */
async function findSessionPathById(sessionId: string): Promise<string | null> {
  if (!SESSION_ID_PATTERN.test(sessionId)) return null;
  const sessionsDir = resolvePath(defaultSessionsDir());
  let projectDirs: Dirent[];
  try {
    projectDirs = await readdir(sessionsDir, { withFileTypes: true });
  } catch {
    return null;
  }
  const realRoot = await realpath(sessionsDir).catch(() => sessionsDir);

  const suffix = `_${sessionId}.jsonl`;
  let match: string | undefined;
  for (const projectDir of projectDirs) {
    // 与权威目录扫描同口径：符号链接目录不算项目目录（scanSessionFiles 只取 isDirectory）。
    if (!projectDir.isDirectory()) continue;
    const projectPath = resolvePathWithinDefaultSessions(joinPath(sessionsDir, projectDir.name), sessionsDir);
    if (!projectPath) continue;

    let files: string[];
    try {
      files = await readdir(projectPath);
    } catch {
      continue;
    }

    for (const file of files) {
      if (!file.endsWith(suffix)) continue;
      const candidate = resolvePathWithinDefaultSessions(joinPath(projectPath, file), sessionsDir);
      if (!candidate) continue;
      const real = await realpath(candidate).catch(() => null);
      if (!real) continue;
      if (!resolvePathWithinDefaultSessions(real, realRoot)) return null;
      try {
        if (readSessionHeader(candidate)?.id !== sessionId) continue;
      } catch {
        continue;
      }
      // 同一 id 多个候选：不自行选一，交回目录扫描的既有语义
      if (match && match !== candidate) return null;
      match = candidate;
    }
  }

  return match ?? null;
}

/** 已知文件路径 → id：realpath 后仍须在 sessions 根内，且 header 可信。 */
function findSessionIdByPath(filePath: string): string | undefined {
  if (!filePath.endsWith(".jsonl")) return undefined;
  const sessionsDir = resolvePath(defaultSessionsDir());
  const candidate = resolvePathWithinDefaultSessions(filePath, sessionsDir);
  if (!candidate) return undefined;
  try {
    if (!resolvePathWithinDefaultSessions(realpathSync(candidate), realpathSync(sessionsDir))) return undefined;
  } catch {
    return undefined;
  }
  try {
    const sessionId = readSessionHeader(candidate)?.id;
    if (!sessionId) return undefined;
    cacheSessionPath(sessionId, candidate);
    return sessionId;
  } catch {
    return undefined;
  }
}

export async function resolveSessionPath(sessionId: string): Promise<string | null> {
  const cached = getPathCache().get(sessionId);
  if (cached) {
    if (existsSync(cached)) return cached;
    invalidateSessionPathCache(sessionId);
  }

  // 缓存未命中：先有界定位，避免为一次深链/冷启动全扫 sessions 目录
  const targeted = await findSessionPathById(sessionId);
  if (targeted) {
    cacheSessionPath(sessionId, targeted);
    return targeted;
  }

  // Cache miss or stale path: scan all sessions to populate cache, then retry
  await listAllSessions();
  const resolved = getPathCache().get(sessionId) ?? null;
  if (resolved && !existsSync(resolved)) {
    invalidateSessionPathCache(sessionId);
    return null;
  }
  return resolved;
}

export async function resolveSessionIdByPath(filePath: string): Promise<string | undefined> {
  const pathKey = normalizePath(filePath);
  const cached = getPathToIdCache().get(pathKey);
  if (cached) return cached;

  const targeted = findSessionIdByPath(filePath);
  if (targeted) return targeted;

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
  const entries = openSessionView(filePath).getEntries();
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
 * - 否则按指纹复用只读视图（openCachedSessionReadView；无 live 时不再每请求重解 JSONL）
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
      // 只读视图复用（指纹含正文 size/mtime 与 leaf sidecar）：翻页/刷新的重开
      // 不再全量重解 JSONL。写路径不走这里（见 session-read-manager-cache）。
      const sm = openCachedSessionReadView(path);
      return {
        getEntries: () => sm.getEntries(),
        getLeafId: () => sm.getLeafId(),
        getTree: () => sm.getTree() as ReturnType<SessionManagerReadView["getTree"]>,
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
    const entry: { id: string; type: string; message?: unknown } = { id: e.id, type: e.type };
    // 磁盘浅树补消息摘要（SDK getTree 的 label 等价物）：分支侧栏节点可辨认。
    // 仅保留 text 块，避免把图片/大工具结果带进树。
    if (e.type === "message" && "message" in e) {
      const msg = (e as { message?: { role?: string; content?: unknown } }).message;
      if (msg && typeof msg.content === "object" && msg.content !== null) {
        const content = Array.isArray(msg.content)
          ? (msg.content as Array<{ type?: string; text?: string }>)
            .filter((b) => b.type === "text" && typeof b.text === "string")
            .map((b) => ({ type: "text" as const, text: b.text }))
          : msg.content;
        entry.message = { role: msg.role, content };
      } else {
        entry.message = msg;
      }
    }
    byId.set(e.id, { entry, children: [] });
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
  options: SessionReaderProjectionOptions = {},
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
    stripMetadataNodes(sm.getTree() as Parameters<typeof stripMetadataNodes>[0]),
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
/**
 * 不参与对话上下文、也不该成为导航落点的元数据 entry：
 * - label：给消息打标签；
 * - usage：缓存保活/压缩的用量记录（0.87.0 起 SDK 会写，idle 保活成功后可能停在链尾）；
 * - context_edit：只追加的上下文编辑记录（0.87.0 起 SDK 会写，用于从模型上下文里省略条目）。
 * 它们都可能成为 JSONL 链尾，导航时必须像 label 一样上溯到最近的真实消息，
 * 否则分支导航会露出 "usage" 这类类型名。
 */
const METADATA_ENTRY_TYPES: ReadonlySet<string> = new Set(["label", "usage", "context_edit"]);

export function resolveNavigationLeafId(
  entries: ReadonlyArray<{ id: string; type: string; parentId: string | null }>,
  leafId: string | null | undefined,
): string | null {
  if (leafId == null) return null;
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  let current = byId.get(leafId);
  if (!current) return leafId;
  while (current && METADATA_ENTRY_TYPES.has(current.type)) {
    if (!current.parentId) return null;
    current = byId.get(current.parentId);
  }
  return current?.id ?? null;
}

/**
 * 从导航树中移除元数据节点（label / usage / context_edit），将其子节点提升到父级。
 * 目标 entry 上的 node.label（由 SessionManager.getTree 解析）保持不变；
 * JSONL 中的历史 label entry 不删除。
 */
export function stripMetadataNodes<T extends {
  entry: { id: string; type: string };
  children: T[];
}>(nodes: T[]): T[] {
  // 迭代版后序遍历（显式栈）：元数据节点提升其子节点，其余原样保留。
  // 递归版在超长线性链（数千层）下栈溢出（Maximum call stack size exceeded，
  // 大会话加载 500）。兄弟顺序保持正序（入栈倒序、pop 正序）。
  interface Frame { node: T; out: T[]; }
  const rootOut: T[] = [];
  const stack: Frame[] = [];
  for (let i = nodes.length - 1; i >= 0; i--) {
    stack.push({ node: nodes[i], out: rootOut });
  }
  while (stack.length > 0) {
    const { node, out } = stack.pop()!;
    if (METADATA_ENTRY_TYPES.has(node.entry.type)) {
      for (let i = node.children.length - 1; i >= 0; i--) {
        stack.push({ node: node.children[i], out });
      }
      continue;
    }
    const childOut: T[] = [];
    for (let i = node.children.length - 1; i >= 0; i--) {
      stack.push({ node: node.children[i], out: childOut });
    }
    out.push({ ...node, children: childOut } as T);
  }
  return rootOut;
}

/** 有书签 label 的节点不得在投影中被压缩掉。 */
export function hasBookmarkLabel(node: { label?: string }): boolean {
  return typeof node.label === "string" && node.label.length > 0;
}

/**
 * 将会话树投影为发给客户端的浅导航树。
 * 保留根、分支点、叶子与带 label 的书签目标；压缩无 label 的单子链。
 * 被压缩的 entry id 挂到下一可见节点，便于 UI 识别链内活跃 leaf。
 * 调用方应先 stripMetadataNodes，避免元数据成为可点击假分支。
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
export function buildSessionPathLocal(
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
 * 可见 entry 列表：返回完整链（含压缩前的旧消息）。
 * 压缩（compact）不删除旧条目，Pidance 按完整历史正常显示；
 * 与 Pi buildContextEntries（摘要+kept 截断）的差异是产品决策。
 */
function buildContextEntriesLocal(entries: SessionEntry[], leafId?: string | null): SessionEntry[] {
  return buildSessionPathLocal(entries, leafId);
}

function getSessionContextSettingsLocal(path: SessionEntry[]): {
  thinkingLevel?: string;
  model?: { provider?: string; modelId?: string; id?: string };
} {
  let thinkingLevel: string | undefined;
  let model: { provider?: string; modelId?: string; id?: string } | undefined;
  let lastAssistantModel: { provider: string; modelId: string; id: string } | undefined;
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
    if (e.type === "message") {
      const msg = (e as { message?: { role?: string; provider?: string; model?: string } }).message;
      if (msg?.role === "assistant" && typeof msg.provider === "string" && msg.provider && typeof msg.model === "string" && msg.model) {
        lastAssistantModel = { provider: msg.provider, modelId: msg.model, id: msg.model };
      }
    }
  }
  return { thinkingLevel, model: model ?? lastAssistantModel };
}
/**
 * 自定义 entry 的渲染行解析器（由调用方注入）。
 *
 * 拿到 entry 本身 → 返回渲染行；返回 null 表示不可渲染 → 该项不显示。
 * 注入而不是在 reader 里加载扩展：reader 保持纯同步、不读盘、可单测，
 * 扩展加载与缓存由服务层负责（见 lib/extension-entry-renderers.ts）。
 */
export type EntryLinesResolver = (entry: unknown) => string[] | null;

/** 会话投影选项（纯同步：不加载扩展、不做 IO）。 */
export interface SessionReaderProjectionOptions {
  deferThinking?: boolean;
  deferToolResultImages?: boolean;
  /**
   * 插件用 `registerEntryRenderer` 注册的自定义 entry 渲染器。
   * 缺省时未知 customType 的 entry 不投影（与历史行为一致）。
   */
  entryLines?: EntryLinesResolver;
}

/** Pidance 自有 customType：有本地投影，不交给插件渲染器。 */
export function isPidanceOwnCustomType(customType: unknown): boolean {
  return (
    customType === PIDANCE_BINARY_CUSTOM_TYPE ||
    customType === PIDANCE_COMMAND_CUSTOM_TYPE ||
    customType === PIDANCE_ACTIVITY_CUSTOM_TYPE
  );
}

/**
 * 未知 customType 的 entry → 插件渲染行。
 * 任何异常/非法输出都归为「不渲染」（不显示），绝不让会话读取失败。
 */
function entryCustomLines(
  entry: SessionEntry,
  options: SessionReaderProjectionOptions,
): string[] | null {
  const customType = (entry as { customType?: unknown }).customType;
  if (typeof customType !== "string" || customType === "" || isPidanceOwnCustomType(customType)) {
    return null;
  }
  const resolve = options.entryLines;
  if (!resolve) return null;
  let lines: string[] | null;
  try {
    lines = resolve(entry);
  } catch {
    return null;
  }
  if (!Array.isArray(lines) || lines.length === 0) return null;
  return lines.every((line) => typeof line === "string") ? lines : null;
}

export function buildSessionContext(
  entries: SessionEntry[],
  leafId?: string | null,
  options: SessionReaderProjectionOptions = {},
): SessionContext {
  const path = buildSessionPathLocal(entries, leafId);
  const settings = getSessionContextSettingsLocal(path);
  const contextEntries = buildContextEntriesLocal(entries, leafId);

  // Convert the selected context entries and their IDs together. This keeps
  // fork/navigation targets aligned while preserving compaction ordering.
  const messages: AgentMessage[] = [];
  const entryIds: string[] = [];
  // 沿路径重放思考档：settings 是路径末尾值，不能套到全部历史消息。
  const thinkingByEntryId = new Map<string, string>();
  let replayThinking = "off";
  for (const entry of path) {
    if (entry.type === "thinking_level_change" && typeof (entry as { thinkingLevel?: string }).thinkingLevel === "string") {
      replayThinking = (entry as { thinkingLevel: string }).thinkingLevel;
    }
    thinkingByEntryId.set(entry.id, replayThinking);
  }
  for (const entry of contextEntries) {
    const m = entryToUiMessage(entry, options);
    if (m?.role === "custom" && m.customType === PIDANCE_BINARY_CUSTOM_TYPE) {
      const binary = parseBinaryMessageData(m.details);
      const targetIndex = binary?.messageEntryId
        ? entryIds.indexOf(binary.messageEntryId)
        : -1;
      const target = targetIndex >= 0 ? messages[targetIndex] : undefined;
      if (binary && target?.role === "user") {
        messages[targetIndex] = {
          ...target,
          binaryBlocks: [...(target.binaryBlocks ?? []), binary],
        };
        // Binary custom entries are UI metadata attached to the Pi user entry;
        // they do not get a second visible row or a fake branch target.
        continue;
      }
    }
    if (m) {
      messages.push(
        m.role === "assistant"
          ? { ...m, thinkingLevel: thinkingByEntryId.get(entry.id) ?? replayThinking }
          : m,
      );
      entryIds.push(entry.id);
    }
  }

  const projectedMessages = options.deferToolResultImages
    ? messages.map(omitBinaryBackedUserImages)
    : messages;
  return {
    messages: projectedMessages,
    entryIds,
    thinkingLevel: settings.thinkingLevel ?? "off",
    model: (settings.model as SessionContext["model"]) ?? null,
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

function omitBinaryBackedUserImages(message: AgentMessage): AgentMessage {
  if (message.role !== "user" || !Array.isArray(message.content)) return message;
  if (!message.binaryBlocks?.some((block) => block.kind === "image")) return message;
  return {
    ...message,
    content: message.content.filter((block) => block.type !== "image"),
  };
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
  options: SessionReaderProjectionOptions,
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
          isThinkingLikeType(block.type) && getThinkingText(block).trim() !== ""
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
      // 插件用 registerEntryRenderer 注册的自定义 entry（supervisor reply、watchdog
      // warning 等）没有自有内容可回退，只能由插件渲染器出内容：拿到行才投影，
      // 拿不到就不显示（不能把插件私有载荷当文本糊到界面上）。
      // 非法/未知 version 安全跳过。压缩语义跟随 piBuildContextEntries 可见集：
      // 被压缩掉的普通消息前的 activity 不复活。
      if (entry.customType === PIDANCE_BINARY_CUSTOM_TYPE) {
        const binary = parseBinaryMessageData(entry.data);
        if (!binary) return null;
        return binaryMessageToUiMessage(binary, parseEntryTimestamp(entry.timestamp));
      }
      if (entry.customType === PIDANCE_COMMAND_CUSTOM_TYPE) {
        const command = parseCommandEntryData(entry.data);
        if (!command) return null;
        return {
          role: "custom",
          customType: PIDANCE_COMMAND_CUSTOM_TYPE,
          content: command.command,
          display: true,
          details: { ok: command.ok, result: command.result },
          timestamp: parseEntryTimestamp(entry.timestamp),
        };
      }
      if (entry.customType === PIDANCE_ACTIVITY_CUSTOM_TYPE) {
        const activity = parseActivityData(entry.data);
        if (!activity) return null;
        return activityToUiMessage(activity, parseEntryTimestamp(entry.timestamp));
      }
      const entryLines = entryCustomLines(entry, options);
      if (!entryLines) return null;
      return {
        role: "custom",
        customType: entry.customType,
        // 内容全在 renderedLines 里：entry 没有 content 字段，给空串让前端只渲染
        // 渲染行（标题走通用的 customType 美化，前端已有逻辑）。
        content: "",
        display: true,
        renderedLines: entryLines,
        timestamp: parseEntryTimestamp(entry.timestamp),
      };
    }
    default:
      return null;
  }
}
