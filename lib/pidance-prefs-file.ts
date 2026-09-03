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

/** 顶层键合并；双方均为对象时再深合并一层（drafts/fileTree 等嵌套键不互相覆盖）。 */
export function mergePidancePrefs(base: PidancePrefs, patch: PidancePrefs): PidancePrefs {
  const out: PidancePrefs = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (isPlainRecord(value) && isPlainRecord(out[key])) {
      out[key] = { ...(out[key] as PidancePrefs), ...(value as PidancePrefs) };
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

/** API 整包 patch 的原子合并入口：锁内重新读取，保留并发写入的嵌套 sessionQueue。 */
export function mergeAndWritePidancePrefs(
  patch: PidancePrefs,
  agentDir: string = getAgentDir(),
): void {
  withPrefsLock(agentDir, () => {
    const current = readPidancePrefs(agentDir);
    writePidancePrefsUnlocked(mergePidancePrefs(current, patch), agentDir);
  });
}
