import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const m = await jiti.import("./new-session-intent.ts");

test("createNewSessionIntent：稳定携带 cwd 与 generation", () => {
  const intent = m.createNewSessionIntent("/repo-a", 3, () => "i-1");
  assert.deepEqual(intent, { id: "i-1", cwd: "/repo-a", generation: 3 });
});

test("shouldPromoteSessionCreated：新 intent 后旧结果不选中", () => {
  assert.equal(
    m.shouldPromoteSessionCreated({
      currentIntentId: "b",
      eventIntentId: "a",
      selectedSessionId: null,
      createdSessionId: "sid-a",
    }),
    false,
  );
  assert.equal(
    m.shouldPromoteSessionCreated({
      currentIntentId: "b",
      eventIntentId: "b",
      selectedSessionId: null,
      createdSessionId: "sid-b",
    }),
    true,
  );
  // 已选其它 session 时不覆盖
  assert.equal(
    m.shouldPromoteSessionCreated({
      currentIntentId: null,
      eventIntentId: null,
      selectedSessionId: "other",
      createdSessionId: "sid-a",
    }),
    false,
  );
  // 已选同一 sid 可更新
  assert.equal(
    m.shouldPromoteSessionCreated({
      currentIntentId: "b",
      eventIntentId: "b",
      selectedSessionId: "sid-b",
      createdSessionId: "sid-b",
    }),
    true,
  );
  // 有 current intent 但事件缺 intentId：拒绝
  assert.equal(
    m.shouldPromoteSessionCreated({
      currentIntentId: "b",
      eventIntentId: null,
      selectedSessionId: null,
      createdSessionId: "sid",
    }),
    false,
  );
});

test("shouldApplyHydratedSession：仅匹配 selected id；fork 不要求 active intent", () => {
  assert.equal(
    m.shouldApplyHydratedSession({
      selectedSessionId: "s1",
      hydratedId: "s1",
    }),
    true,
  );
  assert.equal(
    m.shouldApplyHydratedSession({
      selectedSessionId: "s2",
      hydratedId: "s1",
    }),
    false,
  );
  assert.equal(
    m.shouldApplyHydratedSession({
      selectedSessionId: "s1",
      hydratedId: "s1",
      intentId: "a",
      activeIntentId: "b",
    }),
    false,
  );
  // fork 路径：调用方把 activeIntentId 设为与 intentId 同值（或均空），不依赖 new intent
  assert.equal(
    m.shouldApplyHydratedSession({
      selectedSessionId: "forked",
      hydratedId: "forked",
      intentId: null,
      activeIntentId: null,
    }),
    true,
  );
});

test("stale intent 不选中：A 迟到不得 promote 当前 B chat", () => {
  // 用户已在 B intent 空 chat；A 的 ensure 迟到
  assert.equal(
    m.shouldPromoteSessionCreated({
      currentIntentId: "intent-b",
      eventIntentId: "intent-a",
      selectedSessionId: null,
      createdSessionId: "sid-a",
    }),
    false,
  );
  // 用户已选中 B 的真实 sid；A 更不得覆盖
  assert.equal(
    m.shouldPromoteSessionCreated({
      currentIntentId: "intent-b",
      eventIntentId: "intent-a",
      selectedSessionId: "sid-b",
      createdSessionId: "sid-a",
    }),
    false,
  );
});

test("pendingSessionId：占位 id 可识别，与真实 uuid 区分", () => {
  const id = m.pendingSessionId("intent-1");
  assert.equal(id, "pending:intent-1");
  assert.equal(m.isPendingSessionId(id), true);
  assert.equal(m.isPendingSessionId("019fefba-b58e-7a9b-919c-8b4555b36ec4"), false);
});
