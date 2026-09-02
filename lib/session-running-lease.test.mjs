import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

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
const { getRunningStartedAtTable } = await jiti.import("./live-session-registry.ts");

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


test("running projection：跨进程 lease 的 startedAt 保持稳定并进入聚合表", () => {
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
    assert.deepEqual(getRunningStartedAtTable(agentDir, 9_100)["remote-epoch"], 7_000);
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
