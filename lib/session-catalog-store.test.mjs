import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { createSessionCatalogStore } = await jiti.import("./session-catalog-store.ts");

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
