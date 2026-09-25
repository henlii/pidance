/**
 * /api/sessions/[id]/lock：只读的 writer 租约探针（锁定条的发现路径）。
 *
 * 两段：
 * 1. 纯 handler：把锁定/未锁定/缺参/探针异常映射成明确状态码与响应体；
 * 2. 真实依赖：临时 agentDir + 一个**活着的** sleeper 进程持有租约 → 必须报 true；
 *    持有者进程死掉后 → 必须报 false（死 pid 可立即接管，与 acquireRunningLease 同口径）；
 *    本进程自己持有的租约 → false（自己不算「被对端占用」）。
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import test, { after } from "node:test";
import { createJiti } from "jiti";
import { fileURLToPath } from "node:url";

const jiti = createJiti(import.meta.url, {
  alias: { "@": fileURLToPath(new URL("../", import.meta.url)) },
});
const { createSessionLockHandler } = await jiti.import("./session-lock-route.ts");

// route 文件现在只做「工厂 → HTTP 方法」这一步，测试直接驱动工厂。
const GET = createSessionLockHandler();

const tempDirs = [];
function tempAgentDir() {
  const dir = mkdtempSync(join(tmpdir(), "pidance-lock-probe-"));
  tempDirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

const params = (id) => ({ params: Promise.resolve({ id }) });
const run = (handler, id) => handler(new Request("http://localhost/api/sessions/x/lock"), params(id));

/** 租约文件名与 lib/session-running-lease.ts 的 leasePath 同口径。 */
function writeLease(agentDir, sessionId, pid) {
  const dir = join(agentDir, "pidance-running-leases");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const safe = sessionId.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 180);
  writeFileSync(
    join(dir, `${safe}.json`),
    `${JSON.stringify({ pid, sessionId, heartbeatAt: Date.now(), startedAt: Date.now() })}\n`,
  );
}

// ── handler 映射 ────────────────────────────────────────────────────────────

test("对端持锁：200 + lockedByOther=true", async () => {
  const res = await run(createSessionLockHandler({ isLockedByOther: () => true }), "s1");
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { lockedByOther: true });
});

test("未持锁：200 + lockedByOther=false", async () => {
  const res = await run(createSessionLockHandler({ isLockedByOther: () => false }), "s1");
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { lockedByOther: false });
});

test("缺 id：400（不把缺参当「未锁定」放过去）", async () => {
  const res = await run(createSessionLockHandler({ isLockedByOther: () => false }), "   ");
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /Missing session id/);
});

test("探针异常：503 + code=unavailable（客户端据此保留上一次状态，不误清锁定条）", async () => {
  const res = await run(createSessionLockHandler({
    isLockedByOther: () => { throw new Error("lease dir unreadable"); },
  }), "s1");
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.equal(body.code, "unavailable");
  assert.match(body.error, /lease dir unreadable/);
});

// ── 真实依赖（临时 agentDir + 真实活进程） ───────────────────────────────────

test("真实租约：活着的对端进程 → true；进程死后 → false；本进程自己 → false", async (t) => {
  const agentDir = tempAgentDir();
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(() => { delete process.env.PI_CODING_AGENT_DIR; });

  const sessionId = "01a0lockprobe-0000";
  assert.equal((await run(GET, sessionId)).status, 200, "无租约时应正常返回");
  assert.deepEqual(await (await run(GET, sessionId)).json(), { lockedByOther: false }, "无租约时应报未锁定");

  // 本进程自己持有：不算被对端占用（与 acquireRunningLease 的可接管口径一致）。
  writeLease(agentDir, sessionId, process.pid);
  assert.deepEqual(await (await run(GET, sessionId)).json(), { lockedByOther: false }, "自己的租约不应报被对端占用");

  // 活的 sleeper 持有：必须报 true。
  const sleeper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], { stdio: "ignore" });
  try {
    assert.ok(sleeper.pid, "sleeper 未启动");
    writeLease(agentDir, sessionId, sleeper.pid);
    assert.deepEqual(await (await run(GET, sessionId)).json(), { lockedByOther: true }, "活着的对端租约必须报 true");

    sleeper.kill("SIGKILL");
    await once(sleeper, "exit");
    assert.deepEqual(await (await run(GET, sessionId)).json(), { lockedByOther: false }, "持有者进程死后应报未锁定（可立即接管）");
  } finally {
    sleeper.kill("SIGKILL");
  }
});
