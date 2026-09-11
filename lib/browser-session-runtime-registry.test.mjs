import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { createBrowserSessionRuntimeRegistry } = await jiti.import("./browser-session-runtime-registry.ts");
// 用真实 EventStreamManager 驱动，避免只测到替身的行为。
const { createEventStreamManager } = await jiti.import("./event-stream-manager.ts");

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

test("新会话 ensure 成功后跳过 wake：顺序 ensure → sse → post", async () => {
  const order = [];
  const registry = createBrowserSessionRuntimeRegistry({
    async ensureNewSession(cwd) {
      order.push(`ensure:${cwd}`);
      return "real-new-1";
    },
    async postPrompt(sessionId, input) {
      order.push(`post:${sessionId}:${input.message}`);
      return { submissionId: input.submissionId, sessionId, status: "accepted" };
    },
    wake: async () => { order.push("wake"); },
    createEventStream: () => {
      const stream = fakeStream();
      const original = stream.manager.ensureConnected;
      stream.manager.ensureConnected = async (...args) => {
        order.push("sse");
        return original(...args);
      };
      return stream.manager;
    },
    restoreDraft() {},
  });
  const result = await registry.submitPrompt({
    target: { kind: "new", intentId: "intent-1", cwd: "/repo" },
    submissionId: "new-skip-wake",
    message: "first prompt",
    draftKey: "new:/repo",
  });
  assert.equal(result.status, "accepted");
  // 刚 ensure 的 host 在 startup-hold 保活窗口内必然 live：新会话文件尚未落盘，
  // wake（走磁盘 resolvePath）会 404 而拒发——必须跳过 wake 直接 post。
  assert.deepEqual(order, ["ensure:/repo", "sse", "post:real-new-1:first prompt"]);
});


test("submitPrompt 先 wake 再连接 SSE，冷会话不丢首轮事件", async () => {
  const order = [];
  const registry = createBrowserSessionRuntimeRegistry({
    async postPrompt(sessionId, input) {
      order.push("post");
      return { submissionId: input.submissionId, sessionId, status: "accepted" };
    },
    wake: async () => { order.push("wake"); },
    createEventStream: () => {
      const stream = fakeStream();
      const original = stream.manager.ensureConnected;
      stream.manager.ensureConnected = async (...args) => {
        order.push("sse");
        return original(...args);
      };
      return stream.manager;
    },
    restoreDraft() {},
  });
  const result = await registry.submitPrompt({
    target: { kind: "persisted", sessionId: "cold-submit" },
    submissionId: "cold-submit-1",
    message: "first",
    draftKey: "cold-submit",
  });
  assert.equal(result.status, "accepted");
  assert.deepEqual(order, ["wake", "sse", "post"]);
});

test("打开会话只连接已有 live，不在 attach 阶段 wake", async () => {
  let wakes = 0;
  const registry = createBrowserSessionRuntimeRegistry({
    async postPrompt(sessionId, input) {
      return { submissionId: input.submissionId, sessionId, status: "accepted" };
    },
    wake: async () => { wakes += 1; },
    createEventStream: () => fakeStream().manager,
    restoreDraft() {},
  });
  const subscription = registry.attach("cold-session");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(wakes, 0);
  subscription.dispose();
  registry.ensureEventsConnected("cold-session");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(wakes, 0, "重连冷会话也不得 wake");
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

test("rejected/unknown：未确认的乐观 user 气泡从 timeline 移除", async () => {
  const registry = createBrowserSessionRuntimeRegistry({
    async postPrompt(sessionId, input) {
      return { submissionId: input.submissionId, sessionId, status: "rejected" };
    },
    restoreDraft() {},
    createEventStream: () => fakeStream().manager,
  });
  await registry.submitPrompt({
    target: { kind: "persisted", sessionId: "A" },
    submissionId: "sub-drop",
    message: "ghost",
    draftKey: "A",
  });
  const afterReject = registry.getSnapshot("A");
  assert.equal(afterReject.messages.some((message) => message.role === "user"), false);

  const locked = createBrowserSessionRuntimeRegistry({
    async postPrompt() {
      throw new Error("should not POST after wake lock");
    },
    async wake() {
      throw new Error("Session is locked by another Pidance process (writable host ownership)");
    },
    restoreDraft() {},
    createEventStream: () => fakeStream().manager,
  });
  const result = await locked.submitPrompt({
    target: { kind: "persisted", sessionId: "B" },
    submissionId: "sub-lock",
    message: "locked send",
    draftKey: "B",
  });
  assert.equal(result.status, "unknown");
  assert.match(result.error ?? "", /locked by another/);
  const afterLock = locked.getSnapshot("B");
  assert.equal(afterLock.messages.some((message) => message.role === "user"), false);
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
  assert.equal(applied, "stale", "live 事件期间磁盘快照不得覆盖时间线，但不是被取代");
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
  assert.equal(applied, "applied", "connected/agent_start 不得阻塞初始 hydrate");
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
  assert.equal(newer, "applied");
  const stale = registry.hydrate("A", [{ role: "user", content: "older", timestamp: 1 }], ["o-1"], {
    hydrateRequestSeq: 1,
  });
  assert.equal(stale, "superseded", "更新的响应已落地 → 旧响应整体作废");
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
  }), "applied");
  // A→B 只改变视图订阅，不销毁 A slot；切回 A 应取得 2，而不是从 1 重来。
  registry.attach("B").dispose();
  const second = registry.beginHydrate("A");
  assert.equal(second, 2);
  assert.equal(registry.hydrate("A", [{ role: "user", content: "A-new", timestamp: 2 }], ["a-2"], {
    hydrateRequestSeq: second,
  }), "applied");
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

test("submitPrompt 后、user message_end 之前只有一条乐观消息（无双条）", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const registry = createBrowserSessionRuntimeRegistry({
    async postPrompt() {
      await gate;
      return { submissionId: "single-optimistic", sessionId: "A", status: "accepted" };
    },
    createEventStream: () => fakeStream().manager,
    restoreDraft() {},
  });
  registry.attach("A");
  const pending = registry.submitPrompt({
    target: { kind: "persisted", sessionId: "A" },
    submissionId: "single-optimistic",
    message: "hello",
    draftKey: "A",
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const snap = registry.getSnapshot("A");
  const userCount = snap.messages.filter((msg) => msg.role === "user").length;
  assert.equal(snap.messages.length, 1, "乐观 user 只能出现一次");
  assert.equal(userCount, 1);
  // user message_end 未消费前的乐观槽位为空 entryId
  assert.equal(snap.entryIds[0] ?? "", "");
  release();
  await pending;
});


test("生产 SSE 无 entryId 且 user 文本被插件变换时，原位确认乐观消息不追加第二条", async () => {
  const registry = createBrowserSessionRuntimeRegistry({
    async postPrompt(sessionId, input) {
      return { submissionId: input.submissionId, sessionId, status: "accepted" };
    },
    createEventStream: () => fakeStream().manager,
    restoreDraft() {},
  });
  await registry.submitPrompt({
    target: { kind: "persisted", sessionId: "A" },
    submissionId: "transformed-user",
    message: "original prompt",
    draftKey: "A",
  });
  registry.applyEvent("A", {
    type: "message_end",
    // 生产 projectAgentEvent 不保证携带 entryId
    message: { role: "user", content: "plugin transformed prompt", timestamp: 1 },
  });
  const snap = registry.getSnapshot("A");
  assert.equal(snap.messages.length, 1);
  assert.equal(snap.messages[0].content, "plugin transformed prompt");
  assert.equal(snap.entryIds.length, snap.messages.length);
  assert.equal(registry.getSubmission("A", "transformed-user")?.status, "accepted");
});

test("刷新冷挂载：importRunningRun 把服务端在跑的 run 导入 slot（不重复导入、不清收尾）", async () => {
  const registry = createBrowserSessionRuntimeRegistry({
    async postPrompt(sessionId, input) {
      return { submissionId: input.submissionId, sessionId, status: "accepted" };
    },
    async getAgentState() {
      return { live: true, activeRun: true, state: { isStreaming: false, isPromptRunning: true, isCompacting: false } };
    },
    createEventStream: () => fakeStream().manager,
    restoreDraft() {},
  });
  // 冷 slot：无客户端提交，服务端已在跑。
  assert.equal(registry.getRunState("A")?.agentRunning ?? false, false);
  registry.importRunningRun("A");
  const imported = registry.getRunState("A");
  assert.equal(imported.agentRunning, true);
  assert.equal(imported.completedRunId, null);
  const firstRunId = imported.promptRunId;
  // 重复导入（热路径多次 includeState）不得再把 runId 膨胀。
  registry.importRunningRun("A");
  assert.equal(registry.getRunState("A").promptRunId, firstRunId);
  // 导入后 reconcile 不得误收尾（服务端仍在 promptRunning）。
  const result = await registry.reconcile("A");
  assert.equal(result.shouldFinish, false);
  // 服务端 agent_end 事件正常收尾。
  registry.applyEvent("A", { type: "agent_end" });
  const settled = registry.getRunState("A");
  assert.equal(settled.agentRunning, false);
  assert.equal(settled.completedRunId, firstRunId);
});

test("reconcile：host 已在 run 结束后销毁时，明确 idle 可收口旧 running slot", async () => {
  const registry = createBrowserSessionRuntimeRegistry({
    async postPrompt(sessionId, input) {
      return { submissionId: input.submissionId, sessionId, status: "accepted" };
    },
    async getAgentState() {
      return { live: false, activeRun: false, lockedByOther: false };
    },
    restoreDraft() {},
  });
  registry.importRunningRun("A");
  const result = await registry.reconcile("A");
  assert.equal(result?.live, false);
  assert.equal(result?.shouldFinish, true);
  assert.equal(registry.getRunState("A")?.agentRunning, true, "reconcile 只产出收尾决策，不直接改 slot");
});

test("reconcile：对端仍持有运行锁时不得把 slot 提前收尾", async () => {
  const registry = createBrowserSessionRuntimeRegistry({
    async postPrompt(sessionId, input) {
      return { submissionId: input.submissionId, sessionId, status: "accepted" };
    },
    async getAgentState() {
      return { live: false, activeRun: false, lockedByOther: true };
    },
    restoreDraft() {},
  });
  registry.importRunningRun("A");
  const result = await registry.reconcile("A");
  assert.equal(result?.shouldFinish, false);
});

test("切走后空闲会话关闭 SSE：detach + 兜底 fire → manager.close；在途 run 保活、结算后再关", async () => {
  const streams = new Map();
  const closedIds = [];
  let timerSeq = 0;
  const liveTimers = new Map();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const registry = createBrowserSessionRuntimeRegistry({
    async postPrompt(sessionId, input) {
      await gate;
      return { submissionId: input.submissionId, sessionId, status: "accepted" };
    },
    createEventStream: (sessionId) => {
      const stream = fakeStream();
      const original = stream.manager.close;
      stream.manager.close = () => {
        closedIds.push(sessionId);
        original.call(stream.manager);
      };
      streams.set(sessionId, stream);
      return stream.manager;
    },
    schedule(fn) {
      const id = ++timerSeq;
      liveTimers.set(id, fn);
      return id;
    },
    clearSchedule(id) {
      liveTimers.delete(id);
    },
    restoreDraft() {},
  });
  const fireOne = () => {
    const [id, fn] = [...liveTimers.entries()][0];
    liveTimers.delete(id);
    fn();
  };

  // 打开 A（有 SSE）→ 切到 B（A detach）
  const subA = registry.attach("A");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(streams.has("A"), "attach 建立事件流");
  registry.attach("B").dispose();
  subA.dispose();
  assert.equal(closedIds.length, 0, "detach 不立即关闭");
  assert.ok(liveTimers.size > 0, "detach 后调度兜底关闭");

  // 窗口内切回 A：A 的关闭调度被取消，SSE 保留
  const reA = registry.attach("A");
  assert.equal(closedIds.length, 0, "切回窗口内未关闭");
  reA.dispose();
  // 在途提交（POST 被 gate 挡住）：fire 也不得关闭运行中的 SSE
  const pending = registry.submitPrompt({
    target: { kind: "persisted", sessionId: "A" },
    submissionId: "keep-alive-1",
    message: "running",
    draftKey: "A",
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  while (liveTimers.size > 0) fireOne();
  assert.equal(closedIds.includes("A"), false, "在途 run 期间不得关闭运行中会话的 SSE");

  // 提交结算（仍在后台运行态由 agent_end 收尾）：finally 调度空闲关闭
  release();
  await pending;
  registry.applyEvent("A", { type: "agent_end" });
  while (liveTimers.size > 0) fireOne();
  assert.deepEqual(closedIds.sort(), ["A", "B"], "空闲会话 SSE 被延迟关闭");
  assert.equal(registry.getEventSource("A"), null, "关闭后无残留 source");
});

test("message_end user content 为 blocks 数组时与 string 乐观气泡按文本绑定，不追加双条", async () => {
  const registry = createBrowserSessionRuntimeRegistry({
    async postPrompt(sessionId, input) {
      return { submissionId: input.submissionId, sessionId, status: "accepted" };
    },
    restoreDraft() {},
  });
  await registry.submitPrompt({
    target: { kind: "persisted", sessionId: "S" },
    submissionId: "dup-blocks",
    message: "第一条。",
    draftKey: "S",
  });
  registry.applyEvent("S", { type: "agent_start" });
  registry.applyEvent("S", {
    type: "message_end",
    entryId: "e-1",
    message: { role: "user", content: [{ type: "text", text: "第一条。" }], timestamp: 1 },
  });
  // steer 乐观气泡：content 是 string（appendLocal 路径）。
  registry.appendLocal("S", { role: "user", content: "引导气泡文本。", timestamp: 2, _steerOptimistic: true });
  // Pi 投递 steer：message_end user content 是 blocks 数组（Pi 实际形状）。
  registry.applyEvent("S", {
    type: "message_end",
    entryId: "e-2",
    message: { role: "user", content: [{ type: "text", text: "引导气泡文本。" }], timestamp: 3 },
  });
  const snap = registry.getSnapshot("S");
  assert.equal(snap.messages.length, 2, "投递消息必须与乐观气泡绑定（共 2 条：第一条 + 引导）");
  assert.deepEqual(snap.entryIds, ["e-1", "e-2"]);
});

test("prepend 更旧历史后，迟到的 user 确认仍命中乐观记录（不写错位置）", async () => {
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
    message: "hello",
    draftKey: "A",
  });
  // 用户上滚加载更旧历史：prepend 会把乐观记录的下标整体右移。
  // 旧实现把 submission→下标 存进 map，且 hydrate 后不重映射，
  // 下一步确认会覆盖到 "older" 上。
  registry.hydrate("A", [
    { role: "user", content: "older", timestamp: 0 },
    { role: "assistant", content: "older reply", timestamp: 0 },
  ], ["e1", "e2"], { mode: "prepend" });
  registry.applyEvent("A", {
    type: "message_end",
    message: { role: "user", content: "hello", timestamp: 1 },
  });
  const snap = registry.getSnapshot("A");
  assert.deepEqual(
    snap.messages.map((message) => message.content),
    ["older", "older reply", "hello"],
    "更旧历史不被改写，乐观消息原位确认",
  );
  assert.equal(snap.messages.length, snap.entryIds.length, "messages 与 entryIds 保持平行");
});

test("hydrate(prepend) 从 slot 自身时间线归并，不清空已有消息", () => {
  const registry = createBrowserSessionRuntimeRegistry({
    async postPrompt() { throw new Error("unused"); },
    createEventStream: () => fakeStream().manager,
    restoreDraft() {},
  });
  registry.hydrate("A", [{ role: "user", content: "recent", timestamp: 2 }], ["e2"], { mode: "replace" });
  registry.hydrate("A", [{ role: "user", content: "older", timestamp: 1 }], ["e1"], { mode: "prepend" });
  const snap = registry.getSnapshot("A");
  assert.deepEqual(snap.messages.map((message) => message.content), ["older", "recent"]);
  assert.deepEqual(snap.entryIds, ["e1", "e2"]);
});

test("提交状态单调：SSE 已确认 persisted 后，迟到的 accepted receipt 不回退", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const registry = createBrowserSessionRuntimeRegistry({
    async postPrompt(sessionId, input) {
      await gate;
      return { submissionId: input.submissionId, sessionId, status: "accepted" };
    },
    createEventStream: () => fakeStream().manager,
    restoreDraft() {},
  });
  const pending = registry.submitPrompt({
    target: { kind: "persisted", sessionId: "A" },
    submissionId: "s1",
    message: "hi",
    draftKey: "A",
  });
  registry.applyEvent("A", {
    type: "message_end",
    entryId: "e1",
    message: { role: "user", content: "hi", timestamp: 1 },
  });
  assert.equal(registry.getSubmission("A", "s1")?.status, "persisted");
  release();
  await pending;
  assert.equal(registry.getSubmission("A", "s1")?.status, "persisted", "accepted receipt 不得覆盖 persisted");
  assert.equal(registry.getSubmission("A", "s1")?.entryId, "e1");
});

test("dropLocal 只移除尚无交付证据的本地记录", () => {
  const registry = createBrowserSessionRuntimeRegistry({
    async postPrompt() { throw new Error("unused"); },
    createEventStream: () => fakeStream().manager,
    restoreDraft() {},
  });
  const key = registry.appendLocal("A", { role: "user", content: "steer", timestamp: 1 });
  assert.equal(registry.getSnapshot("A")?.messages.length, 1);
  assert.equal(registry.dropLocal("A", key), true, "未确认的本地记录可回滚");
  assert.equal(registry.getSnapshot("A")?.messages.length, 0);
  assert.equal(registry.dropLocal("A", key), false, "不存在时返回 false");

  registry.hydrate("A", [{ role: "user", content: "disk", timestamp: 2 }], ["e1"], { mode: "replace" });
  assert.equal(registry.dropLocal("A", "e1"), false, "已确认（带 entryId）的记录不得被删除");
  assert.equal(registry.getSnapshot("A")?.messages.length, 1);
});

test("同文两条引导拿到不同 key，各自能独立回滚", () => {
  const registry = createBrowserSessionRuntimeRegistry({
    async postPrompt() { throw new Error("unused"); },
    createEventStream: () => fakeStream().manager,
    restoreDraft() {},
  });
  const first = registry.appendLocal("A", { role: "user", content: "继续", timestamp: 1 });
  const second = registry.appendLocal("A", { role: "user", content: "继续", timestamp: 2 });
  assert.notEqual(first, second, "正文相同也必须拿到不同 key");
  assert.equal(registry.dropLocal("A", second), true);
  assert.deepEqual(
    registry.getSnapshot("A")?.messages.map((message) => message.timestamp),
    [1],
    "只回滚对应那一条",
  );
});

test("迟到 HTTP 失败：已观察到投递时不得回滚消息、running 与草稿", async () => {
  // 旧版这个用例的 postPrompt 实际总是成功（失败开关从未赋值），
  // 因此它没有制造它声称覆盖的故障。这里用可控 deferred 真正 reject。
  let rejectPrompt;
  const drafts = [];
  const registry = createBrowserSessionRuntimeRegistry({
    postPrompt(sessionId, input) {
      return new Promise((_resolve, reject) => {
        rejectPrompt = () => reject(new Error("socket hang up"));
      });
    },
    createEventStream: () => fakeStream().manager,
    restoreDraft(draftKey, draft) { drafts.push({ draftKey, ...draft }); },
  });
  const pending = registry.submitPrompt({
    target: { kind: "persisted", sessionId: "A" },
    submissionId: "s1",
    message: "hi",
    draftKey: "A",
  });
  // SSE 先到：生产 user message_end 不带 entryId，但事件已证明服务端看到了这条消息。
  registry.applyEvent("A", {
    type: "message_end",
    message: { role: "user", content: "hi", timestamp: 1 },
  });
  assert.equal(registry.getSubmission("A", "s1")?.delivered, true);

  rejectPrompt();
  const result = await pending;

  const snap = registry.getSnapshot("A");
  assert.deepEqual(
    snap.messages.map((message) => message.content),
    ["hi"],
    "已投递的消息不得被迟到的 HTTP 错误抹掉",
  );
  assert.equal(snap.agentRunning, true, "已投递时不得把正在跑的 run 标成结束");
  assert.equal(result.status, "accepted", "已投递必须按已投递返回，不能回报失败");
  assert.equal(drafts.length, 0, "已投递时不得恢复草稿（否则文本同时留在输入框与会话里）");
});

test("迟到 HTTP 失败：未观察到投递时才回滚消息与草稿", async () => {
  let rejectPrompt;
  const drafts = [];
  const registry = createBrowserSessionRuntimeRegistry({
    postPrompt() {
      return new Promise((_resolve, reject) => {
        rejectPrompt = () => reject(new Error("socket hang up"));
      });
    },
    createEventStream: () => fakeStream().manager,
    restoreDraft(draftKey, draft) { drafts.push({ draftKey, ...draft }); },
  });
  const pending = registry.submitPrompt({
    target: { kind: "persisted", sessionId: "A" },
    submissionId: "s1",
    message: "hi",
    draftKey: "A",
  });
  rejectPrompt();
  const result = await pending;

  const snap = registry.getSnapshot("A");
  assert.deepEqual(snap.messages, [], "未投递的假气泡必须移除");
  assert.equal(snap.agentRunning, false, "失败后必须收口运行态，不能永久 busy");
  assert.equal(result.status, "unknown");
  assert.equal(drafts.length, 1, "未投递时恢复草稿");
  assert.equal(drafts[0].value, "hi");
});

test("hydrate 已对账后，迟到的 user message_end 不追加重复消息", async () => {
  const registry = createBrowserSessionRuntimeRegistry({
    async postPrompt(sessionId, input) {
      return { submissionId: input.submissionId, sessionId, status: "accepted" };
    },
    createEventStream: () => fakeStream().manager,
    restoreDraft() {},
  });
  const pending = registry.submitPrompt({
    target: { kind: "persisted", sessionId: "A" },
    submissionId: "s1",
    message: "hello",
    draftKey: "A",
  });
  // 磁盘尾页重载已包含这条 user 消息（真实 entryId）。
  registry.hydrate("A", [{ role: "user", content: "hello", timestamp: 1 }], ["e1"], { mode: "replace" });
  registry.applyEvent("A", {
    type: "message_end",
    message: { role: "user", content: "hello", timestamp: 1 },
  });
  await pending;
  const snap = registry.getSnapshot("A");
  assert.deepEqual(snap.entryIds, ["e1"], "不得追加第二条重复消息");
  assert.equal(snap.messages.length, 1);
});

test("非 timeline 事件不重建 messages/entryIds 引用（避免多余重渲染）", () => {
  const registry = createBrowserSessionRuntimeRegistry({
    async postPrompt() { throw new Error("unused"); },
    createEventStream: () => fakeStream().manager,
    restoreDraft() {},
  });
  registry.hydrate("A", [{ role: "user", content: "hi", timestamp: 1 }], ["e1"], { mode: "replace" });
  const before = registry.getSnapshot("A");
  registry.applyEvent("A", { type: "agent_start" });
  registry.applyEvent("A", { type: "message_update", message: { role: "assistant", content: "x" } });
  registry.applyEvent("A", { type: "agent_end" });
  const after = registry.getSnapshot("A");
  assert.equal(after.messages, before.messages, "timeline 未变时 messages 必须保持同一引用");
  assert.equal(after.entryIds, before.entryIds);
});

test("submitPrompt 在首个 await 之前同步置 running（不依赖等待）", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const registry = createBrowserSessionRuntimeRegistry({
    async postPrompt(sessionId, input) {
      await gate;
      return { submissionId: input.submissionId, sessionId, status: "accepted" };
    },
    createEventStream: () => fakeStream().manager,
    restoreDraft() {},
  });
  const pending = registry.submitPrompt({
    target: { kind: "persisted", sessionId: "A" },
    submissionId: "s1",
    message: "hi",
    draftKey: "A",
  });
  // 尚未 await：乐观状态必须已经可见（这是原先独立 beginOptimisticRun 入口的职责，
  // 但独立入口在 target 解析失败时会留下永久 busy）。
  const snap = registry.getSnapshot("A");
  assert.equal(snap.agentRunning, true);
  assert.equal(snap.streamState.isStreaming, true);
  assert.equal(snap.streamState.streamingMessage, null, "无首帧时不得造出空 live 气泡");
  assert.equal(snap.messages.length, 1, "乐观 user 气泡同步入列");
  release();
  await pending;
});

test("rejected 结算收口乐观运行态", async () => {
  const registry = createBrowserSessionRuntimeRegistry({
    async postPrompt(sessionId, input) {
      return { submissionId: input.submissionId, sessionId, status: "rejected" };
    },
    createEventStream: () => fakeStream().manager,
    restoreDraft() {},
  });
  await registry.submitPrompt({
    target: { kind: "persisted", sessionId: "A" },
    submissionId: "s1",
    message: "hi",
    draftKey: "A",
  });
  const snap = registry.getSnapshot("A");
  assert.equal(snap.agentRunning, false);
  assert.equal(snap.streamState.isStreaming, false);
});

test("bash 运行态与 run 态同一快照发布", () => {
  const registry = createBrowserSessionRuntimeRegistry({
    async postPrompt() { throw new Error("unused"); },
    createEventStream: () => fakeStream().manager,
    restoreDraft() {},
  });
  registry.setBashRunning("A", true, { command: "ls", excludeFromContext: false, startedAt: 1 });
  let snap = registry.getSnapshot("A");
  assert.equal(snap.bashRunning, true);
  assert.deepEqual(snap.pendingBash, { command: "ls", excludeFromContext: false, startedAt: 1 });

  registry.setBashRunning("A", false);
  snap = registry.getSnapshot("A");
  assert.equal(snap.bashRunning, false);
  assert.equal(snap.pendingBash, null, "结束后必须清掉 pending 命令");
});

test("abort 同时收口运行态与流式态", () => {
  const registry = createBrowserSessionRuntimeRegistry({
    async postPrompt() { throw new Error("unused"); },
    createEventStream: () => fakeStream().manager,
    restoreDraft() {},
  });
  registry.applyEvent("A", { type: "agent_start" });
  registry.applyEvent("A", { type: "message_update", message: { role: "assistant", content: "x" } });
  assert.equal(registry.getSnapshot("A").streamState.isStreaming, true);
  registry.abort("A");
  const snap = registry.getSnapshot("A");
  assert.equal(snap.agentRunning, false);
  assert.equal(snap.streamState.isStreaming, false);
});

test("abort 且已观察到投递：按已投递返回，不回滚消息与草稿", async () => {
  const drafts = [];
  const registry = createBrowserSessionRuntimeRegistry({
    postPrompt(_sessionId, input) {
      return new Promise((_resolve, reject) => {
        // 模拟 Stop：等待被 abort 后以 AbortError 结算。
        input.signal?.addEventListener("abort", () => {
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        });
      });
    },
    createEventStream: () => fakeStream().manager,
    restoreDraft(draftKey, draft) { drafts.push({ draftKey, ...draft }); },
  });
  const pending = registry.submitPrompt({
    target: { kind: "persisted", sessionId: "A" },
    submissionId: "s1",
    message: "hi",
    draftKey: "A",
  });
  registry.applyEvent("A", {
    type: "message_end",
    entryId: "e1",
    message: { role: "user", content: "hi", timestamp: 1 },
  });
  await registry.abortSubmission("A", "s1");
  const result = await pending;

  const snap = registry.getSnapshot("A");
  assert.deepEqual(snap.messages.map((m) => m.content), ["hi"], "已投递消息不得因 Stop 被抹掉");
  assert.equal(result.status, "accepted");
  assert.equal(drafts.length, 0, "已投递时不得恢复草稿");
  assert.equal(snap.entryIds[0], "e1");
});

test("abort 且未观察到投递：回滚假气泡并恢复草稿", async () => {
  const drafts = [];
  const registry = createBrowserSessionRuntimeRegistry({
    postPrompt(_sessionId, input) {
      return new Promise((_resolve, reject) => {
        input.signal?.addEventListener("abort", () => {
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        });
      });
    },
    createEventStream: () => fakeStream().manager,
    restoreDraft(draftKey, draft) { drafts.push({ draftKey, ...draft }); },
  });
  const pending = registry.submitPrompt({
    target: { kind: "persisted", sessionId: "A" },
    submissionId: "s1",
    message: "hi",
    draftKey: "A",
  });
  await registry.abortSubmission("A", "s1");
  const result = await pending;

  const snap = registry.getSnapshot("A");
  assert.deepEqual(snap.messages, [], "未投递的假气泡必须移除");
  assert.equal(snap.agentRunning, false);
  assert.equal(result.status, "unknown");
  assert.equal(drafts.length, 1, "未投递时把文本还给输入框");
});

test("stale 与 superseded 语义不同：前者时间线不动但仍是最新磁盘读取", () => {
  const registry = createBrowserSessionRuntimeRegistry({
    async postPrompt() { throw new Error("unused"); },
    createEventStream: () => fakeStream().manager,
    restoreDraft() {},
  });
  const sinceSeq = registry.getSnapshot("A")?.timelineSeq ?? 0;
  // live 事件推进 timelineSeq
  registry.applyEvent("A", { type: "agent_start" });
  registry.applyEvent("A", {
    type: "message_end",
    entryId: "live-1",
    message: { role: "assistant", content: "live reply", timestamp: 2 },
  });
  const stale = registry.hydrate(
    "A",
    [{ role: "user", content: "disk context", timestamp: 1 }],
    ["d-1"],
    { sinceSeq, hydrateRequestSeq: 1 },
  );
  assert.equal(stale, "stale");
  assert.deepEqual(
    registry.getSnapshot("A").messages.map((m) => m.content),
    ["live reply"],
    "时间线保留 live 版本",
  );

  // 同一代次的响应再次到达：已被标记 superseded 之外的序号仍可应用
  const superseded = registry.hydrate(
    "A",
    [{ role: "user", content: "older response", timestamp: 0 }],
    ["d-0"],
    { hydrateRequestSeq: 0 },
  );
  assert.equal(superseded, "superseded", "序号不前进的响应整体作废");
});

test("致命断线后重试窗口内重连：旧 manager 不得被静默丢弃（否则留下重复流）", async () => {
  // 生产路径：run 中 SSE 致命断开 → manager 排了一个重连定时器（current 已置 null）。
  // 此时 connectEvents 看到 getCurrentSource() === null，若直接 `slot.eventStream = null`
  // 而不 close()，那个定时器不会被清，之后会自己 connect 出一条无人跟踪的流。
  const sources = [];
  const timers = [];
  const createManager = (sessionId) => createEventStreamManager({
    getEventsUrl: (id) => `/events/${id}`,
    createEventSource: () => {
      const src = { closed: false, readyState: 1, onmessage: null, onerror: null, close() { this.closed = true; this.readyState = 2; } };
      sources.push({ sessionId, src });
      return src;
    },
    schedule: (fn, ms) => { const t = { fn, ms, cancelled: false }; timers.push(t); return t; },
    clearSchedule: (t) => { if (t) t.cancelled = true; },
    scheduleFrame: (fn) => { fn(); return 0; },
    cancelFrame: () => {},
    shouldAutoReconnect: () => true,
  });

  const registry = createBrowserSessionRuntimeRegistry({
    async postPrompt() { throw new Error("unused"); },
    // registry 自己会调 ensureConnected，这里只造 manager。
    createEventStream: (id) => createManager(id),
    restoreDraft() {},
    schedule: (fn, ms) => { const t = { fn, ms, cancelled: false }; timers.push(t); return t; },
    clearSchedule: (t) => { if (t) t.cancelled = true; },
  });

  registry.attach("A");
  assert.equal(sources.length, 1, "attach 建立一条流");

  // 模拟致命断线：source CLOSED 并触发 onerror（manager 内部排重连）
  sources[0].src.readyState = 2;
  sources[0].src.onerror?.();
  const reconnectTimers = timers.filter((t) => !t.cancelled);
  assert.ok(reconnectTimers.length >= 1, "manager 应当排了重连定时器");

  // 视图重建连接（visibility 恢复 / 重新 attach）
  registry.ensureEventsConnected("A");
  assert.equal(sources.length, 2, "重建后有一条新流");

  // 关键断言：旧 manager 的重连定时器必须已作废，否则它会再开一条重复流。
  // 注意：旧 source 的 readyState 已是 CLOSED（浏览器自己关的），不能算「活流」；
  // 真正要防的是它再 connect 出一条新的。
  const createdBeforeFlush = sources.length;
  for (const t of timers.filter((t) => !t.cancelled)) t.fn();
  assert.equal(
    sources.length,
    createdBeforeFlush,
    `旧 manager 不得自行重连出新流（实际 ${sources.length} 条，说明旧流未被 close）`,
  );
  const liveCount = sources.filter((s) => s.src.readyState !== 2).length;
  assert.equal(liveCount, 1, "任一时刻只允许一条未关闭的流指向同一会话");
});

test("别名与真实 id 同时 attach：全部 dispose 后必须回到「无人观看」", async () => {
  // 这是跨实例（31415/31416）最痛的形态：计数失配 → viewAttached 永真
  // → 空闲不收流 → host 不 dispose → writer 租约不释放 → 另一实例打不开会话。
  const registry = createBrowserSessionRuntimeRegistry({
    async createAndPrompt() {
      return { sessionId: "real-1", receipt: { submissionId: "x", sessionId: "real-1", status: "accepted" } };
    },
    createEventStream: () => fakeStream().manager,
    restoreDraft() {},
  });
  const pending = registry.attach("pending:i1");
  await registry.submitPrompt({
    target: { kind: "new", intentId: "i1", cwd: "/tmp" },
    submissionId: "s1",
    message: "hi",
    draftKey: "new:i1",
  });
  // promote 之后两边都有人订阅（旧 effect 尚未清理 + 新 effect 已 attach）。
  const real = registry.attach("real-1");
  assert.equal(registry.getSnapshot("real-1")?.attachCount, 2);

  real.dispose();
  assert.equal(registry.getSnapshot("real-1")?.attachCount, 1, "还有一个订阅在");
  pending.dispose();
  assert.equal(
    registry.getSnapshot("real-1")?.attachCount,
    0,
    "全部 dispose 后必须归零，否则空闲收流永不触发、writer 租约不释放",
  );
});

test("dispose 幂等：重复调用不会把计数压成负数或漏减", async () => {
  const registry = createBrowserSessionRuntimeRegistry({
    async postPrompt() { throw new Error("unused"); },
    createEventStream: () => fakeStream().manager,
    restoreDraft() {},
  });
  const sub = registry.attach("A");
  sub.dispose();
  sub.dispose();
  assert.equal(registry.getSnapshot("A")?.attachCount, 0);
});

test("别名解析：pending id 与真实 id 命中同一 slot（不产生第二份状态）", async () => {
  const registry = createBrowserSessionRuntimeRegistry({
    async createAndPrompt() {
      return { sessionId: "real-2", receipt: { submissionId: "x", sessionId: "real-2", status: "accepted" } };
    },
    createEventStream: () => fakeStream().manager,
    restoreDraft() {},
  });
  registry.attach("pending:i2");
  await registry.submitPrompt({
    target: { kind: "new", intentId: "i2", cwd: "/tmp" },
    submissionId: "s2",
    message: "hi",
    draftKey: "new:i2",
  });
  // 两个 id 看到的是同一份时间线，且 sessionId 已归一为真实 id。
  assert.equal(
    registry.getSnapshot("pending:i2")?.sessionId,
    "real-2",
    "pending 别名必须解析到真实 slot",
  );
  assert.deepEqual(
    registry.getSnapshot("pending:i2")?.messages,
    registry.getSnapshot("real-2")?.messages,
    "别名不得产生第二份状态",
  );
});

test("rekey 后旧 attachments 仍能正确释放（不按 id 回查）", async () => {
  const registry = createBrowserSessionRuntimeRegistry({
    async createAndPrompt() {
      return { sessionId: "real-3", receipt: { submissionId: "x", sessionId: "real-3", status: "accepted" } };
    },
    createEventStream: () => fakeStream().manager,
    restoreDraft() {},
  });
  const sub = registry.attach("pending:i3");
  await registry.submitPrompt({
    target: { kind: "new", intentId: "i3", cwd: "/tmp" },
    submissionId: "s3",
    message: "hi",
    draftKey: "new:i3",
  });
  sub.dispose();
  assert.equal(
    registry.getSnapshot("real-3")?.attachCount,
    0,
    "rekey 之后旧订阅的 dispose 必须仍然生效",
  );
});

test("重复 dispose 同一订阅：不得扣掉其它附件的计数", async () => {
  // 旧实现是裸计数器且 dispose 用 Math.max(0, n-1)：同一订阅释放两次会把
  // 另一个附件的计数一起扣掉 → 「无人观看」被提前判定 → 空闲收流提前触发。
  const registry = createBrowserSessionRuntimeRegistry({
    async postPrompt() { throw new Error("unused"); },
    createEventStream: () => fakeStream().manager,
    restoreDraft() {},
  });
  const first = registry.attach("A");
  const second = registry.attach("A");
  assert.equal(registry.getSnapshot("A")?.attachCount, 2);

  first.dispose();
  first.dispose();
  assert.equal(
    registry.getSnapshot("A")?.attachCount,
    1,
    "重复 dispose 不得把 second 的计数一起扣掉",
  );
  second.dispose();
  assert.equal(registry.getSnapshot("A")?.attachCount, 0);
});

test("两个附件共用同一 onEvent：其中一个释放不得摘掉事件处理器", async () => {
  // 旧实现 viewHandlers 是「按函数引用增删」：两个附件传同一个函数时，
  // 第一个 dispose 就把处理器删了，第二个附件从此收不到事件。
  const seen = [];
  const shared = (event) => seen.push(event);
  const registry = createBrowserSessionRuntimeRegistry({
    async postPrompt() { throw new Error("unused"); },
    createEventStream: () => fakeStream().manager,
    restoreDraft() {},
  });
  const first = registry.attach("A", shared);
  const second = registry.attach("A", shared);

  first.dispose();
  // 剩下那个附件仍应收到事件。
  registry.applyEvent("A", { type: "agent_start" });
  assert.equal(seen.length, 1, "第二个附件必须仍能收到事件");
  second.dispose();
});

test("turnMetrics：decodeMs 不含 TTFT，速率按解码时间加权", async () => {
  // 时钟可控：agent_start=0，首个 token=1000（TTFT=1000），message_end=3000
  // → 本 step decodeMs=2000、output=100 → 50 tok/s。
  // 起点用真实量级时间戳：0 在新语义里表示「起点未知」，会被守卫挡掉。
  const BASE = 1_700_000_000_000;
  let clock = BASE;
  const registry = createBrowserSessionRuntimeRegistry({
    async postPrompt() { throw new Error("unused"); },
    createEventStream: () => fakeStream().manager,
    restoreDraft() {},
    now: () => clock,
  });
  clock = BASE;
  registry.applyEvent("A", { type: "agent_start" });
  clock = BASE + 1000;
  registry.applyEvent("A", {
    type: "message_update",
    message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
  });
  clock = BASE + 3000;
  registry.applyEvent("A", {
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text: "hi" }], usage: { output: 100 } },
  });
  const metrics = registry.getSnapshot("A").turnMetrics;
  assert.equal(metrics.ttftMs, 1000, "TTFT = agent_start → 首个内容帧");
  assert.equal(metrics.tokensPerSecond, 50, "100 tokens / 2s 解码时间");
});

test("turnMetrics：空壳帧不算首个 token，缺失 usage 的 step 不参与平均", async () => {
  const BASE = 1_700_000_000_000;
  let clock = BASE;
  const registry = createBrowserSessionRuntimeRegistry({
    async postPrompt() { throw new Error("unused"); },
    createEventStream: () => fakeStream().manager,
    restoreDraft() {},
    now: () => clock,
  });
  clock = BASE;
  registry.applyEvent("A", { type: "agent_start" });
  // 空 content 帧（role 已到但还没有内容）不得当作首个 token。
  clock = BASE + 500;
  registry.applyEvent("A", { type: "message_update", message: { role: "assistant", content: [] } });
  assert.equal(registry.getSnapshot("A").turnMetrics.ttftMs, undefined);
  // 有内容才算。
  clock = BASE + 800;
  registry.applyEvent("A", {
    type: "message_update",
    message: { role: "assistant", content: [{ type: "text", text: "a" }] },
  });
  assert.equal(registry.getSnapshot("A").turnMetrics.ttftMs, 800);
  // 该 step 无 usage → 不计入，且不得产生速率。
  clock = BASE + 2800;
  registry.applyEvent("A", {
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text: "a" }] },
  });
  assert.equal(registry.getSnapshot("A").turnMetrics.tokensPerSecond, undefined);
});

test("turnMetrics：多 step 求和后相除（加权），不是速率平均", async () => {
  // step1：decode 1000ms / output 10 → 10 tok/s
  // step2：decode 1000ms / output 90 → 90 tok/s
  // 加权结果 = 100 tokens / 2s = 50 tok/s（算术平均会是 50……用不等长验证更明确）
  // 改为 step1：decode 1000ms / 10 tokens；step2：decode 3000ms / 90 tokens
  // 加权 = 100 / 4s = 25 tok/s；算术平均 = (10 + 30)/2 = 20 tok/s。
  let clock = 0;
  const registry = createBrowserSessionRuntimeRegistry({
    async postPrompt() { throw new Error("unused"); },
    createEventStream: () => fakeStream().manager,
    restoreDraft() {},
    now: () => clock,
  });
  clock = 0;
  registry.applyEvent("A", { type: "agent_start" });

  clock = 1000;
  registry.applyEvent("A", { type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "1" }] } });
  clock = 2000;
  registry.applyEvent("A", { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "1" }], usage: { output: 10 } } });

  clock = 5000;
  registry.applyEvent("A", { type: "message_start", message: { role: "assistant", content: [{ type: "text", text: "2" }] } });
  clock = 8000;
  registry.applyEvent("A", { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "2" }], usage: { output: 90 } } });

  const tps = registry.getSnapshot("A").turnMetrics.tokensPerSecond;
  assert.equal(tps, 25, "100 tokens / 4s 解码总时长（按时间加权）");
});

test("turnMetrics：新 run 重置累积", async () => {
  let clock = 0;
  const registry = createBrowserSessionRuntimeRegistry({
    async postPrompt() { throw new Error("unused"); },
    createEventStream: () => fakeStream().manager,
    restoreDraft() {},
    now: () => clock,
  });
  clock = 0;
  registry.applyEvent("A", { type: "agent_start" });
  clock = 100;
  registry.applyEvent("A", { type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "x" }] } });
  clock = 1100;
  registry.applyEvent("A", { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "x" }], usage: { output: 50 } } });
  assert.ok(registry.getSnapshot("A").turnMetrics.tokensPerSecond > 0);

  // 第二轮：不累积上一轮
  clock = 2000;
  registry.applyEvent("A", { type: "agent_start" });
  clock = 2500;
  registry.applyEvent("A", { type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "y" }] } });
  clock = 3500;
  registry.applyEvent("A", { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "y" }], usage: { output: 20 } } });
  const metrics = registry.getSnapshot("A").turnMetrics;
  assert.equal(metrics.ttftMs, 500, "第二轮 TTFT 独立计算");
  assert.equal(metrics.tokensPerSecond, 20, "只算本轮：20 tokens / 1s");
});

test("turnMetrics：submitPrompt 乐观路径也重置起点（agent_start 缺失时 TTFT 不得荒谬）", async () => {
  // 回归：起点只在 agent_start 重置时，若该事件未到达，startedAt 保持 0，
  // TTFT 会变成「Date.now() - 0」这种几十年的数字。
  let clock = 1_700_000_000_000;
  const registry = createBrowserSessionRuntimeRegistry({
    async postPrompt(sessionId, input) {
      return { submissionId: input.submissionId, sessionId, status: "accepted" };
    },
    createEventStream: () => fakeStream().manager,
    restoreDraft() {},
    now: () => clock,
  });
  await registry.submitPrompt({
    target: { kind: "persisted", sessionId: "A" },
    submissionId: "s1",
    message: "hi",
    draftKey: "A",
  });
  // 不发 agent_start，直接进内容帧（模拟事件缺失/乐观路径）。
  clock += 400;
  registry.applyEvent("A", {
    type: "message_update",
    message: { role: "assistant", content: [{ type: "text", text: "x" }] },
  });
  const ttft = registry.getSnapshot("A").turnMetrics.ttftMs;
  assert.equal(ttft, 400, "TTFT 应相对本轮起点，而不是相对 0");
});

test("turnMetrics：起点未知时不输出 TTFT（宁缺勿错）", () => {
  let clock = 1_700_000_000_000;
  const registry = createBrowserSessionRuntimeRegistry({
    async postPrompt() { throw new Error("unused"); },
    createEventStream: () => fakeStream().manager,
    restoreDraft() {},
    now: () => clock,
  });
  // 未经过任何起点设置（模拟 slot 冷建后直接收到内容帧）。
  registry.applyEvent("A", {
    type: "message_update",
    message: { role: "assistant", content: [{ type: "text", text: "x" }] },
  });
  assert.equal(
    registry.getSnapshot("A").turnMetrics.ttftMs,
    undefined,
    "起点为 0 时不得给出 TTFT",
  );
});

test("turnMetrics：importRunningRun 用服务端 startedAt 作起点", () => {
  let clock = 1_700_000_000_000;
  const registry = createBrowserSessionRuntimeRegistry({
    async postPrompt() { throw new Error("unused"); },
    createEventStream: () => fakeStream().manager,
    restoreDraft() {},
    now: () => clock,
  });
  const startedAt = clock - 5_000;
  registry.importRunningRun("A", startedAt);
  registry.applyEvent("A", {
    type: "message_update",
    message: { role: "assistant", content: [{ type: "text", text: "x" }] },
  });
  assert.equal(registry.getSnapshot("A").turnMetrics.ttftMs, 5000, "冷挂载恢复按服务端起点算");
});
