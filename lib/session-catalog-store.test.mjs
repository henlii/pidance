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

/** 假的 registry 按会话订阅：publish 前登记的监听器会立即收到当前快照（同真实实现）。 */
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

    // 提交结算：被拒/失败，没有 run，也没有任何后续权威快照 → 标记必须自己退出
    registry.publish("a", { agentRunning: false, sendInFlight: false });
    assert.equal(store.getSnapshot().effectiveRunningIds.has("a"), false);
  } finally {
    unlink();
  }
});

test("registry 挂钩不干预仍在跑/仍在提交的标记，并在标记消失后退订", () => {
  const store = createSessionCatalogStore({ now: () => 1_000 });
  const registry = fakeRegistry();
  const unlink = linkStartingMarksToRegistry(store, registry);
  try {
    registry.publish("a", { agentRunning: true, sendInFlight: false });
    store.markStarting("a", 1_000);
    registry.publish("a", { agentRunning: true, sendInFlight: false });
    assert.equal(store.getSnapshot().effectiveRunningIds.has("a"), true, "仍在跑的标记不得被挂钩回收");

    // 正常结束由权威快照规则回收；挂钩随之退订（再次发布不抱错）
    store.applyRunningSnapshot({ runningIds: [], now: 3_000 });
    registry.publish("a", { agentRunning: false, sendInFlight: false });
    assert.equal(store.getSnapshot().effectiveRunningIds.has("a"), false);
  } finally {
    unlink();
  }
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
