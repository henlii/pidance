/**
 * 跨进程 writer 租约：31415 与 31416 共享 agentDir 时互斥 session 写入。
 * 正常运行从 starting 到 agent_settled 后 host dispose；settled 后立即释放，
 * 不因 SSE 订阅继续占用空闲会话。
 * 不表示「智能体正在执行」——侧栏 running/计时走 isRunning，对端占用走 lockedByOther。
 */
import { randomBytes } from "node:crypto";
import {
  existsSync,
  linkSync,
  mkdirSync,
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
/** 锁文件内容不可解析（写坏/残留）时的回收门槛；正常锁按持有者 pid 判活。 */
const LEASE_LOCK_CORRUPT_STALE_MS = 10_000;
export const LEASE_LOCK_TIMEOUT_MESSAGE = "Timed out acquiring Pidance running-lease lock";

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

function sleepSync(milliseconds: number): void {
  const buffer = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(buffer, 0, 0, milliseconds);
}

/** 锁持有者：pid 判活 + token 判所有权（防止旧持有者删掉新持有者的锁）。 */
function readLockOwner(lockPath: string): { pid: number; token: string } | null {
  try {
    const raw = JSON.parse(readFileSync(lockPath, "utf8")) as Partial<{ pid: number; token: string }>;
    if (typeof raw.pid !== "number" || typeof raw.token !== "string") return null;
    return { pid: raw.pid, token: raw.token };
  } catch {
    return null;
  }
}

/**
 * 跨进程独占锁：内容先写好再 link 占位（link 目标已存在即 EEXIST，原子），
 * 释放时校验 token，只删自己的锁。
 *
 * 陈旧回收只针对**持有者进程已死**的锁：活着的持有者（含被 SIGSTOP/长 GC 暂停的）
 * 一律等待到超时并抛错（fail closed），绝不因为「文件旧了」抢锁 —— 否则暂停中的
 * 持有者恢复后会把新持有者的锁删掉，两个进程同时进入临界区。
 */
function withLeaseLock<T>(agentDir: string, fn: () => T): T {
  const dir = leaseDir(agentDir);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const lockPath = join(dir, LEASE_LOCK_NAME);
  const token = randomBytes(8).toString("hex");
  const deadline = Date.now() + LEASE_LOCK_TIMEOUT_MS;
  let acquired = false;
  while (!acquired) {
    const temp = `${lockPath}.${process.pid}.${token}.tmp`;
    try {
      writeFileSync(temp, JSON.stringify({ pid: process.pid, token }), { mode: 0o600 });
      linkSync(temp, lockPath);
      acquired = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        try { unlinkSync(temp); } catch { /* ignore */ }
        throw error;
      }
    }
    try {
      unlinkSync(temp);
    } catch {
      /* 临时文件可能已被 link 走 */
    }
    if (acquired) break;

    const owner = readLockOwner(lockPath);
    if (owner && !isPidAlive(owner.pid)) {
      // 持有者已死：可安全回收（再校验一次 token，避免删掉刚接手的新锁）。
      try {
        if (readLockOwner(lockPath)?.token === owner.token) unlinkSync(lockPath);
      } catch {
        /* ignore */
      }
      continue;
    }
    if (!owner) {
      // 内容不可解析：只回收确实很旧的残留，避免误删正在创建中的锁。
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > LEASE_LOCK_CORRUPT_STALE_MS) unlinkSync(lockPath);
      } catch {
        /* ignore */
      }
    }
    if (Date.now() >= deadline) throw new Error(LEASE_LOCK_TIMEOUT_MESSAGE);
    sleepSync(LEASE_LOCK_WAIT_MS);
  }
  try {
    return fn();
  } finally {
    // 只删自己的锁：被暂停后恢复的旧持有者不得删掉新持有者的锁。
    try {
      if (readLockOwner(lockPath)?.token === token) unlinkSync(lockPath);
    } catch {
      /* ignore lock cleanup failure */
    }
  }
}

/** 锁超时按「拿不到写权」处理（fail closed），其余错误继续抛。 */
function isLeaseLockTimeout(error: unknown): boolean {
  return error instanceof Error && error.message === LEASE_LOCK_TIMEOUT_MESSAGE;
}

/** 原子写：临时文件 + rename，避免读者看到写了一半的 JSON。 */
function writeLease(path: string, lease: RunningLease): void {
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(lease)}\n`, { mode: 0o600 });
  renameSync(temp, path);
}

/**
 * 租约对「对端持有」是否有效：持有者 PID 必须仍然存活。
 *
 * 与 isFresh 的区别（重要）：isFresh 还要求心跳在 TTL 内，只用于判断「新鲜度」。
 * 而「能否接管 / 能否覆盖 / 能否删除」**一律不得**只看心跳：持有者可能只是被
 * SIGSTOP / 长阻塞 / GC 暂停，进程仍活着，其 SessionManager 仍持有 JSONL writer。
 * 只用 isFresh 判定会在这种情况下让两个进程同时写同一 JSONL。
 */
export function isLeaseHeldByLiveOwner(lease: RunningLease | null): boolean {
  return Boolean(lease && isPidAlive(lease.pid));
}

/** 该租约是否可以被别人接管/覆盖/回收：只有持有者进程已死（或内容损坏）才行。 */
function canEvictLease(lease: RunningLease | null): boolean {
  return !isLeaseHeldByLiveOwner(lease);
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
      // 只回收「持有者已死 / 内容损坏」的租约。心跳过期但进程仍活着的不能删：
      // 它可能仍持有 writer（被暂停），删掉等于放行另一个进程接管。
      if (canEvictLease(lease)) {
        try {
          unlinkSync(path);
        } catch {
          /* ignore */
        }
        continue;
      }
      if (!isFresh(lease!, now)) continue; // 活持有者但心跳过期：保留，不计入 fresh 列表
      fresh.push(lease!);
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
  try {
    return withLeaseLock(agentDir, () => {
    const path = leasePath(agentDir, sessionId);
    const current = existsSync(path) ? readLeaseFile(path) : null;
    // 只抢死持有者的租约：活进程（哪怕心跳过期）仍可能是 writer。
    if (current && current.pid !== process.pid && !canEvictLease(current)) {
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
  } catch (error) {
    if (isLeaseLockTimeout(error)) return false;
    throw error;
  }
}

export function heartbeatRunningLease(
  sessionId: string,
  agentDir: string = getAgentDir(),
  now = Date.now(),
): void {
  if (!sessionId) return;
  try {
    withLeaseLock(agentDir, () => {
      const path = leasePath(agentDir, sessionId);
      const current = existsSync(path) ? readLeaseFile(path) : null;
      // 绝不覆盖活持有者的租约（哪怕对方心跳过期）：它就是 writer。
      if (current && current.pid !== process.pid && !canEvictLease(current)) return;
      writeLease(path, {
        pid: process.pid,
        sessionId,
        heartbeatAt: now,
        startedAt: current && current.pid === process.pid ? current.startedAt : now,
      });
    });
  } catch (error) {
    if (!isLeaseLockTimeout(error)) throw error;
  }
}

export function releaseRunningLease(
  sessionId: string,
  agentDir: string = getAgentDir(),
): void {
  if (!sessionId) return;
  try {
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
  } catch (error) {
    if (!isLeaseLockTimeout(error)) throw error;
  }
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
  if (!lease) return false;
  if (lease.pid === process.pid) return false;
  // 对端进程仍活着就是「被别进程占用」，不因心跳过期而放行；
  // 死 pid 可立即接管（与 acquireRunningLease 同口径）。
  return isLeaseHeldByLiveOwner(lease);
}
