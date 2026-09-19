import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { createSessionCatalogStore, linkStartingMarksToRegistry } = await jiti.import("./session-catalog-store.ts");

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

test("A5: 两个本地 starting 会话都保留 running", () => {
  const store = createSessionCatalogStore({ now: () => 1000 });
  store.markStarting("a");
  store.markStarting("b");
  const snap = store.getSnapshot();
  assert.equal(snap.startingIds.has("a"), true);
  assert.equal(snap.startingIds.has("b"), true);
  assert.equal(snap.effectiveRunningIds.has("a"), true);
  assert.equal(snap.effectiveRunningIds.has("b"), true);
});

test("切走会话后 run 结束：乐观 starting 标记不得残留（列表不再显示运行中）", () => {
  const store = createSessionCatalogStore({ now: () => 1_000 });
  // 打开一个服务端已在跑的会话：chat 上报 agentRunning → 本地乐观标记
  store.applyRunningSnapshot({ runningIds: ["a"], runningStartedAt: { a: 100 }, now: 2_000 });
  store.markStarting("a", 2_000);
  assert.equal(store.getSnapshot().effectiveRunningIds.has("a"), true);

  // run 结束：权威快照不再含 a，本地也没有在途 send → 标记必须回收
  store.applyRunningSnapshot({ runningIds: [], now: 40_000 });
  const snap = store.getSnapshot();
  assert.equal(snap.startingIds.has("a"), false);
  assert.equal(snap.effectiveRunningIds.has("a"), false);
  assert.equal(snap.runningStartedAt.has("a"), false, "回收标记时同时清掉计时播种");
});

test("发送窗口：本地 send 在途时乐观标记跨过快照未含它的时刻", () => {
  const store = createSessionCatalogStore({ now: () => 1_000 });
  store.markStarting("a", 1_000);
  // 唤醒/提交期间（send 在途）：服务端快照尚未含 a，不得闪没
  store.applyRunningSnapshot({ runningIds: [], localInFlightIds: ["a"], now: 1_500 });
  assert.equal(store.getSnapshot().effectiveRunningIds.has("a"), true);

  // 服务端确认在跑：徽标交给 runningIds，乐观标记退出
  store.applyRunningSnapshot({ runningIds: ["a"], runningStartedAt: { a: 1_600 }, now: 2_000 });
  let snap = store.getSnapshot();
  assert.equal(snap.startingIds.has("a"), false);
  assert.equal(snap.effectiveRunningIds.has("a"), true);

  // run 结束 → 运行中消失
  store.applyRunningSnapshot({ runningIds: [], now: 30_000 });
  snap = store.getSnapshot();
  assert.equal(snap.effectiveRunningIds.has("a"), false);
});

test("回收未被服务端确认的乐观标记不得产生未读", () => {
  const store = createSessionCatalogStore({ now: () => 1_000 });
  // 发送在途：chat 上报 agentRunning → 乐观标记（服务端从未报告在跑）
  store.markStarting("a", 1_000);
  store.applyRunningSnapshot({ runningIds: [], now: 2_000 });
  const snap = store.getSnapshot("b");
  assert.equal(snap.effectiveRunningIds.has("a"), false);
  assert.equal(snap.unreadIds.has("a"), false, "从未确认在跑的标记不得当成跑完一轮");
});

test("服务端确认过的 run 结束后产生未读：当前会话不标未读", () => {
  const store = createSessionCatalogStore({ now: () => 1_000 });
  store.applyRunningSnapshot({ runningIds: ["a"], runningStartedAt: { a: 900 }, selectedSessionId: "b", now: 1_000 });
  store.applyRunningSnapshot({ runningIds: [], selectedSessionId: "b", now: 5_000 });
  assert.equal(store.getSnapshot("b").unreadIds.has("a"), true);

  const selected = createSessionCatalogStore({ now: () => 1_000 });
  selected.applyRunningSnapshot({ runningIds: ["a"], runningStartedAt: { a: 900 }, selectedSessionId: "a", now: 1_000 });
  selected.applyRunningSnapshot({ runningIds: [], selectedSessionId: "a", now: 5_000 });
  assert.equal(selected.getSnapshot("a").unreadIds.has("a"), false, "当前显示的会话完成不标未读");
});

/** 假的 registry 按会话订阅：publish/订阅时立即给监听器当前快照（同真实实现）。 */
function fakeRegistry() {
  const listeners = new Map();
  const snapshots = new Map();
  return {
    subscribe(sessionId, listener) {
      const set = listeners.get(sessionId) ?? new Set();
      set.add(listener);
      listeners.set(sessionId, set);
      const snapshot = snapshots.get(sessionId) ?? { sessionId, agentRunning: false, sendInFlight: false };
      listener(snapshot);
      return () => set.delete(listener);
    },
    publish(sessionId, snapshot) {
      snapshots.set(sessionId, { sessionId, ...snapshot });
      for (const listener of listeners.get(sessionId) ?? []) listener(snapshots.get(sessionId));
    },
    listenerCount(sessionId) {
      return listeners.get(sessionId)?.size ?? 0;
    },
    totalListeners() {
      return [...listeners.values()].reduce((sum, set) => sum + set.size, 0);
    },
  };
}

test("提交结算但服务端从未确认在跑：registry 挂钩立即回收乐观标记", () => {
  const store = createSessionCatalogStore({ now: () => 1_000 });
  const registry = fakeRegistry();
  const unlink = linkStartingMarksToRegistry(store, registry);
  try {
    // 真实顺序：registry 先置位乐观 run（send 在途），chat 才上报标记
    registry.publish("a", { agentRunning: true, sendInFlight: true });
    store.markStarting("a", 1_000);
    assert.equal(store.getSnapshot().effectiveRunningIds.has("a"), true);
    assert.equal(registry.listenerCount("a"), 1);

    // 提交结算：被拒/失败，没有 run，也没有任何后续权威快照 → 标记必须自己退出
    registry.publish("a", { agentRunning: false, sendInFlight: false });
    assert.equal(store.getSnapshot().effectiveRunningIds.has("a"), false);

    // 退订由 store 变更驱动：标记消失后监听器不得残留
    assert.equal(registry.listenerCount("a"), 0, "标记回收后监听器未退订");
  } finally {
    unlink();
  }
});

test("订阅首个快照已空闲时立即回收标记且不泄漏监听器", () => {
  const store = createSessionCatalogStore({ now: () => 1_000 });
  const registry = fakeRegistry();
  // 钩子先接上；registry 尚未置位（首个快照空闲）时登记标记
  const unlink = linkStartingMarksToRegistry(store, registry);
  try {
    store.markStarting("a", 1_000);
    assert.equal(store.getSnapshot().effectiveRunningIds.has("a"), false, "本地无 run 的标记应立即回收");
    assert.equal(registry.totalListeners(), 0, "同步重入不得留下失效订阅");
    assert.equal(store.getSnapshot().runningStartedAt.has("a"), false, "回收标记同步清掉计时播种");
  } finally {
    unlink();
  }
});

test("空快照时提交仍在途，随后结算失败且无后续快照：标记/计时/监听/未读均清理", async () => {
  const store = createSessionCatalogStore({ now: () => 1_000 });
  const registry = fakeRegistry();
  const unlink = linkStartingMarksToRegistry(store, registry);
  try {
    registry.publish("a", { agentRunning: true, sendInFlight: true });
    store.markStarting("a", 1_000);

    // 提交（POST）仍待决：用一个真正未结算的 Promise 代表在途，结算时才发布 registry 状态
    let settleSubmission;
    let settled = false;
    const submission = new Promise((resolve) => { settleSubmission = resolve; });
    void submission.then(() => {
      settled = true;
      registry.publish("a", { agentRunning: false, sendInFlight: false });
    });

    // 权威空快照到达时提交仍在途 → 标记保留（发送窗口）
    store.applyRunningSnapshot({ runningIds: [], localInFlightIds: ["a"], now: 1_500 });
    assert.equal(store.getSnapshot().effectiveRunningIds.has("a"), true);
    assert.equal(settled, false, "提交不得在结算前提前结清");
    assert.equal(registry.listenerCount("a"), 1);

    // 结算：被拒/失败，没有 run，也没有后续全局快照
    settleSubmission();
    await submission;

    const snap = store.getSnapshot("b");
    assert.equal(settled, true);
    assert.equal(snap.effectiveRunningIds.has("a"), false);
    assert.equal(snap.startingIds.has("a"), false);
    assert.equal(snap.runningStartedAt.has("a"), false, "回收标记时同步退出计时播种");
    assert.equal(snap.unreadIds.has("a"), false, "失败提交不得产生未读");
    assert.equal(registry.totalListeners(), 0);

    // 同一 id 再次启动：计时使用新起点，不复用上一轮
    registry.publish("a", { agentRunning: true, sendInFlight: true });
    store.markStarting("a", 9_000);
    assert.equal(store.getSnapshot().runningStartedAt.get("a"), 9_000);
  } finally {
    unlink();
  }
});

test("subscribe 同步回调期间同 id 被重新登记：只保留一条订阅", () => {
  const store = createSessionCatalogStore({ now: () => 1_000 });
  const registry = fakeRegistry();
  // 挂钩之前先挂一个监听器：标记被回收的同一个 emit 里立刻重新登记同 id
  // （模拟「同步首个快照回收标记」期间用户马上又发了一次）。
  let rearm = false;
  store.subscribe(() => {
    if (!rearm || store.getState().startingIds.size > 0) return;
    rearm = false;
    store.markStarting("a", 2_000);
  });
  const unlink = linkStartingMarksToRegistry(store, registry);
  try {
    rearm = true;
    store.markStarting("a", 1_000);
    const snap = store.getSnapshot();
    assert.equal(snap.effectiveRunningIds.has("a"), true, "重新登记的标记必须保留");
    assert.equal(snap.runningStartedAt.get("a"), 2_000, "重新登记应使用新计时起点");
    assert.equal(registry.listenerCount("a"), 1, "旧订阅不得覆盖或泄漏新订阅");
  } finally {
    unlink();
  }
  assert.equal(registry.totalListeners(), 0);
});

test("registry 挂钩不干预仍在跑/仍在提交的标记，并在 unlink 后退订", () => {
  const store = createSessionCatalogStore({ now: () => 1_000 });
  const registry = fakeRegistry();
  const unlink = linkStartingMarksToRegistry(store, registry);
  registry.publish("a", { agentRunning: true, sendInFlight: false });
  store.markStarting("a", 1_000);
  registry.publish("a", { agentRunning: true, sendInFlight: false });
  assert.equal(store.getSnapshot().effectiveRunningIds.has("a"), true, "仍在跑的标记不得被挂钩回收");
  assert.equal(registry.listenerCount("a"), 1);

  // 正常结束由权威快照规则回收；挂钩随之退订（再次发布不抱错）
  store.applyRunningSnapshot({ runningIds: [], now: 3_000 });
  registry.publish("a", { agentRunning: false, sendInFlight: false });
  assert.equal(store.getSnapshot().effectiveRunningIds.has("a"), false);
  assert.equal(registry.listenerCount("a"), 0);

  unlink();
  unlink(); // 幂等
  assert.equal(registry.totalListeners(), 0);
  store.markStarting("a", 4_000);
  assert.equal(registry.totalListeners(), 0, "unlink 后不得再订阅");
});

test("A5: 旧 run 完成后紧接新 run 仍按 startedAt 生成未读，running 优先", () => {
  const store = createSessionCatalogStore({ now: () => 1_000 });
  store.applyRunningSnapshot({
    runningIds: ["a"],
    runningStartedAt: { a: 100 },
    selectedSessionId: "b",
    now: 1_000,
  });
  store.applyRunningSnapshot({
    runningIds: ["a"],
    runningStartedAt: { a: 500 },
    selectedSessionId: "b",
    now: 2_000,
  });
  let snap = store.getSnapshot("b");
  assert.equal(snap.effectiveRunningIds.has("a"), true);
  assert.equal(snap.unreadIds.has("a"), false, "running 优先，不显示未读点");

  store.applyRunningSnapshot({
    runningIds: [],
    selectedSessionId: "b",
    now: 3_000,
  });
  snap = store.getSnapshot("b");
  assert.equal(snap.unreadIds.has("a"), true);
});

test("A8: 归档/删除后 pending 被权威回收，不复活", () => {
  const store = createSessionCatalogStore();
  store.upsertPending(session("p1"));
  store.applyServerList({
    sessions: [session("s1")],
    archivedSessions: [session("p1")],
    archivedCount: 1,
  });
  let snap = store.getSnapshot();
  assert.equal(snap.sessions.some((item) => item.id === "p1"), false);
  assert.equal(store.getState().pendingById.has("p1"), false);

  store.upsertPending(session("p1"));
  store.markDeleted("p1");
  store.applyServerList({
    sessions: [session("s1")],
    archivedSessions: [],
  });
  snap = store.getSnapshot();
  assert.equal(snap.sessions.some((item) => item.id === "p1"), false);
});

test("列表失败保留已有会话并标记 error，不永久空白", () => {
  const store = createSessionCatalogStore();
  store.applyServerList({ sessions: [session("s1")] });
  store.applyListError("HTTP 500");
  const snap = store.getSnapshot();
  assert.equal(snap.listStatus, "error");
  assert.equal(snap.sessions[0].id, "s1");
  assert.equal(snap.error, "HTTP 500");
});

test("A8: 首次列表失败也结束恢复判定", () => {
  const store = createSessionCatalogStore();
  store.applyListError("network");
  const snap = store.getSnapshot();
  assert.equal(snap.serverListLoaded, true);
  assert.equal(snap.listStatus, "error");
  assert.equal(snap.error, "network");
});

test("A8: 缓存预览列表不算权威列表（URL 恢复不得拿旧快照判 not-found）", () => {
  const store = createSessionCatalogStore();
  store.applyServerList({ sessions: [session("old")], provisional: true });
  let snap = store.getSnapshot();
  assert.equal(snap.serverListLoaded, false);
  assert.equal(snap.sessions.length, 1); // 旧缓存仍先亮 UI

  store.applyServerList({ sessions: [session("old"), session("fresh")] });
  snap = store.getSnapshot();
  assert.equal(snap.serverListLoaded, true);
  assert.equal(snap.sessions.length, 2);
});

test("A8: 缓存预览不得把不在快照里的 pending 会话回收掉", () => {
  const store = createSessionCatalogStore();
  store.upsertPending(session("local-new"));
  store.applyServerList({ sessions: [session("old")], provisional: true });
  const snap = store.getSnapshot();
  assert.ok(snap.sessions.some((item) => item.id === "local-new"));
  assert.equal(snap.serverListLoaded, false);
});
