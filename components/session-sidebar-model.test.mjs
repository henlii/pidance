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

const modelModule = jiti.import("./session-sidebar-model.ts");

/** 列表默认取「全部会话的 cwd」：这些用例测的是分组/排序，不是列表过滤规则。 */
async function treeOf(sessions, options = {}) {
  const { buildSidebarTree } = await modelModule;
  const roots = [...new Set(sessions.map((s) => s.cwd))];
  return buildSidebarTree(sessions, { projectRoots: roots, ...options });
}

test("多项目：按 cwd 分项目，按最近活动降序，忽略陈旧的 projectRoot", async () => {
  const a = session("a1", { cwd: "/repo-a", modified: "2026-07-01T00:00:00.000Z" });
  const b = session("b1", { cwd: "/repo-b", modified: "2026-07-09T00:00:00.000Z" });
  // 客户端陈旧缓存：projectRoot 仍指向另一个目录 —— 分组只看 cwd。
  const c = session("c1", { cwd: "/repo-worktrees/feat", projectRoot: "/repo", modified: "2026-07-05T00:00:00.000Z" });
  const tree = await treeOf([a, b, c]);
  assert.deepEqual(tree.map((p) => p.root), ["/repo-b", "/repo-worktrees/feat", "/repo-a"]);
  assert.deepEqual(tree.find((p) => p.root === "/repo-worktrees/feat").tree.map((n) => n.session.id), ["c1"]);
});

test("同一目录的会话直接挂项目下", async () => {
  const main1 = session("m1", { cwd: "/repo" });
  const main2 = session("m2", { cwd: "/repo" });
  const tree = await treeOf([main1, main2]);
  assert.equal(tree.length, 1);
  assert.equal(tree[0].root, "/repo");
  assert.deepEqual(tree[0].tree.map((n) => n.session.id).sort(), ["m1", "m2"]);
});

test("同一仓库的两个 checkout 是两个项目，不合并", async () => {
  const main = session("m", { cwd: "/repo" });
  const wt = session("w1", { cwd: "/repo-worktrees/feat-login" });
  const tree = await treeOf([main, wt]);
  assert.deepEqual(tree.map((p) => p.root).sort(), ["/repo", "/repo-worktrees/feat-login"]);
  assert.equal(tree.find((p) => p.root === "/repo").tree.length, 1);
  assert.equal(tree.find((p) => p.root === "/repo-worktrees/feat-login").tree.length, 1);
});

test("fork child 语义在项目内保留；subagent 子会话不展示", async () => {
  const parent = session("p", { cwd: "/repo", modified: "2026-07-09T00:00:00.000Z" });
  const fork = session("f", { cwd: "/repo", parentSessionId: "p", modified: "2026-07-08T00:00:00.000Z" });
  const sub = session("s", {
    cwd: "/repo",
    subagent: { parentSessionId: "p", runId: "r1", runIndex: 0 },
    readOnly: true,
  });
  const tree = await treeOf([parent, fork, sub]);
  const nodes = tree[0].tree;
  // fork 平铺：父与 fork 各一条根行、都不挂子节点；subagent 子会话仍被过滤。
  assert.deepEqual([...nodes].map((n) => n.session.id).sort(), ["f", "p"]);
  assert.ok(nodes.every((n) => n.children.length === 0), "fork 不该嵌套在父行下");
  assert.ok(nodes.every((n) => n.relation === null));
  // 输入 SessionInfo 不被修改。
  assert.equal(sub.parentSessionId, undefined);
});

test("subagent 会话不展示：不留孤儿根项", async () => {
  const orphan = session("o", {
    cwd: "/repo",
    subagent: { parentSessionId: "ghost", runId: "r1", runIndex: 1 },
    readOnly: true,
  });
  const tree = await treeOf([orphan]);
  assert.equal(tree[0].tree.length, 0);
});

test("搜索命中 fork 子会话时它就是一条根行（平铺）；subagent 不参与", async () => {
  const { filterSidebarTree } = await jiti.import("./session-sidebar-model.ts");
  const parent = session("p", { cwd: "/repo", name: "main work" });
  const fork = session("f", { cwd: "/repo", parentSessionId: "p", firstMessage: "investigate flaky" });
  const wtParent = session("wp", { cwd: "/repo-worktrees/feat", name: "wt root" });
  const wtChild = session("wc", {
    cwd: "/repo-worktrees/feat",
    parentSessionId: "wp",
    firstMessage: "ordinary child",
  });
  const wtSub = session("ws", {
    cwd: "/repo-worktrees/feat",
    subagent: { parentSessionId: "wc", runId: "r9", runIndex: 2, agent: "explore" },
    readOnly: true,
  });
  const otherProject = session("x", { cwd: "/other", name: "unrelated" });
  const tree = await treeOf([parent, fork, wtParent, wtChild, wtSub, otherProject]);
  // subagent 的 agent 名不再可命中（节点不展示）。
  assert.deepEqual(filterSidebarTree(tree, "explore"), []);
  // 命中 fork 子会话的 firstMessage：平铺语义下它就是那个项目里的一条根行；
  // 同项目里没命中的父会话被剪掉，另一个项目整体被剪掉。
  const filtered = filterSidebarTree(tree, "ordinary");
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].root, "/repo-worktrees/feat");
  assert.deepEqual(filtered[0].tree.map((n) => n.session.id), ["wc"]);
  assert.equal(filtered[0].tree[0].children.length, 0, "平铺后没有再嵌套一层子行");
});

test("搜索命中项目根路径保留整个项目；命中会话字段保留祖先链", async () => {
  const { filterSidebarTree } = await jiti.import("./session-sidebar-model.ts");
  const main = session("m", { cwd: "/repo", name: "zzz" });
  const other = session("o", { cwd: "/repo-worktrees/feat", name: "hit me" });
  const tree = await treeOf([main, other]);
  // 命中项目根：整棵树原样（引用相等，未做无谓克隆）。
  assert.equal(filterSidebarTree(tree, "repo")[0], tree[0]);
  assert.equal(filterSidebarTree(tree, "repo").length, 2);
  // 命中会话字段：只保留命中的项目。
  const bySession = filterSidebarTree(tree, "hit me");
  assert.deepEqual(bySession.map((p) => p.root), ["/repo-worktrees/feat"]);
  // 空查询原样返回；无匹配返回空。
  assert.equal(filterSidebarTree(tree, ""), tree);
  assert.deepEqual(filterSidebarTree(tree, "no-such-thing"), []);
});

test("#53 选中但未加入列表的目录不再造空项目行；列表内的空项目仍置顶", async () => {
  const existing = session("a", { cwd: "/repo-a" });
  // 项目区只列项目列表内的目录：未加入的 selectedCwd 不再例外地造出空项目行
  // （它的会话现在归未分组区，不需要靠临时项目行留住）。
  const unlisted = await treeOf([existing], { selectedCwd: "/new-project" });
  assert.deepEqual(unlisted.map((p) => p.root), ["/repo-a"]);
  // 刚通过「添加项目」加入的空项目（在列表里）仍然置顶且可用
  const listed = await treeOf([existing], {
    selectedCwd: "/new-project",
    projectRoots: ["/new-project", "/repo-a"],
  });
  assert.equal(listed[0].root, "/new-project");
  assert.equal(listed[0].tree.length, 0);
  assert.equal(listed[0].latestActivity, "");
});

test("projectRoots：列表里的项目即使无会话也显示；不在列表里的（含已有会话）不显示", async () => {
  const existing = session("a", { cwd: "/repo-a" });
  const tree = await treeOf([existing], {
    selectedCwd: "/repo-a",
    projectRoots: ["/empty-project", "/repo-a"],
  });
  // 两个项目都显示：有会话的 /repo-a + 空项目 /empty-project
  assert.equal(tree.length, 2);
  const empty = tree.find((p) => p.root === "/empty-project");
  assert.ok(empty, "添加过的空项目必须显示");
  assert.equal(empty.tree.length, 0);
  assert.equal(empty.latestActivity, "");
  // 空项目在列表里就持续显示（与选中状态无关）；不在列表里的项目连会话一起隐藏
  const other = await treeOf([existing], { projectRoots: ["/empty-project"] });
  assert.deepEqual(other.map((p) => p.root), ["/empty-project"]);
  assert.equal(other[0].tree.length, 0);
});

test("#53 Collapse all / Expand all 一并覆盖未分组区", async () => {
  const { collectAllCollapseIds, UNGROUPED_GROUP_KEY } = await jiti.import("./session-sidebar-model.ts");
  const main = session("m", { cwd: "/repo" });
  const loose = session("l", { cwd: "/tmp/scratch" });
  const tree = await treeOf([main, loose], { projectRoots: ["/repo"] });
  assert.deepEqual(collectAllCollapseIds(tree).projectRoots, ["/repo"]);
  const withUngrouped = collectAllCollapseIds(tree, { includeUngrouped: true }).projectRoots;
  assert.deepEqual(withUngrouped, ["/repo", UNGROUPED_GROUP_KEY]);
  // 未分组区为空时不写入它的 key（避免折叠一个不存在的区）
  assert.deepEqual(
    collectAllCollapseIds(collectAllCollapseIds(tree).projectRoots.map((root) => ({ root, tree: [], latestActivity: "" })))
      .projectRoots,
    ["/repo"],
  );
});

test("Collapse all 收集全部项目根；Expand all 即清空集合", async () => {
  const { collectAllCollapseIds } = await jiti.import("./session-sidebar-model.ts");
  const main = session("m", { cwd: "/repo" });
  const other = session("o", { cwd: "/other" });
  const tree = await treeOf([main, other]);
  const ids = collectAllCollapseIds(tree);
  assert.deepEqual(ids.projectRoots.sort(), ["/other", "/repo"]);
});

test("会话定位：返回项目根；平铺后没有会话级祖先链", async () => {
  const { locateSessionInSidebarTree } = await jiti.import("./session-sidebar-model.ts");
  const parent = session("p", { cwd: "/repo" });
  const child = session("c", { cwd: "/repo", parentSessionId: "p" });
  const otherParent = session("op", { cwd: "/other" });
  const otherGrand = session("og", { cwd: "/other", parentSessionId: "op" });
  const tree = await treeOf([parent, child, otherParent, otherGrand]);
  assert.deepEqual(locateSessionInSidebarTree(tree, "p"), { projectRoot: "/repo", ancestors: [] });
  // fork 是独立会话：它自己是根项，没有祖先链可展开。
  assert.deepEqual(locateSessionInSidebarTree(tree, "c"), { projectRoot: "/repo", ancestors: [] });
  assert.deepEqual(locateSessionInSidebarTree(tree, "og"), { projectRoot: "/other", ancestors: [] });
  assert.equal(locateSessionInSidebarTree(tree, "missing"), null);
});

test("关闭当前项目候选：按展示顺序取下一个未关闭项目，无剩余返回 null", async () => {
  const { pickProjectRootAfterClose } = await jiti.import("./session-sidebar-model.ts");
  // modified 由 session() 序号派生：a1 最新在前。
  const a = session("a1", { cwd: "/repo-a", modified: "2026-07-09T00:00:00.000Z" });
  const b = session("b1", { cwd: "/repo-b", modified: "2026-07-08T00:00:00.000Z" });
  const c = session("c1", { cwd: "/repo-c", modified: "2026-07-07T00:00:00.000Z" });
  const tree = await treeOf([a, b, c]);
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
  const { filterSidebarTree } = await jiti.import("./session-sidebar-model.ts");
  const main = session("m", { cwd: "/repo", name: "zzz" });
  const other = session("o", { cwd: "/other", name: "zzz" });
  const tree = await treeOf([main, other]);
  const aliases = { "/repo": "支付中台" };
  // 命中 alias：整棵树原样保留（引用相等），未命中项目被过滤。
  const byAlias = filterSidebarTree(tree, "支付", aliases);
  assert.equal(byAlias.length, 1);
  assert.equal(byAlias[0], tree.find((p) => p.root === "/repo"));
  // alias 大小写不敏感（查询已归一化为小写，alias 在模型内同步小写）。
  const byAliasCase = filterSidebarTree(tree, "pay", { "/repo": "PayCore" });
  assert.equal(byAliasCase.length, 1);
  assert.equal(byAliasCase[0].root, "/repo");
  // 不传 alias：只按根路径/会话字段命中。
  assert.deepEqual(filterSidebarTree(tree, "支付").map((p) => p.root), []);
  // alias 未命中但根路径命中：仍然保留整个项目。
  assert.equal(filterSidebarTree(tree, "other", aliases)[0].root, "/other");
});

test("搜索与折叠偏好隔离：过滤不触碰折叠集合，搜索期强制展开只读不写", async () => {
  const { filterSidebarTree } = await jiti.import("./session-sidebar-model.ts");
  const { isSessionNodeEffectivelyCollapsed } = await jiti.import("./session-tree.ts");
  const main = session("m", { cwd: "/repo", name: "hit me" });
  const tree = await treeOf([main]);
  const collapsedProjects = new Set(["/repo"]);
  // 搜索过滤是纯函数：折叠集合原样不动。
  const filtered = filterSidebarTree(tree, "hit");
  assert.equal(filtered.length, 1);
  assert.deepEqual([...collapsedProjects], ["/repo"]);
  // 搜索期间渲染层强制展开，集合不被改写。
  assert.equal(isSessionNodeEffectivelyCollapsed(collapsedProjects, "/repo", true), false);
  assert.equal(isSessionNodeEffectivelyCollapsed(collapsedProjects, "/repo", false), true);
  assert.deepEqual([...collapsedProjects], ["/repo"]);
});

test("平铺后项目树里没有父子嵌套（subagent 仍隐藏）", async () => {
  const mainParent = session("mp", { cwd: "/repo" });
  const mainSub = session("ms", {
    cwd: "/repo",
    subagent: { parentSessionId: "mp", runId: "r1", runIndex: 0 },
    readOnly: true,
  });
  const forkOnly = session("fo", { cwd: "/other" });
  const forkChild = session("fc", { cwd: "/other", parentSessionId: "fo" });
  const tree = await treeOf([mainParent, mainSub, forkOnly, forkChild]);
  const all = tree.flatMap((p) => p.tree);
  assert.deepEqual(all.map((n) => n.session.id).sort(), ["fc", "fo", "mp"]);
  assert.ok(all.every((n) => n.children.length === 0), "不该有嵌套子行");
  assert.equal(all.some((n) => n.session.id === "ms"), false, "subagent 仍隐藏");
});

test("平铺后未分组区同样没有父子嵌套（#53）", async () => {
  const { buildUngroupedTree } = await jiti.import("./session-sidebar-model.ts");
  const projectParent = session("pp", { cwd: "/repo" });
  const projectChild = session("pc", { cwd: "/repo", parentSessionId: "pp" });
  const looseParent = session("lp", { cwd: "/loose" });
  const looseChild = session("lc", { cwd: "/loose", parentSessionId: "lp" });
  await treeOf([projectParent, projectChild]);
  const ungrouped = buildUngroupedTree([projectParent, projectChild, looseParent, looseChild], { projectRoots: ["/repo"] });
  assert.deepEqual(ungrouped.map((n) => n.session.id).sort(), ["lc", "lp"]);
  assert.ok(ungrouped.every((n) => n.children.length === 0));
});

test("全文模式：按 session id 集合保留祖先链，不按 name/alias 整树匹配", async () => {
  const { filterSidebarTree } = await jiti.import("./session-sidebar-model.ts");
  const parent = session("p", { cwd: "/repo", name: "main work" });
  const child = session("c", { cwd: "/repo", parentSessionId: "p", firstMessage: "leaf body" });
  const other = session("o", { cwd: "/other", name: "repo alias bait" });
  const tree = await treeOf([parent, child, other]);
  // 仅命中 child：平铺语义下它就是一条根行（不再保留 p → c 祖先链）；other 不保留。
  const filtered = filterSidebarTree(tree, "", { "/other": "repo" }, new Set(["c"]));
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].root, "/repo");
  assert.deepEqual(filtered[0].tree.map((n) => n.session.id), ["c"]);
  assert.equal(filtered[0].tree[0].children.length, 0);
  // 空集合：全文模式无命中 → 空树。
  assert.deepEqual(filterSidebarTree(tree, "", undefined, new Set()), []);
});

test("项目排序：az/za 按显示名，fixed 按指定顺序，拖动改序", async () => {
  const { sortSidebarProjects, moveProjectInOrder } = await jiti.import("./session-sidebar-model.ts");
  const a = session("a1", { cwd: "/alpha", modified: "2026-07-01T00:00:00.000Z" });
  const b = session("b1", { cwd: "/beta", modified: "2026-07-09T00:00:00.000Z" });
  const tree = await treeOf([a, b]);
  assert.deepEqual(sortSidebarProjects(tree, { mode: "az" }).map((p) => p.root), ["/alpha", "/beta"]);
  assert.deepEqual(sortSidebarProjects(tree, { mode: "za" }).map((p) => p.root), ["/beta", "/alpha"]);
  assert.deepEqual(
    sortSidebarProjects(tree, { mode: "fixed", order: ["/alpha", "/beta"] }).map((p) => p.root),
    ["/alpha", "/beta"],
  );
  assert.deepEqual(moveProjectInOrder(["/alpha", "/beta", "/gamma"], "/gamma", "/alpha"), ["/gamma", "/alpha", "/beta"]);
});

test("projectHasRunningSession：只认本目录的 running，旁路 checkout 不阻止关闭", async () => {
  const { projectHasRunningSession } = await jiti.import("./session-sidebar-model.ts");
  const main = session("s1", { cwd: "/repo" });
  const wt = session("s2", { cwd: "/repo-worktrees/feat" });
  const other = session("s3", { cwd: "/other" });
  // 陈旧缓存里的 projectRoot 不参与判定。
  const stale = session("s4", { cwd: "/elsewhere", projectRoot: "/repo" });
  const sessions = [main, wt, other, stale];
  assert.equal(projectHasRunningSession(sessions, new Set(["s1"]), "/repo"), true);
  assert.equal(projectHasRunningSession(sessions, new Set(["s2"]), "/repo"), false);
  assert.equal(projectHasRunningSession(sessions, new Set(["s4"]), "/repo"), false);
  assert.equal(projectHasRunningSession(sessions, new Set(["s2"]), "/repo-worktrees/feat"), true);
  assert.equal(projectHasRunningSession(sessions, new Set(["s3"]), "/repo"), false);
  assert.equal(projectHasRunningSession(sessions, ["s1"], "/repo"), true);
  assert.equal(projectHasRunningSession(sessions, [], "/repo"), false);
});

test("#53 不在列表里的目录不进项目区（无论是否选中）；它的会话由未分组区承接", async () => {
  const { buildSidebarTree, buildUngroupedTree } = await jiti.import("./session-sidebar-model.ts");
  const existing = session("x", { cwd: "/existing" });
  assert.deepEqual(
    buildSidebarTree([existing], { projectRoots: ["/listed"] }).map((p) => p.root),
    ["/listed"],
  );
  // 选中也不进项目区（旧行为是造一个临时项目行）
  assert.deepEqual(
    buildSidebarTree([existing], { projectRoots: ["/listed"], selectedCwd: "/existing" }).map((p) => p.root),
    ["/listed"],
  );
  assert.deepEqual(
    buildUngroupedTree([existing], { projectRoots: ["/listed"] }).map((n) => n.session.id),
    ["x"],
  );
});

// ── #53 未分组会话区 ──────────────────────────────────────────────────────

test("#53 派生未分组：cwd 不在项目列表的会话进未分组（含从未加入过的目录）", async () => {
  const m = await modelModule;
  const inside = session("in", { cwd: "/repo" });
  const listed = session("in2", { cwd: "/other", modified: "2026-07-08T00:00:00.000Z" });
  const loose = session("loose", { cwd: "/tmp/scratch" });
  const sessions = [inside, listed, loose];
  const projectTree = m.buildSidebarTree(sessions, { projectRoots: ["/repo", "/other"] });
  assert.deepEqual(projectTree.map((p) => p.root).sort(), ["/other", "/repo"]);
  assert.deepEqual(
    m.buildUngroupedTree(sessions, { projectRoots: ["/repo", "/other"] }).map((n) => n.session.id),
    ["loose"],
  );
  // 项目列表为空时全部会话都在未分组区
  assert.deepEqual(
    m.buildUngroupedTree(sessions, { projectRoots: [] }).map((n) => n.session.id).sort(),
    ["in", "in2", "loose"],
  );
});

test("#53 显式未分组标记优先于派生：目录重新加入后旧会话仍留未分组，新会话进项目", async () => {
  const m = await modelModule;
  const old = session("old", { cwd: "/repo", modified: "2026-07-01T00:00:00.000Z" });
  const fresh = session("fresh", { cwd: "/repo", modified: "2026-07-05T00:00:00.000Z" });
  const options = { projectRoots: ["/repo"], ungroupedSessionIds: new Set(["old"]) };
  const projectTree = m.buildSidebarTree([old, fresh], options);
  assert.deepEqual(projectTree.map((p) => p.root), ["/repo"]);
  assert.deepEqual(projectTree[0].tree.map((n) => n.session.id), ["fresh"]);
  assert.deepEqual(m.buildUngroupedTree([old, fresh], options).map((n) => n.session.id), ["old"]);
  // 数组形式同样接受，且不改输入
  const asArray = ["old"];
  assert.deepEqual(
    m.buildUngroupedTree([old, fresh], { projectRoots: ["/repo"], ungroupedSessionIds: asArray })
      .map((n) => n.session.id),
    ["old"],
  );
  assert.deepEqual(asArray, ["old"]);
});

test("#53 未分组树沿用 fork/subagent 语义与排序：子会话挂父下、subagent 不展示", async () => {
  const m = await modelModule;
  const parent = session("up", { cwd: "/tmp/scratch", modified: "2026-07-09T00:00:00.000Z" });
  const forkChild = session("uc", { cwd: "/tmp/scratch", parentSessionId: "up", modified: "2026-07-10T00:00:00.000Z" });
  const sub = session("usub", {
    cwd: "/tmp/scratch",
    modified: "2026-07-11T00:00:00.000Z",
    subagent: { parentSessionId: "up", runId: "r", runIndex: 1 },
  });
  const other = session("uother", { cwd: "/tmp/two", modified: "2026-07-08T00:00:00.000Z" });
  const tree = m.buildUngroupedTree([parent, forkChild, sub, other], { projectRoots: [] });
  // fork 平铺：父与 fork 各一条根行；subagent 仍不展示。
  assert.deepEqual([...tree].map((n) => n.session.id).sort(), ["uc", "uother", "up"]);
  assert.ok(tree.every((n) => n.children.length === 0));
  assert.equal(tree.some((n) => n.session.id === "usub"), false);
});

test("#53 未分组定位：命中返回祖先链（含空链），未找到返回 null", async () => {
  const m = await modelModule;
  const parent = session("up", { cwd: "/tmp/scratch" });
  const child = session("uc", { cwd: "/tmp/scratch", parentSessionId: "up" });
  const tree = m.buildUngroupedTree([parent, child], { projectRoots: [] });
  assert.deepEqual(m.locateSessionInUngroupedTree(tree, "up"), []);
  assert.deepEqual(m.locateSessionInUngroupedTree(tree, "uc"), [], "平铺后 fork 无祖先链");
  assert.equal(m.locateSessionInUngroupedTree(tree, "missing"), null);
});
