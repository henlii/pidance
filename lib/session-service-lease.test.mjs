/**
 * #27 A4 / A8 直测：**对端进程持有 writer 租约**时，Service 层的入口必须明确失败（409 文案），
 * 且**不得写盘**；持有者进程消失（死 pid）后同一入口应当恢复可用。
 *
 * 与 `lib/session-running-lease.test.mjs` 的分工：那边测租约自身的 acquire/release 语义
 * （底层），这里测**Service 层**的可观察行为 —— 这正是 issue #27 验收 A4（ensureLive /
 * submitPrompt 得到 locked、JSONL 没有第二套 writer）与 A8（rename / appendActivity / branch
 * 409 且磁盘不被写）要的直测。
 *
 * 伪造方式：子进程抢到真实租约后只做心跳（不写任何 JSONL），等价于「另一个 Pidance 进程
 * 正持有该会话的 writer」——不需要真的起 31415。
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { spawn } from "node:child_process";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { createSessionService } = await jiti.import("./session-service.ts");
const { openSessionView } = await jiti.import("./pi-session-io.ts");
const {
  SESSION_RUNNING_LOCKED_MESSAGE,
  isRunningLeaseHeldByOther,
  isSessionRunningLockedError,
} = await jiti.import("./session-running-lease.ts");

/** 子进程：抢到租约后只心跳（模拟对端 Pidance 持有 writer），不做任何写盘。 */
const LEASE_HOLDER_SOURCE = `
import { pathToFileURL } from "node:url";
import { createJiti } from "jiti";
const target = pathToFileURL(process.cwd() + "/lib/session-running-lease.ts").href;
const mod = await createJiti(target).import(target);
const sid = process.env.LEASE_SESSION_ID;
const dir = process.env.LEASE_AGENT_DIR;
const won = mod.acquireRunningLease(sid, dir);
console.log(won ? "held" : "lost");
if (!won) process.exit(2);
setInterval(() => mod.heartbeatRunningLease(sid, dir), 200);
`;

function spawnLeaseHolder(sessionId, agentDir) {
  return spawn(process.execPath, ["--input-type=module", "-e", LEASE_HOLDER_SOURCE], {
    cwd: process.cwd(),
    env: { ...process.env, LEASE_SESSION_ID: sessionId, LEASE_AGENT_DIR: agentDir },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** 写一个**真实可解析**的会话 fixture（header + 一条 user 消息），确保失败只因租约。 */
function writeSessionFixture(agentDir, sessionId) {
  const sessionDir = join(agentDir, "sessions", "--lease-service-fixture--");
  mkdirSync(sessionDir, { recursive: true });
  const file = join(sessionDir, `2026-01-01T00-00-00-000Z_${sessionId}.jsonl`);
  writeFileSync(
    file,
    [
      JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: "2026-01-01T00:00:00.000Z", cwd: "/tmp" }),
      JSON.stringify({
        type: "message",
        id: "m1",
        parentId: null,
        timestamp: "2026-01-01T00:00:01.000Z",
        message: { role: "user", content: "fixture", timestamp: Date.now() },
      }),
    ].join("\n") + "\n",
  );
  return file;
}

function makeService(agentDir, file, sessionId, onStartHost = () => {}) {
  return createSessionService({
    listAllSessions: async () => [
      { id: sessionId, cwd: "/tmp", path: file, created: "", modified: "", messageCount: 1, firstMessage: "fixture" },
    ],
    resolveSessionPath: async () => file,
    getRpcSession: () => undefined,
    waitForSessionStart: async () => null,
    // 起了 host 就是「第二套 writer」——A4 要求它在对端持锁时**一次都不发生**。
    startRpcSession: async () => {
      onStartHost();
      throw new Error("测试替身：对端持锁期间不该启动 host");
    },
    openSessionView: (path) => openSessionView(path),
    archiveAgentDir: () => agentDir,
    invalidateSessionListCache: () => {},
  });
}

/** 断言失败确实是「对端持有 writer」这一类（而不是别的错误被误当成锁）。 */
function assertLockedRejection(fn, label) {
  return assert.rejects(
    fn,
    (error) => {
      const message = error instanceof Error ? error.message : String(error);
      assert.ok(
        isSessionRunningLockedError(error) && message.includes(SESSION_RUNNING_LOCKED_MESSAGE),
        `${label} 应因对端租约失败，实际：${message}`,
      );
      return true;
    },
  );
}

test("#27 A4/A8：对端持有活 pid 租约时，Service 各入口明确 locked 且磁盘不被写", { timeout: 30_000 }, async () => {
  const agentDir = mkdtempSync(join(tmpdir(), "svc-lease-"));
  const sessionId = "01a00000-0000-7000-8000-000000000027";
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  let child = null;
  try {
    const file = writeSessionFixture(agentDir, sessionId);
    process.env.PI_CODING_AGENT_DIR = agentDir;

    child = spawnLeaseHolder(sessionId, agentDir);
    // 等子进程真的抢到租约（否则后面的断言可能在「还没持锁」时假绿）。
    for (let i = 0; i < 100 && !isRunningLeaseHeldByOther(sessionId); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(isRunningLeaseHeldByOther(sessionId), true, "前置失败：子进程没能持有租约");

    let hostStarts = 0;
    const service = makeService(agentDir, file, sessionId, () => { hostStarts += 1; });
    const before = readFileSync(file, "utf8");
    const mtimeBefore = statSync(file).mtimeMs;

    // A4：ensureLive / submitPrompt 必须 locked（不能静默再开一个 SessionManager）
    await assertLockedRejection(() => service.ensureLive(sessionId), "A4 ensureLive");
    await assertLockedRejection(
      () => service.submitPrompt(sessionId, { type: "prompt", message: "hi", submissionId: "sub-locked-1" }),
      "A4 submitPrompt",
    );

    // A8：离线写三件套必须 locked（rename / appendActivity / branchFromAssistant）
    await assertLockedRejection(() => service.renameSession(sessionId, "被对端持锁时的改名"), "A8 renameSession");
    await assertLockedRejection(
      () => service.appendActivity(sessionId, { kind: "note", title: "t", content: "c" }),
      "A8 appendActivity",
    );
    await assertLockedRejection(() => service.branchFromAssistant(sessionId, "m1"), "A8 branchFromAssistant");

    // 磁盘必须逐字未变（mtime 也不变：一字节都没写）
    assert.equal(readFileSync(file, "utf8"), before, "对端持锁时 JSONL 内容被改写了");
    assert.equal(statSync(file).mtimeMs, mtimeBefore, "对端持锁时 JSONL 被写（mtime 变化）");

    // A4 的强断言：对端持锁期间**一次都没起过 host**（否则就是第二套 SessionManager writer）
    assert.equal(hostStarts, 0, "对端持锁时仍然启动了 host（双 writer 风险）");

    // 对端持锁期间，状态投影必须是「对端锁定」而不是假 cold
    assert.deepEqual(await service.getAgentState(sessionId), { live: false, activeRun: false, lockedByOther: true });

    // 反证：持有者进程消失（死 pid）后同一入口应当成功 —— 证明上面的失败确实来自租约
    child.kill("SIGKILL");
    await new Promise((resolve) => child.once("exit", resolve));
    child = null;
    assert.equal(isRunningLeaseHeldByOther(sessionId), false, "死 pid 的租约必须失效");
    await assert.doesNotReject(() => service.renameSession(sessionId, "rename-after-peer-died"));
    assert.equal(hostStarts, 0, "离线写（rename）本来就不该起 host");
    assert.ok(
      readFileSync(file, "utf8").includes("rename-after-peer-died"),
      "反证失败：对端消失后 rename 应当真的写进 JSONL",
    );
  } finally {
    child?.kill("SIGKILL");
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("#27 A4：对端租约不影响只读会话判定（readOnly 会话仍走 readOnly 分支）", { timeout: 30_000 }, async () => {
  const agentDir = mkdtempSync(join(tmpdir(), "svc-lease-ro-"));
  const sessionId = "01a00000-0000-7000-8000-000000000028";
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  let child = null;
  try {
    const file = writeSessionFixture(agentDir, sessionId);
    process.env.PI_CODING_AGENT_DIR = agentDir;
    child = spawnLeaseHolder(sessionId, agentDir);
    for (let i = 0; i < 100 && !isRunningLeaseHeldByOther(sessionId); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const service = createSessionService({
      listAllSessions: async () => [
        { id: sessionId, cwd: "/tmp", path: file, created: "", modified: "", messageCount: 1, firstMessage: "fixture", readOnly: true },
      ],
      resolveSessionPath: async () => file,
      getRpcSession: () => undefined,
      waitForSessionStart: async () => null,
      openSessionView: (path) => openSessionView(path),
      archiveAgentDir: () => agentDir,
      invalidateSessionListCache: () => {},
    });
    // 只读会话：状态投影带 readOnly，且 ensureLive 不得因为租约去启动 host
    const state = await service.getAgentState(sessionId);
    assert.equal(state.readOnly, true);
    await assert.rejects(() => service.ensureLive(sessionId));
    assert.match(readFileSync(file, "utf8"), /fixture/, "只读判定路径不该改写 JSONL");
  } finally {
    child?.kill("SIGKILL");
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(agentDir, { recursive: true, force: true });
  }
});
