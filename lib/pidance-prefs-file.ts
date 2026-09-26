/**
 * 服务端持久化偏好文件（pidance-preferences.json）读写。
 *
 * 与 /api/preferences 共用同一存储；客户端偏好走该 API，
 * 服务端生命周期（Host 队列水合/清理）直接原子读写同一文件。
 */
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "./pi-paths";
import { applyPrefOps, type PidancePrefOp } from "./pidance-prefs-ops";

export type PidancePrefs = Record<string, unknown>;

export const PIDANCE_PREFS_FILENAME = "pidance-preferences.json";
const PIDANCE_PREFS_LOCK_SUFFIX = ".lock";
const PREFS_LOCK_WAIT_MS = 10;
const PREFS_LOCK_TIMEOUT_MS = 15_000;
const PREFS_LOCK_STALE_MS = 60_000;

export function getPidancePrefsPath(agentDir: string = getAgentDir()): string {
  return join(agentDir, PIDANCE_PREFS_FILENAME);
}

export function isPlainRecord(value: unknown): value is PidancePrefs {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readPidancePrefs(agentDir: string = getAgentDir()): PidancePrefs {
  const path = getPidancePrefsPath(agentDir);
  if (!existsSync(path)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return isPlainRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function sleepSync(milliseconds: number): void {
  const buffer = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(buffer, 0, 0, milliseconds);
}

function withPrefsLock<T>(agentDir: string, action: () => T): T {
  const path = getPidancePrefsPath(agentDir);
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const lockPath = `${path}${PIDANCE_PREFS_LOCK_SUFFIX}`;
  const deadline = Date.now() + PREFS_LOCK_TIMEOUT_MS;
  let fd: number | null = null;
  while (fd === null) {
    try {
      fd = openSync(lockPath, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > PREFS_LOCK_STALE_MS) unlinkSync(lockPath);
      } catch {
        // The owner may have released the lock between stat/unlink.
      }
      if (Date.now() >= deadline) throw new Error("Timed out acquiring Pidance preferences lock");
      sleepSync(PREFS_LOCK_WAIT_MS);
    }
  }
  try {
    return action();
  } finally {
    closeSync(fd);
    try {
      unlinkSync(lockPath);
    } catch {
      /* ignore lock cleanup failure */
    }
  }
}

/** 原子写：temp + rename，权限 0600；进程间通过 lock 文件串行化。 */
function writePidancePrefsUnlocked(prefs: PidancePrefs, agentDir: string): void {
  const path = getPidancePrefsPath(agentDir);
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify(prefs, null, 2), { flag: "wx", mode: 0o600 });
    renameSync(temp, path);
  } catch (error) {
    try {
      unlinkSync(temp);
    } catch {
      /* ignore */
    }
    throw error;
  }
}

export function writePidancePrefs(prefs: PidancePrefs, agentDir: string = getAgentDir()): void {
  withPrefsLock(agentDir, () => writePidancePrefsUnlocked(prefs, agentDir));
}

/**
 * 顶层键合并；双方均为对象时再深合并一层（drafts/fileTree 等嵌套键不互相覆盖）。
 * patch 中显式 null = 删除键（墓碑语义）：merge 是并集，客户端整包 PUT 若不携带
 * 某键会被当作「未改动」保留，导致 clearDraft 等服务端残留旧值、刷新后草稿复活。
 */
export function mergePidancePrefs(base: PidancePrefs, patch: PidancePrefs): PidancePrefs {
  const out: PidancePrefs = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete out[key];
    } else if (isPlainRecord(value) && isPlainRecord(out[key])) {
      const merged: PidancePrefs = { ...(out[key] as PidancePrefs) };
      for (const [subKey, subValue] of Object.entries(value as PidancePrefs)) {
        if (subValue === null) delete merged[subKey];
        else merged[subKey] = subValue;
      }
      out[key] = merged;
    } else {
      out[key] = value;
    }
  }
  return out;
}

function getByDottedKey(prefs: PidancePrefs, key: string): unknown {
  const parts = key.split(".");
  let target: unknown = prefs;
  for (const part of parts) {
    if (typeof target !== "object" || target === null) return undefined;
    target = (target as PidancePrefs)[part];
  }
  return target;
}

function setByDottedKey(prefs: PidancePrefs, key: string, value: unknown): void {
  const parts = key.split(".");
  let target = prefs;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    const next = target[part];
    if (typeof next !== "object" || next === null || Array.isArray(next)) {
      target[part] = {};
    }
    target = target[part] as PidancePrefs;
  }
  const last = parts[parts.length - 1];
  if (value === undefined || value === null) {
    delete target[last];
  } else {
    target[last] = value;
  }
}

export function getPidancePref(prefs: PidancePrefs, key: string): unknown {
  return getByDottedKey(prefs, key);
}

/** 在同一把跨进程锁内完成读-改-写，避免 Host 与 UI PUT 互相覆盖。 */
export function updatePidancePref(
  key: string,
  value: unknown,
  agentDir: string = getAgentDir(),
): void {
  withPrefsLock(agentDir, () => {
    const prefs = readPidancePrefs(agentDir);
    setByDottedKey(prefs, key, value);
    writePidancePrefsUnlocked(prefs, agentDir);
  });
}

/**
 * 剥离客户端提交里的宿主持有键。
 *
 * `/api/preferences` PUT 是「整包快照 patch」。客户端内存里的快照可能停在投递
 * 之前：一次无关的偏好写入（草稿/hold）会把旧队列连同旧版本号一起写回，把已投递
 * 的条目恢复成 `waiting`，下一个 Host 实例就会再投一次（重复投递）。
 *
 * 队列的唯一 writer 是 Host（客户端只能通过 agent 命令 API 写），这里在入库前
 * 兜底剥离 `sessionQueue` / 扁平 `sessionQueue.<id>`；`sessionQueueHold` 是
 * 客户端持有的键，不在剥离范围内。
 */
export function stripHostOwnedQueuePrefs(patch: PidancePrefs): { patch: PidancePrefs; dropped: string[] } {
  const out: PidancePrefs = {};
  const dropped: string[] = [];
  for (const [key, value] of Object.entries(patch)) {
    if (key === "sessionQueue" || key.startsWith("sessionQueue.")) {
      dropped.push(key);
      continue;
    }
    out[key] = value;
  }
  return { patch: out, dropped };
}

/** API 整包 patch 的原子合并入口：锁内重新读取，保留并发写入的嵌套 sessionQueue。 */
export function mergeAndWritePidancePrefs(
  patch: PidancePrefs,
  agentDir: string = getAgentDir(),
): PidancePrefs {
  return withPrefsLock(agentDir, () => {
    const current = readPidancePrefs(agentDir);
    const merged = mergePidancePrefs(current, patch);
    writePidancePrefsUnlocked(merged, agentDir);
    return merged;
  });
}

/**
 * 计算一次 patch 实际改动的点路径 → 变更后的值（供广播用，见 lib/pidance-prefs-bus.ts）。
 *
 * 粒度与合并语义对齐：patch 里的顶层键若是普通对象、且原值也是普通对象，就按**子键**逐个
 * 比较（`sidebarUi.projectRoots`），否则整个顶层键算一处变更。这样客户端能按字段应用，
 * 不必因为一个小改动重读整份偏好。
 */
export function diffPrefsPatch(
  before: PidancePrefs,
  patch: PidancePrefs,
  after: PidancePrefs,
): Record<string, unknown> {
  const changed: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    const beforeValue = before[key];
    const afterValue = after[key];
    if (isPlainRecord(value) && isPlainRecord(beforeValue)) {
      for (const subKey of Object.keys(value as PidancePrefs)) {
        const path = `${key}.${subKey}`;
        const beforeSub = (beforeValue as PidancePrefs)[subKey];
        const afterSub = isPlainRecord(afterValue) ? (afterValue as PidancePrefs)[subKey] : undefined;
        if (JSON.stringify(beforeSub) !== JSON.stringify(afterSub)) {
          changed[path] = afterSub ?? null;
        }
      }
      continue;
    }
    if (JSON.stringify(beforeValue) !== JSON.stringify(afterValue)) {
      changed[key] = afterValue ?? null;
    }
  }
  return changed;
}

/** API patch 的原子合并 + 返回实际变更（#66：变更用于广播）。 */
export function mergeAndWritePidancePrefsWithDiff(
  patch: PidancePrefs,
  agentDir: string = getAgentDir(),
): Record<string, unknown> {
  return withPrefsLock(agentDir, () => {
    const current = readPidancePrefs(agentDir);
    const merged = mergePidancePrefs(current, patch);
    const changed = diffPrefsPatch(current, patch, merged);
    if (Object.keys(changed).length > 0) writePidancePrefsUnlocked(merged, agentDir);
    return changed;
  });
}

/**
 * 锁内基于**最新**文件内容做一次读-改-写（回调返回 true 才写盘）。
 *
 * 与 `updatePidancePref` / `mergeAndWritePidancePrefs` 的区别是：判定逻辑由调用方给，
 * 但它是在**同一把锁里、对着刚读出来的内容**执行的。这是给「维护类」写入用的：
 * 调用方通常要先做代价高的事（扫会话目录、列附件）才能算出候选，而**落盘前必须重读** ——
 * 否则会拿锁外那份旧快照把锁窗口里的并发写入盖掉。
 *
 * `unreadSessionState` 是典型受害者：它是**整对象**键，`setByDottedKey` 整体替换而非按 id 合并，
 * 两个进程（31415/31416 共用 agent dir）各自「读→扫→写」就会互相吃掉对方的未读时钟。
 */
export function mutatePidancePrefs(
  mutate: (prefs: PidancePrefs) => boolean,
  agentDir: string = getAgentDir(),
): boolean {
  return withPrefsLock(agentDir, () => {
    const prefs = readPidancePrefs(agentDir);
    if (!mutate(prefs)) return false;
    writePidancePrefsUnlocked(prefs, agentDir);
    return true;
  });
}

/**
 * 命令语义的原子入口（#66）：在锁内把命令施加到**当前**文件内容上，并返回实际变更的键。
 * 集合类键的并发加/删因此不会互相覆盖（整值 patch 会）。
 */
export function applyAndWritePidancePrefsOps(
  ops: readonly PidancePrefOp[],
  agentDir: string = getAgentDir(),
): Record<string, unknown> {
  return withPrefsLock(agentDir, () => {
    const current = readPidancePrefs(agentDir);
    const changedKeys = applyPrefOps(current, ops);
    if (changedKeys.length === 0) return {};
    writePidancePrefsUnlocked(current, agentDir);
    const changed: Record<string, unknown> = {};
    for (const key of changedKeys) {
      changed[key] = getByDottedKey(current, key) ?? null;
    }
    return changed;
  });
}
