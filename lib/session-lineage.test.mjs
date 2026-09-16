import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  buildLineageIndex,
  collectLineageDescendants,
  lineagePath,
  shortSessionTitle,
  subagentParentId,
  visibleLineageNodes,
} = await jiti.import("./session-lineage.ts");

function session(id, overrides = {}) {
  return {
    path: `/tmp/${id}.jsonl`,
    id,
    cwd: "/repo",
    created: "2026-07-01T00:00:00.000Z",
    modified: "2026-07-01T00:00:00.000Z",
    messageCount: 1,
    firstMessage: `msg-${id}`,
    ...overrides,
  };
}

function child(id, parentSessionId, overrides = {}) {
  return session(id, {
    subagent: { parentSessionId, runId: "run-1", runIndex: 0 },
    readOnly: true,
    // 服务端子会话投影固定给这个占位符
    firstMessage: "(no messages)",
    ...overrides,
  });
}

test("subagentParentId 只认 subagent 关系，fork 不算谱系", () => {
  assert.equal(subagentParentId(session("a")), null);
  assert.equal(subagentParentId(session("a", { parentSessionId: "root" })), null);
  assert.equal(subagentParentId(child("a", "root")), "root");
});

test("buildLineageIndex 按父分组，同级 modified 倒序，叶子不建桶", () => {
  const index = buildLineageIndex([
    child("a", "root", { modified: "2026-07-02T00:00:00.000Z" }),
    child("b", "root", { modified: "2026-07-03T00:00:00.000Z" }),
    child("c", "b"),
    session("root"),
  ]);
  assert.deepEqual(index.get("root").map((s) => s.id), ["b", "a"]);
  assert.deepEqual(index.get("b").map((s) => s.id), ["c"]);
  assert.equal(index.has("c"), false);
});

test("lineagePath 返回根 → 当前，缺失节点不丢链", () => {
  const sessions = [session("root"), child("a", "root"), child("b", "a")];
  assert.deepEqual(lineagePath(sessions, "b").map((s) => s.id), ["root", "a", "b"]);
  assert.deepEqual(lineagePath(sessions, "root").map((s) => s.id), ["root"]);
  assert.deepEqual(lineagePath(sessions, "missing"), []);
  // 父会话已删除：链在断点截断，保留当前会话
  assert.deepEqual(lineagePath([child("o", "gone")], "o").map((s) => s.id), ["o"]);
});

test("lineagePath 遇自环不死循环", () => {
  const a = child("a", "b");
  const b = child("b", "a");
  assert.deepEqual(lineagePath([a, b], "a").map((s) => s.id), ["b", "a"]);
});

test("collectLineageDescendants 前序遍历 + 深度，遇环不重复", () => {
  const index = buildLineageIndex([
    session("root"),
    child("a", "root", { modified: "2026-07-02T00:00:00.000Z" }),
    child("b", "root", { modified: "2026-07-03T00:00:00.000Z" }),
    child("a1", "a"),
    child("a2", "a", { modified: "2026-07-04T00:00:00.000Z" }),
    child("loop", "a2", { subagent: { parentSessionId: "a2", runId: "run-1", runIndex: 0 } }),
  ]);
  const nodes = collectLineageDescendants(index, "root");
  assert.deepEqual(
    nodes.map((n) => [n.session.id, n.depth]),
    [["b", 1], ["a", 1], ["a2", 2], ["loop", 3], ["a1", 2]],
  );
  // 成环的 index（b 的父又指回 a）不会无限展开
  const cyclic = new Map([
    ["root", [child("a", "root")]],
    ["a", [child("b", "a")]],
    ["b", [child("a", "root")]],
  ]);
  assert.deepEqual(collectLineageDescendants(cyclic, "root").map((n) => n.session.id), ["a", "b"]);
});

test("visibleLineageNodes 折叠节点保留自身、跳过其后代", () => {
  const index = buildLineageIndex([
    session("root"),
    child("a", "root", { modified: "2026-07-02T00:00:00.000Z" }),
    child("b", "root", { modified: "2026-07-03T00:00:00.000Z" }),
    child("a1", "a"),
  ]);
  assert.deepEqual(
    visibleLineageNodes(index, "root", new Set()).map((n) => [n.session.id, n.depth]),
    [["b", 1], ["a", 1], ["a1", 2]],
  );
  assert.deepEqual(
    visibleLineageNodes(index, "root", new Set(["a"])).map((n) => n.session.id),
    ["b", "a"],
  );
  assert.deepEqual(visibleLineageNodes(index, "missing", new Set()), []);
});

test("shortSessionTitle: name → 首条消息首行 → id，并单行截断", () => {
  assert.equal(shortSessionTitle(session("a", { name: "  修复登录  " })), "修复登录");
  assert.equal(shortSessionTitle(session("a", { firstMessage: "第一行\n第二行" })), "第一行");
  // 子会话没有 name/首条消息（服务端给 "(no messages)" 或空串）→ 回退 id
  assert.equal(shortSessionTitle(child("abcdef012345", "root")), "abcdef012345");
  assert.equal(shortSessionTitle(child("abcdef012345", "root", { firstMessage: "" })), "abcdef012345");
  const long = shortSessionTitle(session("a", { name: "x".repeat(80) }), 10);
  assert.equal(long, `${"x".repeat(9)}…`);
  assert.equal(long.length, 10);
});
