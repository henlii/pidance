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

test("#53 最近会话：只排除 subagent 子会话，不再按目录过滤（未分组会话照常出现）", async () => {
  const m = await load();
  const list = [
    session("root-recent", { modified: "2026-07-12T00:00:00.000Z" }),
    session("subagent", {
      modified: "2026-07-13T00:00:00.000Z",
      subagent: { parentSessionId: "parent", runId: "r1", runIndex: 1 },
    }),
    session("closed-project", { modified: "2026-07-11T00:00:00.000Z", cwd: "/repo-closed" }),
    // 陈旧缓存：projectRoot 指向 /repo，但 cwd 是旁路目录 —— 仍按 cwd 判定。
    session("stale-cache", { modified: "2026-07-10T00:00:00.000Z", cwd: "/repo-worktrees/feat", projectRoot: "/repo" }),
  ];
  const recent = m.deriveRecentSessions({ sessions: list });
  assert.deepEqual(recent.map((s) => s.id), ["root-recent", "closed-project", "stale-cache"]);
  // 已删除/归档（不在 sessions 里）的会话自然不会出现；subagent 仍被排除。
  assert.equal(recent.some((s) => s.id === "subagent"), false);
});

test("#53 最近/置顶不再按目录过滤：陈旧 projectRoot 不影响，置顶的会话一定可见", async () => {
  const m = await load();
  // 客户端旧缓存：cwd 在旁路 checkout，projectRoot 仍指向主仓 —— 分组只看 cwd，展示不看目录
  const stale = session("stale", {
    cwd: "/repo-worktrees/feat",
    projectRoot: "/repo",
    modified: "2026-07-12T00:00:00.000Z",
  });
  const sessions = [session("main", { modified: "2026-07-11T00:00:00.000Z" }), stale];
  assert.deepEqual(m.deriveRecentSessions({ sessions }).map((s) => s.id), ["stale", "main"]);
  assert.deepEqual(
    m.derivePinnedSessions({ sessions, pinnedSessionIds: ["main", "stale"] }).map((s) => s.id),
    ["main", "stale"],
  );
  // 项目被关闭后（会话 cwd 已不在项目列表）仍然出现在最近/置顶：它们归未分组区。
  const closedOnly = [session("closed", { cwd: "/repo-closed", modified: "2026-07-12T00:00:00.000Z" })];
  assert.deepEqual(m.deriveRecentSessions({ sessions: closedOnly }).map((s) => s.id), ["closed"]);
  assert.deepEqual(
    m.derivePinnedSessions({ sessions: closedOnly, pinnedSessionIds: ["closed"] }).map((s) => s.id),
    ["closed"],
  );
});

test("最近会话：显示更多后可收到默认条数", async () => {
  const m = await load();
  assert.equal(m.nextRecentVisibleCount(5, 20, "more"), 10);
  assert.equal(m.nextRecentVisibleCount(10, 20, "more"), 15);
  assert.equal(m.nextRecentVisibleCount(18, 20, "more"), 20);
  assert.equal(m.nextRecentVisibleCount(20, 20, "more"), 20);
  assert.equal(m.nextRecentVisibleCount(15, 20, "fewer"), 5);
  assert.equal(m.nextRecentVisibleCount(20, 3, "fewer"), 3);
  assert.equal(m.nextRecentVisibleCount(-1, 20, "more"), 5);
});

test("子代理发现补刷：新缺失集合立刻火，同集合冷却后最多再试，成功清空复位", async () => {
  const m = await load();
  const first = m.planSubagentDiscoveryRefresh({
    missingIds: ["c1"], lastKey: "", attempts: 0, lastAttemptAt: 0, now: 1000,
  });
  assert.equal(first.fire, true);
  assert.equal(first.attempts, 1);
  const sameTick = m.planSubagentDiscoveryRefresh({
    missingIds: ["c1"], lastKey: first.lastKey, attempts: first.attempts, lastAttemptAt: first.lastAttemptAt, now: 1001,
  });
  assert.equal(sameTick.fire, false);
  const afterCooldown = m.planSubagentDiscoveryRefresh({
    missingIds: ["c1"], lastKey: first.lastKey, attempts: first.attempts, lastAttemptAt: first.lastAttemptAt, now: 5001,
  });
  assert.equal(afterCooldown.fire, true);
  assert.equal(afterCooldown.attempts, 2);
  const exhausted = m.planSubagentDiscoveryRefresh({
    missingIds: ["c1"], lastKey: "c1", attempts: 3, lastAttemptAt: 1000, now: 20_000,
  });
  assert.equal(exhausted.fire, false);
  const cleared = m.planSubagentDiscoveryRefresh({
    missingIds: [], lastKey: "c1", attempts: 3, lastAttemptAt: 1000, now: 20_000,
  });
  assert.equal(cleared.fire, false);
  assert.equal(cleared.lastKey, "");
  const reappeared = m.planSubagentDiscoveryRefresh({
    missingIds: ["c1"], lastKey: "", attempts: 0, lastAttemptAt: 0, now: 30_000,
  });
  assert.equal(reappeared.fire, true);
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

test("置顶会话：按 pinnedSessionIds 顺序输出仍存在的会话（不按目录过滤）", async () => {
  const m = await load();
  const list = [
    session("first", { cwd: "/repo-a" }),
    session("second", { cwd: "/repo-a" }),
    session("closed", { cwd: "/repo-closed" }),
    session("sub", {
      subagent: { parentSessionId: "p", runId: "r1", runIndex: 1 },
    }),
  ];
  // 顺序 = pinnedSessionIds 顺序（最新置顶在前）；已删除/归档（不在 sessions）
  // 与 subagent 会话跳过；项目被关闭的目录不再让它从置顶区消失。
  const pinned = m.derivePinnedSessions({
    sessions: list,
    pinnedSessionIds: ["second", "gone", "first", "closed", "sub"],
  });
  assert.deepEqual(pinned.map((s) => s.id), ["second", "first", "closed"]);
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

test("最近/置顶区：fork 子会话是独立会话，各自成行（不折叠进父行）", async () => {
  const m = await jiti.import("./session-sidebar-state.ts");
  // 真实场景：fork 会连标题一起复制，父子看起来像「同一个会话」；它们**各自一条行**。
  const parent = session("fork-parent", {
    firstMessage: "pi的扩展面板有几种",
    modified: "2026-07-02T00:00:00.000Z",
    messageCount: 37,
  });
  const child = session("fork-child", {
    firstMessage: "pi的扩展面板有几种",
    modified: "2026-07-03T00:00:00.000Z",
    messageCount: 37,
    parentSessionId: "fork-parent",
  });
  const other = session("other", { modified: "2026-07-01T00:00:00.000Z" });

  // 平铺：父与 fork 各占一行（按活动排序，子的更近所以在前面）
  assert.deepEqual(
    m.deriveRecentSessions({ sessions: [child, parent, other] }).map((s) => s.id),
    ["fork-child", "fork-parent", "other"],
    "fork 子会话必须自己占一行，不能因为父也在列表里就被折叠掉",
  );
  assert.deepEqual(
    m.deriveRecentSessions({ sessions: [child, parent, other], limit: 2 }).map((s) => s.id),
    ["fork-child", "fork-parent"],
    "截断也不改变平铺语义",
  );
  // 置顶同样平铺：父子都置顶 → 两条行；只钉子 → 子自己一条行
  assert.deepEqual(
    m.derivePinnedSessions({ sessions: [parent, child, other], pinnedSessionIds: ["fork-parent", "fork-child"] })
      .map((s) => s.id),
    ["fork-parent", "fork-child"],
    "父子都置顶时各占一行",
  );
  assert.deepEqual(
    m.derivePinnedSessions({ sessions: [parent, child], pinnedSessionIds: ["fork-child"] }).map((s) => s.id),
    ["fork-child"],
    "只钉子会话时它也照常一行",
  );
});
