import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
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
const { resolveSessionPath } = await jiti.import("./session-reader.ts");

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
  const sleeper = spawnSleeper();
  try {
    mkdirSync(join(agentDir, RUNNING_LEASE_DIRNAME), { recursive: true });
    writeFileSync(
      join(agentDir, RUNNING_LEASE_DIRNAME, "sid-b.json"),
      JSON.stringify({ pid: sleeper.pid, sessionId: "sid-b", heartbeatAt: 5_000 }),
    );
    assert.equal(isRunningLeaseHeldByOther("sid-b", agentDir, 5_000), true);
    assert.equal(acquireRunningLease("sid-b", agentDir, 5_000), false);
    assert.deepEqual(listFreshRunningLeaseSessionIds(agentDir, 5_000), ["sid-b"]);
  } finally {
    sleeper.kill("SIGKILL");
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("running lease：活 pid 心跳过期不得抢占，死 pid 才可接管（#30）", async () => {
  const agentDir = mkdtempSync(join(tmpdir(), "lease-"));
  const sleeper = spawnSleeper();
  try {
    mkdirSync(join(agentDir, RUNNING_LEASE_DIRNAME), { recursive: true });
    // 活进程持有但心跳远超 TTL：其 SessionManager 仍可能持有 JSONL writer，
    // 因此 acquire 与「是否被他人持有」都不得仅凭心跳过期放行。
    writeFileSync(
      join(agentDir, RUNNING_LEASE_DIRNAME, "sid-c.json"),
      JSON.stringify({ pid: sleeper.pid, sessionId: "sid-c", heartbeatAt: 1_000 }),
    );
    const now = 1_000 + RUNNING_LEASE_TTL_MS + 1;
    assert.equal(
      isRunningLeaseHeldByOther("sid-c", agentDir, now),
      true,
      "活持有者心跳过期仍应视为被占用",
    );
    assert.equal(
      acquireRunningLease("sid-c", agentDir, now),
      false,
      "不得抢活持有者的写权（否则双 writer）",
    );

    // 持有者退出后才可接管（死 pid 立即可抢，不必等 TTL）。
    sleeper.kill("SIGKILL");
    await waitForLease(() => {
      try { process.kill(sleeper.pid, 0); return false; } catch { return true; }
    }, "占位进程未退出");
    assert.equal(isRunningLeaseHeldByOther("sid-c", agentDir, now), false);
    assert.equal(acquireRunningLease("sid-c", agentDir, now), true);
    heartbeatRunningLease("sid-c", agentDir, now + 10);
    assert.equal(isRunningLeaseHeldByOther("sid-c", agentDir, now + 10), false);
  } finally {
    sleeper.kill("SIGKILL");
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("running lease：死 pid 租约即使心跳新鲜也从列表回收", async () => {
  const agentDir = mkdtempSync(join(tmpdir(), "lease-"));
  const sleeper = spawnSleeper();
  const deadPid = sleeper.pid;
  sleeper.kill("SIGKILL");
  await waitForLease(() => {
    try { process.kill(deadPid, 0); return false; } catch { return true; }
  }, "占位进程未退出");
  try {
    mkdirSync(join(agentDir, RUNNING_LEASE_DIRNAME), { recursive: true });
    writeFileSync(
      join(agentDir, RUNNING_LEASE_DIRNAME, "sid-dead.json"),
      JSON.stringify({ pid: deadPid, sessionId: "sid-dead", heartbeatAt: 1_000 }),
    );
    // 心跳时间戳仍「新鲜」，但持有者已死：不应继续占用。
    assert.deepEqual(listFreshRunningLeaseSessionIds(agentDir, 1_000), []);
    assert.equal(isRunningLeaseHeldByOther("sid-dead", agentDir, 1_000), false);
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

/**
 * 子进程：用真实模块在指定 agentDir 抢租约。
 * LEASE_BARRIER_AT（绝对毫秒）用于让多个进程在同一时刻竞争；
 * 抢到后持续心跳 LEASE_HOLD_MS，便于父进程观察互斥效果。
 */
const LEASE_CHILD_SOURCE = `
import { pathToFileURL } from "node:url";
import { createJiti } from "jiti";
const target = pathToFileURL(process.cwd() + "/lib/session-running-lease.ts").href;
const mod = await createJiti(target).import(target);
const sid = process.env.LEASE_SESSION_ID;
const dir = process.env.LEASE_AGENT_DIR;
const barrierAt = Number(process.env.LEASE_BARRIER_AT || 0);
while (Date.now() < barrierAt) { /* 自旋到同一时刻，最大化竞争窗口 */ }
const won = mod.acquireRunningLease(sid, dir);
console.log(won ? "won" : "lost");
if (!won) process.exit(0);
const holdMs = Number(process.env.LEASE_HOLD_MS || 0);
const timer = setInterval(() => mod.heartbeatRunningLease(sid, dir), 200);
if (holdMs > 0) setTimeout(() => { clearInterval(timer); process.exit(0); }, holdMs);
`;

function spawnLeaseHolder(sessionId, agentDir, { barrierAt = 0, holdMs = 0 } = {}) {
  return spawn(process.execPath, ["--input-type=module", "-e", LEASE_CHILD_SOURCE], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      LEASE_SESSION_ID: sessionId,
      LEASE_AGENT_DIR: agentDir,
      LEASE_BARRIER_AT: String(barrierAt),
      LEASE_HOLD_MS: String(holdMs),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** 收集子进程 stdout（含 "won"/"lost" 判定行）。 */
function collectChildOutput(child) {
  let buffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { buffer += chunk; });
  return () => buffer;
}

/** 启动一个只用来占住 pid 的存活进程（用于构造"其他进程持有"的租约）。 */
function spawnSleeper() {
  return spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], { stdio: "ignore" });
}

/** 读锁文件里的 token（仅测试用：验证锁仍属于原持有者）。 */
function readLockToken(lockPath) {
  try {
    return JSON.parse(readFileSync(lockPath, "utf8")).token ?? null;
  } catch {
    return null;
  }
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

test("follow-up 恢复：对端持锁时不启动本进程 host（真实可解析会话）", { timeout: 30_000 }, async () => {
  const agentDir = mkdtempSync(join(tmpdir(), "lease-recover-"));
  const sessionId = "recover-held-session";
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  let child;
  try {
    process.env.PI_CODING_AGENT_DIR = agentDir;
    // 真实落盘的会话（header + 一条 user 消息）：确保"没启动 host"只可能因为租约，
    // 而不是 resolveSessionPath 找不到文件。
    const sessionDir = join(agentDir, "sessions", "--recover-fixture--");
    mkdirSync(sessionDir, { recursive: true });
    const sessionFile = join(sessionDir, `2026-01-01T00-00-00-000Z_${sessionId}.jsonl`);
    writeFileSync(
      sessionFile,
      [
        JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: "2026-01-01T00:00:00.000Z", cwd: "/tmp" }),
        JSON.stringify({ type: "message", id: "m1", parentId: null, timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: "fixture", timestamp: Date.now() } }),
      ].join("\n") + "\n",
    );
    writeFileSync(
      join(agentDir, "pidance-preferences.json"),
      JSON.stringify({ sessionQueue: { [sessionId]: ["queued while other process owns writer"] } }),
    );

    // 正控制：会话必须可解析，否则本用例会因为找不到文件而假通过。
    assert.equal(await resolveSessionPath(sessionId), sessionFile, "fixture 会话不可解析，用例无意义");

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

test("running lease：两个进程同时抢锁只有一方成功（TOCTOU 回归）", { timeout: 30_000 }, async () => {
  const agentDir = mkdtempSync(join(tmpdir(), "lease-race-"));
  const sessionId = "race-session";
  const children = [];
  try {
    // 屏障：两个子进程在同一绝对时刻开始 acquire。
    const barrierAt = Date.now() + 600;
    for (let i = 0; i < 2; i += 1) {
      const child = spawnLeaseHolder(sessionId, agentDir, { barrierAt, holdMs: 2_500 });
      children.push({ child, output: collectChildOutput(child) });
    }
    await Promise.all(children.map(({ child }) => new Promise((resolve) => child.once("exit", resolve))));
    const verdicts = children.map(({ output }) => output().trim().split("\n").at(-1)).filter(Boolean);
    assert.equal(verdicts.length, 2, `子进程未输出判定：${JSON.stringify(verdicts)}`);
    assert.equal(
      verdicts.filter((verdict) => verdict === "won").length,
      1,
      `同时竞争必须恰好一方成功，实际 ${JSON.stringify(verdicts)}`,
    );
    // 竞争结束后租约仍可被本进程按规则处理（赢家已退出 → 死 pid 可抢占）。
    assert.equal(acquireRunningLease(sessionId, agentDir), true);
    releaseRunningLease(sessionId, agentDir);
    assert.deepEqual(listFreshRunningLeaseSessionIds(agentDir), []);
  } finally {
    for (const { child } of children) child.kill("SIGKILL");
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("running lease：清理过期文件不误删新 owner，旧 owner 不删新租约", { timeout: 30_000 }, async () => {
  const agentDir = mkdtempSync(join(tmpdir(), "lease-owner-"));
  const leaseDir = join(agentDir, RUNNING_LEASE_DIRNAME);
  let sleeper;
  try {
    sleeper = spawnSleeper();
    mkdirSync(leaseDir, { recursive: true });
    const stalePath = join(leaseDir, "stale.json");
    const freshPath = join(leaseDir, "fresh.json");
    writeFileSync(stalePath, JSON.stringify({ pid: 1, sessionId: "stale", heartbeatAt: 1_000 }));
    writeFileSync(
      freshPath,
      JSON.stringify({ pid: sleeper.pid, sessionId: "fresh", heartbeatAt: Date.now() }),
    );

    assert.deepEqual(listFreshRunningLeaseSessionIds(agentDir), ["fresh"], "只应保留新鲜租约");
    assert.equal(existsSync(stalePath), false, "过期文件应被清理");
    assert.equal(existsSync(freshPath), true, "新鲜租约不得被清理误删");

    // 旧 owner（本进程）不得删除对端持有的租约。
    releaseRunningLease("fresh", agentDir);
    assert.equal(existsSync(freshPath), true, "旧 owner 不得删除新 owner 的租约");
    // 对端进程消失后才可回收。
    sleeper.kill("SIGKILL");
    await new Promise((resolve) => sleeper.once("exit", resolve));
    sleeper = null;
    assert.equal(acquireRunningLease("fresh", agentDir), true, "死 pid 的租约可被抢占");
    releaseRunningLease("fresh", agentDir);
  } finally {
    sleeper?.kill("SIGKILL");
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("lease lock：活着的持有者（含被暂停）不因「文件旧」被抢锁", { timeout: 30_000 }, async () => {
  const agentDir = mkdtempSync(join(tmpdir(), "lease-lock-live-"));
  const leaseDir = join(agentDir, RUNNING_LEASE_DIRNAME);
  let sleeper;
  try {
    sleeper = spawnSleeper();
    mkdirSync(leaseDir, { recursive: true });
    const lockPath = join(leaseDir, ".lease-lock");
    writeFileSync(lockPath, JSON.stringify({ pid: sleeper.pid, token: "peer-token" }));
    // 把锁文件时间改老，模拟「持有者被 SIGSTOP/长 GC 暂停」：mtime 很旧但进程活着。
    const old = Date.now() / 1000 - 3600;
    utimesSync(lockPath, old, old);

    assert.equal(
      acquireRunningLease("lock-live-session", agentDir),
      false,
      "持有者活着（哪怕锁文件很旧）时必须 fail closed，不得抢锁",
    );
    assert.equal(existsSync(lockPath), true, "不得删除活着持有者的锁");
    assert.equal(readLockToken(lockPath), "peer-token", "锁必须仍属于原持有者");

    // 持有者消失后锁可回收。
    sleeper.kill("SIGKILL");
    await new Promise((resolve) => sleeper.once("exit", resolve));
    sleeper = null;
    assert.equal(acquireRunningLease("lock-live-session", agentDir), true, "死 pid 的锁应被回收后拿到写权");
    releaseRunningLease("lock-live-session", agentDir);
  } finally {
    sleeper?.kill("SIGKILL");
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("lease lock：损坏内容只回收旧残留，新文件不抢", { timeout: 30_000 }, async () => {
  const agentDir = mkdtempSync(join(tmpdir(), "lease-lock-corrupt-"));
  const leaseDir = join(agentDir, RUNNING_LEASE_DIRNAME);
  try {
    mkdirSync(leaseDir, { recursive: true });
    const lockPath = join(leaseDir, ".lease-lock");

    // 很旧的损坏文件：视为残留，回收后可拿到写权。
    writeFileSync(lockPath, "");
    const old = Date.now() / 1000 - 3600;
    utimesSync(lockPath, old, old);
    assert.equal(acquireRunningLease("corrupt-old", agentDir), true, "旧残留应被回收");
    releaseRunningLease("corrupt-old", agentDir);

    // 刚创建但内容损坏：可能是别人正在创建，不得抢。
    writeFileSync(lockPath, "");
    assert.equal(
      acquireRunningLease("corrupt-fresh", agentDir),
      false,
      "刚出现的损坏锁不得抢占（可能是他人正在创建）",
    );
    assert.equal(existsSync(lockPath), true, "不得删除他人的锁文件");
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("lease lock：暂停的租约持有者期间，本进程不得成为 writer", { timeout: 30_000 }, async () => {
  const agentDir = mkdtempSync(join(tmpdir(), "lease-paused-"));
  const sessionId = "paused-session";
  let child;
  try {
    child = spawnLeaseHolder(sessionId, agentDir, { holdMs: 0 });
    await waitForLease(() => isRunningLeaseHeldByOther(sessionId, agentDir), "子进程未抢到租约");
    // 暂停持有者：心跳停止，但进程仍活着 → 租约在 TTL 内必须继续生效。
    child.kill("SIGSTOP");
    assert.equal(isRunningLeaseHeldByOther(sessionId, agentDir), true, "暂停中的持有者仍占写权");
    assert.equal(acquireRunningLease(sessionId, agentDir), false, "不得抢暂停持有者的写权");

    child.kill("SIGKILL");
    await new Promise((resolve) => child.once("exit", resolve));
    child = null;
    assert.equal(acquireRunningLease(sessionId, agentDir), true, "持有者退出后可接管");
    releaseRunningLease(sessionId, agentDir);
  } finally {
    child?.kill("SIGKILL");
    rmSync(agentDir, { recursive: true, force: true });
  }
});
