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
  isRunningLeaseHeldByOther,
  RUNNING_LEASE_TTL_MS,
  RUNNING_LEASE_DIRNAME,
} = await jiti.import("./session-running-lease.ts");

test("running lease：本进程 acquire 后出现在列表，release 后消失", () => {
  const agentDir = mkdtempSync(join(tmpdir(), "lease-"));
  try {
    assert.equal(acquireRunningLease("sid-a", agentDir, 1_000), true);
    assert.deepEqual(listFreshRunningLeaseSessionIds(agentDir, 1_000), ["sid-a"]);
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
