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
    cwd: "/repo-a",
    created: "2026-07-01T00:00:00.000Z",
    modified: `2026-07-0${(seq % 8) + 1}T00:00:00.000Z`,
    messageCount: 1,
    firstMessage: `msg-${id}`,
    ...overrides,
  };
}

test("多项目：按 projectRoot ?? cwd 分项目，按最近活动降序", async () => {
  const { buildSidebarTree } = await jiti.import("./session-sidebar-model.ts");
  const a = session("a1", { cwd: "/repo-a", projectRoot: "/repo-a", modified: "2026-07-01T00:00:00.000Z" });
  const b = session("b1", { cwd: "/repo-b", projectRoot: "/repo-b", modified: "2026-07-09T00:00:00.000Z" });
  // 无 projectRoot 的会话回退 cwd 作为项目根。
  const c = session("c1", { cwd: "/plain-dir", projectRoot: undefined, modified: "2026-07-05T00:00:00.000Z" });
  const tree = buildSidebarTree([a, b, c]);
  assert.deepEqual(tree.map((p) => p.root), ["/repo-b", "/plain-dir", "/repo-a"]);
  assert.equal(tree.length, 3);
});

test("主 worktree 隐式：主仓会话直接挂项目下，不产生 worktree 分组", async () => {
  const { buildSidebarTree } = await jiti.import("./session-sidebar-model.ts");
  const main1 = session("m1", { cwd: "/repo", projectRoot: "/repo" });
  const main2 = session("m2", { cwd: "/repo", projectRoot: "/repo" });
  const tree = buildSidebarTree([main1, main2]);
  assert.equal(tree.length, 1);
  assert.equal(tree[0].worktrees.length, 0);
  assert.deepEqual(tree[0].mainTree.map((n) => n.session.id).sort(), ["m1", "m2"]);
});

test("非主 worktree 分组：cwd !== projectRoot 的会话归入分组并带分支名", async () => {
  const { buildSidebarTree } = await jiti.import("./session-sidebar-model.ts");
  const main = session("m", { cwd: "/repo", projectRoot: "/repo" });
  const wt = session("w1", {
    cwd: "/repo-worktrees/feat-login",
    projectRoot: "/repo",
    worktreeBranch: "feat/login",
  });
  const tree = buildSidebarTree([main, wt]);
  assert.equal(tree.length, 1);
  assert.equal(tree[0].mainTree.length, 1);
  assert.equal(tree[0].worktrees.length, 1);
  assert.equal(tree[0].worktrees[0].path, "/repo-worktrees/feat-login");
  assert.equal(tree[0].worktrees[0].branch, "feat/login");
  assert.equal(tree[0].worktrees[0].tree[0].session.id, "w1");
});

test("fork child 语义在项目树分组内保留；subagent 子会话不展示", async () => {
  const { buildSidebarTree } = await jiti.import("./session-sidebar-model.ts");
  const parent = session("p", { cwd: "/repo", projectRoot: "/repo", modified: "2026-07-09T00:00:00.000Z" });
  const fork = session("f", { cwd: "/repo", projectRoot: "/repo", parentSessionId: "p", modified: "2026-07-08T00:00:00.000Z" });
  const sub = session("s", {
    cwd: "/repo", projectRoot: "/repo",
    subagent: { parentSessionId: "p", runId: "r1", runIndex: 0 },
    readOnly: true,
  });
  // worktree 组内同样保留嵌套关系。
  const wtParent = session("wp", { cwd: "/repo-worktrees/feat", projectRoot: "/repo", worktreeBranch: "feat", modified: "2026-07-09T00:00:00.000Z" });
  const wtChild = session("wc", { cwd: "/repo-worktrees/feat", projectRoot: "/repo", worktreeBranch: "feat", parentSessionId: "wp" });
  const tree = buildSidebarTree([parent, fork, sub, wtParent, wtChild]);
  const mainTree = tree[0].mainTree;
  assert.equal(mainTree.length, 1);
  // subagent 子会话被过滤，仅 fork 子会话保留。
  assert.deepEqual(mainTree[0].children.map((n) => [n.session.id, n.relation]), [["f", "fork"]]);
  assert.equal(tree[0].worktrees[0].tree[0].children[0].session.id, "wc");
  assert.equal(tree[0].worktrees[0].tree[0].children[0].relation, "fork");
  // 输入 SessionInfo 不被修改。
  assert.equal(sub.parentSessionId, undefined);
});

test("subagent 会话不展示：worktree 组内不留孤儿根项", async () => {
  const { buildSidebarTree } = await jiti.import("./session-sidebar-model.ts");
  const orphan = session("o", {
    cwd: "/repo-worktrees/feat", projectRoot: "/repo", worktreeBranch: "feat",
    subagent: { parentSessionId: "ghost", runId: "r1", runIndex: 1 },
    readOnly: true,
  });
  const tree = buildSidebarTree([orphan]);
  assert.equal(tree[0].worktrees[0].tree.length, 0);
});

test("搜索命中 fork child 时保留完整 project → worktree → session 祖先链；subagent 不参与", async () => {
  const { buildSidebarTree, filterSidebarTree } = await jiti.import("./session-sidebar-model.ts");
  const parent = session("p", { cwd: "/repo", projectRoot: "/repo", name: "main work" });
  const fork = session("f", { cwd: "/repo", projectRoot: "/repo", parentSessionId: "p", firstMessage: "investigate flaky" });
  const wtParent = session("wp", { cwd: "/repo-worktrees/feat", projectRoot: "/repo", worktreeBranch: "feat", name: "wt root" });
  const wtChild = session("wc", {
    cwd: "/repo-worktrees/feat", projectRoot: "/repo", worktreeBranch: "feat",
    parentSessionId: "wp",
    subagent: undefined,
    firstMessage: "ordinary child",
  });
  const wtSub = session("ws", {
    cwd: "/repo-worktrees/feat", projectRoot: "/repo", worktreeBranch: "feat",
    subagent: { parentSessionId: "wc", runId: "r9", runIndex: 2, agent: "explore" },
    readOnly: true,
  });
  const otherProject = session("x", { cwd: "/other", projectRoot: "/other", name: "unrelated" });
  const tree = buildSidebarTree([parent, fork, wtParent, wtChild, wtSub, otherProject]);
  // subagent 的 agent 名不再可命中（节点不展示）。
  assert.deepEqual(filterSidebarTree(tree, "explore"), []);
  // 命中 fork child 的 firstMessage：保留 project 与命中 worktree 组的祖先链。
  const filtered = filterSidebarTree(tree, "ordinary");
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].root, "/repo");
  // 主仓未命中被剪掉，但项目与命中 worktree 组保留。
  assert.equal(filtered[0].mainTree.length, 0);
  assert.equal(filtered[0].worktrees.length, 1);
  const wtTree = filtered[0].worktrees[0].tree;
  assert.equal(wtTree[0].session.id, "wp");
  assert.equal(wtTree[0].children[0].session.id, "wc");
});

test("搜索命中项目根路径保留整个项目；命中分支名保留整个分组", async () => {
  const { buildSidebarTree, filterSidebarTree } = await jiti.import("./session-sidebar-model.ts");
  const main = session("m", { cwd: "/repo", projectRoot: "/repo", name: "zzz" });
  const wt = session("w", { cwd: "/repo-worktrees/feat", projectRoot: "/repo", worktreeBranch: "feat/login", name: "zzz" });
  const tree = buildSidebarTree([main, wt]);
  // 命中项目根：整棵树原样（引用相等，未做无谓克隆）。
  assert.equal(filterSidebarTree(tree, "repo")[0], tree[0]);
  // 命中分支名：分组原样保留，主仓未命中被剪掉。
  const byBranch = filterSidebarTree(tree, "feat/login");
  assert.equal(byBranch.length, 1);
  assert.equal(byBranch[0].mainTree.length, 0);
  assert.equal(byBranch[0].worktrees[0], tree[0].worktrees[0]);
  // 空查询原样返回；无匹配返回空。
  assert.equal(filterSidebarTree(tree, ""), tree);
  assert.deepEqual(filterSidebarTree(tree, "no-such-thing"), []);
});

test("无会话的 selectedCwd 也必须显示为可用项目项（置顶）", async () => {
  const { buildSidebarTree } = await jiti.import("./session-sidebar-model.ts");
  const existing = session("a", { cwd: "/repo-a", projectRoot: "/repo-a" });
  const tree = buildSidebarTree([existing], { selectedCwd: "/new-project", selectedProjectRoot: "/new-project" });
  assert.equal(tree.length, 2);
  assert.equal(tree[0].root, "/new-project");
  assert.equal(tree[0].mainTree.length, 0);
  assert.equal(tree[0].worktrees.length, 0);
  assert.equal(tree[0].latestActivity, "");
});

test("addedProjectRoots：无会话且未被选中的项目也持续显示（项目独立于会话）", async () => {
  const { buildSidebarTree } = await jiti.import("./session-sidebar-model.ts");
  const existing = session("a", { cwd: "/repo-a", projectRoot: "/repo-a" });
  const tree = buildSidebarTree([existing], {
    selectedCwd: "/repo-a",
    selectedProjectRoot: "/repo-a",
    addedProjectRoots: ["/empty-project", "/repo-a"],
  });
  // 两个项目都显示：有会话的 /repo-a + 空项目 /empty-project
  assert.equal(tree.length, 2);
  const empty = tree.find((p) => p.root === "/empty-project");
  assert.ok(empty, "添加过的空项目必须显示");
  assert.equal(empty.mainTree.length, 0);
  assert.equal(empty.worktrees.length, 0);
  assert.equal(empty.latestActivity, "");
  // 与 selectedCwd 无关：切走选中后空项目仍在
  const other = buildSidebarTree([existing], { addedProjectRoots: ["/empty-project"] });
  assert.equal(other.length, 2);
  assert.ok(other.find((p) => p.root === "/empty-project"));
});

test("selectedCwd 属于已有项目的空 worktree：knownWorktrees 补齐空分组", async () => {
  const { buildSidebarTree } = await jiti.import("./session-sidebar-model.ts");
  const main = session("m", { cwd: "/repo", projectRoot: "/repo" });
  const tree = buildSidebarTree([main], {
    selectedCwd: "/repo-worktrees/empty",
    selectedProjectRoot: "/repo",
    knownWorktrees: [
      { path: "/repo", branch: "main", isMain: true },
      { path: "/repo-worktrees/empty", branch: "empty-branch", isMain: false },
    ],
  });
  assert.equal(tree.length, 1);
  // 主 worktree 隐式：不为其生成分组行。
  assert.equal(tree[0].worktrees.length, 1);
  assert.equal(tree[0].worktrees[0].path, "/repo-worktrees/empty");
  assert.equal(tree[0].worktrees[0].branch, "empty-branch");
  assert.equal(tree[0].worktrees[0].tree.length, 0);
});

test("Collapse all 收集全部项目根与 worktree 路径；Expand all 即清空集合", async () => {
  const { buildSidebarTree, collectAllCollapseIds } = await jiti.import("./session-sidebar-model.ts");
  const main = session("m", { cwd: "/repo", projectRoot: "/repo" });
  const wt = session("w", { cwd: "/repo-worktrees/feat", projectRoot: "/repo", worktreeBranch: "feat" });
  const other = session("o", { cwd: "/other", projectRoot: "/other" });
  const tree = buildSidebarTree([main, wt, other]);
  const ids = collectAllCollapseIds(tree);
  assert.deepEqual(ids.projectRoots.sort(), ["/other", "/repo"]);
  assert.deepEqual(ids.worktreePaths, ["/repo-worktrees/feat"]);
});

test("会话定位：返回项目根、非主 worktree 分组与会话级祖先链", async () => {
  const { buildSidebarTree, locateSessionInSidebarTree } = await jiti.import("./session-sidebar-model.ts");
  const parent = session("p", { cwd: "/repo", projectRoot: "/repo" });
  const child = session("c", { cwd: "/repo", projectRoot: "/repo", parentSessionId: "p" });
  const wtParent = session("wp", { cwd: "/repo-worktrees/feat", projectRoot: "/repo", worktreeBranch: "feat" });
  const wtGrand = session("wg", {
    cwd: "/repo-worktrees/feat", projectRoot: "/repo", worktreeBranch: "feat",
    parentSessionId: "wp",
  });
  const tree = buildSidebarTree([parent, child, wtParent, wtGrand]);
  assert.deepEqual(locateSessionInSidebarTree(tree, "p"), { projectRoot: "/repo", worktreePath: null, ancestors: [] });
  assert.deepEqual(locateSessionInSidebarTree(tree, "c"), { projectRoot: "/repo", worktreePath: null, ancestors: ["p"] });
  assert.deepEqual(locateSessionInSidebarTree(tree, "wg"), { projectRoot: "/repo", worktreePath: "/repo-worktrees/feat", ancestors: ["wp"] });
  assert.equal(locateSessionInSidebarTree(tree, "missing"), null);
});

test("关闭项目过滤：从树中隐藏已关闭项目，空集合原样返回", async () => {
  const { buildSidebarTree, filterClosedProjects } = await jiti.import("./session-sidebar-model.ts");
  const a = session("a", { cwd: "/repo-a", projectRoot: "/repo-a" });
  const b = session("b", { cwd: "/repo-b", projectRoot: "/repo-b" });
  const tree = buildSidebarTree([a, b]);
  // 空集合：引用相等，零开销。
  assert.equal(filterClosedProjects(tree, new Set()), tree);
  const filtered = filterClosedProjects(tree, new Set(["/repo-a"]));
  assert.deepEqual(filtered.map((p) => p.root), ["/repo-b"]);
  // 项目节点复用引用，输入树不被修改。
  assert.equal(filtered[0], tree.find((p) => p.root === "/repo-b"));
  assert.equal(tree.length, 2);
  // 全部关闭 → 空数组。
  assert.deepEqual(filterClosedProjects(tree, new Set(["/repo-a", "/repo-b"])), []);
});

test("关闭当前项目候选：按展示顺序取下一个未关闭项目，无剩余返回 null", async () => {
  const { buildSidebarTree, pickProjectRootAfterClose } = await jiti.import("./session-sidebar-model.ts");
  // modified 由 session() 序号派生：a1 最新在前。
  const a = session("a1", { cwd: "/repo-a", projectRoot: "/repo-a", modified: "2026-07-09T00:00:00.000Z" });
  const b = session("b1", { cwd: "/repo-b", projectRoot: "/repo-b", modified: "2026-07-08T00:00:00.000Z" });
  const c = session("c1", { cwd: "/repo-c", projectRoot: "/repo-c", modified: "2026-07-07T00:00:00.000Z" });
  const tree = buildSidebarTree([a, b, c]);
  assert.deepEqual(tree.map((p) => p.root), ["/repo-a", "/repo-b", "/repo-c"]);
  // 关闭最前的当前项目 → 取顺序上的下一个。
  assert.equal(pickProjectRootAfterClose(tree, "/repo-a", new Set(["/repo-a"])), "/repo-b");
  // 下一个也已关闭 → 继续向后跳过。
  assert.equal(pickProjectRootAfterClose(tree, "/repo-a", new Set(["/repo-a", "/repo-b"])), "/repo-c");
  // 关闭末尾项目 → 回退到最前的未关闭项目。
  assert.equal(pickProjectRootAfterClose(tree, "/repo-c", new Set(["/repo-c"])), "/repo-a");
  // 无剩余项目 → null（调用方置空 cwd 回到空工作区）。
  assert.equal(pickProjectRootAfterClose(tree, "/repo-a", new Set(["/repo-a", "/repo-b", "/repo-c"])), null);
  assert.equal(pickProjectRootAfterClose([], "/repo-a", new Set(["/repo-a"])), null);
});

test("alias 搜索：命中项目 alias 保留整个项目，与根路径命中语义一致", async () => {
  const { buildSidebarTree, filterSidebarTree } = await jiti.import("./session-sidebar-model.ts");
  const main = session("m", { cwd: "/repo", projectRoot: "/repo", name: "zzz" });
  const wt = session("w", { cwd: "/repo-worktrees/feat", projectRoot: "/repo", worktreeBranch: "feat", name: "zzz" });
  const other = session("o", { cwd: "/other", projectRoot: "/other", name: "zzz" });
  const tree = buildSidebarTree([main, wt, other]);
  const aliases = { "/repo": "支付中台" };
  // 命中 alias：整棵树原样保留（引用相等），未命中项目被过滤。
  const byAlias = filterSidebarTree(tree, "支付", aliases);
  assert.equal(byAlias.length, 1);
  assert.equal(byAlias[0], tree.find((p) => p.root === "/repo"));
  // alias 大小写不敏感（查询已归一化为小写，alias 在模型内同步小写）。
  const byAliasCase = filterSidebarTree(tree, "pay", { "/repo": "PayCore" });
  assert.equal(byAliasCase.length, 1);
  assert.equal(byAliasCase[0].root, "/repo");
  // 不传 alias：行为与旧版一致（仅根路径/分支/会话字段可命中）。
  assert.deepEqual(filterSidebarTree(tree, "支付").map((p) => p.root), []);
  // alias 未命中但根路径命中：仍然保留整个项目。
  assert.equal(filterSidebarTree(tree, "other", aliases)[0].root, "/other");
});

test("搜索与折叠偏好隔离：过滤不触碰折叠集合，搜索期强制展开只读不写", async () => {
  const { buildSidebarTree, filterSidebarTree } = await jiti.import("./session-sidebar-model.ts");
  const { isSessionNodeEffectivelyCollapsed } = await jiti.import("./session-tree.ts");
  const main = session("m", { cwd: "/repo", projectRoot: "/repo", name: "hit me" });
  const tree = buildSidebarTree([main]);
  const collapsedProjects = new Set(["/repo"]);
  const collapsedWorktrees = new Set(["/repo-worktrees/feat"]);
  // 搜索过滤是纯函数：两个折叠集合原样不动。
  const filtered = filterSidebarTree(tree, "hit");
  assert.equal(filtered.length, 1);
  assert.deepEqual([...collapsedProjects], ["/repo"]);
  assert.deepEqual([...collapsedWorktrees], ["/repo-worktrees/feat"]);
  // 搜索期间渲染层强制展开（对项目/worktree 复用同一判定），集合不被改写。
  assert.equal(isSessionNodeEffectivelyCollapsed(collapsedProjects, "/repo", true), false);
  assert.equal(isSessionNodeEffectivelyCollapsed(collapsedWorktrees, "/repo-worktrees/feat", true), false);
  assert.equal(isSessionNodeEffectivelyCollapsed(collapsedProjects, "/repo", false), true);
  assert.deepEqual([...collapsedProjects], ["/repo"]);
});

test("collectSubagentParentIdsFromSidebarTree：含子节点的父会话默认收起", async () => {
  const {
    buildSidebarTree,
    collectSubagentParentIdsFromSidebarTree,
  } = await jiti.import("./session-sidebar-model.ts");
  const mainParent = session("mp", { cwd: "/repo", projectRoot: "/repo" });
  const mainSub = session("ms", {
    cwd: "/repo",
    projectRoot: "/repo",
    subagent: { parentSessionId: "mp", runId: "r1", runIndex: 0 },
    readOnly: true,
  });
  const wtParent = session("wp", {
    cwd: "/repo-worktrees/feat",
    projectRoot: "/repo",
  });
  const wtSub = session("ws", {
    cwd: "/repo-worktrees/feat",
    projectRoot: "/repo",
    subagent: { parentSessionId: "wp", runId: "r2", runIndex: 0 },
    readOnly: true,
  });
  const forkOnly = session("fo", { cwd: "/repo", projectRoot: "/repo" });
  const forkChild = session("fc", {
    cwd: "/repo",
    projectRoot: "/repo",
    parentSessionId: "fo",
  });
  const tree = buildSidebarTree(
    [mainParent, mainSub, wtParent, wtSub, forkOnly, forkChild],
    { knownWorktrees: [{ path: "/repo-worktrees/feat", branch: "feat", isMain: false }] },
  );
  // subagent 子会话不展示；含 fork 子节点的父会话（fo）默认收起。
  assert.deepEqual(collectSubagentParentIdsFromSidebarTree(tree).sort(), ["fo"]);
});

test("全文模式：按 session id 集合保留祖先链，不按 name/alias 整树匹配", async () => {
  const { buildSidebarTree, filterSidebarTree } = await jiti.import("./session-sidebar-model.ts");
  const parent = session("p", { cwd: "/repo", projectRoot: "/repo", name: "main work" });
  const child = session("c", {
    cwd: "/repo", projectRoot: "/repo", parentSessionId: "p", firstMessage: "leaf body",
  });
  const other = session("o", { cwd: "/other", projectRoot: "/other", name: "repo alias bait" });
  const tree = buildSidebarTree([parent, child, other]);
  // 仅命中 child：保留 p → c 祖先链，不保留 other（即使 name 含 repo）。
  const filtered = filterSidebarTree(tree, "", { "/other": "repo" }, new Set(["c"]));
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].root, "/repo");
  assert.equal(filtered[0].mainTree.length, 1);
  assert.equal(filtered[0].mainTree[0].session.id, "p");
  assert.equal(filtered[0].mainTree[0].children[0].session.id, "c");
  // 空集合：全文模式无命中 → 空树。
  assert.deepEqual(filterSidebarTree(tree, "", undefined, new Set()), []);
});
