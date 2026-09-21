/**
 * 未读会话 id 的 localStorage 读写。
 * 与 SessionSidebar 解耦，便于 node:test 注入 storage。
 */

export const UNREAD_SESSIONS_STORAGE_KEY = "pidance:unread-session-ids";

export type StorageLike = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

export function parseUnreadSessionIds(raw: string | null): Set<string> {
  if (!raw) return new Set();
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) return new Set(parsed.filter((id): id is string => typeof id === "string"));
    return new Set();
  } catch {
    return new Set();
  }
}

/** 加载未读会话 id：仅读规范键；损坏输入安全回退空集合。 */
export function loadUnreadSessionIdsFromStorage(storage: StorageLike): Set<string> {
  try {
    return parseUnreadSessionIds(storage.getItem(UNREAD_SESSIONS_STORAGE_KEY));
  } catch {
    return new Set();
  }
}

export function loadUnreadSessionIds(): Set<string> {
  if (typeof window === "undefined") return new Set();
  return loadUnreadSessionIdsFromStorage(window.localStorage);
}

/**
 * 未读时钟的本地缓存键（#65）。与旧的 `pidance:unread-session-ids`（纯 id 列表）不同，
 * 缓存的是 {completedAt, readAt} 时钟：只有时间戳才能跨端合并，纯 id 列表无法表达
 * 「这台设备读到哪一刻」，会破坏「任一设备读过即全端已读」。
 */
export const UNREAD_SESSION_CLOCK_STORAGE_KEY = "pidance:unread-session-clock";

/**
 * 旧 id 列表迁移成时钟时用的时刻：取一个**明显早于任何真实时间**的值（1970），
 * 这样「列表里 = 未读」的旧语义得以保留，而任何设备之后的 readAt（真实时间）都会
 * 大于它 → 立刻变成已读。若用「迁移时的 now」，会把另一台设备早些时候的已读重新变回未读。
 */
const LEGACY_LIST_COMPLETED_AT = "1970-01-01T00:00:00.000Z";

/** 读本地缓存时钟；没有新键时把旧 id 列表迁移成时钟（迁移结果不回写，由调用方决定）。 */
export function loadUnreadSessionClock(storage: StorageLike): UnreadSessionState {
  try {
    const raw = storage.getItem(UNREAD_SESSION_CLOCK_STORAGE_KEY);
    if (raw) return parseUnreadSessionState(JSON.parse(raw));
  } catch {
    // 损坏输入回退到下面的旧键/空时钟
  }
  try {
    const legacy = parseUnreadSessionIds(storage.getItem(UNREAD_SESSIONS_STORAGE_KEY));
    if (legacy.size === 0) return emptyUnreadSessionState();
    const completedAt: Record<string, string> = {};
    for (const id of legacy) completedAt[id] = LEGACY_LIST_COMPLETED_AT;
    return { completedAt, readAt: {} };
  } catch {
    return emptyUnreadSessionState();
  }
}

export function saveUnreadSessionClock(storage: StorageLike, state: UnreadSessionState): void {
  try {
    storage.setItem(UNREAD_SESSION_CLOCK_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // 存储不可用（隐私模式）：时钟只活在内存里，服务端那份仍是权威。
  }
}

export function saveUnreadSessionIds(ids: Set<string>): void {
  if (typeof window === "undefined") return;
  try {
    if (ids.size === 0) window.localStorage.removeItem(UNREAD_SESSIONS_STORAGE_KEY);
    else window.localStorage.setItem(UNREAD_SESSIONS_STORAGE_KEY, JSON.stringify([...ids]));
  } catch {
    // ignore storage quota / privacy-mode errors
  }
}

/**
 * running 集合变化时更新未读：完成的会话先打标记，当前正在看的会话立刻视为已查看。
 * 无变化时返回原 Set（便于 React 跳过更新）。
 */
export function applyRunningUnreadTransition(
  prevUnread: Set<string>,
  previousRunning: ReadonlySet<string>,
  currentRunning: ReadonlySet<string>,
  selectedSessionId: string | null,
): Set<string> {
  const completed = [...previousRunning].filter((id) => !currentRunning.has(id));
  const newlyRunning = [...currentRunning].filter((id) => !previousRunning.has(id));
  if (completed.length === 0 && newlyRunning.length === 0) return prevUnread;
  const next = new Set(prevUnread);
  newlyRunning.forEach((id) => next.delete(id));
  completed.forEach((id) => next.add(id));
  if (selectedSessionId) next.delete(selectedSessionId);
  return next;
}

/** 多端可合并的未读时钟：unread 当且仅当 completedAt > readAt。 */
export type UnreadSessionState = {
  completedAt: Record<string, string>;
  readAt: Record<string, string>;
};

export const UNREAD_SESSION_STATE_KEY = "unreadSessionState";

function isIso(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function parseTimeMap(value: unknown): Record<string, string> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [id, ts] of Object.entries(value as Record<string, unknown>)) {
    if (!id || !isIso(ts)) continue;
    out[id] = ts;
  }
  return out;
}

export function emptyUnreadSessionState(): UnreadSessionState {
  return { completedAt: {}, readAt: {} };
}

/** 接受新结构或旧版 unreadSessionIds 字符串数组。 */
export function parseUnreadSessionState(raw: unknown, nowIso = new Date().toISOString()): UnreadSessionState {
  if (Array.isArray(raw)) {
    const completedAt: Record<string, string> = {};
    for (const id of raw) {
      if (typeof id === "string" && id) completedAt[id] = nowIso;
    }
    return { completedAt, readAt: {} };
  }
  if (raw === null || typeof raw !== "object") return emptyUnreadSessionState();
  const record = raw as Record<string, unknown>;
  return {
    completedAt: parseTimeMap(record.completedAt),
    readAt: parseTimeMap(record.readAt),
  };
}

function sameTimeMap(a: Record<string, string>, b: Record<string, string>): boolean {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((id) => a[id] === b[id]);
}

export function mergeUnreadSessionState(a: UnreadSessionState, b: UnreadSessionState): UnreadSessionState {
  const completedAt = { ...a.completedAt };
  for (const [id, ts] of Object.entries(b.completedAt)) {
    if (!completedAt[id] || ts > completedAt[id]) completedAt[id] = ts;
  }
  const readAt = { ...a.readAt };
  for (const [id, ts] of Object.entries(b.readAt)) {
    if (!readAt[id] || ts > readAt[id]) readAt[id] = ts;
  }
  if (sameTimeMap(completedAt, a.completedAt) && sameTimeMap(readAt, a.readAt)) return a;
  return { completedAt, readAt };
}

export function unreadIdsFromState(state: UnreadSessionState): Set<string> {
  const ids = new Set<string>();
  for (const [id, completed] of Object.entries(state.completedAt)) {
    const read = state.readAt[id];
    if (!read || read < completed) ids.add(id);
  }
  return ids;
}

export function markSessionRead(state: UnreadSessionState, sessionId: string, at: string): UnreadSessionState {
  if (!sessionId) return state;
  if (state.readAt[sessionId] && state.readAt[sessionId] >= at) return state;
  return { ...state, readAt: { ...state.readAt, [sessionId]: at } };
}

export function pruneUnreadSessionState(state: UnreadSessionState, existingIds: ReadonlySet<string>): UnreadSessionState {
  let changed = false;
  const completedAt: Record<string, string> = {};
  const readAt: Record<string, string> = {};
  for (const [id, ts] of Object.entries(state.completedAt)) {
    if (!existingIds.has(id)) {
      changed = true;
      continue;
    }
    completedAt[id] = ts;
  }
  for (const [id, ts] of Object.entries(state.readAt)) {
    if (!existingIds.has(id)) {
      changed = true;
      continue;
    }
    readAt[id] = ts;
  }
  return changed ? { completedAt, readAt } : state;
}

/** 仅接受未被较新 running 事件或恢复请求覆盖的 GET 快照。 */
export function shouldApplyRunningReconciliation(
  requestRevision: number,
  currentRevision: number,
  requestId: number,
  latestRequestId: number,
): boolean {
  return requestRevision === currentRevision && requestId === latestRequestId;
}

export function applyRunningUnreadStateTransition(
  prev: UnreadSessionState,
  previousRunning: ReadonlySet<string>,
  currentRunning: ReadonlySet<string>,
  selectedSessionId: string | null,
  nowIso: string,
): UnreadSessionState {
  const completed = [...previousRunning].filter((id) => !currentRunning.has(id));
  const newlyRunning = [...currentRunning].filter((id) => !previousRunning.has(id));
  if (completed.length === 0 && newlyRunning.length === 0) return prev;
  let next = prev;
  if (completed.length > 0) {
    const completedAt = { ...next.completedAt };
    for (const id of completed) {
      if (!completedAt[id] || nowIso > completedAt[id]) completedAt[id] = nowIso;
    }
    next = { ...next, completedAt };
  }
  if (selectedSessionId) next = markSessionRead(next, selectedSessionId, nowIso);
  return next;
}
