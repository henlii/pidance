import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { notifyRunningChange } = await jiti.import("./live-session-registry.ts");

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

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
    if (prevSessions === undefined) delete globalThis.__piSessions;
    else globalThis.__piSessions = prevSessions;
    rmSync(agentDir, { recursive: true, force: true });
  }
});
