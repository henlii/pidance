import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { createBrowserSessionRuntimeRegistry } = await jiti.import("./browser-session-runtime-registry.ts");

function fakeStream() {
  const handlers = [];
  return {
    manager: {
      connect: async () => ({ status: "connected", source: { close() {}, readyState: 1, onmessage: null, onerror: null } }),
      ensureConnected: async (_id, onEvent) => {
        handlers.push(onEvent);
      },
      close() {},
      getCurrentSource: () => null,
    },
    emit(event) {
      for (const handler of handlers) handler(event);
    },
  };
}

test("A1: 发送后立即 detach 仍恰好 POST 一次到原会话", async () => {
  const posts = [];
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const stream = fakeStream();
  const registry = createBrowserSessionRuntimeRegistry({
    async postPrompt(sessionId, input) {
      posts.push({ sessionId, ...input });
      await gate;
      return { submissionId: input.submissionId, sessionId, status: "accepted" };
    },
    createEventStream: () => stream.manager,
    restoreDraft() {},
  });

  const pending = registry.submitPrompt({
    target: { kind: "persisted", sessionId: "A" },
    submissionId: "sub-1",
    message: "hello A",
    draftKey: "A",
  });
  registry.attach("B");
  registry.detach("A");
  release();
  const receipt = await pending;
  assert.equal(receipt.status, "accepted");
  assert.equal(receipt.sessionId, "A");
  assert.equal(posts.length, 1);
  assert.equal(posts[0].sessionId, "A");
  assert.equal(posts[0].message, "hello A");
  assert.equal(registry.getSnapshot("B")?.messages.length ?? 0, 0);
});

test("A2: rejected 只恢复原 draftKey，unknown 不自动重发", async () => {
  const restored = [];
  const posts = [];
  const registry = createBrowserSessionRuntimeRegistry({
    async postPrompt(sessionId, input) {
      posts.push(input.submissionId);
      return { submissionId: input.submissionId, sessionId, status: "rejected" };
    },
    restoreDraft(draftKey, message) {
      restored.push({ draftKey, message });
    },
    createEventStream: () => fakeStream().manager,
  });

  const rejected = await registry.submitPrompt({
    target: { kind: "persisted", sessionId: "A" },
    submissionId: "sub-r",
    message: "from A",
    draftKey: "A",
  });
  assert.equal(rejected.status, "rejected");
  assert.deepEqual(restored, [{ draftKey: "A", message: "from A" }]);

  restored.length = 0;
  posts.length = 0;
  const unknownRegistry = createBrowserSessionRuntimeRegistry({
    async postPrompt() {
      posts.push("x");
      throw new Error("network");
    },
    restoreDraft(draftKey, message) {
      restored.push({ draftKey, message });
    },
    createEventStream: () => fakeStream().manager,
  });
  const unknown = await unknownRegistry.submitPrompt({
    target: { kind: "persisted", sessionId: "A" },
    submissionId: "sub-u",
    message: "maybe",
    draftKey: "A",
  });
  assert.equal(unknown.status, "unknown");
  assert.equal(posts.length, 1);
  assert.equal(unknownRegistry.getSubmission("A", "sub-u")?.status, "unknown");
});

test("A4: detach 不 abort；事件仍写入原 runtime；reattach 恢复 timeline", async () => {
  const stream = fakeStream();
  const registry = createBrowserSessionRuntimeRegistry({
    async postPrompt(sessionId, input) {
      return { submissionId: input.submissionId, sessionId, status: "accepted" };
    },
    createEventStream: () => stream.manager,
    restoreDraft() {},
  });

  registry.attach("A");
  await registry.submitPrompt({
    target: { kind: "persisted", sessionId: "A" },
    submissionId: "sub-a",
    message: "stay",
    draftKey: "A",
  });
  registry.detach("A");
  registry.applyEvent("A", {
    type: "agent_start",
  });
  registry.applyEvent("A", {
    type: "message_end",
    message: { role: "assistant", content: "reply", timestamp: 1 },
  });
  const detached = registry.getSnapshot("A");
  assert.equal(detached.agentRunning, true);
  assert.equal(detached.messages.some((msg) => msg.role === "assistant"), true);

  const attached = registry.attach("A");
  assert.equal(attached.messages.some((msg) => msg.role === "assistant"), true);
  assert.equal(attached.agentRunning, true);
});

test("相同 submissionId 不重复 POST", async () => {
  let calls = 0;
  const registry = createBrowserSessionRuntimeRegistry({
    async postPrompt(sessionId, input) {
      calls += 1;
      return { submissionId: input.submissionId, sessionId, status: "accepted" };
    },
    createEventStream: () => fakeStream().manager,
    restoreDraft() {},
  });
  const first = await registry.submitPrompt({
    target: { kind: "persisted", sessionId: "A" },
    submissionId: "same",
    message: "hi",
    draftKey: "A",
  });
  const second = await registry.submitPrompt({
    target: { kind: "persisted", sessionId: "A" },
    submissionId: "same",
    message: "hi",
    draftKey: "A",
  });
  assert.equal(first.submissionId, second.submissionId);
  assert.equal(calls, 1);
});
