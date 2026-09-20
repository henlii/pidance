import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);

let seq = 0;
function session(id, overrides = {}) {
  seq += 1;
  return {
    path: `/tmp/${id}.jsonl`,
    id,
    cwd: "/tmp",
    created: "2026-07-01T00:00:00.000Z",
    modified: `2026-07-0${(seq % 8) + 1}T00:00:00.000Z`,
    messageCount: 1,
    firstMessage: `msg-${id}`,
    ...overrides,
  };
}

test("subagent 子会话不展示：仅 fork 子会话进入树，subagent 整体跳过", async () => {
  const { buildSessionDisplayTree } = await jiti.import("./session-tree.ts");
  const parent = session("p", { modified: "2026-07-09T00:00:00.000Z" });
  const fork = session("f1", { parentSessionId: "p", modified: "2026-07-08T00:00:00.000Z" });
  const sub2 = session("s2", { subagent: { parentSessionId: "p", runId: "abcd1234", runIndex: 2 }, readOnly: true });
  const sub0 = session("s0", { subagent: { parentSessionId: "p", runId: "abcd1234", runIndex: 0 }, readOnly: true });
  const roots = buildSessionDisplayTree([parent, fork, sub2, sub0]);
  assert.equal(roots.length, 1);
  assert.equal(roots[0].session.id, "p");
  assert.equal(roots[0].relation, null);
  // subagent 子会话不进入展示树；fork 子会话按 modified 降序保留。
  assert.deepEqual(roots[0].children.map((n) => n.session.id), ["f1"]);
  assert.deepEqual(roots[0].children.map((n) => n.relation), ["fork"]);
});

test("嵌套 subagent 整体隐藏：父会话下不残留任何 subagent 后代", async () => {
  const { buildSessionDisplayTree } = await jiti.import("./session-tree.ts");
  const parent = session("p");
  const child = session("c", { subagent: { parentSessionId: "p", runId: "r1", runIndex: 0 }, readOnly: true });
  const grandchild = session("g", { subagent: { parentSessionId: "c", runId: "r2", runIndex: 0 }, readOnly: true });
  const roots = buildSessionDisplayTree([grandchild, child, parent]);
  assert.equal(roots.length, 1);
  assert.equal(roots[0].session.id, "p");
  // child 与其孙代 grandchild 均为 subagent，一并隐藏。
  assert.equal(roots[0].children.length, 0);
});

test("subagent 会话不产生孤儿根项：父缺失的 subagent 同样被隐藏", async () => {
  const { buildSessionDisplayTree } = await jiti.import("./session-tree.ts");
  // 父 "ghost" 不在集合内：subagent 会话不展示，也不再降级为根项。
  const orphan = session("o", { subagent: { parentSessionId: "ghost", runId: "r1", runIndex: 1 }, readOnly: true });
  const other = session("x");
  const roots = buildSessionDisplayTree([orphan, other]);
  assert.equal(roots.length, 1);
  assert.equal(roots[0].session.id, "x");
  assert.equal(roots[0].relation, null);
});

test("fork 祖先缺失时沿链上溯到集合内最近祖先（保留原有语义）", async () => {
  const { buildSessionDisplayTree } = await jiti.import("./session-tree.ts");
  const grandparent = session("gp");
  // "mid" 不在集合内：f 的 fork 链 gp <- mid <- f，应直接挂到 gp。
  const fork = session("f", { parentSessionId: "mid" });
  grandparent.parentSessionId = undefined;
  const withMid = session("mid", { parentSessionId: "gp" });
  const rootsOrphanChain = buildSessionDisplayTree([grandparent, fork]);
  assert.equal(rootsOrphanChain.length, 2); // mid 缺失且 gp 与 f 无链关系 → 两个根
  const roots = buildSessionDisplayTree([grandparent, withMid, fork]);
  assert.equal(roots.length, 1);
  assert.equal(roots[0].children[0].session.id, "mid");
  assert.equal(roots[0].children[0].children[0].session.id, "f");
  assert.equal(roots[0].children[0].children[0].relation, "fork");
});

test("subagent 关系成环时相关节点被过滤：展示树为空", async () => {
  const { buildSessionDisplayTree } = await jiti.import("./session-tree.ts");
  const a = session("a", { subagent: { parentSessionId: "b", runId: "r1", runIndex: 0 }, readOnly: true });
  const b = session("b", { subagent: { parentSessionId: "a", runId: "r2", runIndex: 0 }, readOnly: true });
  const roots = buildSessionDisplayTree([a, b]);
  assert.deepEqual(roots, []);
});

test("fork/subagent 混合环：subagent 成员过滤后 fork 侧按常规降级", async () => {
  const { buildSessionDisplayTree } = await jiti.import("./session-tree.ts");
  const a = session("a", { parentSessionId: "b" });
  const b = session("b", { subagent: { parentSessionId: "a", runId: "r1", runIndex: 0 }, readOnly: true });
  const roots = buildSessionDisplayTree([a, b]);
  // b 为 subagent 被隐藏；a 的 fork 父缺失，降级为可访问根项。
  assert.equal(roots.length, 1);
  assert.equal(roots[0].session.id, "a");
  assert.equal(roots[0].relation, null);
});

test("parentSessionId 与 subagent 同时存在：subagent 标记即整体不展示", async () => {
  const { buildSessionDisplayTree } = await jiti.import("./session-tree.ts");
  const realParent = session("real");
  const forkParent = session("forkp");
  const both = session("both", {
    parentSessionId: "forkp",
    subagent: { parentSessionId: "real", runId: "r1", runIndex: 3, agent: "explore" },
    readOnly: true,
  });
  const roots = buildSessionDisplayTree([both, forkParent, realParent]);
  // both 为 subagent 会话，整体不展示；两个候选父都不挂接任何子节点。
  assert.equal(roots.length, 2);
  assert.ok(roots.every((n) => n.children.length === 0));
});

test("绝不修改 SessionInfo：subagent.parentSessionId 不写入 parentSessionId", async () => {
  const { buildSessionDisplayTree } = await jiti.import("./session-tree.ts");
  const child = session("c", {
    subagent: { parentSessionId: "p", runId: "r1", runIndex: 0 },
    readOnly: true,
  });
  const parent = session("p");
  buildSessionDisplayTree([child, parent]);
  assert.equal(child.parentSessionId, undefined);
  assert.equal(child.readOnly, true);
  assert.equal(child.subagent.parentSessionId, "p");
});

test("同层 subagent 的多个 run 全部隐藏，父会话无子节点", async () => {
  const { buildSessionDisplayTree } = await jiti.import("./session-tree.ts");
  const parent = session("p", { modified: "2026-07-09T00:00:00.000Z" });
  const runs = [5, 0, 3].map((runIndex, i) => session(`s${i}`, {
    subagent: { parentSessionId: "p", runId: "r1", runIndex },
    readOnly: true,
    // modified 故意与 runIndex 反序，证明展示树不再包含这些 run。
    modified: `2026-07-0${9 - runIndex}T00:00:00.000Z`,
  }));
  const roots = buildSessionDisplayTree([parent, ...runs]);
  assert.equal(roots.length, 1);
  assert.equal(roots[0].session.id, "p");
  assert.deepEqual(roots[0].children, []);
});

// ── 会话搜索 helper ──────────────────────────────────────────────────────

test("搜索命中 child 时保留完整祖先链（fork 链）；subagent 不再命中", async () => {
  const { buildSessionDisplayTree, filterSessionDisplayTree } = await jiti.import("./session-tree.ts");
  const parent = session("p", { name: "main work" });
  const fork = session("f1", { parentSessionId: "p", firstMessage: "investigate flaky test" });
  const sub = session("s1", {
    subagent: { parentSessionId: "f1", runId: "abcd1234", runIndex: 2, agent: "explore" },
    readOnly: true,
  });
  const other = session("x", { name: "unrelated" });
  const tree = buildSessionDisplayTree([parent, fork, sub, other]);
  // 命中 subagent 的 agent 名：该节点不展示，搜索也无命中。
  assert.deepEqual(filterSessionDisplayTree(tree, "explore"), []);
  // 命中 fork 的 firstMessage：祖先链 p ← f1 完整保留，无关节点被剪掉。
  const filtered = filterSessionDisplayTree(tree, "flaky");
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].session.id, "p");
  assert.equal(filtered[0].children.length, 1);
  assert.equal(filtered[0].children[0].session.id, "f1");
  assert.equal(filtered[0].children[0].relation, "fork");
});

test("搜索可命中 name/firstMessage/id/subagent run", async () => {
  const { buildSessionDisplayTree, filterSessionDisplayTree, sessionMatchesQuery } = await jiti.import("./session-tree.ts");
  const s = session("abc123def456", {
    name: "Refactor auth",
    firstMessage: "how do I migrate",
    subagent: { parentSessionId: "p", runId: "deadbeef", runIndex: 7, agent: "reviewer" },
    readOnly: true,
  });
  for (const q of ["refactor", "migrate", "abc123", "reviewer", "deadbeef", "run 7", "run-7", "7"]) {
    assert.ok(sessionMatchesQuery(s, q), `应命中: ${q}`);
  }
  assert.ok(!sessionMatchesQuery(s, "nonexistent"));
  // 大小写不敏感：调用方先用 normalizeSessionQuery 归一化。
  const { normalizeSessionQuery } = await jiti.import("./session-tree.ts");
  assert.ok(sessionMatchesQuery(s, normalizeSessionQuery("  REFACTOR ")));
  // 普通 fork 会话不含 subagent 字段也可命中 fork 自身字段。
  const fork = session("f", { parentSessionId: "p", firstMessage: "plain fork message" });
  const tree = buildSessionDisplayTree([fork]);
  assert.equal(filterSessionDisplayTree(tree, "plain").length, 1);
});

test("搜索过滤不变异原树：节点与 children 数组均为新对象", async () => {
  const { buildSessionDisplayTree, filterSessionDisplayTree } = await jiti.import("./session-tree.ts");
  const parent = session("p", { name: "keep me" });
  const child = session("c", { parentSessionId: "p", firstMessage: "child content" });
  const tree = buildSessionDisplayTree([parent, child]);
  const beforeChildren = tree[0].children;
  const filtered = filterSessionDisplayTree(tree, "child");
  assert.notEqual(filtered[0], tree[0]);
  assert.notEqual(filtered[0].children, beforeChildren);
  // 原树结构不变。
  assert.equal(tree[0].children.length, 1);
  assert.equal(beforeChildren[0].session.id, "c");
  // 空查询直接返回原数组引用（调用方不做过滤）。
  assert.equal(filterSessionDisplayTree(tree, ""), tree);
});

test("无匹配时返回空数组（由 UI 显示空状态）", async () => {
  const { buildSessionDisplayTree, filterSessionDisplayTree } = await jiti.import("./session-tree.ts");
  const tree = buildSessionDisplayTree([session("a"), session("b")]);
  assert.deepEqual(filterSessionDisplayTree(tree, "zzz-no-match"), []);
});

test("getDisplayNodeAncestorIds 返回自根向父的祖先链；subagent 不在树中", async () => {
  const { buildSessionDisplayTree, getDisplayNodeAncestorIds } = await jiti.import("./session-tree.ts");
  const parent = session("p");
  const child = session("c", { parentSessionId: "p" });
  const grand = session("g", { subagent: { parentSessionId: "c", runId: "r1", runIndex: 0 }, readOnly: true });
  const tree = buildSessionDisplayTree([parent, child, grand]);
  // g 为 subagent，不展示 → 无祖先链。
  assert.deepEqual(getDisplayNodeAncestorIds(tree, "g"), []);
  assert.deepEqual(getDisplayNodeAncestorIds(tree, "c"), ["p"]);
  assert.deepEqual(getDisplayNodeAncestorIds(tree, "p"), []);
  assert.deepEqual(getDisplayNodeAncestorIds(tree, "missing"), []);
});

test("折叠与搜索展开分离：搜索强制展开但不写折叠集合", async () => {
  const { isSessionNodeEffectivelyCollapsed } = await jiti.import("./session-tree.ts");
  const collapsed = new Set(["a", "b"]);
  // 非搜索：尊重折叠集合。
  assert.equal(isSessionNodeEffectivelyCollapsed(collapsed, "a", false), true);
  assert.equal(isSessionNodeEffectivelyCollapsed(collapsed, "c", false), false);
  // 搜索中：全部强制展开，集合本身不被修改。
  assert.equal(isSessionNodeEffectivelyCollapsed(collapsed, "a", true), false);
  assert.equal(isSessionNodeEffectivelyCollapsed(collapsed, "c", true), false);
  assert.deepEqual([...collapsed].sort(), ["a", "b"]);
});

test("collectSubagentParentIds：所有含子节点的父会话均默认收起", async () => {
  const { buildSessionDisplayTree, collectSubagentParentIds } = await jiti.import("./session-tree.ts");
  const parent = session("p");
  const sub = session("s", { subagent: { parentSessionId: "p", runId: "r1", runIndex: 0 }, readOnly: true });
  const nestedParent = session("np");
  const nestedSub = session("ns", { subagent: { parentSessionId: "np", runId: "r2", runIndex: 0 }, readOnly: true });
  // nestedParent 作为 subagent 挂在 p 下时：整链不展示，收集不涉及。
  nestedParent.subagent = { parentSessionId: "p", runId: "r0", runIndex: 1 };
  nestedParent.readOnly = true;
  nestedSub.subagent = { parentSessionId: "np", runId: "r2", runIndex: 0 };
  const forkOnly = session("fo");
  const forkChild = session("fc", { parentSessionId: "fo" });
  const tree = buildSessionDisplayTree([parent, sub, nestedParent, nestedSub, forkOnly, forkChild]);
  // subagent 节点不再进入展示树；仅 fork 子节点的父会话（fo）进入默认收起集合。
  assert.deepEqual(collectSubagentParentIds(tree).sort(), ["fo"]);
  assert.equal(tree.find((n) => n.session.id === "fo")?.children.length, 1);
});
