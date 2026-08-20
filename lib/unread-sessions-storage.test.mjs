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
