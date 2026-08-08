/**
 * 会话全文搜索（只读）。
 *
 * 优先以 immutable 方式打开 pi-hermes-memory 的 sessions.db，走 message_fts FTS5；
 * DB 缺失/打开失败/运行时无 node:sqlite 时，降级为有界 JSONL 扫描。
 * 全程禁止写入（含 WAL）；不修改 Pi 原生 schema。
 */

import { createReadStream, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { getAgentDir } from "./pi-paths";

export type SessionSearchSource = "fts" | "jsonl" | "none";

export interface SessionSearchHit {
  readonly sessionId: string;
  readonly role?: string;
  readonly snippet: string;
  readonly timestamp: string;
  /** hermes messages.id 或 JSONL entry id（若有）。 */
  readonly messageId?: string;
}

export interface SessionSearchResult {
  readonly query: string;
  readonly source: SessionSearchSource;
  readonly hits: readonly SessionSearchHit[];
  /** 按时间降序去重后的会话 id（侧栏过滤用）。 */
  readonly sessionIds: readonly string[];
}

export interface SessionSearchLimits {
  readonly maxHits: number;
  readonly maxFiles: number;
  readonly maxBytesPerFile: number;
  readonly maxTotalBytes: number;
  readonly snippetRadius: number;
}

export const DEFAULT_SEARCH_LIMITS: SessionSearchLimits = {
  maxHits: 40,
  maxFiles: 120,
  maxBytesPerFile: 2 * 1024 * 1024,
  maxTotalBytes: 32 * 1024 * 1024,
  snippetRadius: 48,
};

export type SessionFulltextSearchDeps = {
  getAgentDir: () => string;
  resolveHermesDbPath: (agentDir: string) => string | null;
  openSqliteReadonly: (dbPath: string) => SqliteReadonly | null;
  listJsonlFiles: (sessionsRoot: string) => string[];
  scanJsonlFile: (
    filePath: string,
    query: string,
    limits: Pick<SessionSearchLimits, "maxBytesPerFile" | "snippetRadius">,
  ) => Promise<readonly SessionSearchHit[]>;
  existsSync: (path: string) => boolean;
};

/** 最小 SQLite 只读面，便于测试注入。 */
export type SqliteReadonly = {
  prepare: (sql: string) => {
    all: (...params: unknown[]) => unknown[];
  };
  close: () => void;
};

const FTS5_OPERATOR_PATTERN = /\b(OR|AND|NOT|NEAR)\b/;
const FTS5_TOKEN_PATTERN = /"([^"]*)"|(\S+)/g;
const NATURAL_LANGUAGE_CONNECTORS = new Set(["and", "or", "not", "near"]);

/** 查询归一化（展示/空查询判定用）。 */
export function normalizeFulltextQuery(query: string): string {
  return query.trim();
}

/**
 * 将自然语言查询转为 FTS5 MATCH 表达式（镜像 pi-hermes-memory fts-query）：
 * 普通词逐个加引号隐式 AND；显式大写算子原样透传。
 */
export function normalizeFts5Query(query: string): string {
  const trimmed = query.trim();
  if (!trimmed) return "";
  if (FTS5_OPERATOR_PATTERN.test(trimmed)) return trimmed;
  const terms: string[] = [];
  for (const match of trimmed.matchAll(FTS5_TOKEN_PATTERN)) {
    const phrase = match[1];
    const term = match[2];
    if (phrase === undefined && term && NATURAL_LANGUAGE_CONNECTORS.has(term.toLowerCase())) {
      continue;
    }
    const raw = phrase ?? term ?? "";
    if (raw.length > 0) terms.push(raw);
  }
  return terms.map((term) => `"${term.replace(/"/g, '""')}"`).join(" ");
}

/** 多词失败时 OR 回退；单词或显式算子返回 null。 */
export function buildFallbackFts5Query(query: string): string | null {
  const trimmed = query.trim();
  if (!trimmed || FTS5_OPERATOR_PATTERN.test(trimmed)) return null;
  const terms: string[] = [];
  for (const match of trimmed.matchAll(FTS5_TOKEN_PATTERN)) {
    const phrase = match[1];
    const term = match[2];
    if (phrase === undefined && term && NATURAL_LANGUAGE_CONNECTORS.has(term.toLowerCase())) {
      continue;
    }
    const raw = phrase ?? term ?? "";
    if (raw.length > 0) terms.push(raw);
  }
  if (terms.length <= 1) return null;
  return terms.map((term) => `"${term.replace(/"/g, '""')}"`).join(" OR ");
}

export function isFts5QueryError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return msg.includes("fts5") || msg.includes("unterminated string") || msg.includes("syntax error");
}

/** 从命中正文截取片段，尽量以 query 为中心。 */
export function buildSnippet(content: string, query: string, radius = DEFAULT_SEARCH_LIMITS.snippetRadius): string {
  const text = content.replace(/\s+/g, " ").trim();
  if (!text) return "";
  const needle = query.trim();
  if (!needle) return text.slice(0, radius * 2);
  const lower = text.toLowerCase();
  const idx = lower.indexOf(needle.toLowerCase());
  if (idx < 0) {
    return text.length > radius * 2 ? `${text.slice(0, radius * 2)}…` : text;
  }
  const start = Math.max(0, idx - radius);
  const end = Math.min(text.length, idx + needle.length + radius);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < text.length ? "…" : "";
  return `${prefix}${text.slice(start, end)}${suffix}`;
}

/**
 * 解析 hermes DB 路径：优先 config memoryDir，否则默认
 * `<agentDir>/pi-hermes-memory/sessions.db`。
 */
export function resolveHermesSessionsDbPath(
  agentDir: string,
  exists: (path: string) => boolean = existsSync,
): string | null {
  const configPath = join(agentDir, "hermes-memory-config.json");
  if (exists(configPath)) {
    try {
      // 同步读配置：仅用于定位只读 DB，不缓存写入。
      const raw = JSON.parse(readFileSync(configPath, "utf8")) as { memoryDir?: unknown };
      if (typeof raw.memoryDir === "string" && raw.memoryDir.trim()) {
        const dir = expandHomePath(raw.memoryDir.trim(), agentDir);
        const candidate = join(dir, "sessions.db");
        if (exists(candidate) && isNonEmptyFile(candidate, exists)) return candidate;
      }
    } catch {
      // 配置损坏时忽略，走默认路径。
    }
  }
  const defaults = [
    join(agentDir, "pi-hermes-memory", "sessions.db"),
    join(agentDir, "memory", "sessions.db"),
  ];
  for (const candidate of defaults) {
    if (exists(candidate) && isNonEmptyFile(candidate, exists)) return candidate;
  }
  return null;
}

function expandHomePath(input: string, agentDir: string): string {
  if (input === "~") return process.env.HOME ?? agentDir;
  if (input.startsWith("~/") || input.startsWith("~\\")) {
    return join(process.env.HOME ?? agentDir, input.slice(2));
  }
  if (input.startsWith("/") || /^[A-Za-z]:[\\/]/.test(input)) return input;
  return join(agentDir, input);
}

function isNonEmptyFile(path: string, exists: (path: string) => boolean): boolean {
  if (!exists(path)) return false;
  try {
    return statSync(path).isFile() && statSync(path).size > 0;
  } catch {
    return false;
  }
}

/** 加载 node:sqlite（实验特性）。Next/Turbopack 下裸 require 可能失败，改用 createRequire。 */
function loadDatabaseSync(): (new (path: string, options?: { readOnly?: boolean }) => SqliteReadonly) | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("node:sqlite") as { DatabaseSync?: new (path: string, options?: { readOnly?: boolean }) => SqliteReadonly };
    if (typeof mod?.DatabaseSync === "function") return mod.DatabaseSync;
  } catch {
    // fall through
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { createRequire } = require("node:module") as typeof import("node:module");
    const req = createRequire(typeof __filename !== "undefined" ? __filename : join(process.cwd(), "lib/session-fulltext-search.ts"));
    const mod = req("node:sqlite") as { DatabaseSync?: new (path: string, options?: { readOnly?: boolean }) => SqliteReadonly };
    if (typeof mod?.DatabaseSync === "function") return mod.DatabaseSync;
  } catch {
    // fall through
  }
  return null;
}

/**
 * 以只读方式打开 SQLite。
 * 优先 URI `mode=ro&immutable=1`（不碰 WAL、不产生写入）；失败再试 path + readOnly。
 */
export function openSqliteImmutable(dbPath: string): SqliteReadonly | null {
  const DatabaseSync = loadDatabaseSync();
  if (!DatabaseSync) return null;
  const normalized = dbPath.replace(/\\/g, "/");
  const uri = `file:${normalized}?mode=ro&immutable=1`;
  try {
    return new DatabaseSync(uri, { readOnly: true });
  } catch {
    // immutable 在部分运行时/带 WAL 的库上可能失败；仍用只读 path 打开。
  }
  try {
    return new DatabaseSync(dbPath, { readOnly: true });
  } catch {
    return null;
  }
}

type FtsRow = {
  session_id: string;
  role: string;
  content: string;
  timestamp: string;
  message_id: string;
  snippet: string;
};

function searchFts(
  db: SqliteReadonly,
  query: string,
  maxHits: number,
): SessionSearchHit[] {
  const run = (matchQuery: string): SessionSearchHit[] => {
    const sql = `
      SELECT
        m.session_id AS session_id,
        m.role AS role,
        m.content AS content,
        m.timestamp AS timestamp,
        m.id AS message_id,
        snippet(message_fts, 0, '«', '»', '…', 12) AS snippet
      FROM message_fts
      JOIN messages m ON m.rowid = message_fts.rowid
      WHERE message_fts MATCH ?
      ORDER BY m.timestamp DESC
      LIMIT ?
    `;
    try {
      const rows = db.prepare(sql).all(matchQuery, maxHits) as FtsRow[];
      return rows
        .filter((row) => typeof row.session_id === "string" && row.session_id)
        .map((row) => ({
          sessionId: row.session_id,
          role: typeof row.role === "string" ? row.role : undefined,
          snippet: (typeof row.snippet === "string" && row.snippet.trim())
            ? row.snippet.trim()
            : buildSnippet(String(row.content ?? ""), query),
          timestamp: typeof row.timestamp === "string" ? row.timestamp : "",
          messageId: typeof row.message_id === "string" ? row.message_id : undefined,
        }));
    } catch (err) {
      if (isFts5QueryError(err)) return [];
      throw err;
    }
  };

  const primary = normalizeFts5Query(query);
  if (!primary) return [];
  const exact = run(primary);
  if (exact.length > 0) return exact;
  if (FTS5_OPERATOR_PATTERN.test(query.trim())) return exact;
  const fallback = buildFallbackFts5Query(query);
  if (fallback && fallback !== primary) {
    const rows = run(fallback);
    if (rows.length > 0) return rows;
  }
  // FTS 无结果时用 LIKE 回退（仍只读）。
  try {
    const likeSql = `
      SELECT
        m.session_id AS session_id,
        m.role AS role,
        m.content AS content,
        m.timestamp AS timestamp,
        m.id AS message_id,
        m.content AS snippet
      FROM messages m
      WHERE m.content LIKE ? ESCAPE '\\'
      ORDER BY m.timestamp DESC
      LIMIT ?
    `;
    const needle = `%${query.trim().replace(/[\\%_]/g, "\\$&")}%`;
    const rows = db.prepare(likeSql).all(needle, maxHits) as FtsRow[];
    return rows
      .filter((row) => typeof row.session_id === "string" && row.session_id)
      .map((row) => ({
        sessionId: row.session_id,
        role: typeof row.role === "string" ? row.role : undefined,
        snippet: buildSnippet(String(row.content ?? ""), query),
        timestamp: typeof row.timestamp === "string" ? row.timestamp : "",
        messageId: typeof row.message_id === "string" ? row.message_id : undefined,
      }));
  } catch {
    return [];
  }
}

/** 从 JSONL 行中提取可搜索文本（user/assistant 消息正文）。 */
export function extractSearchableTextFromJsonlLine(line: string): {
  sessionId?: string;
  messageId?: string;
  role?: string;
  timestamp?: string;
  text: string;
} | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed[0] !== "{") return null;
  let entry: unknown;
  try {
    entry = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!entry || typeof entry !== "object") return null;
  const record = entry as Record<string, unknown>;
  if (record.type === "session" && typeof record.id === "string") {
    return { sessionId: record.id, text: "" };
  }
  if (record.type !== "message") return null;
  const message = record.message;
  if (!message || typeof message !== "object") return null;
  const msg = message as Record<string, unknown>;
  const role = typeof msg.role === "string" ? msg.role : undefined;
  if (role !== "user" && role !== "assistant" && role !== "system") return null;
  const text = flattenMessageContent(msg.content);
  if (!text) return null;
  return {
    messageId: typeof record.id === "string" ? record.id : undefined,
    role,
    timestamp: typeof record.timestamp === "string"
      ? record.timestamp
      : (typeof msg.timestamp === "string" ? msg.timestamp : undefined),
    text,
  };
}

function flattenMessageContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === "string") {
      parts.push(block);
      continue;
    }
    if (!block || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    if (typeof b.text === "string") parts.push(b.text);
    else if (typeof b.content === "string") parts.push(b.content);
    else if (typeof b.thinking === "string") parts.push(b.thinking);
  }
  return parts.join("\n").trim();
}

/** 从会话文件路径推断 session id（`<ts>_<uuid>.jsonl`）。 */
export function sessionIdFromJsonlPath(filePath: string): string | null {
  const base = filePath.replace(/\\/g, "/").split("/").pop() ?? "";
  const m = base.match(/_([0-9a-fA-F-]{8,})\.jsonl$/);
  return m?.[1] ?? null;
}

export async function scanJsonlFileForQuery(
  filePath: string,
  query: string,
  limits: Pick<SessionSearchLimits, "maxBytesPerFile" | "snippetRadius"> = DEFAULT_SEARCH_LIMITS,
): Promise<SessionSearchHit[]> {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  let size = 0;
  try {
    size = statSync(filePath).size;
  } catch {
    return [];
  }
  if (size <= 0 || size > limits.maxBytesPerFile) return [];

  const hits: SessionSearchHit[] = [];
  let sessionId = sessionIdFromJsonlPath(filePath);
  let bytesRead = 0;
  const stream = createReadStream(filePath, { encoding: "utf8" });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      bytesRead += Buffer.byteLength(line, "utf8") + 1;
      if (bytesRead > limits.maxBytesPerFile) break;
      const parsed = extractSearchableTextFromJsonlLine(line);
      if (!parsed) continue;
      if (parsed.sessionId) {
        sessionId = parsed.sessionId;
        continue;
      }
      if (!sessionId || !parsed.text.toLowerCase().includes(needle)) continue;
      hits.push({
        sessionId,
        role: parsed.role,
        snippet: buildSnippet(parsed.text, query, limits.snippetRadius),
        timestamp: parsed.timestamp ?? "",
        messageId: parsed.messageId,
      });
    }
  } catch {
    // 单文件损坏不影响其它文件。
  } finally {
    rl.close();
    stream.destroy();
  }
  return hits;
}

/** 递归列出 sessions 根下 .jsonl（有界）。 */
export function listSessionJsonlFiles(sessionsRoot: string, maxFiles: number): string[] {
  if (!existsSync(sessionsRoot)) return [];
  const out: string[] = [];
  const walk = (dir: string) => {
    if (out.length >= maxFiles) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    // 优先较新文件：按名称大致时间序倒序。
    entries.sort((a, b) => b.name.localeCompare(a.name));
    for (const entry of entries) {
      if (out.length >= maxFiles) return;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith(".jsonl")) out.push(full);
    }
  };
  walk(sessionsRoot);
  return out;
}

function uniqueSessionIds(hits: readonly SessionSearchHit[]): string[] {
  const seen = new Set<string>();
  const ids: string[] = [];
  // hits 已按时间降序时，先出现的即最新。
  for (const hit of hits) {
    if (seen.has(hit.sessionId)) continue;
    seen.add(hit.sessionId);
    ids.push(hit.sessionId);
  }
  return ids;
}

function defaultDeps(): SessionFulltextSearchDeps {
  return {
    getAgentDir,
    resolveHermesDbPath: (agentDir) => resolveHermesSessionsDbPath(agentDir),
    openSqliteReadonly: openSqliteImmutable,
    listJsonlFiles: (root) => listSessionJsonlFiles(root, DEFAULT_SEARCH_LIMITS.maxFiles),
    scanJsonlFile: scanJsonlFileForQuery,
    existsSync,
  };
}

/**
 * 执行全文搜索：FTS 优先，失败则有界 JSONL 降级。
 * 纯编排、可注入 deps；默认实现只读。
 */
export async function searchSessionsFulltext(
  rawQuery: string,
  options: {
    limits?: Partial<SessionSearchLimits>;
    deps?: Partial<SessionFulltextSearchDeps>;
  } = {},
): Promise<SessionSearchResult> {
  const query = normalizeFulltextQuery(rawQuery);
  const limits: SessionSearchLimits = { ...DEFAULT_SEARCH_LIMITS, ...options.limits };
  const deps: SessionFulltextSearchDeps = { ...defaultDeps(), ...options.deps };

  if (!query) {
    return { query: "", source: "none", hits: [], sessionIds: [] };
  }

  const agentDir = deps.getAgentDir();
  const dbPath = deps.resolveHermesDbPath(agentDir);
  if (dbPath) {
    const db = deps.openSqliteReadonly(dbPath);
    if (db) {
      try {
        const hits = searchFts(db, query, limits.maxHits);
        return {
          query,
          source: "fts",
          hits,
          sessionIds: uniqueSessionIds(hits),
        };
      } catch {
        // 打开成功但查询失败 → 降级 JSONL
      } finally {
        try {
          db.close();
        } catch {
          // ignore
        }
      }
    }
  }

  // JSONL 降级：限定会话根、文件数与字节数。
  const sessionsRoot = join(agentDir, "sessions");
  if (!deps.existsSync(sessionsRoot)) {
    return { query, source: "jsonl", hits: [], sessionIds: [] };
  }
  const files = deps.listJsonlFiles(sessionsRoot).slice(0, limits.maxFiles);
  const hits: SessionSearchHit[] = [];
  let totalBytes = 0;
  for (const file of files) {
    if (hits.length >= limits.maxHits) break;
    let size = 0;
    try {
      size = statSync(file).size;
    } catch {
      continue;
    }
    if (size <= 0) continue;
    if (totalBytes + size > limits.maxTotalBytes) break;
    totalBytes += size;
    const fileHits = await deps.scanJsonlFile(file, query, limits);
    for (const hit of fileHits) {
      hits.push(hit);
      if (hits.length >= limits.maxHits) break;
    }
  }
  hits.sort((a, b) => (b.timestamp || "").localeCompare(a.timestamp || ""));
  return {
    query,
    source: "jsonl",
    hits: hits.slice(0, limits.maxHits),
    sessionIds: uniqueSessionIds(hits),
  };
}
