import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { spawn } from "node:child_process";

const jiti = createJiti(import.meta.url);
const {
  acquireRunningLease,
  heartbeatRunningLease,
  releaseRunningLease,
  listFreshRunningLeaseSessionIds,
  listFreshRunningLeaseSessions,
  isRunningLeaseHeldByOther,
  RUNNING_LEASE_TTL_MS,
  RUNNING_LEASE_DIRNAME,
} = await jiti.import("./session-running-lease.ts");
const { getRunningStartedAtTable, getRunningRpcSessionIds, recoverFollowUpQueues } = await jiti.import("./live-session-registry.ts");

test("running lease：本进程 acquire 后出现在列表，release 后消失", () => {
  const agentDir = mkdtempSync(join(tmpdir(), "lease-"));
  try {
    assert.equal(acquireRunningLease("sid-a", agentDir, 1_000), true);
    assert.deepEqual(listFreshRunningLeaseSessionIds(agentDir, 1_000), ["sid-a"]);
    assert.deepEqual(listFreshRunningLeaseSessions(agentDir, 1_000), [{ sessionId: "sid-a", startedAt: 1_000 }]);
    heartbeatRunningLease("sid-a", agentDir, 1_500);
    assert.deepEqual(listFreshRunningLeaseSessions(agentDir, 1_500), [{ sessionId: "sid-a", startedAt: 1_000 }]);
    assert.equal(isRunningLeaseHeldByOther("sid-a", agentDir, 1_000), false);
    releaseRunningLease("sid-a", agentDir);
    assert.deepEqual(listFreshRunningLeaseSessionIds(agentDir, 1_000), []);
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("running lease：其他活着的 pid 未过期时拒绝 acquire", () => {
  const agentDir = mkdtempSync(join(tmpdir(), "lease-"));
  try {
    mkdirSync(join(agentDir, RUNNING_LEASE_DIRNAME), { recursive: true });
    writeFileSync(
      join(agentDir, RUNNING_LEASE_DIRNAME, "sid-b.json"),
      JSON.stringify({ pid: 1, sessionId: "sid-b", heartbeatAt: 5_000 }),
    );
    assert.equal(isRunningLeaseHeldByOther("sid-b", agentDir, 5_000), true);
    assert.equal(acquireRunningLease("sid-b", agentDir, 5_000), false);
    assert.deepEqual(listFreshRunningLeaseSessionIds(agentDir, 5_000), ["sid-b"]);
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("running lease：过期或死 pid 可抢占", () => {
  const agentDir = mkdtempSync(join(tmpdir(), "lease-"));
  try {
    mkdirSync(join(agentDir, RUNNING_LEASE_DIRNAME), { recursive: true });
    writeFileSync(
      join(agentDir, RUNNING_LEASE_DIRNAME, "sid-c.json"),
      JSON.stringify({
        pid: 1,
        sessionId: "sid-c",
        heartbeatAt: 1_000,
      }),
    );
    const now = 1_000 + RUNNING_LEASE_TTL_MS + 1;
    assert.equal(isRunningLeaseHeldByOther("sid-c", agentDir, now), false);
    assert.equal(acquireRunningLease("sid-c", agentDir, now), true);
    heartbeatRunningLease("sid-c", agentDir, now + 10);
    assert.equal(isRunningLeaseHeldByOther("sid-c", agentDir, now + 10), false);
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});


test("running projection：writer lease 不进入 running 计时/集合", () => {
  const agentDir = mkdtempSync(join(tmpdir(), "lease-table-"));
  try {
    mkdirSync(join(agentDir, RUNNING_LEASE_DIRNAME), { recursive: true });
    writeFileSync(
      join(agentDir, RUNNING_LEASE_DIRNAME, "remote.json"),
      JSON.stringify({
        pid: process.pid,
        sessionId: "remote-epoch",
        heartbeatAt: 9_000,
        startedAt: 7_000,
      }),
    );
    assert.equal(getRunningStartedAtTable(agentDir, 9_100)["remote-epoch"], undefined);
    assert.equal(getRunningRpcSessionIds().includes("remote-epoch"), false);
    assert.deepEqual(listFreshRunningLeaseSessionIds(agentDir, 9_100), ["remote-epoch"]);
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("running projection：本地 starting id 不因重复读取而重置 startedAt", () => {
  const previous = globalThis.__piStartLocks;
  const agentDir = mkdtempSync(join(tmpdir(), "lease-local-"));
  try {
    globalThis.__piStartLocks = new Map([["local-start-epoch", Promise.resolve(null)]]);
    const first = getRunningStartedAtTable(agentDir, 10_000);
    const second = getRunningStartedAtTable(agentDir, 20_000);
    assert.equal(first["local-start-epoch"], 10_000);
    assert.equal(second["local-start-epoch"], 10_000);
  } finally {
    globalThis.__piStartLocks = previous;
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("running lease：过期文件在列举时被清理", () => {
  const agentDir = mkdtempSync(join(tmpdir(), "lease-prune-"));
  try {
    mkdirSync(join(agentDir, RUNNING_LEASE_DIRNAME), { recursive: true });
    const stalePath = join(agentDir, RUNNING_LEASE_DIRNAME, "stale.json");
    writeFileSync(
      stalePath,
      JSON.stringify({
        pid: 1,
        sessionId: "stale",
        heartbeatAt: 1_000,
        startedAt: 1_000,
      }),
    );
    const now = 1_000 + RUNNING_LEASE_TTL_MS + 1;
    assert.deepEqual(listFreshRunningLeaseSessionIds(agentDir, now), []);
    assert.equal(existsSync(stalePath), false);
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});

/** 子进程：用真实模块在指定 agentDir 抢租约并持续心跳（模拟另一个 Pidance 进程）。 */
const LEASE_CHILD_SOURCE = `
import { pathToFileURL } from "node:url";
import { createJiti } from "jiti";
const target = pathToFileURL(process.cwd() + "/lib/session-running-lease.ts").href;
const mod = await createJiti(target).import(target);
const sid = process.env.LEASE_SESSION_ID;
const dir = process.env.LEASE_AGENT_DIR;
if (!mod.acquireRunningLease(sid, dir)) process.exit(3);
setInterval(() => mod.heartbeatRunningLease(sid, dir), 300);
`;

function spawnLeaseHolder(sessionId, agentDir) {
  return spawn(process.execPath, ["--input-type=module", "-e", LEASE_CHILD_SOURCE], {
    cwd: process.cwd(),
    env: { ...process.env, LEASE_SESSION_ID: sessionId, LEASE_AGENT_DIR: agentDir },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function waitForLease(predicate, message, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(message);
}

test("running lease：两个进程共享同一 agentDir 时互斥，持有者退出后可抢占", { timeout: 30_000 }, async () => {
  const agentDir = mkdtempSync(join(tmpdir(), "lease-xproc-"));
  const sessionId = "xproc-session";
  let child;
  try {
    child = spawnLeaseHolder(sessionId, agentDir);
    await waitForLease(
      () => isRunningLeaseHeldByOther(sessionId, agentDir),
      "子进程未能在共享 agentDir 抢到租约",
    );
    // 对端持有 writer 窗口：本进程不得抢占，且对外可见为 locked。
    assert.equal(acquireRunningLease(sessionId, agentDir), false, "对端持锁时本进程不得 acquire");
    assert.deepEqual(listFreshRunningLeaseSessionIds(agentDir), [sessionId]);

    // 持有者消失（进程被杀 = 崩溃/被清掉）：死 pid 立即失效，可被抢占。
    child.kill("SIGKILL");
    await new Promise((resolve) => child.once("exit", resolve));
    child = null;
    assert.equal(isRunningLeaseHeldByOther(sessionId, agentDir), false, "死 pid 的租约必须失效");
    assert.equal(acquireRunningLease(sessionId, agentDir), true, "死 pid 的租约可被抢占");
    releaseRunningLease(sessionId, agentDir);
  } finally {
    child?.kill("SIGKILL");
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("follow-up 恢复：对端持锁时不启动本进程 host", { timeout: 30_000 }, async () => {
  const agentDir = mkdtempSync(join(tmpdir(), "lease-recover-"));
  const sessionId = "recover-held-session";
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  let child;
  try {
    process.env.PI_CODING_AGENT_DIR = agentDir;
    writeFileSync(
      join(agentDir, "pidance-preferences.json"),
      JSON.stringify({ sessionQueue: { [sessionId]: ["queued while other process owns writer"] } }),
    );
    child = spawnLeaseHolder(sessionId, agentDir);
    await waitForLease(
      () => isRunningLeaseHeldByOther(sessionId, agentDir),
      "子进程未能在共享 agentDir 抢到租约",
    );

    await recoverFollowUpQueues();

    assert.equal(
      getRunningRpcSessionIds().includes(sessionId),
      false,
      "对端持锁时本进程不得为该会话启动 host",
    );
    assert.equal(isRunningLeaseHeldByOther(sessionId, agentDir), true, "对端租约不得被本进程覆盖");
  } finally {
    child?.kill("SIGKILL");
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(agentDir, { recursive: true, force: true });
  }
});
