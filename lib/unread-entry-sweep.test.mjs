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

function readUnread(agentDir) {
  return JSON.parse(readFileSync(join(agentDir, PREFS_FILE), "utf8")).unreadSessionState;
}

/** 列表里存在、且没有 subagent 标记 —— 侧栏会显示它的未读。 */
const listable = (id) => ({ id });
/** 子代理子会话：列表里存在，但带 subagent 标记，侧栏恒不显示未读。 */
const child = (id) => ({ id, subagent: { parentSessionId: "p1", runId: "r1", runIndex: 1 } });

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
    assert.equal(statSync(join(agentDir, PREFS_FILE)).isFile(), true);
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
      listSessions: async () => [],
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
      listSessions: async () => [],
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
      listSessions: async () => [],
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
      listSessions: async () => [],
    });
    assert.equal(throttled.skipped, true);
    assert.deepEqual(throttled.swept, []);
    assert.deepEqual(Object.keys(readUnread(agentDir).completedAt), ["deleted2"], "被节流时不动盘");
    const later = await sweepStaleUnreadEntries({
      agentDir,
      now: NOW + UNREAD_SWEEP_MIN_INTERVAL_MS + 1,
      listSessions: async () => [],
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
      listSessions: async () => [listable("alive")],
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
      listSessions: async () => [],
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
      listSessions: async () => [],
    });
    assert.deepEqual(result.swept, ["broken"]);
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});
