/**
 * 归档状态存储与服务层（P0-2 归档功能）。
 *
 * 设计要点：
 * - 独立 sidecar 目录 `~/.pi/agent/pidance-archive/<session-id>.json`，版本 1；
 * - 绝不写 Pi `.jsonl`、不改 header/parentSession/fork/subagent 关系；
 * - 每会话单文件、同目录临时文件 + rename 原子写；
 * - 文件名校验（UUID/session id 字符集）、读取字节上限、JSON 损坏安全跳过；
 * - sidecar 目录只允许普通目录，不跟随 symlink；记录不因损坏/越权拖垮列表。
 *
 * 本模块只做记录 IO 与纯逻辑（Fs 注入，便于测试），组合动作
 * （archiveSession / restoreSession / 批量）经 createArchiveActions(deps)
 * 注入会话服务能力，由 lib/session-service.ts 组装，Route Handler 保持薄。
 */

import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { getAgentDir } from "./pi-paths";
import type { SessionHeader, SessionInfo } from "./types";

export interface ArchiveRecord {
  version: 1;
  sessionId: string;
  sessionPath: string;
  archivedAt: string;
}

/** 单条记录读取字节上限（损坏/超限安全跳过）。 */
export const ARCHIVE_RECORD_MAX_BYTES = 64 * 1024;
/** 记录列表内存缓存 TTL（ms）。 */
const ARCHIVE_RECORDS_CACHE_TTL_MS = 5_000;

// ---------------------------------------------------------------------------
// Fs 注入（测试用 fake fs 可替换；生产用 realArchiveFs）
// ---------------------------------------------------------------------------

export interface SessionArchiveFs {
  existsSync(path: string): boolean;
  lstatSync(path: string): { isDirectory(): boolean; isSymbolicLink(): boolean };
  mkdirSync(path: string, options?: { recursive?: boolean }): void;
  readFileSync(path: string, encoding: "utf8"): string;
  writeFileSync(path: string, data: string, options?: { encoding: "utf8"; flag?: string }): void;
  renameSync(oldPath: string, newPath: string): void;
  unlinkSync(path: string): void;
  readdirSync(path: string): string[];
}

export const realArchiveFs: SessionArchiveFs = {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync: (path, encoding) => readFileSync(path, encoding),
  writeFileSync: (path, data, options) => writeFileSync(path, data, options),
  renameSync,
  unlinkSync,
  readdirSync,
};

// ---------------------------------------------------------------------------
// 目录与文件名校验
// ---------------------------------------------------------------------------

/** sidecar 目录路径（sessions 目录之外，不影响 Pi 会话扫描）。 */
export function archiveDirPath(agentDir: string = getAgentDir()): string {
  return join(agentDir, "pidance-archive");
}

/**
 * 校验 session id 字符集并生成 sidecar 文件名。
 * 只允许规范 UUID / session id 字符集（8-64 位 hex + 连字符），杜绝路径穿越。
 * 非法返回 null。
 */
export function archiveFileNameFor(sessionId: string): string | null {
  if (typeof sessionId !== "string") return null;
  if (sessionId.length < 8 || sessionId.length > 64) return null;
  if (!/^[0-9a-fA-F][0-9a-fA-F-]{7,63}$/.test(sessionId)) return null;
  return `${sessionId}.json`;
}

/** 从文件名反向解析 session id；非法文件名返回 null。 */
export function sessionIdFromArchiveFileName(fileName: string): string | null {
  if (typeof fileName !== "string" || !fileName.endsWith(".json")) return null;
  const id = fileName.slice(0, -5);
  if (id.length < 8 || id.length > 64) return null;
  if (!/^[0-9a-fA-F][0-9a-fA-F-]{7,63}$/.test(id)) return null;
  return id;
}

/**
 * sidecar 目录安全检查：目录不存在时创建（mkdir -p）；
 * 已存在时必须是普通目录且非 symlink，否则拒绝使用（A7 安全降级）。
 */
export function ensureSafeArchiveDir(fs: SessionArchiveFs, agentDir: string): string | null {
  const dir = archiveDirPath(agentDir);
  try {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const st = fs.lstatSync(dir);
    if (st.isSymbolicLink() || !st.isDirectory()) return null;
    return dir;
  } catch {
    return null;
  }
}

/** 只读探测：目录不可用返回 null（不创建）。 */
function safeArchiveDirReadOnly(fs: SessionArchiveFs, agentDir: string): string | null {
  try {
    const dir = archiveDirPath(agentDir);
    if (!fs.existsSync(dir)) return null;
    const st = fs.lstatSync(dir);
    if (st.isSymbolicLink() || !st.isDirectory()) return null;
    return dir;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 记录读写
// ---------------------------------------------------------------------------

function isValidRecord(value: unknown): value is ArchiveRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  if (record.version !== 1) return false;
  if (typeof record.sessionId !== "string" || record.sessionId.length === 0) return false;
  if (typeof record.sessionPath !== "string" || record.sessionPath.length === 0) return false;
  if (typeof record.archivedAt !== "string" || Number.isNaN(Date.parse(record.archivedAt))) return false;
  return true;
}

/**
 * 读取单条记录。任何异常（不存在、symlink、超限、损坏、id 不匹配）→ null，
 * 安全跳过，不抛错（A7）。
 */
export function readArchiveRecord(fs: SessionArchiveFs, agentDir: string, sessionId: string): ArchiveRecord | null {
  const fileName = archiveFileNameFor(sessionId);
  if (!fileName) return null;
  const dir = safeArchiveDirReadOnly(fs, agentDir);
  if (!dir) return null;
  const filePath = join(dir, fileName);
  try {
    if (!fs.existsSync(filePath)) return null;
    const st = fs.lstatSync(filePath);
    if (st.isSymbolicLink()) return null;
    const raw = fs.readFileSync(filePath, "utf8");
    if (raw.length > ARCHIVE_RECORD_MAX_BYTES) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!isValidRecord(parsed)) return null;
    if (parsed.sessionId !== sessionId) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * 扫描全部合法记录；损坏/非法文件名/symlink/越权目录一律跳过（不 500）。
 * 结果带短 TTL 内存缓存（globalThis，见 AGENTS.md globalThis 表）。
 */
export function listArchiveRecords(fs: SessionArchiveFs, agentDir: string): ArchiveRecord[] {
  const cached = globalThis.__piArchiveRecordsCache;
  if (cached && Date.now() - cached.ts < ARCHIVE_RECORDS_CACHE_TTL_MS) {
    return cached.records;
  }
  const dir = safeArchiveDirReadOnly(fs, agentDir);
  const records: ArchiveRecord[] = [];
  if (dir) {
    let names: string[] = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      names = [];
    }
    for (const name of names) {
      const id = sessionIdFromArchiveFileName(name);
      if (!id) continue;
      const record = readArchiveRecord(fs, agentDir, id);
      if (record) records.push(record);
    }
  }
  globalThis.__piArchiveRecordsCache = { records, ts: Date.now() };
  return records;
}

/** 归档/恢复/永久删除后调用：使记录缓存失效。 */
export function invalidateArchiveRecordsCache(): void {
  globalThis.__piArchiveRecordsCache = undefined;
}

declare global {
  var __piArchiveRecordsCache: { records: ArchiveRecord[]; ts: number } | undefined;
}

/**
 * 原子写记录：同目录临时文件（wx 独占）→ flush（写满即 close）→ rename。
 * 写失败时清理临时文件；rename 成功后原记录被原子替换。
 */
export function writeArchiveRecord(fs: SessionArchiveFs, agentDir: string, record: ArchiveRecord): void {
  const fileName = archiveFileNameFor(record.sessionId);
  if (!fileName) throw new Error("Invalid session id");
  if (!isValidRecord(record)) throw new Error("Invalid archive record");
  const dir = ensureSafeArchiveDir(fs, agentDir);
  if (!dir) throw new Error("Archive directory unavailable");
  const targetPath = join(dir, fileName);
  const tmpPath = join(dir, `.${fileName}.${process.pid}.${Date.now().toString(36)}.tmp`);
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(record), { encoding: "utf8", flag: "wx" });
    fs.renameSync(tmpPath, targetPath);
    invalidateArchiveRecordsCache();
  } catch (error) {
    try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch { /* 清理失败忽略 */ }
    throw error;
  }
}

/**
 * 删除记录并确认删除完成。记录不存在返回 false；删除后确认目标已不存在
 * 才返回 true（服务端确认语义，D6）。
 */
export function deleteArchiveRecord(fs: SessionArchiveFs, agentDir: string, sessionId: string): boolean {
  const fileName = archiveFileNameFor(sessionId);
  if (!fileName) return false;
  const dir = safeArchiveDirReadOnly(fs, agentDir);
  if (!dir) return false;
  const filePath = join(dir, fileName);
  try {
    if (!fs.existsSync(filePath)) return false;
    fs.unlinkSync(filePath);
    invalidateArchiveRecordsCache();
    return !fs.existsSync(filePath);
  } catch {
    return false;
  }
}

/** 永久删除会话成功后同步清理对应 sidecar（幂等；D8.4）。 */
export function removeArchiveRecordAfterPermanentDelete(fs: SessionArchiveFs, agentDir: string, sessionId: string): void {
  deleteArchiveRecord(fs, agentDir, sessionId);
}

// ---------------------------------------------------------------------------
// 列表投影分区（服务端权威，客户端不读 sidecar）
// ---------------------------------------------------------------------------

/**
 * 权威归档 id 集合：会话 id 与记录 sessionPath 同时匹配才视为已归档。
 * - 记录存在且记录 sessionPath 与真实会话 path 一致 → id 入集（archived）
 * - 记录存在但 path 不一致 → 视为失效记录：会话保持 active，不隐藏正常会话（A7）
 * - 无记录 → 不入集（active）
 * 列表投影（partitionSessionsByArchiveState）与全文搜索（search route）共用此
 * 判定，保证会话移动/重建/恢复等 stale sidecar 场景下侧栏与搜索三处视图一致。
 */
export function archivedSessionIdsFor(
  sessions: readonly SessionInfo[],
  records: readonly ArchiveRecord[],
): Set<string> {
  const byId = new Map<string, ArchiveRecord>();
  for (const record of records) byId.set(record.sessionId, record);
  const archivedIds = new Set<string>();
  for (const session of sessions) {
    const record = byId.get(session.id);
    if (record && record.sessionPath === session.path) archivedIds.add(session.id);
  }
  return archivedIds;
}

/**
 * 按 scope 过滤候选会话 id 集合（全文搜索 route 用）：
 * - active：保留不在权威归档集合中的 id
 * - archived：只保留权威归档集合中的 id
 * 候选 id 若不在真实会话列表中（索引孤儿）→ 不入权威集合 → active 保留、
 * archived 排除，与「无记录 → active」语义一致。
 */
export function filterSessionIdsByArchiveScope(
  candidateIds: readonly string[],
  sessions: readonly SessionInfo[],
  records: readonly ArchiveRecord[],
  scope: "active" | "archived",
): Set<string> {
  const archivedIds = archivedSessionIdsFor(sessions, records);
  const kept = new Set<string>();
  for (const id of candidateIds) {
    const isArchived = archivedIds.has(id);
    if (scope === "active" ? !isArchived : isArchived) kept.add(id);
  }
  return kept;
}

/**
 * 将全部真实会话按归档状态分区（复用 archivedSessionIdsFor 权威判定）：
 * - 记录存在且记录 sessionPath 与真实会话 path 一致 → archived（附加 archivedAt）
 * - 其余 → active
 * 只读 subagent 子会话同样按记录分区（可归档普通会话；subagent 默认不可归档由
 * archiveSession 的 readOnly 门禁保证）。
 */
export function partitionSessionsByArchiveState(
  sessions: readonly SessionInfo[],
  records: readonly ArchiveRecord[],
): { active: SessionInfo[]; archived: SessionInfo[] } {
  const archivedIds = archivedSessionIdsFor(sessions, records);
  const byId = new Map<string, ArchiveRecord>();
  for (const record of records) byId.set(record.sessionId, record);
  const active: SessionInfo[] = [];
  const archived: SessionInfo[] = [];
  for (const session of sessions) {
    if (archivedIds.has(session.id)) {
      const record = byId.get(session.id);
      archived.push({ ...session, archivedAt: record ? record.archivedAt : undefined });
    } else {
      active.push(session);
    }
  }
  return { active, archived };
}

// ---------------------------------------------------------------------------
// 组合动作（依赖注入；由 session-service 组装）
// ---------------------------------------------------------------------------

export class ArchiveConflictError extends Error {
  constructor() {
    super("Session is running; cannot archive while active");
  }
  override toString() {
    return this.message;
  }
}

export interface ArchiveActionDeps {
  fs?: SessionArchiveFs;
  agentDir?: () => string;
  resolveSessionPath(sessionId: string): Promise<string | null>;
  readSessionHeader(filePath: string): SessionHeader | null;
  isReadOnly(sessionId: string): Promise<boolean>;
  isRunning(sessionId: string): boolean;
  getSessionInfo(sessionId: string): Promise<SessionInfo | null>;
  invalidateSessionListCache(): void;
  /** 返回 ISO 时间字符串（可注入固定值便于测试）。 */
  now(): string;
}

export interface ArchiveActionResult {
  succeededIds: string[];
  failed: Array<{ id: string; error: string }>;
}

export interface ArchiveActions {
  archiveSession(sessionId: string): Promise<string>;
  restoreSession(sessionId: string): Promise<SessionInfo | null>;
  archiveSessions(sessionIds: string[]): Promise<ArchiveActionResult>;
  restoreSessions(sessionIds: string[]): Promise<ArchiveActionResult>;
}

export function createArchiveActions(deps: ArchiveActionDeps): ArchiveActions {
  const fs = deps.fs ?? realArchiveFs;
  const agentDir = () => deps.agentDir?.() ?? getAgentDir();

  const isArchivedRecord = (sessionId: string): boolean =>
    readArchiveRecord(fs, agentDir(), sessionId) !== null;

  const archiveSession = async (sessionId: string): Promise<string> => {
    // 1. 拒绝只读 subagent（复用 session-service 门禁语义）
    if (await deps.isReadOnly(sessionId)) {
      throw new Error("Subagent sessions are read-only");
    }
    // 2. running 会话拒绝归档，不自动 abort（409 语义由调用方映射）
    if (deps.isRunning(sessionId)) {
      throw new ArchiveConflictError();
    }
    // 3. 解析真实会话 + 验证 .jsonl header id
    const filePath = await deps.resolveSessionPath(sessionId);
    if (!filePath) throw new Error("Session not found");
    const header = deps.readSessionHeader(filePath);
    if (!header || header.id !== sessionId) {
      throw new Error("Session header id mismatch");
    }
    // 4. 原子写 sidecar
    const record: ArchiveRecord = {
      version: 1,
      sessionId,
      sessionPath: filePath,
      archivedAt: deps.now(),
    };
    writeArchiveRecord(fs, agentDir(), record);
    // 5. 失效列表缓存（客户端 SWR 由刷新代际自然失效）
    deps.invalidateSessionListCache();
    return record.archivedAt;
  };

  const restoreSession = async (sessionId: string): Promise<SessionInfo | null> => {
    // 1. 验证记录存在
    if (!isArchivedRecord(sessionId)) throw new Error("Session is not archived");
    // 2. 验证真实会话仍存在
    const filePath = await deps.resolveSessionPath(sessionId);
    if (!filePath) throw new Error("Session not found");
    // 3. 删除 sidecar 并确认删除完成
    const removed = deleteArchiveRecord(fs, agentDir(), sessionId);
    if (!removed) throw new Error("Failed to remove archive record");
    // 4. 失效列表缓存
    deps.invalidateSessionListCache();
    // 5. 返回恢复后的 SessionInfo（archivedAt 字段自然消失）
    return deps.getSessionInfo(sessionId);
  };

  const archiveSessions = async (sessionIds: string[]): Promise<ArchiveActionResult> => {
    const succeededIds: string[] = [];
    const failed: Array<{ id: string; error: string }> = [];
    for (const sessionId of sessionIds) {
      try {
        await archiveSession(sessionId);
        succeededIds.push(sessionId);
      } catch (error) {
        failed.push({ id: sessionId, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return { succeededIds, failed };
  };

  const restoreSessions = async (sessionIds: string[]): Promise<ArchiveActionResult> => {
    const succeededIds: string[] = [];
    const failed: Array<{ id: string; error: string }> = [];
    for (const sessionId of sessionIds) {
      try {
        await restoreSession(sessionId);
        succeededIds.push(sessionId);
      } catch (error) {
        failed.push({ id: sessionId, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return { succeededIds, failed };
  };

  return { archiveSession, restoreSession, archiveSessions, restoreSessions };
}
