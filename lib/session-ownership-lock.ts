/**
 * Pidance 进程级 session 所有权锁（31415/31416 共享 agentDir 时防双写）。
 * 外部 Pi CLI 不识别此锁；运维上禁止与 Pidance 并发写同一 session。
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

export type SessionLockHandle = {
  release: () => void;
  path: string;
};

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
      return {
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
