/**
 * 本标签页记着「上次在看哪个会话」（issue #81 第 5 项 / 上游 #887）。
 *
 * 用 `sessionStorage` 而不是 `localStorage`：后者同源共享，一个窗口切会话会把
 * 其它窗口一起拖过去（上游正是这么踩的）。这里只负责「本标签页自己的记忆」。
 *
 * 地址栏的 `?session=` 仍是权威，这份记忆只在 URL 既没有 `session` 也没有 `cwd` 时兜底，
 * 而且是**软提示**：记住的会话如果已经不存在，调用方应当清掉它并按裸地址走，
 * 而不是停在「会话未找到」。
 */

export const TAB_SESSION_STORAGE_KEY = "pidance:active-session";

export type TabSessionStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

/** 只接受像会话 id 的字符串：非空、无空白、长度有上限；其余一律视为没记住。 */
export function parseRememberedSessionId(raw: string | null): string | null {
  if (typeof raw !== "string") return null;
  const id = raw.trim();
  if (!id || id.length > 128 || /\s/.test(id)) return null;
  return id;
}

export function loadRememberedSessionId(storage: TabSessionStorage | null | undefined): string | null {
  if (!storage) return null;
  try {
    return parseRememberedSessionId(storage.getItem(TAB_SESSION_STORAGE_KEY));
  } catch {
    // 存储不可用（隐私模式/被禁用）：当作没记住，不影响导航。
    return null;
  }
}

export function saveRememberedSessionId(storage: TabSessionStorage | null | undefined, sessionId: string): void {
  if (!storage) return;
  const id = parseRememberedSessionId(sessionId);
  if (!id) return;
  try {
    storage.setItem(TAB_SESSION_STORAGE_KEY, id);
  } catch {
    // 配额/隐私模式：记忆是可选优化，失败即静默降级。
  }
}

export function clearRememberedSessionId(storage: TabSessionStorage | null | undefined): void {
  if (!storage) return;
  try {
    storage.removeItem(TAB_SESSION_STORAGE_KEY);
  } catch {
    /* 同上 */
  }
}

/**
 * 按地址栏 query 同步记忆：`?session=<id>` 记下，其余（`/`、清空会话的场景）清掉。
 *
 * 由 AppShell 的 `syncUrl` 单点调用，所以「切会话 / 新建 / 删除」都自动保持一致，
 * 不需要在每个调用点各写一遍。
 */
export function syncRememberedSessionFromQuery(query: string, storage: TabSessionStorage | null | undefined): void {
  if (!storage) return;
  let id: string | null = null;
  try {
    id = parseRememberedSessionId(new URLSearchParams(query.startsWith("?") ? query : `?${query.replace(/^\/\??/, "")}`).get("session"));
  } catch {
    id = null;
  }
  if (id) saveRememberedSessionId(storage, id);
  else clearRememberedSessionId(storage);
}

function browserStorage(): TabSessionStorage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

export function loadRememberedTabSessionId(): string | null {
  return loadRememberedSessionId(browserStorage());
}

export function rememberTabSessionFromQuery(query: string): void {
  syncRememberedSessionFromQuery(query, browserStorage());
}

export function rememberTabSessionId(sessionId: string): void {
  saveRememberedSessionId(browserStorage(), sessionId);
}

export function forgetRememberedTabSessionId(): void {
  clearRememberedSessionId(browserStorage());
}
