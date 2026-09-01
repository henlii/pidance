/**
 * 跨进程 running/starting 租约：31415 与 31416 共享 agentDir 时，
 * 让对端看见「正在跑」，并拒绝第二套 writable prompt。
 * 只覆盖 starting/running 窗口；空闲 live host 不占租约（避免闲置 10 分钟锁死）。
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "./pi-paths";

export const SESSION_RUNNING_LOCKED_MESSAGE =
  "Session is locked by another Pidance process (writable host ownership)";

export const RUNNING_LEASE_TTL_MS = 20_000;
export const RUNNING_LEASE_DIRNAME = "pidance-running-leases";

export type RunningLease = {
  pid: number;
  sessionId: string;
  heartbeatAt: number;
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
    return { pid: raw.pid, sessionId: raw.sessionId, heartbeatAt: raw.heartbeatAt };
  } catch {
    return null;
  }
}

function isFresh(lease: RunningLease, now: number): boolean {
  return now - lease.heartbeatAt <= RUNNING_LEASE_TTL_MS && isPidAlive(lease.pid);
}

function writeLease(path: string, lease: RunningLease): void {
  writeFileSync(path, `${JSON.stringify(lease)}\n`, { mode: 0o600 });
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
  const dir = leaseDir(agentDir);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = leasePath(agentDir, sessionId);
  const current = existsSync(path) ? readLeaseFile(path) : null;
  if (current && isFresh(current, now) && current.pid !== process.pid) {
    return false;
  }
  writeLease(path, { pid: process.pid, sessionId, heartbeatAt: now });
  return true;
}

export function heartbeatRunningLease(
  sessionId: string,
  agentDir: string = getAgentDir(),
  now = Date.now(),
): void {
  if (!sessionId) return;
  const path = leasePath(agentDir, sessionId);
  const current = existsSync(path) ? readLeaseFile(path) : null;
  if (current && current.pid !== process.pid && isFresh(current, now)) return;
  if (!existsSync(leaseDir(agentDir))) mkdirSync(leaseDir(agentDir), { recursive: true, mode: 0o700 });
  writeLease(path, { pid: process.pid, sessionId, heartbeatAt: now });
}

export function releaseRunningLease(
  sessionId: string,
  agentDir: string = getAgentDir(),
): void {
  if (!sessionId) return;
  const path = leasePath(agentDir, sessionId);
  const current = existsSync(path) ? readLeaseFile(path) : null;
  if (current && current.pid !== process.pid) return;
  try {
    unlinkSync(path);
  } catch {
    /* ignore */
  }
}

export function listFreshRunningLeaseSessionIds(
  agentDir: string = getAgentDir(),
  now = Date.now(),
): string[] {
  const dir = leaseDir(agentDir);
  if (!existsSync(dir)) return [];
  const ids: string[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    const lease = readLeaseFile(join(dir, name));
    if (!lease || !isFresh(lease, now)) continue;
    ids.push(lease.sessionId);
  }
  return ids;
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
