/**
 * 自有会话 JSONL 读写（不依赖 SessionManager、不依赖 pi npm）。
 * 覆盖管理面与外部 RPC 树写所需最小面：
 * open / create / branch / createBranchedSession / append 系列 / get 系列。
 *
 * 文件格式与 Pi session v3 对齐（见 AGENTS.md）。
 */

import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { getDefaultSessionDir } from "./pi-paths";
import { readLeafSidecar, writeLeafSidecar } from "./session-leaf-sidecar";

export const SESSION_VERSION = 3;

export type SessionHeader = {
  type: "session";
  version: number;
  id: string;
  timestamp: string;
  cwd: string;
  parentSession?: string;
};

export type SessionEntry = {
  type: string;
  id: string;
  parentId: string | null;
  timestamp?: string;
  [key: string]: unknown;
};

function generateEntryId(byId: Map<string, SessionEntry>): string {
  for (let i = 0; i < 100; i++) {
    const id = randomUUID().replace(/-/g, "").slice(0, 8);
    if (!byId.has(id)) return id;
  }
  return randomUUID();
}

/** 会话 id：优先 uuid v4 风格（外部 pi 用 uuidv7；此处用 randomUUID 足够） */
function createSessionId(): string {
  return randomUUID();
}

function loadEntriesFromFile(path: string): unknown[] {
  const content = readFileSync(path, "utf8");
  const entries: unknown[] = [];
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      /* skip bad line */
    }
  }
  return entries;
}

export class SessionFile {
  private fileEntries: unknown[] = [];
  private byId = new Map<string, SessionEntry>();
  private labelsById = new Map<string, string>();
  private labelTimestampsById = new Map<string, string>();
  private leafId: string | null = null;
  private sessionId: string;
  private sessionFile: string | undefined;
  private cwd: string;
  private sessionDir: string;
  private persist: boolean;
  private flushed = false;

  private constructor(
    cwd: string,
    sessionDir: string,
    sessionFile: string | undefined,
    persist: boolean,
    preloaded?: unknown[],
  ) {
    this.cwd = cwd;
    this.sessionDir = sessionDir;
    this.sessionFile = sessionFile;
    this.persist = persist;
    this.sessionId = createSessionId();

    if (sessionFile && existsSync(sessionFile)) {
      this.fileEntries = preloaded ?? loadEntriesFromFile(sessionFile);
      this.flushed = true;
      this._buildIndex();
      const header = this.fileEntries.find(
        (e) => e && typeof e === "object" && (e as { type?: string }).type === "session",
      ) as SessionHeader | undefined;
      if (header?.id) this.sessionId = header.id;
      if (header?.cwd) this.cwd = header.cwd;
    } else if (!sessionFile) {
      // 新会话：空，等 newSession
      this.fileEntries = [];
      this.flushed = false;
    } else {
      // 指定路径但不存在：按新文件准备
      this.fileEntries = [];
      this.flushed = false;
    }
  }

  static create(cwd: string, sessionDir?: string): SessionFile {
    const dir = sessionDir ? resolve(sessionDir) : getDefaultSessionDir(cwd);
    mkdirSync(dir, { recursive: true });
    const sm = new SessionFile(cwd, dir, undefined, true);
    sm.newSession();
    return sm;
  }

  static open(path: string, sessionDir?: string, cwdOverride?: string): SessionFile {
    const resolvedPath = resolve(path);
    let preloaded: unknown[] | undefined;
    let header: SessionHeader | null = null;
    if (existsSync(resolvedPath)) {
      preloaded = loadEntriesFromFile(resolvedPath);
      const first = preloaded[0] as SessionHeader | undefined;
      header = first?.type === "session" ? first : null;
    }
    const cwd = cwdOverride ?? header?.cwd ?? process.cwd();
    const dir = sessionDir ? resolve(sessionDir) : dirname(resolvedPath);
    return new SessionFile(cwd, dir, resolvedPath, true, preloaded);
  }

  newSession(options?: { parentSession?: string }): string | undefined {
    const timestamp = new Date().toISOString();
    this.sessionId = createSessionId();
    const header: SessionHeader = {
      type: "session",
      version: SESSION_VERSION,
      id: this.sessionId,
      timestamp,
      cwd: this.cwd,
      ...(options?.parentSession ? { parentSession: options.parentSession } : {}),
    };
    this.fileEntries = [header];
    this.byId.clear();
    this.labelsById.clear();
    this.labelTimestampsById.clear();
    this.leafId = null;
    this.flushed = false;
    if (this.persist) {
      mkdirSync(this.sessionDir, { recursive: true });
      const fileTimestamp = timestamp.replace(/[:.]/g, "-");
      this.sessionFile = join(this.sessionDir, `${fileTimestamp}_${this.sessionId}.jsonl`);
    }
    return this.sessionFile;
  }

  private _buildIndex(): void {
    this.byId.clear();
    this.labelsById.clear();
    this.labelTimestampsById.clear();
    this.leafId = null;
    for (const raw of this.fileEntries) {
      if (!raw || typeof raw !== "object") continue;
      const entry = raw as SessionEntry;
      if (entry.type === "session") continue;
      if (typeof entry.id !== "string") continue;
      this.byId.set(entry.id, entry);
      this.leafId = entry.id;
      if (entry.type === "label") {
        const targetId = entry.targetId as string | undefined;
        const label = entry.label as string | undefined;
        if (targetId) {
          if (label) {
            this.labelsById.set(targetId, label);
            if (entry.timestamp) this.labelTimestampsById.set(targetId, entry.timestamp);
          } else {
            this.labelsById.delete(targetId);
            this.labelTimestampsById.delete(targetId);
          }
        }
      }
    }
  }

  private _rewriteFile(): void {
    if (!this.persist || !this.sessionFile) return;
    mkdirSync(dirname(this.sessionFile), { recursive: true });
    const fd = openSync(this.sessionFile, "w");
    try {
      for (const entry of this.fileEntries) {
        writeFileSync(fd, `${JSON.stringify(entry)}\n`);
      }
    } finally {
      closeSync(fd);
    }
  }

  private _persist(entry: SessionEntry): void {
    if (!this.persist || !this.sessionFile) return;
    const hasAssistant = this.fileEntries.some(
      (e) =>
        e &&
        typeof e === "object" &&
        (e as SessionEntry).type === "message" &&
        (e as { message?: { role?: string } }).message?.role === "assistant",
    );
    if (!hasAssistant) {
      if (this.flushed) {
        appendFileSync(this.sessionFile, `${JSON.stringify(entry)}\n`);
      } else {
        this.flushed = false;
      }
      return;
    }
    if (!this.flushed) {
      try {
        const fd = openSync(this.sessionFile, "wx");
        try {
          for (const e of this.fileEntries) {
            writeFileSync(fd, `${JSON.stringify(e)}\n`);
          }
        } finally {
          closeSync(fd);
        }
      } catch {
        // 文件已存在则整文件重写
        this._rewriteFile();
      }
      this.flushed = true;
    } else {
      appendFileSync(this.sessionFile, `${JSON.stringify(entry)}\n`);
    }
  }

  private _appendEntry(entry: SessionEntry): void {
    this.fileEntries.push(entry);
    this.byId.set(entry.id, entry);
    this.leafId = entry.id;
    this._persist(entry);
  }

  isPersisted(): boolean {
    return this.persist;
  }

  getCwd(): string {
    return this.cwd;
  }

  getSessionDir(): string {
    return this.sessionDir;
  }

  getSessionId(): string {
    return this.sessionId;
  }

  getSessionFile(): string | undefined {
    return this.sessionFile;
  }

  getLeafId(): string | null {
    return this.leafId;
  }

  getEntry(id: string): SessionEntry | undefined {
    return this.byId.get(id);
  }

  getHeader(): SessionHeader | null {
    const first = this.fileEntries[0];
    if (first && typeof first === "object" && (first as SessionHeader).type === "session") {
      return first as SessionHeader;
    }
    return null;
  }

  getEntries(): SessionEntry[] {
    return this.fileEntries.filter(
      (e): e is SessionEntry =>
        !!e && typeof e === "object" && (e as SessionEntry).type !== "session" && typeof (e as SessionEntry).id === "string",
    );
  }

  getBranch(fromId?: string): SessionEntry[] {
    const startId = fromId ?? this.leafId;
    if (!startId) return [];
    const path: SessionEntry[] = [];
    let current: string | null = startId;
    const guard = new Set<string>();
    while (current && !guard.has(current)) {
      guard.add(current);
      const entry = this.byId.get(current);
      if (!entry) break;
      path.unshift(entry);
      current = entry.parentId;
    }
    return path;
  }

  getLabel(id: string): string | undefined {
    return this.labelsById.get(id);
  }

  getSessionName(): string | undefined {
    let name: string | undefined;
    for (const e of this.getEntries()) {
      if (e.type === "session_info" && typeof e.name === "string") {
        name = e.name;
      }
    }
    return name;
  }

  /**
   * 切换 leaf 指针（不删条目）。下次 append 会挂在该节点下。
   * 注：Pi 的 leaf 存在内存；落盘通过后续 append 的 parentId 体现。
   * 为持久化 leaf，我们追加一条轻量 leaf 标记……不，Pi 不写 leaf 到文件，
   * leaf = 文件中最后一条 entry 的 id（线性）或内存指针。
   * 分支切换后若不 append，leaf 仅内存；重新 open 会丢。
   * 产品 navigate 后会 destroy 进程，下次 open 会把 leaf 设为文件最后一条——
   * 这与「branch 到中间节点」语义冲突。
   *
   * 修复：branch 后写入一条 type=pidance.leaf 的 custom？会污染。
   * 官方 SessionManager.branch 也只改内存 leafId；重新 open 用最后一条。
   * 实际上 open 后 _buildIndex 把 leafId 设为最后一条 entry——所以
   * navigate 后若不再 append，下次 open 会回到文件末尾。
   *
   * 为让 branch 持久：把目标路径重写为「当前主链」——不，那会丢弃旁支。
   * 正确做法：文件是 append-only 树，leaf 在 header 或侧车。
   * Pi 0.81 的 leaf 在内存；RPC 进程持有 leaf。我们 quiesce 后磁盘 open
   * 需要 leaf 持久化。
   *
   * 实用方案：branch 时若不在文件末尾，追加一条
   * `{type:"custom", customType:"pidance.leaf", data:{leafId}}` 不推进语义？
   * 更简单：rewrite 把选中分支的节点按序重写并丢弃不在路径上的？破坏旁支。
   *
   * 对齐 Pi：branch 只改内存；我们的 open 在文件末尾。
   * 对 navigate 后立即 destroy 再 ensureLive：外部 pi --session 会用自己的 leaf 恢复。
   * 外部 pi open 文件时 leaf = 最后一条。所以磁盘 branch 无效除非 rewrite。
   *
   * 采用：branch 后将「从 root 到 target 的路径」保持，并 append 一条
   * 空操作？查 pi navigateTree……实际 AgentSession.navigateTree 改内存 leaf。
   * 外部 RPC 无 navigate → 我们磁盘 branch 后 destroy；下次 --session 打开
   * pi 用最后 entry 当 leaf。
   *
   * 故：为持久化导航，rewrite 文件使 target 成为最后一条（保留全树 entries，
   * 仅调整？）—— append-only 不能改顺序。
   *
   * 可行：追加一条 type=message 的占位？脏。
   * 或：在 header 写 leafId 扩展字段（pi 可能忽略未知字段）。
   *
   * 采用 header 扩展 `pidanceLeafId`（pi 忽略未知键时安全）+ open 时优先用它。
   */
  branch(branchFromId: string): void {
    if (!this.byId.has(branchFromId)) {
      throw new Error(`Entry ${branchFromId} not found`);
    }
    this.leafId = branchFromId;
    this._persistLeafPointer(branchFromId);
  }

  private _persistLeafPointer(leafId: string): void {
    if (!this.persist || !this.sessionFile) return;
    // leaf 属业务附加元数据：写 sidecar（不污染 Pi 原生 header）。
    // 写失败时 leaf 仅内存（下次 open 回文件末尾），不破坏 session 文件。
    try {
      writeLeafSidecar(this.sessionFile, leafId);
    } catch {
      /* leaf 持久化失败不阻塞导航本身 */
    }
    // branch 是树写操作：同时确保 JSONL 已落盘（无 assistant 时 flush 标记未写）
    if (!this.flushed) {
      this._rewriteFile();
      this.flushed = true;
    }
  }

  /** 历史 header 扩展字段 pidanceLeafId → sidecar 一次性迁移（失败保留原状）。 */
  private _migrateHeaderLeafToSidecar(): void {
    if (!this.persist || !this.sessionFile) return;
    const header = this.getHeader() as (SessionHeader & { pidanceLeafId?: string }) | null;
    const legacy = header?.pidanceLeafId;
    if (!legacy) return;
    const existing = readLeafSidecar(this.sessionFile);
    try {
      // sidecar 已有更新值时不覆盖；无论如何都清理 header 扩展字段
      if (!existing || existing === legacy) {
        if (!existing) writeLeafSidecar(this.sessionFile, legacy);
      }
      this._clearHeaderLeafField();
    } catch {
      /* 迁移失败：保留 header 原状，下次 open 再试；不破坏 session */
    }
  }

  private _clearHeaderLeafField(): void {
    const header = this.getHeader();
    if (!header) return;
    const cleaned = { ...header } as Record<string, unknown>;
    delete cleaned.pidanceLeafId;
    this.fileEntries[0] = cleaned;
    this._rewriteFile();
    this.flushed = true;
  }

  private _restoreLeafFromSidecar(): void {
    if (!this.persist || !this.sessionFile) return;
    const leafId = readLeafSidecar(this.sessionFile);
    if (leafId && this.byId.has(leafId)) {
      this.leafId = leafId;
    }
  }

  /** open 后调用：迁移历史 header 字段并从 sidecar 恢复 leaf */
  restoreLeaf(): void {
    this._migrateHeaderLeafToSidecar();
    this._restoreLeafFromSidecar();
  }

  /** 文件末尾 entry id（不读 sidecar；等价外部 pi 打开时的 leaf）。 */
  getLastEntryId(): string | null {
    for (let i = this.fileEntries.length - 1; i >= 0; i -= 1) {
      const e = this.fileEntries[i] as SessionEntry | undefined;
      if (e && e.type !== "session" && typeof e.id === "string") return e.id;
    }
    return null;
  }

  appendCustomEntry(customType: string, data?: unknown): string {
    const entry: SessionEntry = {
      type: "custom",
      id: generateEntryId(this.byId),
      parentId: this.leafId,
      timestamp: new Date().toISOString(),
      customType,
      data,
    };
    this._appendEntry(entry);
    return entry.id;
  }

  appendLabelChange(targetId: string, label: string | undefined): string {
    const timestamp = new Date().toISOString();
    const entry: SessionEntry = {
      type: "label",
      id: generateEntryId(this.byId),
      parentId: this.leafId,
      timestamp,
      targetId,
      label,
    };
    this._appendEntry(entry);
    if (label) {
      this.labelsById.set(targetId, label);
      this.labelTimestampsById.set(targetId, timestamp);
    } else {
      this.labelsById.delete(targetId);
      this.labelTimestampsById.delete(targetId);
    }
    return entry.id;
  }

  appendModelChange(provider: string, modelId: string): string {
    const entry: SessionEntry = {
      type: "model_change",
      id: generateEntryId(this.byId),
      parentId: this.leafId,
      timestamp: new Date().toISOString(),
      provider,
      modelId,
    };
    this._appendEntry(entry);
    return entry.id;
  }

  /** 会话显示名（session_info entry） */
  appendSessionInfo(name: string): string {
    const entry: SessionEntry = {
      type: "session_info",
      id: generateEntryId(this.byId),
      parentId: this.leafId,
      timestamp: new Date().toISOString(),
      name,
    };
    this._appendEntry(entry);
    // session_info 必须落盘：强制 rewrite（无 assistant 时 _persist 可能不写）
    if (this.persist && this.sessionFile) {
      this._rewriteFile();
      this.flushed = true;
    }
    return entry.id;
  }

  /** 追加 user/assistant/toolResult 等 message entry */
  appendMessage(message: Record<string, unknown>): string {
    const entry: SessionEntry = {
      type: "message",
      id: generateEntryId(this.byId),
      parentId: this.leafId,
      timestamp:
        typeof message.timestamp === "string"
          ? message.timestamp
          : new Date().toISOString(),
      message,
    };
    this._appendEntry(entry);
    return entry.id;
  }

  createBranchedSession(leafId: string): string | undefined {
    const previousSessionFile = this.sessionFile;
    const path = this.getBranch(leafId);
    if (path.length === 0) throw new Error(`Entry ${leafId} not found`);

    const pathWithoutLabels: SessionEntry[] = [];
    let pathParentId: string | null = null;
    for (const entry of path) {
      if (entry.type === "label") continue;
      pathWithoutLabels.push({ ...entry, parentId: pathParentId });
      pathParentId = entry.id;
    }

    const newSessionId = createSessionId();
    const timestamp = new Date().toISOString();
    const fileTimestamp = timestamp.replace(/[:.]/g, "-");
    const newSessionFile = join(this.sessionDir, `${fileTimestamp}_${newSessionId}.jsonl`);
    const header: SessionHeader = {
      type: "session",
      version: SESSION_VERSION,
      id: newSessionId,
      timestamp,
      cwd: this.cwd,
      parentSession: this.persist ? previousSessionFile : undefined,
    };

    const pathEntryIds = new Set(pathWithoutLabels.map((e) => e.id));
    const labelsToWrite: Array<{ targetId: string; label: string; timestamp?: string }> = [];
    for (const [targetId, label] of this.labelsById) {
      if (pathEntryIds.has(targetId)) {
        labelsToWrite.push({
          targetId,
          label,
          timestamp: this.labelTimestampsById.get(targetId),
        });
      }
    }

    let parentId = pathWithoutLabels[pathWithoutLabels.length - 1]?.id || null;
    const labelEntries: SessionEntry[] = [];
    const usedIds = new Set(pathEntryIds);
    for (const { targetId, label, timestamp: labelTimestamp } of labelsToWrite) {
      const id = generateEntryId(new Map([...usedIds].map((i) => [i, {} as SessionEntry])));
      usedIds.add(id);
      const labelEntry: SessionEntry = {
        type: "label",
        id,
        parentId,
        timestamp: labelTimestamp ?? timestamp,
        targetId,
        label,
      };
      labelEntries.push(labelEntry);
      parentId = id;
    }

    const allEntries = [header, ...pathWithoutLabels, ...labelEntries];
    mkdirSync(this.sessionDir, { recursive: true });
    const fd = openSync(newSessionFile, "w");
    try {
      for (const e of allEntries) {
        writeFileSync(fd, `${JSON.stringify(e)}\n`);
      }
    } finally {
      closeSync(fd);
    }
    return newSessionFile;
  }

  /** 只读视图：与 SessionManagerReadView 大致兼容 */
  buildSessionContext(): { messages: unknown[]; entryIds: string[] } {
    const branch = this.getBranch();
    const messages: unknown[] = [];
    const entryIds: string[] = [];
    for (const e of branch) {
      if (e.type === "message" && e.message) {
        messages.push(e.message);
        entryIds.push(e.id);
      }
    }
    return { messages, entryIds };
  }
}

/** open 后自动 restoreLeaf */
export function openSessionFile(path: string, sessionDir?: string): SessionFile {
  const sm = SessionFile.open(path, sessionDir);
  sm.restoreLeaf();
  return sm;
}
