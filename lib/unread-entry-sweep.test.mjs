import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  UNREAD_SWEEP_MAX_ENTRIES,
  UNREAD_SWEEP_MIN_INTERVAL_MS,
  resetUnreadEntrySweepForTests,
  sweepStaleUnreadEntries,
} = await jiti.import("./unread-entry-sweep.ts");

const PREFS_FILE = "pidance-preferences.json";
const NOW = Date.parse("2026-09-26T12:00:00.000Z");
const OLD = new Date(NOW - 60 * 60 * 1000).toISOString();

function makeAgentDir(unreadSessionState) {
  const dir = mkdtempSync(join(tmpdir(), "unread-sweep-"));
  writeFileSync(
    join(dir, PREFS_FILE),
    JSON.stringify({ theme: "dark", unreadSessionState }, null, 2),
    "utf8",
  );
  return dir;
}

function readPrefs(agentDir) {
  return JSON.parse(readFileSync(join(agentDir, PREFS_FILE), "utf8"));
}

function readUnread(agentDir) {
  return readPrefs(agentDir).unreadSessionState;
}

/** 列表里存在、且没有 subagent 标记 —— 侧栏会显示它的未读。 */
const listable = (id) => ({ id });
/** 子代理子会话：列表里存在，但带 subagent 标记，侧栏恒不显示未读。 */
const child = (id) => ({ id, subagent: { parentSessionId: "p1", runId: "r1", runIndex: 1 } });

/** 非空列表的占位（空列表会命中「列表读不完整」的保险丝，见下面那条用例）。 */
const someSessions = async () => [listable("alive")];

/** 模拟扫描期间**另一个进程**（31415/31416 共用一个 agent dir）写偏好。 */
function writeDuringScan(agentDir, mutate) {
  const prefs = readPrefs(agentDir);
  mutate(prefs);
  writeFileSync(join(agentDir, PREFS_FILE), JSON.stringify(prefs, null, 2), "utf8");
}

/**
 * 未读条目回收。
 *
 * 判据 = 客户端显示未读的规则（`components/session-sidebar/sections.tsx` 的
 * `isUnread={!node.session.subagent && …}`）：只有列表里存在且没有 subagent 标记的会话才保留条目。
 */
test("回收只针对侧栏不会显示未读的会话：被删的与子代理子会话，活着的照留", async () => {
  resetUnreadEntrySweepForTests();
  const agentDir = makeAgentDir({
    completedAt: { alive: OLD, child: OLD, deleted: OLD },
    readAt: { alive: OLD, deleted: OLD },
  });
  try {
    const result = await sweepStaleUnreadEntries({
      agentDir,
      now: NOW,
      listSessions: async () => [listable("alive"), child("child")],
    });
    assert.deepEqual(result.swept.sort(), ["child", "deleted"]);
    const state = readUnread(agentDir);
    assert.deepEqual(Object.keys(state.completedAt), ["alive"], "只有活着的会话保留 completedAt");
    assert.deepEqual(Object.keys(state.readAt), ["alive"], "死条目的 readAt 一并清掉");
    assert.equal(readPrefs(agentDir).theme, "dark", "回收只动 unreadSessionState，别的键原样保留");
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("子代理子会话即使在列表里也不保留未读条目", async () => {
  resetUnreadEntrySweepForTests();
  const agentDir = makeAgentDir({ completedAt: { child: OLD }, readAt: {} });
  try {
    const result = await sweepStaleUnreadEntries({
      agentDir,
      now: NOW,
      listSessions: async () => [child("child")],
    });
    assert.deepEqual(result.swept, ["child"]);
    assert.deepEqual(readUnread(agentDir).completedAt, {});
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("宽限期内新写下的条目不动：目录扫描是快照，刚跑完的会话可能还没进列表", async () => {
  resetUnreadEntrySweepForTests();
  const fresh = new Date(NOW - 30 * 1000).toISOString();
  const agentDir = makeAgentDir({ completedAt: { "just-ran": fresh, old: OLD }, readAt: {} });
  try {
    const result = await sweepStaleUnreadEntries({
      agentDir,
      now: NOW,
      listSessions: someSessions,
    });
    assert.deepEqual(result.swept, ["old"], "只回收过期的死条目");
    assert.deepEqual(Object.keys(readUnread(agentDir).completedAt), ["just-ran"]);
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("宽限期可以关掉（证明上一条的保护来自宽限期，而不是判据本身）", async () => {
  resetUnreadEntrySweepForTests();
  const fresh = new Date(NOW - 30 * 1000).toISOString();
  const agentDir = makeAgentDir({ completedAt: { "just-ran": fresh }, readAt: {} });
  try {
    const result = await sweepStaleUnreadEntries({
      agentDir,
      now: NOW,
      minAgeMs: 0,
      listSessions: someSessions,
    });
    assert.deepEqual(result.swept, ["just-ran"]);
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("节流：间隔内重复触发直接跳过，超过间隔才再扫一遍", async () => {
  resetUnreadEntrySweepForTests();
  const agentDir = makeAgentDir({ completedAt: { deleted: OLD }, readAt: {} });
  try {
    const first = await sweepStaleUnreadEntries({
      agentDir,
      now: NOW,
      listSessions: someSessions,
    });
    assert.deepEqual(first.swept, ["deleted"]);
    writeFileSync(
      join(agentDir, PREFS_FILE),
      JSON.stringify({ unreadSessionState: { completedAt: { deleted2: OLD }, readAt: {} } }),
      "utf8",
    );
    const throttled = await sweepStaleUnreadEntries({
      agentDir,
      now: NOW + 1000,
      listSessions: someSessions,
    });
    assert.equal(throttled.skipped, true);
    assert.deepEqual(throttled.swept, []);
    assert.deepEqual(Object.keys(readUnread(agentDir).completedAt), ["deleted2"], "被节流时不动盘");
    const later = await sweepStaleUnreadEntries({
      agentDir,
      now: NOW + UNREAD_SWEEP_MIN_INTERVAL_MS + 1,
      listSessions: someSessions,
    });
    assert.equal(later.skipped, false);
    assert.deepEqual(later.swept, ["deleted2"]);
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("没有死条目时不写盘（mtime 不变）", async () => {
  resetUnreadEntrySweepForTests();
  const agentDir = makeAgentDir({ completedAt: { alive: OLD }, readAt: { alive: OLD } });
  try {
    const before = statSync(join(agentDir, PREFS_FILE)).mtimeMs;
    const result = await sweepStaleUnreadEntries({
      agentDir,
      now: NOW,
      listSessions: someSessions,
    });
    assert.deepEqual(result.swept, []);
    assert.equal(result.skipped, false);
    assert.equal(statSync(join(agentDir, PREFS_FILE)).mtimeMs, before, "无变化就不该重写偏好文件");
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("单次回收有上限，剩下的留给下一轮", async () => {
  resetUnreadEntrySweepForTests();
  const completedAt = {};
  for (let i = 0; i < UNREAD_SWEEP_MAX_ENTRIES + 5; i += 1) completedAt[`dead-${i}`] = OLD;
  const agentDir = makeAgentDir({ completedAt, readAt: {} });
  try {
    const result = await sweepStaleUnreadEntries({
      agentDir,
      now: NOW,
      listSessions: someSessions,
    });
    assert.equal(result.swept.length, UNREAD_SWEEP_MAX_ENTRIES);
    assert.equal(Object.keys(readUnread(agentDir).completedAt).length, 5);
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("时间戳无法解析的条目按死条目回收（留着也不会被任何一端消费）", async () => {
  resetUnreadEntrySweepForTests();
  const agentDir = makeAgentDir({ completedAt: { broken: "not-a-date" }, readAt: {} });
  try {
    const result = await sweepStaleUnreadEntries({
      agentDir,
      now: NOW,
      listSessions: someSessions,
    });
    assert.deepEqual(result.swept, ["broken"]);
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});

/**
 * 审查阻断项：回收的判定要扫目录（锁外慢操作），但落盘前必须在**同一把锁里重读**。
 * 否则「读快照 → 扫目录 → 整桶写回」会把锁窗口里另一进程/另一次 run 结束写下的
 * completedAt、客户端 PUT 合并进来的 readAt、删除路径刚清掉的键全部盖掉
 * （unreadSessionState 是整对象键，setByDottedKey 整体替换而非按 id 合并）。
 */
test("扫描期间另一进程写下的未读不会被整桶写回盖掉", async () => {
  resetUnreadEntrySweepForTests();
  const agentDir = makeAgentDir({ completedAt: { deleted: OLD }, readAt: {} });
  try {
    const result = await sweepStaleUnreadEntries({
      agentDir,
      now: NOW,
      listSessions: async () => {
        writeDuringScan(agentDir, (prefs) => {
          prefs.unreadSessionState.completedAt["other-process"] = OLD;
          prefs.unreadSessionState.readAt["just-read"] = OLD;
        });
        return someSessions();
      },
    });
    assert.deepEqual(result.swept, ["deleted"], "本轮只该删快照里挑出来的死条目");
    const state = readUnread(agentDir);
    assert.deepEqual(Object.keys(state.completedAt), ["other-process"], "扫描期间并发的 completedAt 必须留下");
    assert.deepEqual(Object.keys(state.readAt), ["just-read"], "扫描期间并发的 readAt 必须留下");
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("锁窗口里被刷新过时钟的条目不当死条目删（宽限期按最新值重算）", async () => {
  resetUnreadEntrySweepForTests();
  const agentDir = makeAgentDir({ completedAt: { revived: OLD }, readAt: {} });
  try {
    const result = await sweepStaleUnreadEntries({
      agentDir,
      now: NOW,
      listSessions: async () => {
        writeDuringScan(agentDir, (prefs) => {
          // 扫目录期间这个会话又跑了一轮（另一进程写的 completedAt 变成 30 秒前）
          prefs.unreadSessionState.completedAt.revived = new Date(NOW - 30 * 1000).toISOString();
        });
        return someSessions();
      },
    });
    assert.deepEqual(result.swept, [], "被刷新的条目还在宽限期内，不该删");
    assert.equal(typeof readUnread(agentDir).completedAt.revived, "string");
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});

/**
 * 保险丝：lib/session-metadata-cache.ts 的 readdir 失败会 `return []`，与「真的没有会话」
 * 无法区分，而误判的代价是把全部旧未读清掉（PI_CODING_AGENT_DIR 指错就会这样）。
 * 与 instrumentation.ts 的附件回收「引用集合读不完整就放弃」同口径。
 */
test("会话列表为空时放弃本轮：清不空也不能清错", async () => {
  resetUnreadEntrySweepForTests();
  const agentDir = makeAgentDir({ completedAt: { deleted: OLD }, readAt: { deleted: OLD } });
  try {
    const before = statSync(join(agentDir, PREFS_FILE)).mtimeMs;
    const result = await sweepStaleUnreadEntries({
      agentDir,
      now: NOW,
      listSessions: async () => [],
    });
    assert.deepEqual(result.swept, []);
    assert.equal(result.skipped, true, "空列表算本轮跳过");
    assert.deepEqual(Object.keys(readUnread(agentDir).completedAt), ["deleted"], "一条都不该删");
    assert.equal(statSync(join(agentDir, PREFS_FILE)).mtimeMs, before, "也不该写盘");
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("会话列表读失败会抛出：不写盘，且节流照旧（下次触发最多等一个间隔）", async () => {
  resetUnreadEntrySweepForTests();
  const agentDir = makeAgentDir({ completedAt: { deleted: OLD }, readAt: {} });
  try {
    await assert.rejects(
      sweepStaleUnreadEntries({
        agentDir,
        now: NOW,
        listSessions: async () => {
          throw new Error("readdir failed");
        },
      }),
      /readdir failed/,
    );
    assert.deepEqual(Object.keys(readUnread(agentDir).completedAt), ["deleted"], "失败不改盘");
    // 节流戳在 await 之前就占住了 → 同一间隔内的下一次触发直接跳过（热路径不会反复扫目录）
    const throttled = await sweepStaleUnreadEntries({ agentDir, now: NOW + 1000, listSessions: someSessions });
    assert.equal(throttled.skipped, true);
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});
