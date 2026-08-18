import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const load = () => jiti.import("./session-sidebar-state.ts");

/** @param {string} id @param {Partial<import('../lib/types').SessionInfo>} [overrides] */
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

// ── 分组可见条数 ───────────────────────────────────────────────────────────

test("可见条数：默认 5，显示更多每次 +5，显示更少重置", async () => {
  const m = await load();
  assert.equal(m.DEFAULT_GROUP_VISIBLE_COUNT, 5);
  assert.equal(m.GROUP_VISIBLE_PAGE_SIZE, 5);
  assert.equal(m.getGroupVisibleCount({}, "main:/repo"), 5);

  let counts = m.bumpGroupVisibleCount({}, "g1");
  assert.equal(m.getGroupVisibleCount(counts, "g1"), 10);
  counts = m.bumpGroupVisibleCount(counts, "g1");
  assert.equal(m.getGroupVisibleCount(counts, "g1"), 15);

  const reset = m.resetGroupVisibleCount(counts, "g1");
  assert.equal(m.getGroupVisibleCount(reset, "g1"), 5);
  assert.equal("g1" in reset, false);
  // 未记录的 key 重置返回原引用
  const empty = {};
  assert.equal(m.resetGroupVisibleCount(empty, "x"), empty);
});

test("可见条数：脏值回退默认；截取只切顶层节点不拆 child", async () => {
  const m = await load();
  assert.equal(m.getGroupVisibleCount({ g: 0 }, "g"), 5);
  assert.equal(m.getGroupVisibleCount({ g: NaN }, "g"), 5);
  assert.equal(m.getGroupVisibleCount({ g: 3.7 }, "g"), 5);
  assert.equal(m.getGroupVisibleCount({ g: 12.9 }, "g"), 12);

  const nodes = [
    { id: "a", children: [{ id: "a1" }, { id: "a2" }] },
    { id: "b", children: [{ id: "b1" }] },
    { id: "c", children: [] },
    { id: "d", children: [] },
    { id: "e", children: [] },
    { id: "f", children: [] },
  ];
  const visible = m.getVisibleTopLevelNodes(nodes, 5, false);
  assert.equal(visible.length, 5);
  assert.deepEqual(visible.map((n) => n.id), ["a", "b", "c", "d", "e"]);
  // child tree 完整保留（同一引用）
  assert.equal(visible[0], nodes[0]);
  assert.equal(visible[0].children.length, 2);

  // 搜索激活：返回全部（引用相等）
  assert.equal(m.getVisibleTopLevelNodes(nodes, 5, true), nodes);
  // 可见数 ≥ 总数：引用相等
  assert.equal(m.getVisibleTopLevelNodes(nodes, 100, false), nodes);

  assert.equal(m.canShowMoreTopLevel(6, 5, false), true);
  assert.equal(m.canShowMoreTopLevel(5, 5, false), false);
  assert.equal(m.canShowMoreTopLevel(6, 5, true), false);
  assert.equal(m.canShowFewerTopLevel(10, false), true);
  assert.equal(m.canShowFewerTopLevel(5, false), false);
  assert.equal(m.canShowFewerTopLevel(10, true), false);
});

// ── 乐观会话合并 ───────────────────────────────────────────────────────────

test("乐观合并：server 同 id 替换 pending；stale server 不删 pending 集合项", async () => {
  const m = await load();
  const pendingA = session("a", { name: "optimistic-a", modified: "2026-07-10T00:00:00.000Z" });
  const pendingB = session("b", { name: "optimistic-b", modified: "2026-07-09T00:00:00.000Z" });
  const serverA = session("a", { name: "server-a", modified: "2026-07-10T01:00:00.000Z" });
  const serverC = session("c", { name: "server-c", modified: "2026-07-08T00:00:00.000Z" });

  // 正常回流：server 带 a、c；pending 有 a、b → a 被 server 替换，b 保留
  const merged = m.mergeOptimisticSessions({
    serverSessions: [serverA, serverC],
    pendingSessions: [pendingA, pendingB],
  });
  assert.deepEqual(merged.map((s) => s.id), ["a", "b", "c"]);
  assert.equal(merged.find((s) => s.id === "a")?.name, "server-a");
  assert.equal(merged.find((s) => s.id === "b")?.name, "optimistic-b");

  // stale server：只带回 c，但 b 仍在 pendingIds → b 不得消失
  const stale = m.mergeOptimisticSessions({
    serverSessions: [serverC],
    pendingSessions: [pendingB],
    pendingIds: new Set(["b"]),
  });
  assert.deepEqual(stale.map((s) => s.id).sort(), ["b", "c"]);
});

test("乐观合并：显式删除 id 可移除；排序按 modified/created 稳定", async () => {
  const m = await load();
  const a = session("a", { modified: "2026-07-05T00:00:00.000Z", created: "2026-07-01T00:00:00.000Z" });
  const b = session("b", { modified: "2026-07-05T00:00:00.000Z", created: "2026-07-02T00:00:00.000Z" });
  const c = session("c", { modified: "2026-07-06T00:00:00.000Z", created: "2026-07-01T00:00:00.000Z" });
  // 同 modified+created 时 id 升序
  const d1 = session("d1", { modified: "2026-07-04T00:00:00.000Z", created: "2026-07-01T00:00:00.000Z" });
  const d2 = session("d2", { modified: "2026-07-04T00:00:00.000Z", created: "2026-07-01T00:00:00.000Z" });

  const sorted = m.mergeOptimisticSessions({
    serverSessions: [a, b, c, d2, d1],
    pendingSessions: [],
  });
  assert.deepEqual(sorted.map((s) => s.id), ["c", "b", "a", "d1", "d2"]);

  const deleted = m.mergeOptimisticSessions({
    serverSessions: [a, b, c],
    pendingSessions: [session("p", { modified: "2026-07-07T00:00:00.000Z" })],
    deletedIds: new Set(["b", "p"]),
  });
  assert.deepEqual(deleted.map((s) => s.id), ["c", "a"]);
});

test("pending id 回流：server 出现后从 pending 集合剔除；无变化返回原引用", async () => {
  const m = await load();
  const pending = new Set(["a", "b"]);
  const next = m.reconcilePendingSessionIds(pending, [session("a"), session("c")]);
  assert.deepEqual([...next].sort(), ["b"]);
  const same = m.reconcilePendingSessionIds(next, [session("c")]);
  assert.equal(same, next);
  const empty = new Set();
  assert.equal(m.reconcilePendingSessionIds(empty, [session("x")]), empty);
});

test("多 pending A/B：逐 id 回流；stale server 不丢另一条", async () => {
  const m = await load();
  const pendingA = session("sid-a", {
    name: "optimistic-a",
    modified: "2026-07-12T00:00:00.000Z",
  });
  const pendingB = session("sid-b", {
    name: "optimistic-b",
    modified: "2026-07-11T00:00:00.000Z",
  });
  const pendingIds = new Set(["sid-a", "sid-b"]);

  // R1 只带回 B：A 必须保留
  const afterR1 = m.mergeOptimisticSessions({
    serverSessions: [session("sid-b", { name: "server-b", modified: "2026-07-11T01:00:00.000Z" })],
    pendingSessions: [pendingA, pendingB],
    pendingIds,
  });
  assert.deepEqual(afterR1.map((s) => s.id).sort(), ["sid-a", "sid-b"]);
  assert.equal(afterR1.find((s) => s.id === "sid-b")?.name, "server-b");
  assert.equal(afterR1.find((s) => s.id === "sid-a")?.name, "optimistic-a");

  const pendingAfterB = m.reconcilePendingSessionIds(pendingIds, [
    session("sid-b"),
  ]);
  assert.deepEqual([...pendingAfterB].sort(), ["sid-a"]);

  // R2 带回 A：A 被 server 替换并离开 pending
  const afterR2 = m.mergeOptimisticSessions({
    serverSessions: [
      session("sid-a", { name: "server-a", modified: "2026-07-12T02:00:00.000Z" }),
      session("sid-b", { name: "server-b", modified: "2026-07-11T01:00:00.000Z" }),
    ],
    pendingSessions: [pendingA],
    pendingIds: pendingAfterB,
  });
  assert.equal(afterR2.find((s) => s.id === "sid-a")?.name, "server-a");
  assert.deepEqual(
    [...m.reconcilePendingSessionIds(pendingAfterB, afterR2)].sort(),
    [],
  );
});

test("乱序 list 响应：仅最新 gen 可写 server/error/loading", async () => {
  const m = await load();
  // R1 gen=1，随后 R2 gen=2 成为最新 → R1 迟到不得 apply
  assert.equal(m.shouldApplySessionListResponse(1, 2), false);
  assert.equal(m.shouldApplySessionListResponse(2, 2), true);
  assert.equal(m.shouldApplySessionListResponse(0, 0), false);
  assert.equal(m.shouldApplySessionListResponse(3, 3), true);
});

test("worktree preload generation 不含 session refreshKey", async () => {
  const m = await load();
  assert.equal(m.buildWorktreePreloadGeneration(0), "wt:0");
  assert.equal(m.buildWorktreePreloadGeneration(4), "wt:4");
  assert.equal(m.buildWorktreePreloadGeneration(4.9), "wt:4");
  // 契约：字符串前缀固定 wt:，不得出现 session 相关 token
  const gen = m.buildWorktreePreloadGeneration(7);
  assert.match(gen, /^wt:\d+$/);
  assert.equal(gen.includes("refresh"), false);
  assert.equal(gen.includes("session"), false);
});

// ── 项目 worktree 快照 ─────────────────────────────────────────────────────

const wt = (path, branch = "main", isMain = false) => ({ path, branch, isMain });

test("worktree 快照：loading/error 保留 last-known；单项目错误不影响其他", async () => {
  const m = await load();
  let map = {};
  map = m.upsertProjectWorktreeSnapshot(map, "/repo-a", {
    status: "ready",
    worktrees: [wt("/repo-a", "main", true), wt("/repo-a-wt/feat", "feat")],
  });
  map = m.upsertProjectWorktreeSnapshot(map, "/repo-b", {
    status: "ready",
    worktrees: [wt("/repo-b", "main", true)],
  });

  // loading 保留 a 的列表
  const loading = m.upsertProjectWorktreeSnapshot(map, "/repo-a", { status: "loading" });
  assert.equal(loading["/repo-a"].status, "loading");
  assert.equal(loading["/repo-a"].worktrees.length, 2);
  assert.equal(loading["/repo-b"].status, "ready");

  // error 保留 last-known，不影响 b
  const errored = m.upsertProjectWorktreeSnapshot(loading, "/repo-a", {
    status: "error",
    error: "network",
  });
  assert.equal(errored["/repo-a"].status, "error");
  assert.equal(errored["/repo-a"].error, "network");
  assert.equal(errored["/repo-a"].worktrees.length, 2);
  assert.equal(errored["/repo-b"].worktrees.length, 1);
  assert.equal(errored["/repo-b"].status, "ready");
});

test("worktree 快照：相同列表不触发更新；idle 清空；remove 只删目标", async () => {
  const m = await load();
  const list = [wt("/repo", "main", true)];
  let map = m.upsertProjectWorktreeSnapshot({}, "/repo", { status: "ready", worktrees: list });
  const same = m.upsertProjectWorktreeSnapshot(map, "/repo", {
    status: "ready",
    worktrees: [wt("/repo", "main", true)],
  });
  assert.equal(same, map);

  const idle = m.upsertProjectWorktreeSnapshot(map, "/repo", { status: "idle" });
  assert.notEqual(idle, map);
  assert.equal(idle["/repo"].status, "idle");
  assert.deepEqual(idle["/repo"].worktrees, []);

  map = m.upsertProjectWorktreeSnapshot(map, "/other", { status: "ready", worktrees: list });
  const removed = m.removeProjectWorktreeSnapshot(map, "/repo");
  assert.equal("/repo" in removed, false);
  assert.equal("/other" in removed, true);
  assert.equal(m.removeProjectWorktreeSnapshot(removed, "/missing"), removed);
});

test("worktree 列表比较：path/branch/isMain 顺序敏感", async () => {
  const m = await load();
  assert.equal(m.sameWorktreeList([], []), true);
  assert.equal(
    m.sameWorktreeList([wt("/a", "x", true)], [wt("/a", "x", true)]),
    true,
  );
  assert.equal(
    m.sameWorktreeList([wt("/a", "x", true)], [wt("/a", "y", true)]),
    false,
  );
  assert.equal(
    m.sameWorktreeList([wt("/a"), wt("/b")], [wt("/b"), wt("/a")]),
    false,
  );
});

// ── 预加载队列与 canonical 快照收敛 ────────────────────────────────────────

test("buildKnownProjectRoots：projectRoot 已在 roots → 不加入 selectedCwd（返回原引用）", async () => {
  const m = await load();
  const roots = ["/repo-a", "/repo-b"];
  // 点击 worktree 分组后 selectedCwd 是 worktree 路径，不得混入预加载队列
  const same = m.buildKnownProjectRoots(roots, "/repo-a/.claude/worktrees/1-feat", "/repo-a");
  assert.equal(same, roots);
  assert.deepEqual(same, ["/repo-a", "/repo-b"]);
});

test("buildKnownProjectRoots：projectRoot 不在 roots → unshift projectRoot", async () => {
  const m = await load();
  const roots = ["/repo-b"];
  const next = m.buildKnownProjectRoots(roots, "/repo-b/.claude/worktrees/x", "/repo-a");
  assert.notEqual(next, roots);
  assert.deepEqual(next, ["/repo-a", "/repo-b"]);
});

test("buildKnownProjectRoots：projectRoot 为空且 selectedCwd 不在 roots → unshift selectedCwd", async () => {
  const m = await load();
  const roots = ["/repo-b"];
  const next = m.buildKnownProjectRoots(roots, "/repo-a", null);
  assert.notEqual(next, roots);
  assert.deepEqual(next, ["/repo-a", "/repo-b"]);
  // selectedCwd 已在 roots → 原引用
  const same = m.buildKnownProjectRoots(roots, "/repo-b", null);
  assert.equal(same, roots);
});

test("buildKnownProjectRoots：空输入不变（返回原引用）", async () => {
  const m = await load();
  const empty = [];
  assert.equal(m.buildKnownProjectRoots(empty, null, null), empty);
  assert.equal(m.buildKnownProjectRoots(empty, "", null), empty);
  assert.equal(m.buildKnownProjectRoots(empty, "/a", null) === empty, false);
});

test("upsertCanonicalProjectWorktreeSnapshot：请求 root 即 canonical → 只写该 key", async () => {
  const m = await load();
  const list = [wt("/repo", "main", true)];
  const map = m.upsertCanonicalProjectWorktreeSnapshot({}, "/repo", "/repo", list);
  assert.deepEqual(Object.keys(map), ["/repo"]);
  assert.equal(map["/repo"].status, "ready");
  assert.deepEqual(map["/repo"].worktrees, list);
});

test("upsertCanonicalProjectWorktreeSnapshot：不同 → 移除请求 root（含 loading key），只保留 canonical", async () => {
  const m = await load();
  // 预加载期间请求 root（worktree 路径）先写入了 loading 条目
  let map = m.upsertProjectWorktreeSnapshot({}, "/repo/.claude/worktrees/1-feat", { status: "loading" });
  map = m.upsertProjectWorktreeSnapshot(map, "/repo", {
    status: "ready",
    worktrees: [wt("/repo", "main", true)],
  });
  const next = m.upsertCanonicalProjectWorktreeSnapshot(
    map,
    "/repo/.claude/worktrees/1-feat",
    "/repo",
    [wt("/repo", "main", true), wt("/repo/.claude/worktrees/1-feat", "feat")],
  );
  // 请求 root key 已被移除（含 loading），只剩 canonical
  assert.deepEqual(Object.keys(next).sort(), ["/repo"]);
  assert.equal(next["/repo"].status, "ready");
  assert.equal(next["/repo"].worktrees.length, 2);
  // 原 map 不被修改（immutable）
  assert.equal("/repo/.claude/worktrees/1-feat" in map, true);
});

test("upsertCanonicalProjectWorktreeSnapshot：请求 root 不存在时 remove 是 no-op 不抛错", async () => {
  const m = await load();
  const list = [wt("/repo", "main", true)];
  const map = m.upsertProjectWorktreeSnapshot({}, "/repo", { status: "ready", worktrees: list });
  // requestRoot 不在 map 中：remove no-op，随后 upsert canonical 无变化 → 原引用
  const same = m.upsertCanonicalProjectWorktreeSnapshot(map, "/missing-wt", "/repo", list);
  assert.equal(same, map);
  assert.deepEqual(Object.keys(same), ["/repo"]);
  assert.equal(same["/repo"].status, "ready");
  // canonical 内容不同 → 正常写回且仍只有 canonical 一个 key
  const changed = m.upsertCanonicalProjectWorktreeSnapshot(map, "/missing-wt", "/repo", [
    ...list,
    wt("/repo-wt/feat", "feat"),
  ]);
  assert.deepEqual(Object.keys(changed), ["/repo"]);
  assert.equal(changed["/repo"].worktrees.length, 2);
});

// ── 最近会话区 ─────────────────────────────────────────────────────────────

test("最近会话：按 modified 降序取 top N，默认 20；不修改输入数组", async () => {
  const m = await load();
  const list = [
    session("old", { modified: "2026-07-01T00:00:00.000Z" }),
    session("newer", { modified: "2026-07-10T00:00:00.000Z" }),
    session("mid", { modified: "2026-07-05T00:00:00.000Z" }),
    session("newest", { modified: "2026-07-12T00:00:00.000Z" }),
    session("mid2", { modified: "2026-07-06T00:00:00.000Z" }),
    session("sixth", { modified: "2026-07-04T00:00:00.000Z" }),
  ];
  const recent = m.deriveRecentSessions({ sessions: list });
  // 仅 6 条时默认 limit=20 返回全部 6 条（按 modified 降序）
  assert.deepEqual(recent.map((s) => s.id), ["newest", "newer", "mid2", "mid", "sixth", "old"]);
  // 输入未被修改
  assert.equal(list.length, 6);
  // 自定义 limit
  const top3 = m.deriveRecentSessions({ sessions: list, limit: 3 });
  assert.deepEqual(top3.map((s) => s.id), ["newest", "newer", "mid2"]);
});

test("最近会话：输入乱序也能正确派生（内部稳定排序）", async () => {
  const m = await load();
  const list = [
    session("b", { modified: "2026-07-08T00:00:00.000Z" }),
    session("a", { modified: "2026-07-12T00:00:00.000Z" }),
    session("c", { modified: "2026-07-10T00:00:00.000Z" }),
  ];
  assert.deepEqual(
    m.deriveRecentSessions({ sessions: list, limit: 2 }).map((s) => s.id),
    ["a", "c"],
  );
});

test("最近会话：排除 subagent 子会话与已关闭项目内的会话", async () => {
  const m = await load();
  const list = [
    session("root-recent", { modified: "2026-07-12T00:00:00.000Z", projectRoot: "/repo-a" }),
    session("subagent", {
      modified: "2026-07-13T00:00:00.000Z",
      projectRoot: "/repo-a",
      subagent: { parentSessionId: "parent", runId: "r1", runIndex: 1 },
    }),
    session("closed-project", { modified: "2026-07-11T00:00:00.000Z", projectRoot: "/repo-closed" }),
    session("closed-fallback-cwd", { modified: "2026-07-10T00:00:00.000Z", cwd: "/repo-closed-2" }),
  ];
  const recent = m.deriveRecentSessions({
    sessions: list,
    closedProjectRoots: new Set(["/repo-closed", "/repo-closed-2"]),
  });
  assert.deepEqual(recent.map((s) => s.id), ["root-recent"]);
});

test("最近会话：excludeIds 与损坏 limit 容错", async () => {
  const m = await load();
  const list = [
    session("a", { modified: "2026-07-12T00:00:00.000Z" }),
    session("b", { modified: "2026-07-11T00:00:00.000Z" }),
    session("c", { modified: "2026-07-10T00:00:00.000Z" }),
  ];
  assert.deepEqual(
    m.deriveRecentSessions({ sessions: list, excludeIds: new Set(["a"]) }).map((s) => s.id),
    ["b", "c"],
  );
  assert.deepEqual(m.deriveRecentSessions({ sessions: list, limit: 0 }).map((s) => s.id), []);
  assert.deepEqual(m.deriveRecentSessions({ sessions: list, limit: -3 }).map((s) => s.id), []);
  assert.deepEqual(m.deriveRecentSessions({ sessions: list, limit: 2.9 }).map((s) => s.id), ["a", "b"]);
  // 空输入安全空态
  assert.deepEqual(m.deriveRecentSessions({ sessions: [] }), []);
  assert.equal(m.RECENT_SESSIONS_LIMIT, 20);
  assert.equal(m.RECENT_SESSIONS_INITIAL_VISIBLE, 5);
  assert.equal(m.RECENT_SESSIONS_LOAD_MORE, 5);
});

// ── 置顶会话 ──────────────────────────────────────────────────────────────

test("置顶会话：按 pinnedSessionIds 顺序输出仍存在、可见的会话", async () => {
  const m = await load();
  const list = [
    session("first", { projectRoot: "/repo-a" }),
    session("second", { projectRoot: "/repo-a" }),
    session("closed", { projectRoot: "/repo-closed" }),
    session("sub", {
      subagent: { parentSessionId: "p", runId: "r1", runIndex: 1 },
    }),
  ];
  // 顺序 = pinnedSessionIds 顺序（最新置顶在前）；已删除/归档（不在 sessions）、
  // subagent、关闭项目内的跳过
  const pinned = m.derivePinnedSessions({
    sessions: list,
    pinnedSessionIds: ["second", "gone", "first", "closed", "sub"],
    closedProjectRoots: new Set(["/repo-closed"]),
  });
  assert.deepEqual(pinned.map((s) => s.id), ["second", "first"]);
  // 不修改输入数组
  assert.equal(list.length, 4);
});

test("置顶会话：空置顶列表与空会话列表安全空态", async () => {
  const m = await load();
  assert.deepEqual(m.derivePinnedSessions({ sessions: [], pinnedSessionIds: [] }), []);
  assert.deepEqual(
    m.derivePinnedSessions({ sessions: [session("a")], pinnedSessionIds: [] }),
    [],
  );
  assert.deepEqual(
    m.derivePinnedSessions({ sessions: [], pinnedSessionIds: ["ghost"] }),
    [],
  );
  // 重复 id 不重复输出
  const dup = m.derivePinnedSessions({
    sessions: [session("a")],
    pinnedSessionIds: ["a", "a"],
  });
  assert.deepEqual(dup.map((s) => s.id), ["a"]);
});
