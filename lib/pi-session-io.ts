/**
 * Pi SessionManager 磁盘读写薄封装（server-only）。
 * 取代自研 SessionFile writer/reader；列表快扫仍用 session-metadata-cache。
 */
import {
  CURRENT_SESSION_VERSION,
  SessionManager,
  type SessionHeader,
} from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { clearLeafSidecar, readLeafSidecar } from "./session-leaf-sidecar";

export { CURRENT_SESSION_VERSION };
export type { SessionHeader };

/**
 * SDK 私有（类声明中无 private 修饰、但未列入公开文档）的会话文件写入入口。
 *
 * 为何必须用它（已核实 dist/core/session-manager.d.ts 与运行时实测）：
 * - `isPersisted()` 返回的是「启用了持久化」，**不是**「已写盘」
 *   （无 assistant 时文件不存在而 isPersisted() 为 true）；
 * - `_persist(entry)` 在无 assistant 时不建文件（有 flushed 门槛）；
 * - 公开方法里没有 flush / materialize / save 之类的入口。
 * 产品要求 ensure_session 后文件立即存在（否则不在列表、无法删除），
 * 因此只能走 `_rewriteFile()`（重写全部 fileEntries，openSync(...,"w") 会建文件）
 * 与 `flushed`（置 true 后 `_persist` 才走 append 而不是缓存）。
 *
 * 集中为单一适配层：SDK 升级导致这两项消失时**明确报错**，不再静默跳过
 *（旧写法 `internal._rewriteFile?.()` 在升级后会什么也不做）。
 */
type SdkFileSurface = {
  rewriteFile: () => void;
  markFlushed: () => void;
};

export const SDK_SESSION_FILE_SURFACE_MISSING =
  "Pi SDK 未提供会话文件写入入口（_rewriteFile / flushed）。请检查 @earendil-works/pi-coding-agent 版本（当前基线 0.85.1）与 pi-session-io 适配层。";

function readSdkFileSurface(manager: SessionManager): SdkFileSurface | null {
  const internal = manager as unknown as {
    _rewriteFile?: unknown;
    flushed?: unknown;
  };
  if (typeof internal._rewriteFile !== "function") return null;
  return {
    rewriteFile: () => (internal._rewriteFile as () => void).call(manager),
    markFlushed: () => {
      internal.flushed = true;
    },
  };
}

/** 供升级自检使用：SDK 是否仍提供这两项入口。 */
export function hasSdkFileSurface(manager: SessionManager): boolean {
  return readSdkFileSurface(manager) !== null;
}

function requireSdkFileSurface(manager: SessionManager): SdkFileSurface {
  const surface = readSdkFileSurface(manager);
  if (!surface) throw new Error(SDK_SESSION_FILE_SURFACE_MISSING);
  return surface;
}

/**
 * Pi 在首条 assistant 前延迟落盘；Web 列表/删除需要文件立即存在。
 */
export function materializeSessionFile(manager: SessionManager): void {
  const file = manager.getSessionFile();
  if (!file) return;
  const surface = requireSdkFileSurface(manager);
  if (!existsSync(file)) {
    surface.rewriteFile();
  }
  // 与 Pi 首条 assistant 落盘路径对齐：文件已存在时须标 flushed，否则后续 wx 会 EEXIST
  if (existsSync(file)) {
    surface.markFlushed();
  }
}

/**
 * 打开会话文件；若有 leaf sidecar 且 entry 有效，branch 到该 leaf。
 */
export function openSessionManager(
  path: string,
  sessionDir?: string,
): SessionManager {
  const manager = SessionManager.open(path, sessionDir);
  const expected = readLeafSidecar(path);
  if (expected && manager.getEntry(expected)) {
    const leaf = manager.getLeafId();
    if (leaf !== expected) {
      try {
        manager.branch(expected);
      } catch {
        clearLeafSidecar(path);
      }
    }
  } else if (expected) {
    clearLeafSidecar(path);
  }
  return manager;
}

/**
 * 创建内存会话。默认不落盘（与 Pi 一致：首条 assistant 前可不写文件）。
 * 需要立即出现在会话列表/可删除时，调用方再 materializeSessionFile。
 * 产品路径：ensure_session 不落盘；首次 prompt 成功后再 materialize，避免侧栏堆「无消息」空会话。
 */
export function createSessionManager(
  cwd: string,
  sessionDir?: string,
): SessionManager {
  return SessionManager.create(cwd, sessionDir);
}

/** 只读视图：与 session-reader SessionManagerReadView 对齐 */
export type DiskSessionReadView = {
  getEntries(): unknown[];
  getLeafId(): string | null;
  getTree(): ReturnType<SessionManager["getTree"]>;
  getHeader(): SessionHeader | null;
  getSessionName(): string | undefined;
  getSessionId(): string;
  getSessionFile(): string | undefined;
  getCwd(): string;
  getEntry(id: string): ReturnType<SessionManager["getEntry"]>;
  getBranch(fromId?: string): ReturnType<SessionManager["getBranch"]>;
  buildSessionContext(): ReturnType<SessionManager["buildSessionContext"]>;
  appendSessionInfo(name: string): string;
  appendCustomEntry(customType: string, data?: unknown): string;
  appendModelChange(provider: string, modelId: string): string;
  branch(targetId: string): void;
  createBranchedSession(leafId: string): string | undefined;
  getSessionDir(): string;
  getLastEntryId(): string | null;
};

function lastEntryId(manager: SessionManager): string | null {
  const entries = manager.getEntries();
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e && typeof e === "object" && "id" in e && typeof (e as { id: unknown }).id === "string") {
      return (e as { id: string }).id;
    }
  }
  return null;
}

export function asDiskSessionView(manager: SessionManager): DiskSessionReadView {
  return {
    getEntries: () => manager.getEntries(),
    getLeafId: () => manager.getLeafId(),
    getTree: () => manager.getTree(),
    getHeader: () => manager.getHeader(),
    getSessionName: () => manager.getSessionName(),
    getSessionId: () => manager.getSessionId(),
    getSessionFile: () => manager.getSessionFile(),
    getCwd: () => manager.getCwd(),
    getEntry: (id) => manager.getEntry(id),
    getBranch: (fromId) =>
      fromId === undefined ? manager.getBranch() : manager.getBranch(fromId),
    buildSessionContext: () => manager.buildSessionContext(),
    appendSessionInfo: (name) => manager.appendSessionInfo(name),
    appendCustomEntry: (customType, data) =>
      manager.appendCustomEntry(customType, data),
    appendModelChange: (provider, modelId) =>
      manager.appendModelChange(provider, modelId),
    branch: (targetId) => manager.branch(targetId),
    createBranchedSession: (leafId) => manager.createBranchedSession(leafId),
    getSessionDir: () => manager.getSessionDir(),
    getLastEntryId: () => lastEntryId(manager),
  };
}

export function openSessionView(
  path: string,
  sessionDir?: string,
): DiskSessionReadView {
  return asDiskSessionView(openSessionManager(path, sessionDir));
}

/**
 * Rewrite parentSession through Pi SessionManager. Header is the same object
 * getHeader() returns; _rewriteFile is the manager's atomic JSONL writer.
 */
export function reparentSessionFile(
  filePath: string,
  parentSession: string | undefined,
): void {
  const manager = openSessionManager(filePath);
  const header = manager.getHeader();
  if (!header || header.type !== "session") return;
  if (parentSession) header.parentSession = parentSession;
  else delete header.parentSession;
  // 与 materialize 共用同一适配层：缺失时抛错，不让「重挂父子关系」静默失败
  // （静默失败会让子会话一直指向已被删的父会话）。
  const surface = requireSdkFileSurface(manager);
  surface.rewriteFile();
  if (existsSync(filePath)) surface.markFlushed();
}
