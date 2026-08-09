/**
 * 新会话引导页（NewSessionGuide）的纯逻辑缓存：
 * - 项目列表聚合（/api/sessions → 最近 cwd 列表）与持久化目标项目解析
 * - 工作树列表按 cwd 的 in-flight 去重 + stale-while-revalidate 语义
 *
 * 抽为纯模块以便 node:test 覆盖；组件只负责 UI 状态映射。
 */

export interface GuideWorktreeInfo {
  path: string;
  branch?: string;
  isMain?: boolean;
}

export interface GuideProject {
  cwd: string;
  count: number;
  latest: number;
}

/** 聚合会话列表（含 cwd/created/modified）为「最近项目」列表，按最新活动降序取前 limit。
 * extraRoots：用户主动添加的项目根（无会话也展示，count=0），不在会话列表中时补入。 */
export function aggregateGuideProjects(
  sessions: ReadonlyArray<{ cwd?: string; created?: string; modified?: string }>,
  limit = 12,
  extraRoots: readonly string[] = [],
): GuideProject[] {
  const byCwd = new Map<string, { count: number; latest: number }>();
  for (const s of sessions) {
    if (!s.cwd) continue;
    const ts = s.modified
      ? Date.parse(s.modified)
      : s.created
        ? Date.parse(s.created)
        : 0;
    const entry = byCwd.get(s.cwd) ?? { count: 0, latest: 0 };
    entry.count += 1;
    if (ts > entry.latest) entry.latest = ts;
    byCwd.set(s.cwd, entry);
  }
  const projects = [...byCwd.entries()]
    .map(([cwd, v]) => ({ cwd, count: v.count, latest: v.latest }))
    .sort((a, b) => b.latest - a.latest)
    .slice(0, limit);
  const known = new Set(projects.map((p) => p.cwd));
  // 无会话的已添加项目：置顶便于刚添加即可见（与侧栏空项目置顶语义一致）。
  const extra = extraRoots.filter((root) => !known.has(root)).map((cwd) => ({ cwd, count: 0, latest: 0 }));
  return extra.length > 0 ? [...extra, ...projects].slice(0, limit) : projects;
}

/** 解析持久化目标 cwd 归属的项目：先精确匹配项目根，再最长前缀匹配（工作树路径）。无匹配返回 null。 */
export function resolveGuideTargetProject(
  projects: ReadonlyArray<{ cwd: string }>,
  targetCwd: string,
): string | null {
  if (projects.some((p) => p.cwd === targetCwd)) return targetCwd;
  const parent = projects
    .filter((p) => targetCwd.startsWith(p.cwd + "/"))
    .sort((a, b) => b.cwd.length - a.cwd.length)[0];
  return parent ? parent.cwd : null;
}

export interface WorktreeCacheState {
  /** cwd → 最近一次成功加载的列表（stale 数据，用于 SWR 立即渲染） */
  data: Map<string, GuideWorktreeInfo[]>;
  /** cwd → 最近一次成功加载时间戳（TTL 判定，与 data 同步写入） */
  loadedAt: Map<string, number>;
  /** cwd → in-flight 请求（并发去重） */
  inFlight: Map<string, Promise<GuideWorktreeInfo[]>>;
}

/**
 * 默认缓存中工作树列表的 TTL。与服务端模型缓存（60s）一致：工作树列表可能
 * 因外部 git 操作（新建/删除分支、增删 worktree）变化，客户端采用 stale +
 * 后台刷新折中——TTL 内秒开旧列表并在后台刷新覆盖；TTL 过期视为无缓存、
 * 强制重新请求，避免展示过久陈旧数据。
 */
export const GUIDE_WORKTREE_CACHE_TTL_MS = 60_000;

// ── localStorage 持久化（与 lib/session-list-cache.ts 的键名/序列化风格对齐）──

/** localStorage 键名（项目列表用 pidance.sessionList.v1，工作树用同级风格）。 */
export const GUIDE_WORKTREES_STORAGE_KEY = "pidance.guideWorktrees.v1";

/** 持久化条目：某 cwd 的工作树列表与加载时刻（at = Date.now()，TTL 判定）。 */
export interface PersistedWorktreeEntry {
  items: GuideWorktreeInfo[];
  at: number;
}

/**
 * 解析 localStorage 原始串为「cwd → 条目」Map，并顺带做 TTL 过滤：
 * 损坏 JSON / 非对象 / 空串安全回退空 Map；结构非法或已过期的单条跳过。
 * TTL 判定与服务端一致：now - at >= TTL 视为过期，不恢复。
 */
export function parsePersistedWorktrees(
  raw: string | null,
  now: number,
): Map<string, PersistedWorktreeEntry> {
  const map = new Map<string, PersistedWorktreeEntry>();
  if (!raw) return map;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return map;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return map;
  for (const [cwd, value] of Object.entries(parsed)) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
    const { items, at } = value as { items?: unknown; at?: unknown };
    if (!Array.isArray(items) || typeof at !== "number") continue;
    if (now - at >= GUIDE_WORKTREE_CACHE_TTL_MS) continue;
    map.set(cwd, { items: items as GuideWorktreeInfo[], at });
  }
  return map;
}

/** 序列化「cwd → 条目」Map 为 localStorage 原始串。 */
export function serializePersistedWorktrees(
  map: ReadonlyMap<string, PersistedWorktreeEntry>,
): string {
  const obj: Record<string, PersistedWorktreeEntry> = {};
  for (const [cwd, entry] of map) obj[cwd] = entry;
  return JSON.stringify(obj);
}

/** 原地移除已过期（now - at >= TTL）的条目。 */
export function pruneExpiredWorktrees(
  map: Map<string, PersistedWorktreeEntry>,
  now: number,
): void {
  for (const [cwd, entry] of map) {
    if (now - entry.at >= GUIDE_WORKTREE_CACHE_TTL_MS) map.delete(cwd);
  }
}

/**
 * 把持久化条目合并进内存缓存（hydrate）。只补缺失条目：内存缓存已有数据
 * （本会话内更新/刷新过的）优先，不被 localStorage 覆盖；过期条目由
 * parsePersistedWorktrees 已过滤，此处只需补 entries。
 */
export function hydrateWorktreeCache(
  cache: WorktreeCacheState,
  persisted: ReadonlyMap<string, PersistedWorktreeEntry>,
): void {
  for (const [cwd, entry] of persisted) {
    if (cache.data.has(cwd) && cache.loadedAt.has(cwd)) continue;
    cache.data.set(cwd, entry.items);
    cache.loadedAt.set(cwd, entry.at);
  }
}

export function createWorktreeCache(): WorktreeCacheState {
  return { data: new Map(), loadedAt: new Map(), inFlight: new Map() };
}

/** 模块级默认缓存单例（SPA 生命周期内跨组件挂载/卸载复用；页面刷新自然重建）。 */
let defaultWorktreeCache: WorktreeCacheState | null = null;

export function getDefaultWorktreeCache(): WorktreeCacheState {
  if (!defaultWorktreeCache) defaultWorktreeCache = createWorktreeCache();
  return defaultWorktreeCache;
}

/**
 * 清空默认缓存。cwd 缺省时清全部；传入 cwd 仅清该条（新建工作树成功后调用，
 * 强制该 cwd 下次重新请求）。无缓存时为空操作。
 */
export function clearDefaultWorktreeCache(cwd?: string): void {
  if (!defaultWorktreeCache) return;
  if (cwd) {
    clearWorktreeCache(defaultWorktreeCache, cwd);
  } else {
    defaultWorktreeCache.data.clear();
    defaultWorktreeCache.loadedAt.clear();
    defaultWorktreeCache.inFlight.clear();
  }
}

export interface WorktreeLoadHandle {
  /** 该 cwd 的最终结果（复用 in-flight 或新发起的请求） */
  promise: Promise<GuideWorktreeInfo[]>;
  /** 已有缓存（stale）；无缓存为 null —— 调用方据此决定显示旧数据还是 loading */
  stale: GuideWorktreeInfo[] | null;
}

/**
 * 发起（或复用）某 cwd 的工作树加载，SWR + TTL 语义：
 * - 同 cwd 的并发调用共享同一个 in-flight Promise（去重，不重复请求）
 * - TTL 内已加载过的 cwd 立即返回旧列表（stale），后台刷新完成后经 promise 覆盖
 * - TTL 过期返回 stale=null（调用方进入 loading 并重新请求），避免展示过久陈旧数据
 * - 加载失败不写入缓存：保留旧数据与 loadedAt，下次调用可重试
 *
 * @param now 读取时刻（默认 Date.now()）；测试注入固定值以验证 TTL 边界。
 *            成功写入缓存时同样以该时刻作为 loadedAt（加载完成与发起相差毫秒级）。
 */
export function beginWorktreeLoad(
  cache: WorktreeCacheState,
  cwd: string,
  loader: () => Promise<GuideWorktreeInfo[]>,
  now: number = Date.now(),
): WorktreeLoadHandle {
  const loadedAt = cache.loadedAt.get(cwd);
  const stale =
    loadedAt !== undefined && now - loadedAt < GUIDE_WORKTREE_CACHE_TTL_MS
      ? cache.data.get(cwd) ?? null
      : null;
  const existing = cache.inFlight.get(cwd);
  if (existing) return { promise: existing, stale };

  const promise = Promise.resolve()
    .then(loader)
    .then((wts) => {
      cache.data.set(cwd, wts);
      cache.loadedAt.set(cwd, now);
      return wts;
    })
    .finally(() => {
      if (cache.inFlight.get(cwd) === promise) cache.inFlight.delete(cwd);
    });
  cache.inFlight.set(cwd, promise);
  return { promise, stale };
}

/** 新建工作树成功后使该 cwd 的缓存失效，下次加载强制重新请求。 */
export function clearWorktreeCache(cache: WorktreeCacheState, cwd: string): void {
  cache.data.delete(cwd);
  cache.loadedAt.delete(cwd);
  cache.inFlight.delete(cwd);
}
