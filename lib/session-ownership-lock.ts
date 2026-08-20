/**
 * Pidance 进程级 session 所有权锁（31415/31416 共享 agentDir 时防双写）。
 * 外部 Pi CLI 不识别此锁；运维上禁止与 Pidance 并发写同一 session。
 *
 * 同一会话必须同时锁 session id 与 session 文件路径。只锁其中一个时，
 * 另一实例会把另一把钥匙当成空闲而启动第二套 writable host。
 */
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "./pi-paths";

export const SESSION_LOCKED_MESSAGE =
  "Session is locked by another Pidance process (writable host ownership)";

export function isSessionLockedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("locked by another Pidance process");
}

export type SessionLockHandle = {
  release: () => void;
  path: string;
  keys: string[];
};

type LockPart = { key: string; release: () => void; path: string };

const partsByHandle = new WeakMap<SessionLockHandle, LockPart[]>();

function lockDir(agentDir: string): string {
  return join(agentDir, "pidance-session-locks");
}

function lockPath(agentDir: string, sessionKey: string): string {
  const safe = sessionKey.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 180);
  return join(lockDir(agentDir), `${safe}.lock`);
}

function isPidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readLockPid(path: string): number | null {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as { pid?: unknown };
    return typeof raw.pid === "number" ? raw.pid : null;
  } catch {
    return null;
  }
}

function uniqueKeys(keys: Array<string | undefined | null>): string[] {
  const out: string[] = [];
  for (const key of keys) {
    if (typeof key === "string" && key && !out.includes(key)) out.push(key);
  }
  return out;
}

function attachParts(handle: SessionLockHandle, parts: LockPart[]): SessionLockHandle {
  partsByHandle.set(handle, parts);
  return handle;
}

function composeHandle(parts: LockPart[]): SessionLockHandle {
  let released = false;
  const handle: SessionLockHandle = {
    path: parts[0]?.path ?? "",
    keys: parts.map((part) => part.key),
    release: () => {
      if (released) return;
      released = true;
      for (const part of parts) part.release();
    },
  };
  return attachParts(handle, parts);
}

/**
 * 尝试取得 session 写锁。sessionKey 建议用 session id 或绝对 session 文件路径。
 * 失败返回 null（调用方应只读或 409）。
 */
export function tryAcquireSessionLock(
  sessionKey: string,
  agentDir: string = getAgentDir(),
): SessionLockHandle | null {
  if (!sessionKey) return null;
  const dir = lockDir(agentDir);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = lockPath(agentDir, sessionKey);

  const tryCreate = (): SessionLockHandle | null => {
    try {
      const fd = openSync(path, "wx", 0o600);
      try {
        writeFileSync(
          fd,
          JSON.stringify({
            pid: process.pid,
            sessionKey,
            at: new Date().toISOString(),
          }),
          "utf8",
        );
      } catch {
        try {
          closeSync(fd);
        } catch {
          /* ignore */
        }
        try {
          unlinkSync(path);
        } catch {
          /* ignore */
        }
        return null;
      }
      let released = false;
      const part: LockPart = {
        key: sessionKey,
        path,
        release: () => {
          if (released) return;
          released = true;
          try {
            closeSync(fd);
          } catch {
            /* ignore */
          }
          try {
            unlinkSync(path);
          } catch {
            /* ignore */
          }
        },
      };
      return composeHandle([part]);
    } catch {
      return null;
    }
  };

  const first = tryCreate();
  if (first) return first;

  // 陈旧锁：持有者 PID 已死则清理重试一次
  const holder = readLockPid(path);
  if (holder !== null && !isPidAlive(holder)) {
    try {
      unlinkSync(path);
    } catch {
      /* ignore */
    }
    return tryCreate();
  }
  return null;
}

/**
 * 同时锁住一组钥匙（通常是 session id + session 文件路径）。
 * `held` 已持有的钥匙会保留 fd，不会先放后抢，避免换钥窗口被另一进程插入。
 * 失败时不释放 `held`。
 */
export function tryAcquireSessionOwnership(
  keys: Array<string | undefined | null>,
  agentDir: string = getAgentDir(),
  held?: SessionLockHandle | null,
): SessionLockHandle | null {
  const wanted = uniqueKeys(keys);
  if (wanted.length === 0) return null;
  const heldParts = held ? (partsByHandle.get(held) ?? []) : [];
  const heldByKey = new Map(heldParts.map((part) => [part.key, part]));
  const acquired: LockPart[] = [];
  for (const key of wanted) {
    const existing = heldByKey.get(key);
    if (existing) {
      acquired.push(existing);
      continue;
    }
    const next = tryAcquireSessionLock(key, agentDir);
    if (!next) {
      for (const part of acquired) {
        if (!heldByKey.has(part.key)) part.release();
      }
      return null;
    }
    const parts = partsByHandle.get(next) ?? [];
    acquired.push(...parts);
  }
  return composeHandle(acquired);
}

/** 只读探测：外进程是否占着任一把钥匙。本进程持有的锁不算占用。 */
export function findForeignSessionLockPid(
  keys: Array<string | undefined | null>,
  agentDir: string = getAgentDir(),
  selfPid: number = process.pid,
): number | null {
  for (const key of uniqueKeys(keys)) {
    const path = lockPath(agentDir, key);
    if (!existsSync(path)) continue;
    const pid = readLockPid(path);
    if (pid === null || pid === selfPid || !isPidAlive(pid)) continue;
    return pid;
  }
  return null;
}

/** 释放 held 中不再属于 wanted 的钥匙；wanted 内的钥匙转交给新 handle。 */
export function releaseUnwantedLockKeys(
  held: SessionLockHandle | null | undefined,
  wanted: Array<string | undefined | null>,
): void {
  if (!held) return;
  const wantedSet = new Set(uniqueKeys(wanted));
  const parts = partsByHandle.get(held) ?? [];
  for (const part of parts) {
    if (!wantedSet.has(part.key)) part.release();
  }
}

