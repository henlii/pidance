import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  resolveSubmitTarget,
  resetChatTargetRefs,
  captureChatTargetToken,
  chatTargetTokenMatches,
} = await jiti.import("./chat-submit-target.ts");

test("A1/A3: A→new 不得把上一会话 id 当作提交目标", () => {
  const target = resolveSubmitTarget({
    isNew: true,
    intentId: "intent-b",
    cwd: "/repo",
    persistedSessionId: null,
    ensuredSessionId: null,
  });
  assert.deepEqual(target, { kind: "new", intentId: "intent-b", cwd: "/repo" });
});

test("A1/A3: 新 intent 已 ensure 后复用该 sid，不二次创建", () => {
  const target = resolveSubmitTarget({
    isNew: true,
    intentId: "intent-b",
    cwd: "/repo",
    persistedSessionId: null,
    ensuredSessionId: "sid-from-this-intent",
  });
  assert.deepEqual(target, { kind: "persisted", sessionId: "sid-from-this-intent" });
});

test("A1/A3: 已有会话提交绑定 session?.id，不读残留 ref", () => {
  const target = resolveSubmitTarget({
    isNew: false,
    intentId: null,
    cwd: null,
    persistedSessionId: "session-A",
    ensuredSessionId: "leftover-should-be-ignored",
  });
  assert.deepEqual(target, { kind: "persisted", sessionId: "session-A" });
});

test("new→new：resetChatTargetRefs 清掉上一 intent 的 sid/promote/submitted", () => {
  const refs = {
    sessionId: { current: "sid-from-intent-A" },
    newSessionPromoted: { current: true },
    promptSubmitted: { current: true },
    ensuringNewSession: { current: Promise.resolve("sid-from-intent-A") },
  };
  resetChatTargetRefs(refs, null);
  assert.equal(refs.sessionId.current, null);
  assert.equal(refs.newSessionPromoted.current, false);
  assert.equal(refs.promptSubmitted.current, false);
  assert.equal(refs.ensuringNewSession.current, null);
});

test("A→persisted B：reset 写入 B 的 session id", () => {
  const refs = {
    sessionId: { current: "A" },
    newSessionPromoted: { current: true },
    promptSubmitted: { current: true },
    ensuringNewSession: { current: null },
  };
  resetChatTargetRefs(refs, "B");
  assert.equal(refs.sessionId.current, "B");
  assert.equal(refs.newSessionPromoted.current, false);
  assert.equal(refs.promptSubmitted.current, false);
});

test("A1/A3: new A receipt 在切到 new B 之后不得写回 sid", () => {
  const token = captureChatTargetToken({
    isNew: true,
    intentId: "intent-a",
    persistedSessionId: null,
  });
  resetChatTargetRefs({
    sessionId: { current: null },
    newSessionPromoted: { current: false },
    promptSubmitted: { current: false },
    ensuringNewSession: { current: null },
  }, null);
  const currentAfterSwitch = { intentId: "intent-b", persistedSessionId: null };
  assert.equal(chatTargetTokenMatches(token, currentAfterSwitch), false);
  const refs = { sessionId: { current: null } };
  if (chatTargetTokenMatches(token, currentAfterSwitch)) {
    refs.sessionId.current = "REAL-A";
  }
  assert.equal(refs.sessionId.current, null);
  const next = resolveSubmitTarget({
    isNew: true,
    intentId: "intent-b",
    cwd: "/repo",
    persistedSessionId: null,
    ensuredSessionId: refs.sessionId.current,
  });
  assert.deepEqual(next, { kind: "new", intentId: "intent-b", cwd: "/repo" });
});
