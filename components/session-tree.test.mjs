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

test("fork 子会话平铺为独立根项；subagent 整体跳过", async () => {
  const { buildSessionDisplayTree } = await jiti.import("./session-tree.ts");
  const parent = session("p", { modified: "2026-07-09T00:00:00.000Z" });
  const fork = session("f1", { parentSessionId: "p", modified: "2026-07-08T00:00:00.000Z" });
  const sub2 = session("s2", { subagent: { parentSessionId: "p", runId: "abcd1234", runIndex: 2 }, readOnly: true });
  const sub0 = session("s0", { subagent: { parentSessionId: "p", runId: "abcd1234", runIndex: 0 }, readOnly: true });
  const roots = buildSessionDisplayTree([parent, fork, sub2, sub0]);
  // fork 是独立会话：与父平级，各自一个根项（2026-09-22 起不再嵌套）；subagent 不进入展示树。
  assert.deepEqual(roots.map((n) => n.session.id), ["p", "f1"]);
  assert.deepEqual(roots.map((n) => n.relation), [null, null]);
  assert.ok(roots.every((n) => n.children.length === 0), "fork 不该挂到父下面");
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

test("fork 链不再上溯：任何 fork 子会话都平铺为根项（父在不在都一样）", async () => {
  const { buildSessionDisplayTree } = await jiti.import("./session-tree.ts");
  const grandparent = session("gp");
  const fork = session("f", { parentSessionId: "mid" });
  const withMid = session("mid", { parentSessionId: "gp" });
  // 三种情况都必须是「平铺、无嵌套」：父缺失、父在、隔代父在。
  for (const list of [[grandparent, fork], [grandparent, withMid, fork], [fork]]) {
    const roots = buildSessionDisplayTree(list);
    assert.equal(roots.length, list.length, `列表里每个会话都该是根项：${list.map((x) => x.id)}`);
    assert.ok(roots.every((n) => n.children.length === 0 && n.relation === null), "不该有任何嵌套关系");
  }
});

test("subagent 关系成环时相关节点被过滤：展示树为空", async () => {
  const { buildSessionDisplayTree } = await jiti.import("./session-tree.ts");
  const a = session("a", { subagent: { parentSessionId: "b", runId: "r1", runIndex: 0 }, readOnly: true });
  const b = session("b", { subagent: { parentSessionId: "a", runId: "r2", runIndex: 0 }, readOnly: true });
  const roots = buildSessionDisplayTree([a, b]);
  assert.deepEqual(roots, []);
});

test("fork/subagent 混合：subagent 过滤后 fork 仍是根项（不会因成环被丢）", async () => {
  const { buildSessionDisplayTree } = await jiti.import("./session-tree.ts");
  const a = session("a", { parentSessionId: "b" });
  const b = session("b", { subagent: { parentSessionId: "a", runId: "r1", runIndex: 0 }, readOnly: true });
  const roots = buildSessionDisplayTree([a, b]);
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

test("搜索命中 fork 子会话时它就是一条根行（平铺）；subagent 不再命中", async () => {
  const { buildSessionDisplayTree, filterSessionDisplayTree } = await jiti.import("./session-tree.ts");
  const parent = session("p", { name: "main work" });
  const fork = session("f1", { parentSessionId: "p", firstMessage: "investigate flaky test" });
  const sub = session("s1", {
    subagent: { parentSessionId: "f1", runId: "abcd1234", runIndex: 2, agent: "explore" },
    readOnly: true,
  });
  const other = session("x", { name: "unrelated" });
  const tree = buildSessionDisplayTree([parent, fork, sub, other]);
  assert.deepEqual(filterSessionDisplayTree(tree, "explore"), []);
  // fork 平铺：命中它时只有它自己一条根行（父不被"保留祖先链"带出来）。
  const filtered = filterSessionDisplayTree(tree, "flaky");
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].session.id, "f1");
  assert.equal(filtered[0].children.length, 0);
  assert.equal(filtered[0].relation, null);
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
  // 原树结构不变（fork 平铺：两个都是根项、都没有子节点）。
  assert.equal(tree[0].children.length, 0);
  assert.equal(tree.length, 2);
  // 空查询直接返回原数组引用（调用方不做过滤）。
  assert.equal(filterSessionDisplayTree(tree, ""), tree);
});

test("无匹配时返回空数组（由 UI 显示空状态）", async () => {
  const { buildSessionDisplayTree, filterSessionDisplayTree } = await jiti.import("./session-tree.ts");
  const tree = buildSessionDisplayTree([session("a"), session("b")]);
  assert.deepEqual(filterSessionDisplayTree(tree, "zzz-no-match"), []);
});

test("getDisplayNodeAncestorIds：平铺后所有会话都无祖先链；subagent 不在树中", async () => {
  const { buildSessionDisplayTree, getDisplayNodeAncestorIds } = await jiti.import("./session-tree.ts");
  const parent = session("p");
  const child = session("c", { parentSessionId: "p" });
  const grand = session("g", { subagent: { parentSessionId: "c", runId: "r1", runIndex: 0 }, readOnly: true });
  const tree = buildSessionDisplayTree([parent, child, grand]);
  assert.deepEqual(getDisplayNodeAncestorIds(tree, "g"), [], "subagent 不在树里");
  assert.deepEqual(getDisplayNodeAncestorIds(tree, "c"), [], "fork 子会话是根项，没有祖先链");
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

test("平铺后没有任何「含子节点的父会话」（不再需要默认收起）", async () => {
  const { buildSessionDisplayTree } = await jiti.import("./session-tree.ts");
  const parent = session("p");
  const sub = session("s", { subagent: { parentSessionId: "p", runId: "r1", runIndex: 0 }, readOnly: true });
  const nestedParent = session("np", { subagent: { parentSessionId: "p", runId: "r0", runIndex: 1 }, readOnly: true });
  const forkOnly = session("fo");
  const forkChild = session("fc", { parentSessionId: "fo" });
  const tree = buildSessionDisplayTree([parent, sub, nestedParent, forkOnly, forkChild]);
  assert.ok(tree.every((n) => n.children.length === 0), "平铺后不该存在父子嵌套");
  // 顺序按 modified 降序，与语义无关：先排序再比较
  assert.deepEqual([...tree].map((n) => n.session.id).sort(), ["fc", "fo", "p"]);
});
