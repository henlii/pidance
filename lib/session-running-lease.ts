/**
 * 跨进程 writer 租约：31415 与 31416 共享 agentDir 时互斥 session 写入。
 * 正常运行从 starting 到 agent_settled 后 host dispose；settled 后立即释放，
 * 不因 SSE 订阅继续占用空闲会话。
 * 不表示「智能体正在执行」——侧栏 running/计时走 isRunning，对端占用走 lockedByOther。
 */
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "./pi-paths";

export const SESSION_RUNNING_LOCKED_MESSAGE =
  "Session is locked by another Pidance process (writable host ownership)";

export const RUNNING_LEASE_TTL_MS = 20_000;
export const RUNNING_LEASE_DIRNAME = "pidance-running-leases";

// 租约目录内的跨进程互斥：所有「读-改-写」都在同一把锁里做，避免两个进程
// 同时读到「没有租约」而各自成为 writer（TOCTOU）。
const LEASE_LOCK_NAME = ".lease-lock";
const LEASE_LOCK_WAIT_MS = 5;
const LEASE_LOCK_TIMEOUT_MS = 3_000;
const LEASE_LOCK_STALE_MS = 10_000;

function sleepSync(milliseconds: number): void {
  const buffer = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(buffer, 0, 0, milliseconds);
}

/** 原子独占锁（wx 创建 + 陈旧回收）；所有租约写路径共用。 */
function withLeaseLock<T>(agentDir: string, fn: () => T): T {
  const dir = leaseDir(agentDir);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const lockPath = join(dir, LEASE_LOCK_NAME);
  const deadline = Date.now() + LEASE_LOCK_TIMEOUT_MS;
  let fd: number | null = null;
  while (fd === null) {
    try {
      fd = openSync(lockPath, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > LEASE_LOCK_STALE_MS) unlinkSync(lockPath);
      } catch {
        // 锁持有者可能在 stat/unlink 之间释放
      }
      if (Date.now() >= deadline) throw new Error("Timed out acquiring Pidance running-lease lock");
      sleepSync(LEASE_LOCK_WAIT_MS);
    }
  }
  try {
    return fn();
  } finally {
    closeSync(fd);
    try {
      unlinkSync(lockPath);
    } catch {
      /* ignore lock cleanup failure */
    }
  }
}

export type RunningLease = {
  pid: number;
  sessionId: string;
  heartbeatAt: number;
  /** 稳定 run 起始（首次 acquire 落盘）；跨进程 epoch 用，滚动 heartbeat 不改写 */
  startedAt: number;
};

function leaseDir(agentDir: string): string {
  return join(agentDir, RUNNING_LEASE_DIRNAME);
}

function leasePath(agentDir: string, sessionId: string): string {
  const safe = sessionId.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 180);
  return join(leaseDir(agentDir), `${safe}.json`);
}

function isPidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readLeaseFile(path: string): RunningLease | null {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<RunningLease>;
    if (typeof raw.pid !== "number" || typeof raw.sessionId !== "string") return null;
    if (typeof raw.heartbeatAt !== "number") return null;
    return {
      pid: raw.pid,
      sessionId: raw.sessionId,
      heartbeatAt: raw.heartbeatAt,
      startedAt: typeof raw.startedAt === "number" ? raw.startedAt : raw.heartbeatAt,
    };
  } catch {
    return null;
  }
}

/** 原子写：临时文件 + rename，避免读者看到写了一半的 JSON。 */
function writeLease(path: string, lease: RunningLease): void {
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(lease)}\n`, { mode: 0o600 });
  renameSync(temp, path);
}

export function isFresh(lease: RunningLease, now: number): boolean {
  return now - lease.heartbeatAt <= RUNNING_LEASE_TTL_MS && isPidAlive(lease.pid);
}

function collectFreshLeases(agentDir: string, now: number): RunningLease[] {
  const dir = leaseDir(agentDir);
  if (!existsSync(dir)) return [];
  // 清理过期文件也是「读-改-写」：必须在锁内做，否则可能删掉刚写入的新 owner。
  return withLeaseLock(agentDir, () => {
    const fresh: RunningLease[] = [];
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".json")) continue;
      const path = join(dir, name);
      const lease = readLeaseFile(path);
      if (!lease || !isFresh(lease, now)) {
        try {
          unlinkSync(path);
        } catch {
          /* ignore */
        }
        continue;
      }
      fresh.push(lease);
    }
    return fresh;
  });
}

export function listFreshRunningLeaseSessions(
  agentDir: string | undefined = getAgentDir(),
  now = Date.now(),
): { sessionId: string; startedAt: number }[] {
  return collectFreshLeases(agentDir, now).map((lease) => ({
    sessionId: lease.sessionId,
    startedAt: lease.startedAt,
  }));
}

export function isSessionRunningLockedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("locked by another Pidance process");
}

export function acquireRunningLease(
  sessionId: string,
  agentDir: string = getAgentDir(),
  now = Date.now(),
): boolean {
  if (!sessionId) return false;
  return withLeaseLock(agentDir, () => {
    const path = leasePath(agentDir, sessionId);
    const current = existsSync(path) ? readLeaseFile(path) : null;
    if (current && isFresh(current, now) && current.pid !== process.pid) {
      return false;
    }
    // 首次 acquire 记录稳定 startedAt；同进程重 acquire/心跳沿用，跨进程可见同一 epoch。
    writeLease(path, {
      pid: process.pid,
      sessionId,
      heartbeatAt: now,
      startedAt: current && current.pid === process.pid ? current.startedAt : now,
    });
    return true;
  });
}

export function heartbeatRunningLease(
  sessionId: string,
  agentDir: string = getAgentDir(),
  now = Date.now(),
): void {
  if (!sessionId) return;
  withLeaseLock(agentDir, () => {
    const path = leasePath(agentDir, sessionId);
    const current = existsSync(path) ? readLeaseFile(path) : null;
    if (current && current.pid !== process.pid && isFresh(current, now)) return;
    writeLease(path, {
      pid: process.pid,
      sessionId,
      heartbeatAt: now,
      startedAt: current && current.pid === process.pid ? current.startedAt : now,
    });
  });
}

export function releaseRunningLease(
  sessionId: string,
  agentDir: string = getAgentDir(),
): void {
  if (!sessionId) return;
  withLeaseLock(agentDir, () => {
    const path = leasePath(agentDir, sessionId);
    const current = existsSync(path) ? readLeaseFile(path) : null;
    // 旧 owner 不得删除新 owner 的租约。
    if (current && current.pid !== process.pid) return;
    try {
      unlinkSync(path);
    } catch {
      /* ignore */
    }
  });
}

export function listFreshRunningLeaseSessionIds(
  agentDir: string = getAgentDir(),
  now = Date.now(),
): string[] {
  return collectFreshLeases(agentDir, now).map((lease) => lease.sessionId);
}

export function isRunningLeaseHeldByOther(
  sessionId: string,
  agentDir: string = getAgentDir(),
  now = Date.now(),
): boolean {
  if (!sessionId) return false;
  const lease = existsSync(leasePath(agentDir, sessionId))
    ? readLeaseFile(leasePath(agentDir, sessionId))
    : null;
  if (!lease || !isFresh(lease, now)) return false;
  return lease.pid !== process.pid;
}
