import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);

function makeMemoryStorage(initial = {}) {
  /** @type {Map<string, string>} */
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem(key) {
      return map.has(key) ? map.get(key) : null;
    },
    setItem(key, value) {
      map.set(key, String(value));
    },
    removeItem(key) {
      map.delete(key);
    },
  };
}

test("unread：读取规范键", async () => {
  const {
    loadUnreadSessionIdsFromStorage,
    UNREAD_SESSIONS_STORAGE_KEY,
  } = await jiti.import("./unread-sessions-storage.ts");
  const storage = makeMemoryStorage({
    [UNREAD_SESSIONS_STORAGE_KEY]: JSON.stringify(["a", "b"]),
  });
  assert.deepEqual([...loadUnreadSessionIdsFromStorage(storage)].sort(), ["a", "b"]);
});

test("unread：缺失或损坏输入回退空集合", async () => {
  const { loadUnreadSessionIdsFromStorage, UNREAD_SESSIONS_STORAGE_KEY } = await jiti.import("./unread-sessions-storage.ts");
  assert.deepEqual([...loadUnreadSessionIdsFromStorage(makeMemoryStorage())], []);
  const storage = makeMemoryStorage({ [UNREAD_SESSIONS_STORAGE_KEY]: "{not-json" });
  assert.deepEqual([...loadUnreadSessionIdsFromStorage(storage)], []);
});

test("unread：完成后先标记；当前显示会话立刻视为已查看", async () => {
  const { applyRunningUnreadTransition } = await jiti.import("./unread-sessions-storage.ts");
  const prev = new Set();
  const previousRunning = new Set(["cur", "bg"]);
  const currentRunning = new Set();
  const next = applyRunningUnreadTransition(prev, previousRunning, currentRunning, "cur");
  assert.deepEqual([...next].sort(), ["bg"]);
});

test("unread：无 running 变化时返回原集合", async () => {
  const { applyRunningUnreadTransition } = await jiti.import("./unread-sessions-storage.ts");
  const prev = new Set(["a"]);
  const running = new Set(["r"]);
  const next = applyRunningUnreadTransition(prev, running, running, "a");
  assert.equal(next, prev);
});

test("unread 时钟：completedAt 新于 readAt 才未读；合并取较新时间", async () => {
  const {
    parseUnreadSessionState,
    mergeUnreadSessionState,
    unreadIdsFromState,
    markSessionRead,
    applyRunningUnreadStateTransition,
  } = await jiti.import("./unread-sessions-storage.ts");
  const a = parseUnreadSessionState({ completedAt: { x: "2026-01-01T00:00:00.000Z" }, readAt: {} });
  const b = parseUnreadSessionState({ completedAt: { y: "2026-01-02T00:00:00.000Z" }, readAt: { x: "2026-01-01T01:00:00.000Z" } });
  const merged = mergeUnreadSessionState(a, b);
  assert.deepEqual([...unreadIdsFromState(merged)].sort(), ["y"]);
  const reread = markSessionRead(merged, "y", "2026-01-03T00:00:00.000Z");
  assert.equal(unreadIdsFromState(reread).has("y"), false);
  const afterRun = applyRunningUnreadStateTransition(
    parseUnreadSessionState({}),
    new Set(["cur", "bg"]),
    new Set(),
    "cur",
    "2026-01-04T00:00:00.000Z",
  );
  assert.deepEqual([...unreadIdsFromState(afterRun)].sort(), ["bg"]);
});

test("unread：局部 optimistic running 消失不生成完成标记", async () => {
  const {
    applyRunningUnreadStateTransition,
    parseUnreadSessionState,
    unreadIdsFromState,
  } = await jiti.import("./unread-sessions-storage.ts");
  const state = parseUnreadSessionState({});
  const authoritativeRunning = new Set(["session-a"]);

  const afterLocalSwitch = applyRunningUnreadStateTransition(
    state,
    authoritativeRunning,
    authoritativeRunning,
    "session-b",
    "2026-01-05T00:00:00.000Z",
  );
  assert.equal(unreadIdsFromState(afterLocalSwitch).has("session-a"), false);

  const afterAuthoritativeCompletion = applyRunningUnreadStateTransition(
    afterLocalSwitch,
    authoritativeRunning,
    new Set(),
    "session-b",
    "2026-01-05T00:01:00.000Z",
  );
  assert.equal(unreadIdsFromState(afterAuthoritativeCompletion).has("session-a"), true);
});

test("running 恢复：过期或非最新请求不得覆盖较新的快照", async () => {
  const { shouldApplyRunningReconciliation } = await jiti.import("./unread-sessions-storage.ts");
  assert.equal(shouldApplyRunningReconciliation(4, 5, 2, 2), false);
  assert.equal(shouldApplyRunningReconciliation(5, 5, 1, 2), false);
  assert.equal(shouldApplyRunningReconciliation(5, 5, 2, 2), true);
});

// ── #65：未读改跨端 —— 本地缓存时钟 + 旧 id 列表迁移 ─────────────────────────

test("#65 本地缓存时钟：读写往返，读的是 {completedAt, readAt}", async () => {
  const m = await jiti.import("./unread-sessions-storage.ts");
  const storage = makeMemoryStorage();
  const clock = { completedAt: { a: "2026-09-21T10:00:00.000Z" }, readAt: { b: "2026-09-21T11:00:00.000Z" } };
  m.saveUnreadSessionClock(storage, clock);
  assert.deepEqual(m.loadUnreadSessionClock(storage), clock);
});

test("#65 旧 id 列表迁移：迁成「极早的 completedAt」，任何真实 readAt 都会把它变成已读", async () => {
  const m = await jiti.import("./unread-sessions-storage.ts");
  const storage = makeMemoryStorage({ [m.UNREAD_SESSIONS_STORAGE_KEY]: JSON.stringify(["old-1", "old-2"]) });
  const migrated = m.loadUnreadSessionClock(storage);
  assert.deepEqual(Object.keys(migrated.completedAt).sort(), ["old-1", "old-2"]);
  assert.deepEqual(migrated.readAt, {});
  // 迁移后仍是未读（保持「列表里 = 未读」的旧语义）
  assert.deepEqual([...m.unreadIdsFromState(migrated)].sort(), ["old-1", "old-2"]);
  // 另一台设备之后读过（readAt 是真实时间）→ 不再未读；若迁移用「迁移时刻」，这里会重新变未读
  const otherDevice = { completedAt: {}, readAt: { "old-1": new Date().toISOString() } };
  const merged = m.mergeUnreadSessionState(migrated, otherDevice);
  assert.deepEqual([...m.unreadIdsFromState(merged)], ["old-2"]);
});

test("#65 跨端已读：远端 readAt 新于本地 completedAt 即已读；损坏输入安全回退", async () => {
  const m = await jiti.import("./unread-sessions-storage.ts");
  const corrupted = makeMemoryStorage({ [m.UNREAD_SESSION_CLOCK_STORAGE_KEY]: "{oops" });
  assert.deepEqual(m.loadUnreadSessionClock(corrupted), { completedAt: {}, readAt: {} });
  const local = { completedAt: { s1: "2026-09-21T10:00:00.000Z" }, readAt: {} };
  const remoteRead = { completedAt: {}, readAt: { s1: "2026-09-21T10:00:01.000Z" } };
  assert.equal(m.unreadIdsFromState(m.mergeUnreadSessionState(local, remoteRead)).size, 0, "另一端读过仍显示未读");
  const remoteOlder = { completedAt: {}, readAt: { s1: "2026-09-21T09:00:00.000Z" } };
  assert.deepEqual([...m.unreadIdsFromState(m.mergeUnreadSessionState(local, remoteOlder))], ["s1"], "早于完成时刻的 readAt 不该算已读");
});
