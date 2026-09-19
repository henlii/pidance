import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { createSessionNavigationStore } = await jiti.import("./session-navigation-store.ts");

function session(id, cwd = "/repo-a", projectRoot = cwd) {
  return { id, cwd, projectRoot };
}

test("A3: A→B 选择后迟到 hydrate 不得覆盖当前 target", () => {
  const store = createSessionNavigationStore({ makeIntentId: () => "i1" });
  store.selectPersisted(session("a", "/repo-a"));
  store.selectPersisted(session("b", "/repo-b"));
  assert.equal(store.applyHydrate(session("a", "/repo-a")), false);
  assert.equal(store.selectedSessionId(), "b");
  assert.equal(store.getState().target.kind, "persisted");
  assert.equal(store.getState().target.sessionId, "b");
});

test("A3: new A→new B 后旧 intent promote 被拒绝", () => {
  let n = 0;
  const store = createSessionNavigationStore({ makeIntentId: () => `i${++n}` });
  store.startNew("/repo-a");
  const first = store.currentIntent();
  store.startNew("/repo-b");
  const second = store.currentIntent();
  assert.ok(first && second && first.id !== second.id);
  assert.equal(store.promote(first.id, session("sid-a", "/repo-a")), false);
  assert.equal(store.promote(second.id, session("sid-b", "/repo-b")), true);
  assert.equal(store.selectedSessionId(), "sid-b");
});

test("A3: 迟到 identity 回写不把已选 persisted 清成 new", () => {
  const store = createSessionNavigationStore({ makeIntentId: () => "i1" });
  store.selectPersisted(session("a", "/repo-a", "/repo-a"));
  const next = store.applyIdentityChange(
    { cwd: "/repo-a", projectRoot: "/repo-a" },
    { cwd: "/other", projectRoot: "/other" },
  );
  assert.equal(next.target.kind, "persisted");
  assert.equal(next.target.sessionId, "a");
});

test("A3: 已选 persisted B 后，迟到 identity A 不得覆盖", () => {
  const store = createSessionNavigationStore({ makeIntentId: () => "late" });
  const seqBefore = store.getState().transitionSeq;
  store.selectPersisted(session("b", "/repo-b", "/repo-b"));
  const next = store.applyIdentityChange(
    { cwd: "/repo-a", projectRoot: "/repo-a" },
    { cwd: null, projectRoot: null },
    seqBefore,
  );
  assert.equal(next.target.kind, "persisted");
  assert.equal(next.target.sessionId, "b");
});

test("A3: 真实切项目才进入 new target", () => {
  const store = createSessionNavigationStore({ makeIntentId: () => "i-new" });
  store.selectPersisted(session("a", "/repo-a"));
  const next = store.applyIdentityChange(
    { cwd: "/repo-b", projectRoot: "/repo-b" },
    { cwd: "/repo-a", projectRoot: "/repo-a" },
  );
  assert.equal(next.target.kind, "new");
  assert.equal(next.target.cwd, "/repo-b");
  assert.equal(store.selectedSessionId(), null);
});

test("A3: URL 恢复在途时身份 hydrate 不得抢跑成 new（深链 ?session= 不被冲掉）", () => {
  const store = createSessionNavigationStore({ makeIntentId: () => "i-race" });
  store.beginUrlRestore("s1");
  const hydrating = store.applyIdentityChange(
    { cwd: "/repo-a", projectRoot: "/repo-a" },
    { cwd: null, projectRoot: null },
  );
  assert.equal(hydrating.target.kind, "none");
  assert.equal(hydrating.urlRestore.kind, "loading");
  store.completeUrlRestore({ found: true, session: session("s1", "/repo-a") });
  assert.equal(store.selectedSessionId(), "s1");
  assert.equal(store.getState().target.kind, "persisted");

  // 恢复落定后，身份变化恢复正常：真实切项目仍进入 new target。
  const switched = store.applyIdentityChange(
    { cwd: "/repo-b", projectRoot: "/repo-b" },
    { cwd: "/repo-a", projectRoot: "/repo-a" },
  );
  assert.equal(switched.target.kind, "new");
  assert.equal(switched.target.cwd, "/repo-b");
});

test("A3/A8: URL 空列表完成恢复为 not-found，网络失败可 retry", () => {
  const store = createSessionNavigationStore();
  store.beginUrlRestore("missing");
  store.completeUrlRestore({ found: false });
  assert.equal(store.getState().urlRestore.kind, "not-found");
  assert.equal(store.getState().urlRestore.sessionId, "missing");

  store.beginUrlRestore("s1");
  store.completeUrlRestore({ error: "network down" });
  assert.equal(store.getState().urlRestore.kind, "error");
  const retryId = store.retryUrlRestore();
  assert.equal(retryId, "s1");
  assert.equal(store.getState().urlRestore.kind, "loading");
});

test("A3: URL 恢复在途时用户主动切工作区仍放行", () => {
  const store = createSessionNavigationStore({ makeIntentId: () => "i-user" });
  store.selectPersisted(session("s1", "/repo-a"));
  store.beginUrlRestore("s2");
  assert.equal(store.getState().urlRestore.kind, "loading");
  const switched = store.applyIdentityChange(
    { cwd: "/repo-b", projectRoot: "/repo-b" },
    { cwd: "/repo-a", projectRoot: "/repo-a" },
  );
  assert.equal(switched.target.kind, "new");
  assert.equal(switched.target.cwd, "/repo-b");
  assert.equal(switched.urlRestore.kind, "ready");
});
