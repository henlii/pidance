import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { notifyRunningChange } = await jiti.import("./live-session-registry.ts");
// 同一个 jiti 实例 → 与 live-session-registry 里用的是同一份模块状态（含节流标记）。
const { isUnreadEntrySweepInFlightForTests, resetUnreadEntrySweepForTests } = await jiti.import("./unread-entry-sweep.ts");

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

/** 等上一轮 fire-and-forget 的回收跑完（否则下一次触发会被「执行中」直接跳过）。 */
async function drainUnreadSweep() {
  const deadline = Date.now() + 3000;
  while (isUnreadEntrySweepInFlightForTests() && Date.now() < deadline) await tick();
}

function completedAt(agentDir, sessionId) {
  try {
    const prefs = JSON.parse(readFileSync(join(agentDir, "pidance-preferences.json"), "utf8"));
    return prefs.unreadSessionState?.completedAt?.[sessionId];
  } catch {
    return undefined;
  }
}

/**
 * 未读时钟的写入路径回归。
 *
 * 以前拿「运行集」判「跑完了」，而运行集含 starting —— 打开一个会话会让 host 进入 starting、
 * 稳定后离开，于是**只打开、没提问**也会写一条 completedAt，侧栏立刻多出一个未读。
 * 实测过：在另一个进程里打开用户的会话，对方的侧栏就多一条未读。
 */
test("未读只记在真的跑过的会话上：仅 starting（只打开）不算", async () => {
  const agentDir = mkdtempSync(join(tmpdir(), "unread-running-"));
  const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
  const prevStartLocks = globalThis.__piStartLocks;
  const prevStartedAt = globalThis.__piRunningStartedAt;
  const prevSessions = globalThis.__piSessions;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    // ① 只有 starting：打开会话的过程
    globalThis.__piRunningStartedAt = new Map();
    globalThis.__piStartLocks = new Map([["only-opened", Promise.resolve(null)]]);
    notifyRunningChange();
    globalThis.__piStartLocks = new Map();
    notifyRunningChange();
    await tick();
    assert.equal(completedAt(agentDir, "only-opened"), undefined, "只打开不该产生未读");

    // ② 真的跑过：会话进入 isRunning（真实路径上这个变化会改运行集快照），结束后应记一条
    let running = true;
    globalThis.__piSessions = new Map([
      ["really-ran", { sessionId: "really-ran", isRunning: () => running, isAlive: () => true, listPendingExtensionRequests: () => [], destroy() {} }],
    ]);
    globalThis.__piRunningStartedAt = new Map([["really-ran", 500]]);
    notifyRunningChange();
    running = false;
    globalThis.__piRunningStartedAt = new Map();
    notifyRunningChange();
    await tick();
    assert.equal(typeof completedAt(agentDir, "really-ran"), "string", "跑完了要记未读");
  } finally {
    if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    if (prevStartLocks === undefined) delete globalThis.__piStartLocks;
    else globalThis.__piStartLocks = prevStartLocks;
    if (prevStartedAt === undefined) delete globalThis.__piRunningStartedAt;
    else globalThis.__piRunningStartedAt = prevStartedAt;
    // 先把本轮 fire-and-forget 的回收等干净（它的目录这时还在），别让它飞进下一个用例。
    await drainUnreadSweep();
    if (prevSessions === undefined) delete globalThis.__piSessions;
    else globalThis.__piSessions = prevSessions;
    rmSync(agentDir, { recursive: true, force: true });
  }
});

/**
 * run 结束时的接线：写未读之后会顺手回收「侧栏不会显示」的死条目（见 lib/unread-entry-sweep.ts）。
 *
 * 被删掉的会话、以及恒不显示未读的子代理子会话都会在偏好里留下永远清不掉的条目，
 * 这里是那条回收在真实 run 结束路径上的一次端到端验证。
 */
test("run 结束时会回收死条目，但不动刚写下的未读（宽限期）", async () => {
  const agentDir = mkdtempSync(join(tmpdir(), "unread-sweep-wire-"));
  const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
  const prevStartLocks = globalThis.__piStartLocks;
  const prevStartedAt = globalThis.__piRunningStartedAt;
  const prevSessions = globalThis.__piSessions;
  const prevListCache = globalThis.__piSessionListCache;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  resetUnreadEntrySweepForTests();
  try {
    // 回收有一条「空会话列表一律放弃本轮」的保险丝（readdir 失败与「真的没有会话」无法区分，
    // 见 lib/unread-entry-sweep.ts 的模块 doc 第 2 条），所以这里必须让磁盘上**真的**有一个会话，
    // 否则本用例会因为保险丝空转。列表缓存不按 agent dir 分键，先清掉，确保扫的是这个临时目录。
    globalThis.__piSessionListCache = undefined;
    mkdirSync(join(agentDir, "sessions", "--visible--"), { recursive: true });
    writeFileSync(
      join(agentDir, "sessions", "--visible--", "2026-09-26T12-00-00-000Z_visible-on-disk.jsonl"),
      JSON.stringify({
        type: "session",
        version: 3,
        id: "visible-on-disk",
        timestamp: "2026-09-26T12:00:00.000Z",
        cwd: "/tmp",
      }) + "\n",
      "utf8",
    );

    await drainUnreadSweep();

    // 先塞一条「磁盘上已不存在」的旧死条目。
    writeFileSync(
      join(agentDir, "pidance-preferences.json"),
      JSON.stringify({
        unreadSessionState: {
          completedAt: { "dead-old": new Date(Date.now() - 60 * 60 * 1000).toISOString() },
          readAt: {},
        },
      }),
      "utf8",
    );

    let running = true;
    globalThis.__piSessions = new Map([
      ["sweep-ran", { sessionId: "sweep-ran", isRunning: () => running, isAlive: () => true, listPendingExtensionRequests: () => [], destroy() {} }],
    ]);
    globalThis.__piRunningStartedAt = new Map([["sweep-ran", 500]]);
    notifyRunningChange();
    running = false;
    globalThis.__piRunningStartedAt = new Map();
    notifyRunningChange();

    // 回收是 fire-and-forget（setTimeout 0 + 异步读盘）：按截止时间轮询，别用固定次数的短等待
    // （冷启动那一轮会慢一点，固定 200ms 会偶发假红）。
    let state;
    const deadline = Date.now() + 3000;
    for (;;) {
      state = JSON.parse(readFileSync(join(agentDir, "pidance-preferences.json"), "utf8")).unreadSessionState;
      if (!("dead-old" in state.completedAt)) break;
      if (Date.now() > deadline) break;
      await tick();
    }
    assert.equal("dead-old" in state.completedAt, false, "死条目应被回收");
    assert.equal(typeof state.completedAt["sweep-ran"], "string", "刚跑完的会话在宽限期内必须保留");
  } finally {
    if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    if (prevStartLocks === undefined) delete globalThis.__piStartLocks;
    else globalThis.__piStartLocks = prevStartLocks;
    if (prevStartedAt === undefined) delete globalThis.__piRunningStartedAt;
    else globalThis.__piRunningStartedAt = prevStartedAt;
    if (prevSessions === undefined) delete globalThis.__piSessions;
    else globalThis.__piSessions = prevSessions;
    if (prevListCache === undefined) delete globalThis.__piSessionListCache;
    else globalThis.__piSessionListCache = prevListCache;
    rmSync(agentDir, { recursive: true, force: true });
  }
});
