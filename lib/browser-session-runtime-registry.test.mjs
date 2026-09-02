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
      getCurrentSource: () => ({ close() {}, readyState: 1, onmessage: null, onerror: null }),
      isCurrent: () => true,
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
  const sub = registry.attach("B");
  sub.dispose();
  const subA = registry.attach("A");
  subA.dispose();
  release();
  const receipt = await pending;
  assert.equal(receipt.status, "accepted");
  assert.equal(receipt.sessionId, "A");
  assert.equal(posts.length, 1);
  assert.equal(posts[0].sessionId, "A");
  assert.equal(posts[0].message, "hello A");
  assert.equal(registry.getSnapshot("B")?.messages.length ?? 0, 0);
});

test("A2: rejected 只恢复原 draftKey（含图片），unknown 不自动重发", async () => {
  const restored = [];
  const posts = [];
  const img = { type: "image", data: "QUJD", mimeType: "image/png" };
  const registry = createBrowserSessionRuntimeRegistry({
    async postPrompt(sessionId, input) {
      posts.push(input.submissionId);
      return { submissionId: input.submissionId, sessionId, status: "rejected" };
    },
    restoreDraft(draftKey, draft) {
      restored.push({ draftKey, draft });
    },
    createEventStream: () => fakeStream().manager,
  });

  const rejected = await registry.submitPrompt({
    target: { kind: "persisted", sessionId: "A" },
    submissionId: "sub-r",
    message: "from A",
    images: [img],
    draftKey: "A",
  });
  assert.equal(rejected.status, "rejected");
  assert.equal(restored.length, 1);
  assert.equal(restored[0].draftKey, "A");
  assert.equal(restored[0].draft.images.length, 1);

  restored.length = 0;
  posts.length = 0;
  const unknownRegistry = createBrowserSessionRuntimeRegistry({
    async postPrompt() {
      posts.push("x");
      throw new Error("network");
    },
    restoreDraft(draftKey, draft) {
      restored.push({ draftKey, draft });
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

test("A2: rejected/unknown 后 run 结束，可再次发送（不被运行态门禁锁死）", async () => {
  let mode = "rejected";
  let calls = 0;
  const registry = createBrowserSessionRuntimeRegistry({
    async postPrompt(sessionId, input) {
      calls += 1;
      if (mode === "rejected") {
        return { submissionId: input.submissionId, sessionId, status: "rejected" };
      }
      if (mode === "unknown") {
        throw new Error("network");
      }
      return { submissionId: input.submissionId, sessionId, status: "accepted" };
    },
    restoreDraft() {},
    createEventStream: () => fakeStream().manager,
  });

  // rejected：乐观 running 必须随结算结束
  const rejected = await registry.submitPrompt({
    target: { kind: "persisted", sessionId: "A" },
    submissionId: "sub-r",
    message: "from A",
    draftKey: "A",
  });
  assert.equal(rejected.status, "rejected");
  let runState = registry.getRunState("A");
  assert.equal(runState.agentRunning, false, "rejected 后不得保持 running");
  assert.equal(runState.sendInFlight, false);
  assert.equal(runState.completedRunId, runState.promptRunId);

  // rejected 后立即可再发送（同一 session，新的 submission）
  mode = "accepted";
  const retried = await registry.submitPrompt({
    target: { kind: "persisted", sessionId: "A" },
    submissionId: "sub-r2",
    message: "from A again",
    draftKey: "A",
  });
  assert.equal(retried.status, "accepted");
  assert.equal(calls, 2);
  assert.equal(registry.getRunState("A").agentRunning, true, "新 accepted 提交运行中");

  // unknown（POST 抛错）同样结束 running，恢复可发送
  mode = "unknown";
  const unknown = await registry.submitPrompt({
    target: { kind: "persisted", sessionId: "A" },
    submissionId: "sub-u2",
    message: "maybe",
    draftKey: "A",
  });
  assert.equal(unknown.status, "unknown");
  runState = registry.getRunState("A");
  assert.equal(runState.agentRunning, false, "unknown 后不得保持 running");
  assert.equal(runState.sendInFlight, false);
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

  const subA = registry.attach("A");
  await registry.submitPrompt({
    target: { kind: "persisted", sessionId: "A" },
    submissionId: "sub-a",
    message: "stay",
    draftKey: "A",
  });
  subA.dispose();
  registry.applyEvent("A", {
    type: "agent_start",
  });
  registry.applyEvent("A", {
    type: "message_end",
    entryId: "entry-user-1",
    message: { role: "user", content: "stay", timestamp: 1 },
  });
  registry.applyEvent("A", {
    type: "message_end",
    message: { role: "assistant", content: "reply", timestamp: 2 },
    entryId: "entry-asst-1",
  });
  const detached = registry.getSnapshot("A");
  assert.equal(detached.agentRunning, true);
  assert.equal(detached.messages.some((msg) => msg.role === "assistant"), true);

  const attachedSub = registry.attach("A");
  const attached = registry.getSnapshot("A");
  assert.equal(attached.messages.some((msg) => msg.role === "assistant"), true);
  assert.equal(attached.agentRunning, true);
  attachedSub.dispose();
});

test("相同 submissionId 不重复 POST（含并发）", async () => {
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const registry = createBrowserSessionRuntimeRegistry({
    async postPrompt(sessionId, input) {
      calls += 1;
      await gate;
      return { submissionId: input.submissionId, sessionId, status: "accepted" };
    },
    createEventStream: () => fakeStream().manager,
    restoreDraft() {},
  });
  const first = registry.submitPrompt({
    target: { kind: "persisted", sessionId: "A" },
    submissionId: "same",
    message: "hi",
    draftKey: "A",
  });
  const second = registry.submitPrompt({
    target: { kind: "persisted", sessionId: "A" },
    submissionId: "same",
    message: "hi",
    draftKey: "A",
  });
  release();
  const [r1, r2] = await Promise.all([first, second]);
  assert.equal(r1.submissionId, r2.submissionId);
  assert.equal(calls, 1);
});

test("A6: 正文相同、submissionId 不同的两个 prompt 只标记对应 entry 为 persisted", async () => {
  const registry = createBrowserSessionRuntimeRegistry({
    async postPrompt(sessionId, input) {
      return { submissionId: input.submissionId, sessionId, status: "accepted" };
    },
    createEventStream: () => fakeStream().manager,
    restoreDraft() {},
  });
  await registry.submitPrompt({
    target: { kind: "persisted", sessionId: "A" },
    submissionId: "s1",
    message: "same text",
    draftKey: "A",
  });
  await registry.submitPrompt({
    target: { kind: "persisted", sessionId: "A" },
    submissionId: "s2",
    message: "same text",
    draftKey: "A",
  });
  registry.applyEvent("A", {
    type: "message_end",
    entryId: "entry-1",
    message: { role: "user", content: "same text", timestamp: 1 },
  });
  const s1 = registry.getSubmission("A", "s1");
  const s2 = registry.getSubmission("A", "s2");
  assert.equal(s1.status, "persisted");
  assert.equal(s1.entryId, "entry-1");
  assert.equal(s2.status, "accepted");
  // 第二条 user entry 到达时标记第二条
  registry.applyEvent("A", {
    type: "message_end",
    entryId: "entry-2",
    message: { role: "user", content: "same text", timestamp: 2 },
  });
  assert.equal(registry.getSubmission("A", "s2")?.status, "persisted");
  assert.equal(registry.getSubmission("A", "s2")?.entryId, "entry-2");
});

test("Stop 取消在途 POST：abortSubmission 后 promise 结算为 unknown，不重发", async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const posts = [];
  let abortedSignal = null;
  const registry = createBrowserSessionRuntimeRegistry({
    async postPrompt(sessionId, input) {
      posts.push({ ...input, signal: input.signal });
      abortedSignal = input.signal;
      await new Promise((resolve) => {
        input.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      throw new DOMException("aborted", "AbortError");
    },
    createEventStream: () => fakeStream().manager,
    restoreDraft() {},
  });
  const pending = registry.submitPrompt({
    target: { kind: "persisted", sessionId: "A" },
    submissionId: "stop-1",
    message: "go",
    draftKey: "A",
  });
  await new Promise((r) => setTimeout(r, 20));
  const resultPromise = registry.abortSubmission("A", "stop-1");
  const result = await resultPromise;
  assert.equal(result.status, "unknown");
  const receipt = await pending;
  assert.equal(receipt.status, "unknown");
  assert.ok(abortedSignal?.aborted);
  assert.equal(posts.length, 1);
  release?.();
});

test("attach 返回 disposable；旧 handler 在 dispose 后不再被调用", async () => {
  const stream = fakeStream();
  const calls = [];
  const registry = createBrowserSessionRuntimeRegistry({
    async postPrompt(sessionId, input) {
      return { submissionId: input.submissionId, sessionId, status: "accepted" };
    },
    createEventStream: () => stream.manager,
    restoreDraft() {},
  });
  const sub = registry.attach("A", (event) => calls.push(event.type));
  registry.applyEvent("A", { type: "agent_start" });
  sub.dispose();
  registry.applyEvent("A", { type: "agent_end" });
  assert.deepEqual(calls, ["agent_start"]);
});

test("D1/D3 真实接线：mount → send → unmount(switch) → accepted/persisted → reattach", async () => {
  const stream = fakeStream();
  const posts = [];
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const registry = createBrowserSessionRuntimeRegistry({
    async postPrompt(sessionId, input) {
      posts.push(input.submissionId);
      await gate;
      return { submissionId: input.submissionId, sessionId, status: "accepted" };
    },
    createEventStream: () => stream.manager,
    restoreDraft() {},
  });

  // mount A
  const mountA = registry.attach("A", () => {});
  // send（POST 阻塞中）
  const pending = registry.submitPrompt({
    target: { kind: "persisted", sessionId: "A" },
    submissionId: "wire-1",
    message: "wire hello",
    draftKey: "A",
  });
  // unmount A（切到 B）
  mountA.dispose();
  registry.attach("B", () => {});
  // release POST → accepted
  release();
  const receipt = await pending;
  assert.equal(receipt.status, "accepted");
  assert.equal(posts.length, 1);
  // SSE 事件到 A（此时 A 无视图，但 runtime 必须记录）
  registry.applyEvent("A", {
    type: "message_end",
    entryId: "wire-entry-1",
    message: { role: "user", content: "wire hello", timestamp: 1 },
  });
  registry.applyEvent("A", {
    type: "agent_end",
  });
  const snapA = registry.getSnapshot("A");
  assert.equal(
    snapA.submissions.find((sub) => sub.submissionId === "wire-1")?.status,
    "persisted",
  );
  assert.equal(snapA.submissions.find((sub) => sub.submissionId === "wire-1")?.entryId, "wire-entry-1");
  // reattach A：timeline 完整
  const reA = registry.attach("A");
  const reSnap = registry.getSnapshot("A");
  assert.ok(reSnap.messages.some((msg) => msg.role === "user"));
  reA.dispose();
  registry.detach("B", {
    sessionId: "B",
    dispose: () => {
      registry.getSnapshot("B");
    },
  });
});

test("A6: 同一 entryId 重放不会把两条 submission 绑到同一 entry", async () => {
  const registry = createBrowserSessionRuntimeRegistry({
    async postPrompt(sessionId, input) {
      return { submissionId: input.submissionId, sessionId, status: "accepted" };
    },
    createEventStream: () => fakeStream().manager,
    restoreDraft() {},
  });
  await registry.submitPrompt({
    target: { kind: "persisted", sessionId: "A" },
    submissionId: "s1",
    message: "same text",
    draftKey: "A",
  });
  await registry.submitPrompt({
    target: { kind: "persisted", sessionId: "A" },
    submissionId: "s2",
    message: "same text",
    draftKey: "A",
  });
  const event = {
    type: "message_end",
    entryId: "entry-1",
    message: { role: "user", content: "same text", timestamp: 1 },
  };
  registry.applyEvent("A", event);
  registry.applyEvent("A", event);
  assert.equal(registry.getSubmission("A", "s1")?.status, "persisted");
  assert.equal(registry.getSubmission("A", "s1")?.entryId, "entry-1");
  assert.equal(registry.getSubmission("A", "s2")?.status, "accepted");
  assert.equal(registry.getSubmission("A", "s2")?.entryId ?? null, null);
});

test("ensure 失败进入 registry 结算：rejected/unknown 并按 draftKey 恢复图片", async () => {
  const restored = [];
  const img = { type: "image", data: "QUJD", mimeType: "image/png" };
  const registry = createBrowserSessionRuntimeRegistry({
    async postPrompt() {
      throw new Error("should not POST");
    },
    async ensureNewSession() {
      throw new Error("ensure failed");
    },
    createEventStream: () => fakeStream().manager,
    restoreDraft(draftKey, draft) {
      restored.push({ draftKey, draft });
    },
  });
  const result = await registry.submitPrompt({
    target: { kind: "new", intentId: "intent-1", cwd: "/repo" },
    submissionId: "new-1",
    message: "hello",
    images: [img],
    draftKey: "new:/repo",
  });
  assert.equal(result.status, "unknown");
  assert.equal(restored.length, 1);
  assert.equal(restored[0].draftKey, "new:/repo");
  assert.equal(restored[0].draft.images.length, 1);
  assert.equal(registry.getSubmission(`pending:intent-1`, "new-1")?.status, "unknown");
});

test("生产 postPrompt 把 AbortSignal 传给 fetch", async () => {
  const { getOrCreateBrowserSessionRuntimeRegistry, resetBrowserSessionRuntimeRegistryForTests } =
    await jiti.import("./browser-session-runtime-registry.ts");
  resetBrowserSessionRuntimeRegistryForTests();
  const originalFetch = globalThis.fetch;
  let fetchHasSignal = false;
  let abortDuringFetch = false;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.includes("/api/agent/") && !url.includes("/new") && !url.includes("/events")) {
      fetchHasSignal = Boolean(init?.signal);
      await new Promise((resolve, reject) => {
        if (init?.signal?.aborted) {
          reject(new DOMException("aborted", "AbortError"));
          return;
        }
        init?.signal?.addEventListener("abort", () => {
          abortDuringFetch = true;
          reject(new DOMException("aborted", "AbortError"));
        }, { once: true });
      });
    }
    return { ok: true, json: async () => ({}) };
  };
  try {
    const registry = getOrCreateBrowserSessionRuntimeRegistry();
    const pending = registry.submitPrompt({
      target: { kind: "persisted", sessionId: "A" },
      submissionId: "prod-abort",
      message: "go",
      draftKey: "A",
    });
    await new Promise((r) => setTimeout(r, 20));
    const aborted = await registry.abortSubmission("A", "prod-abort");
    const receipt = await pending;
    assert.equal(fetchHasSignal, true);
    assert.equal(abortDuringFetch, true);
    assert.equal(aborted.status, "unknown");
    assert.equal(receipt.status, "unknown");
  } finally {
    globalThis.fetch = originalFetch;
    resetBrowserSessionRuntimeRegistryForTests();
  }
});

test("reattach：subscribe 立即回放当前 snapshot", async () => {
  const registry = createBrowserSessionRuntimeRegistry({
    async postPrompt(sessionId, input) {
      return { submissionId: input.submissionId, sessionId, status: "accepted" };
    },
    createEventStream: () => fakeStream().manager,
    restoreDraft() {},
  });
  await registry.submitPrompt({
    target: { kind: "persisted", sessionId: "A" },
    submissionId: "wire-snap",
    message: "cached",
    draftKey: "A",
  });
  const snaps = [];
  registry.attach("A");
  registry.subscribe("A", (snap) => snaps.push(snap.messages.length));
  assert.ok(snaps[0] >= 1, "subscribe 必须同步回放已有 timeline");
});

test("陈旧 hydrate 不得覆盖较新 live message_end", async () => {
  const registry = createBrowserSessionRuntimeRegistry({
    async postPrompt(sessionId, input) {
      return { submissionId: input.submissionId, sessionId, status: "accepted" };
    },
    createEventStream: () => fakeStream().manager,
    restoreDraft() {},
  });
  const sinceSeq = registry.getSnapshot("A")?.timelineSeq ?? 0;
  registry.applyEvent("A", {
    type: "agent_start",
  });
  registry.applyEvent("A", {
    type: "message_end",
    entryId: "live-1",
    message: { role: "assistant", content: "live reply", timestamp: 2 },
  });
  const applied = registry.hydrate("A", [{ role: "user", content: "stale context", timestamp: 1 }], ["old"], { sinceSeq });
  assert.equal(applied, false);
  const texts = registry.getSnapshot("A").messages.map((msg) => {
    const content = msg.content;
    return typeof content === "string" ? content : "";
  });
  assert.ok(texts.includes("live reply"));
  assert.equal(texts.includes("stale context"), false);
});
test("connected 事件不递增 timelineSeq，初始磁盘 hydrate 仍可应用", async () => {
  const registry = createBrowserSessionRuntimeRegistry({
    async postPrompt() {
      throw new Error("no post");
    },
    createEventStream: () => fakeStream().manager,
    restoreDraft() {},
  });
  const sinceSeq = registry.getSnapshot("A")?.timelineSeq ?? 0;
  registry.applyEvent("A", { type: "connected" });
  registry.applyEvent("A", { type: "agent_start" });
  const applied = registry.hydrate("A", [{ role: "user", content: "history", timestamp: 1 }], ["h-1"], {
    sinceSeq,
  });
  assert.equal(applied, true, "connected/agent_start 不得阻塞初始 hydrate");
  assert.equal(registry.getSnapshot("A").messages.length, 1);
  assert.equal(registry.getSnapshot("A").messages[0].content, "history");
});

test("同 session 乱序 hydrate：旧响应不覆盖新响应", async () => {
  const registry = createBrowserSessionRuntimeRegistry({
    async postPrompt() {
      throw new Error("no post");
    },
    createEventStream: () => fakeStream().manager,
    restoreDraft() {},
  });
  const newer = registry.hydrate("A", [{ role: "user", content: "newer", timestamp: 2 }], ["n-2"], {
    hydrateRequestSeq: 2,
  });
  assert.equal(newer, true);
  const stale = registry.hydrate("A", [{ role: "user", content: "older", timestamp: 1 }], ["o-1"], {
    hydrateRequestSeq: 1,
  });
  assert.equal(stale, false);
  assert.equal(registry.getSnapshot("A").messages[0].content, "newer");
  assert.deepEqual(registry.getSnapshot("A").entryIds, ["n-2"]);
});

test("A→B→A：slot-owned hydrate 请求序号不会因 hook 重新挂载而倒退", () => {
  const registry = createBrowserSessionRuntimeRegistry({
    async postPrompt() {
      throw new Error("no post");
    },
    createEventStream: () => fakeStream().manager,
    restoreDraft() {},
  });
  const first = registry.beginHydrate("A");
  assert.equal(first, 1);
  assert.equal(registry.hydrate("A", [{ role: "user", content: "A-old", timestamp: 1 }], ["a-1"], {
    hydrateRequestSeq: first,
  }), true);
  // A→B 只改变视图订阅，不销毁 A slot；切回 A 应取得 2，而不是从 1 重来。
  registry.attach("B").dispose();
  const second = registry.beginHydrate("A");
  assert.equal(second, 2);
  assert.equal(registry.hydrate("A", [{ role: "user", content: "A-new", timestamp: 2 }], ["a-2"], {
    hydrateRequestSeq: second,
  }), true);
  assert.equal(registry.getSnapshot("A").messages[0].content, "A-new");
});

test("live message_end 同时追加 messages 与 entryIds", async () => {
  const registry = createBrowserSessionRuntimeRegistry({
    async postPrompt(sessionId, input) {
      return { submissionId: input.submissionId, sessionId, status: "accepted" };
    },
    createEventStream: () => fakeStream().manager,
    restoreDraft() {},
  });
  registry.applyEvent("A", { type: "agent_start" });
  registry.applyEvent("A", {
    type: "message_end",
    entryId: "e-1",
    message: { role: "user", content: "hello", timestamp: 1 },
  });
  registry.applyEvent("A", {
    type: "message_end",
    entryId: "e-2",
    message: { role: "assistant", content: "reply", timestamp: 2 },
  });
  const snap = registry.getSnapshot("A");
  assert.deepEqual(snap.entryIds, ["e-1", "e-2"]);
  assert.equal(snap.messages.length, 2);
});

test("生产 submitPrompt 后 user/assistant message_end 的 entryIds 与 messages 平行", async () => {
  const registry = createBrowserSessionRuntimeRegistry({
    async postPrompt(sessionId, input) {
      return { submissionId: input.submissionId, sessionId, status: "accepted" };
    },
    createEventStream: () => fakeStream().manager,
    restoreDraft() {},
  });
  await registry.submitPrompt({
    target: { kind: "persisted", sessionId: "A" },
    submissionId: "production-submit",
    message: "hello",
    draftKey: "A",
  });
  registry.applyEvent("A", {
    type: "message_end",
    entryId: "a1",
    message: { role: "user", content: "hello", timestamp: 1 },
  });
  registry.applyEvent("A", {
    type: "message_end",
    entryId: "a2",
    message: { role: "assistant", content: "reply", timestamp: 2 },
  });
  const snap = registry.getSnapshot("A");
  assert.equal(snap.messages.length, snap.entryIds.length);
  assert.deepEqual(snap.entryIds, ["a1", "a2"]);
  assert.equal(snap.messages[0].entryId, "a1");
  assert.equal(snap.messages[1].entryId, "a2");
});


test("D3：finish claim 由 per-session registry 单飞，完成后释放", async () => {
  const registry = createBrowserSessionRuntimeRegistry({
    async postPrompt(sessionId, input) {
      return { submissionId: input.submissionId, sessionId, status: "accepted" };
    },
    createEventStream: () => fakeStream().manager,
    restoreDraft() {},
  });
  await registry.submitPrompt({
    target: { kind: "persisted", sessionId: "A" },
    submissionId: "finish-1",
    message: "run",
    draftKey: "A",
  });
  const runId = registry.getRunState("A").promptRunId;
  assert.equal(registry.beginRunFinish("A", runId), true);
  assert.equal(registry.beginRunFinish("A", runId), false);
  registry.releaseRunFinish("A", runId);
  assert.equal(registry.getRunState("A").finishingRunId, null);
  assert.equal(registry.beginRunFinish("A", runId), true);
});

test("D3：registry reconcile 使用 slot 的 running/sendInFlight，不用 hook 单槽", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const registry = createBrowserSessionRuntimeRegistry({
    async postPrompt(sessionId, input) {
      await gate;
      return { submissionId: input.submissionId, sessionId, status: "accepted" };
    },
    async getAgentState() {
      return { live: true, activeRun: false, state: { isStreaming: false, isPromptRunning: false, isCompacting: false } };
    },
    createEventStream: () => fakeStream().manager,
    restoreDraft() {},
  });
  const pending = registry.submitPrompt({
    target: { kind: "persisted", sessionId: "A" },
    submissionId: "reconcile-1",
    message: "run",
    draftKey: "A",
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const result = await registry.reconcile("A");
  assert.equal(result.stale, false);
  assert.equal(result.shouldFinish, false, "sendInFlight/active client run prevents false finish");
  assert.equal(result.live, true);
  release();
  await pending;
});
