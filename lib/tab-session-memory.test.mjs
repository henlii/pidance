import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  return import("./tab-session-memory.ts");
}

function fakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
    size: () => map.size,
    raw: map,
  };
}

test("save/load 往返，并只接受像会话 id 的值", async () => {
  const { saveRememberedSessionId, loadRememberedSessionId, TAB_SESSION_STORAGE_KEY } = await loadSubject();
  const storage = fakeStorage();

  saveRememberedSessionId(storage, "01a0d50b-6da1-71fa-84f0");
  assert.equal(loadRememberedSessionId(storage), "01a0d50b-6da1-71fa-84f0");
  assert.equal(storage.raw.get(TAB_SESSION_STORAGE_KEY), "01a0d50b-6da1-71fa-84f0");
});

test("脏值一律当作没记住（空白、内部空白、超长）", async () => {
  const { parseRememberedSessionId } = await loadSubject();

  assert.equal(parseRememberedSessionId(null), null);
  assert.equal(parseRememberedSessionId(""), null);
  assert.equal(parseRememberedSessionId("   "), null);
  assert.equal(parseRememberedSessionId("a b"), null);
  assert.equal(parseRememberedSessionId("x".repeat(129)), null);
  assert.equal(parseRememberedSessionId("  ok-1  "), "ok-1");
});

test("存储抛错不影响导航（隐私模式）", async () => {
  const { loadRememberedSessionId, saveRememberedSessionId, clearRememberedSessionId, syncRememberedSessionFromQuery } = await loadSubject();
  const throwing = {
    getItem: () => { throw new Error("denied"); },
    setItem: () => { throw new Error("denied"); },
    removeItem: () => { throw new Error("denied"); },
  };

  assert.equal(loadRememberedSessionId(throwing), null);
  saveRememberedSessionId(throwing, "s1");
  clearRememberedSessionId(throwing);
  syncRememberedSessionFromQuery("?session=s1", throwing);
  assert.equal(loadRememberedSessionId(null), null);
});

test("无存储时全部是 no-op", async () => {
  const { loadRememberedSessionId, saveRememberedSessionId, clearRememberedSessionId } = await loadSubject();

  assert.equal(loadRememberedSessionId(undefined), null);
  saveRememberedSessionId(undefined, "s1");
  clearRememberedSessionId(undefined);
});

test("按地址栏 query 同步：?session= 记下，其余清掉", async () => {
  const { syncRememberedSessionFromQuery, loadRememberedSessionId } = await loadSubject();
  const storage = fakeStorage();

  syncRememberedSessionFromQuery("?session=abc", storage);
  assert.equal(loadRememberedSessionId(storage), "abc");

  // 编码过的 id 也能解出来
  syncRememberedSessionFromQuery("?session=a%2Fb", storage);
  assert.equal(loadRememberedSessionId(storage), "a/b");

  // 清空会话的场景（新建/删除后回到 "/"）必须把记忆一起清掉，
  // 否则刷新时会去恢复一个用户已经离开的会话。
  syncRememberedSessionFromQuery("/", storage);
  assert.equal(loadRememberedSessionId(storage), null);

  syncRememberedSessionFromQuery("?session=keep", storage);
  syncRememberedSessionFromQuery("?session=", storage);
  assert.equal(loadRememberedSessionId(storage), null);
});

test("浏览器封装：有 window.sessionStorage 时读写它", async () => {
  const { rememberTabSessionId, loadRememberedTabSessionId, forgetRememberedTabSessionId, rememberTabSessionFromQuery } = await loadSubject();
  const storage = fakeStorage();
  globalThis.window = { sessionStorage: storage };
  try {
    rememberTabSessionId("tab-session");
    assert.equal(loadRememberedTabSessionId(), "tab-session");

    rememberTabSessionFromQuery("/");
    assert.equal(loadRememberedTabSessionId(), null);

    rememberTabSessionId("again");
    forgetRememberedTabSessionId();
    assert.equal(loadRememberedTabSessionId(), null);
  } finally {
    delete globalThis.window;
  }
});
