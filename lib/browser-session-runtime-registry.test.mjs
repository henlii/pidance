import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { createBrowserSessionRuntimeRegistry } = await jiti.import("./browser-session-runtime-registry.ts");
// 用真实 EventStreamManager 驱动，避免只测到替身的行为。
const { createEventStreamManager } = await jiti.import("./event-stream-manager.ts");
const { pendingSessionId } = await jiti.import("./new-session-intent.ts");

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
    // 只拦截 prompt 提交端点（本用例的测点）；/submissions 是显式取消端点，
    // 由 cancelSubmission 自己处理，不能一起挂住。
    if (url.includes("/api/agent/") && !url.includes("/new") && !url.includes("/events") && !url.includes("/submissions")) {
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
  registry.appendLocal("S", { role: "user", content: "引导气泡文本。", timestamp: 2 });
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

test("hydrate(replace)+retain：磁盘尚未包含的引导在 A 槽重载后仍在，交付后只留一条", () => {
  const registry = createBrowserSessionRuntimeRegistry({
    async postPrompt() { throw new Error("unused"); },
    createEventStream: () => fakeStream().manager,
    restoreDraft() {},
  });
  registry.hydrate("A", [{ role: "user", content: "old", timestamp: 1 }], ["e1"], { mode: "replace" });
  const key = registry.appendLocal("A", { role: "user", content: "继续", timestamp: 2 });
  registry.hydrate("B", [{ role: "user", content: "other", timestamp: 3 }], ["b1"], { mode: "replace" });
  registry.hydrate("A", [{ role: "user", content: "old", timestamp: 1 }], ["e1"], {
    mode: "replace",
    pending: "retain",
  });
  assert.deepEqual(
    registry.getSnapshot("A")?.messages.map((message) => message.content),
    ["old", "继续"],
    "A→B→A 的 replace 不得清掉磁盘尚未包含的引导",
  );
  assert.equal(registry.getSnapshot("A")?.messageKeys.includes(key), true);
  registry.applyEvent("A", {
    type: "message_end",
    message: { role: "user", content: "继续", timestamp: 2 },
  });
  assert.deepEqual(
    registry.getSnapshot("A")?.messages.map((message) => message.content),
    ["old", "继续"],
    "生产形态 message_end 不得再追加第二条",
  );
});

test("hydrate(tail) 截断窗口含新 user 时消化乐观气泡，不叠第二条", async () => {
  const registry = createBrowserSessionRuntimeRegistry({
    async postPrompt(sessionId, input) {
      return { submissionId: input.submissionId, sessionId, status: "accepted" };
    },
    createEventStream: () => fakeStream().manager,
    restoreDraft() {},
  });
  registry.hydrate("A", [
    { role: "user", content: "old-0", timestamp: 1 },
    { role: "user", content: "old-1", timestamp: 2 },
    { role: "assistant", content: "ok", timestamp: 3 },
  ], ["e0", "e1", "e2"], { mode: "replace" });
  await registry.submitPrompt({
    target: { kind: "persisted", sessionId: "A" },
    submissionId: "s-tail",
    message: "hello",
    draftKey: "A",
  });
  assert.equal(
    registry.getSnapshot("A")?.messages.filter((message) => message.content === "hello").length,
    1,
  );
  registry.hydrate("A", [
    { role: "user", content: "old-1", timestamp: 2 },
    { role: "assistant", content: "ok", timestamp: 3 },
    { role: "user", content: "hello", timestamp: 4 },
  ], ["e1", "e2", "e3"], { mode: "tail", pending: "retain" });
  const hello = registry.getSnapshot("A")?.messages.filter((message) => message.content === "hello") ?? [];
  assert.equal(hello.length, 1, "截断尾页不得把乐观气泡和磁盘消息叠成两条");
  assert.equal(registry.getSnapshot("A")?.entryIds.at(-1), "e3");
  registry.applyEvent("A", {
    type: "message_end",
    message: { role: "user", content: "hello", timestamp: 4 },
  });
  assert.equal(
    registry.getSnapshot("A")?.messages.filter((message) => message.content === "hello").length,
    1,
    "迟到且无 entryId 的 message_end 不得再追加",
  );
});

test("hydrate(replace) 默认 drop：共享祖先的另一叶不得串入旧引导", () => {
  const registry = createBrowserSessionRuntimeRegistry({
    async postPrompt() { throw new Error("unused"); },
    createEventStream: () => fakeStream().manager,
    restoreDraft() {},
  });
  registry.hydrate("A", [
    { role: "user", content: "root", timestamp: 1 },
    { role: "user", content: "leaf-a", timestamp: 2 },
  ], ["root", "a1"], { mode: "replace" });
  registry.appendLocal("A", { role: "user", content: "引导", timestamp: 3 });
  registry.hydrate("A", [
    { role: "user", content: "root", timestamp: 1 },
    { role: "user", content: "leaf-b", timestamp: 4 },
  ], ["root", "b1"], { mode: "replace", pending: "drop" });
  assert.deepEqual(
    registry.getSnapshot("A")?.messages.map((message) => message.content),
    ["root", "leaf-b"],
    "切分支必须显式 drop pending",
  );
});

test("hydrate(replace)+retain：同叶不重叠分页窗口仍保留 pending", () => {
  const registry = createBrowserSessionRuntimeRegistry({
    async postPrompt() { throw new Error("unused"); },
    createEventStream: () => fakeStream().manager,
    restoreDraft() {},
  });
  registry.hydrate("A", [{ role: "user", content: "recent", timestamp: 2 }], ["e2"], { mode: "replace" });
  registry.appendLocal("A", { role: "user", content: "引导", timestamp: 3 });
  registry.hydrate("A", [{ role: "user", content: "older", timestamp: 1 }], ["e1"], {
    mode: "replace",
    pending: "retain",
  });
  assert.deepEqual(
    registry.getSnapshot("A")?.messages.map((message) => message.content),
    ["older", "引导"],
  );
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

// ── 吞吐读数：服务端为唯一计算方，客户端只渲染 ──

const newRegistry = () => createBrowserSessionRuntimeRegistry({
  async postPrompt(sessionId, input) {
    return { submissionId: input.submissionId, sessionId, status: "accepted" };
  },
  createEventStream: () => fakeStream().manager,
  restoreDraft() {},
});

test("turnMetrics：SSE 事件携带的服务端读数直接投影（客户端不累计）", async () => {
  const registry = newRegistry();
  registry.applyEvent("s1", { type: "agent_start" });
  registry.applyEvent("s1", {
    type: "message_end",
    message: { role: "assistant", usage: { output: 999 } },
    turnMetrics: { tokensPerSecond: 42.5, ttftMs: 320 },
  });
  const snapshot = registry.getSnapshot("s1");
  assert.deepEqual(snapshot.turnMetrics, { tokensPerSecond: 42.5, ttftMs: 320 });
});

test("turnMetrics：普通事件不清空读数；新 run（agent_start）清空等待服务端下发", () => {
  const registry = newRegistry();
  // 读数只在运行中有效（无 run 的 message_* 事件会被丢弃，与渲染态一致）
  registry.applyEvent("s1", { type: "agent_start" });
  registry.applyEvent("s1", { type: "message_update", turnMetrics: { tokensPerSecond: 30 } });
  assert.equal(registry.getSnapshot("s1").turnMetrics.tokensPerSecond, 30);
  // 普通事件无读数：保留（否则速率会闪没）
  registry.applyEvent("s1", { type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "x" }] } });
  assert.equal(registry.getSnapshot("s1").turnMetrics.tokensPerSecond, 30, "无读数事件不得清掉已有读数");
  // 新 run：清空上一轮读数
  registry.applyEvent("s1", { type: "agent_start" });
  assert.deepEqual(registry.getSnapshot("s1").turnMetrics, {});
});

test("turnMetrics：seedTurnMetrics 只做兜底覆盖（冷挂载/重连）", () => {
  const registry = newRegistry();
  registry.seedTurnMetrics("s1", { tokensPerSecond: 12, ttftMs: 800 });
  assert.deepEqual(registry.getSnapshot("s1").turnMetrics, { tokensPerSecond: 12, ttftMs: 800 });
  // null 清空（新 run 起点）
  registry.seedTurnMetrics("s1", null);
  assert.deepEqual(registry.getSnapshot("s1").turnMetrics, {});
});


test("#31 显式 Stop 按 submissionId 发取消请求；失败时保持未知且不重发", async () => {
  let cancelCalls = 0;
  let cancelFails = false;
  const registry = createBrowserSessionRuntimeRegistry({
    // 模拟「POST 响应未回」：请求在途，直到 abort 才拒绝（与生产 fetch 契约一致）
    postPrompt: (_sessionId, input) => new Promise((_resolve, reject) => {
      input.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    }),
    createEventStream: () => fakeStream().manager,
    restoreDraft() {},
    cancelSubmission: async () => {
      cancelCalls += 1;
      if (cancelFails) throw new Error("HTTP 500");
      return { status: "pending" };
    },
  });
  const pending = registry.submitPrompt({
    target: { kind: "persisted", sessionId: "A" },
    submissionId: "cancel-1",
    message: "go",
    draftKey: "A",
  });
  await new Promise((r) => setTimeout(r, 20));

  await registry.abortSubmission("A", "cancel-1");
  assert.equal(cancelCalls, 1, "显式 Stop 必须把取消意图交给服务端提交事务");

  // 再次显式 Stop（用户又按一次）会再发一次请求：这是用户意图，不是自动重发。
  // 服务端对同一提交幂等（只 abort 原运行一次，见 session-service 用例）。
  await registry.abortSubmission("A", "cancel-1");
  assert.equal(cancelCalls, 2, "显式重复 Stop 视为新的用户意图");

  // 关键约束：没有任何自动重发路径（等待一段时间后计数不变）。
  const after = cancelCalls;
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(cancelCalls, after, "不得自动重发取消");

  // 取消请求失败：不抛穿、不改成本地「已停止」的假象
  cancelFails = true;
  const failing = createBrowserSessionRuntimeRegistry({
    postPrompt: (_sessionId, input) => new Promise((_resolve, reject) => {
      input.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    }),
    createEventStream: () => fakeStream().manager,
    restoreDraft() {},
    cancelSubmission: async () => {
      throw new Error("HTTP 500");
    },
  });
  failing.submitPrompt({
    target: { kind: "persisted", sessionId: "B" },
    submissionId: "cancel-2",
    message: "go",
    draftKey: "B",
  });
  await new Promise((r) => setTimeout(r, 20));
  await failing.abortSubmission("B", "cancel-2"); // 不得抛穿
  assert.equal(failing.getSubmission("B", "cancel-2")?.status, "unknown");

  assert.equal(typeof pending.then, "function");
});

test("#31 新会话真实 id 未知时，仍按 submissionId 取消", async () => {
  const cancelled = [];
  const registry = createBrowserSessionRuntimeRegistry({
    // 创建中：真实 id 未知（响应未回）；abort 时按契约拒绝
    createAndPrompt: (_cwd, input) => new Promise((_resolve, reject) => {
      input.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    }),
    createEventStream: () => fakeStream().manager,
    restoreDraft() {},
    cancelSubmission: async (submissionId) => {
      cancelled.push(submissionId);
      return { status: "pending" };
    },
  });
  const pending = registry.submitPrompt({
    target: { kind: "new", intentId: "intent-1", cwd: "/tmp" },
    submissionId: "new-cancel-1",
    message: "first",
    draftKey: "new:intent-1",
  });
  await new Promise((r) => setTimeout(r, 20));

  // 用 pending id 调 Stop：真实 id 未知也必须能定位到该提交
  await registry.abortSubmission(pendingSessionId("intent-1"), "new-cancel-1");
  assert.deepEqual(cancelled, ["new-cancel-1"]);
  assert.equal(typeof pending.then, "function");
});

// ---------------------------------------------------------------------------
// Issue #35：空闲 slot 的有界回收
//
// dispose()（切会话/卸载）只退订视图，**不删 slot**；slots.delete() 之前只出现在
// rekey 里。于是一个页面里打开过的每个会话都会一直留着完整 timeline 与派生数组。
// 回收条件必须保守：宁可多留，不可丢掉未落盘的消息。
// ---------------------------------------------------------------------------

/** 用可控 schedule 驱动空闲窗口（避免真等 5s），并统计回收。 */
function newReclaimHarness(deps = {}) {
  const timers = [];
  const streams = [];
  const registry = createBrowserSessionRuntimeRegistry({
    postPrompt: async (sessionId, input) => ({ submissionId: input.submissionId, sessionId, status: "accepted" }),
    createEventStream: () => {
      const stream = fakeStream();
      streams.push(stream);
      return stream.manager;
    },
    restoreDraft() {},
    schedule: (fn) => { timers.push(fn); return timers.length - 1; },
    clearSchedule: () => {},
    ...deps,
  });
  return {
    registry,
    /** 通过最近一条 SSE 投递事件（驱动 run 状态） */
    emit(event) {
      for (const stream of streams) stream.emit(event);
    },
    /** 触发所有已排定的空闲回调（相当于 5s 窗口到期） */
    fireIdle() {
      const pending = [...timers];
      timers.length = 0;
      for (const fn of pending) fn();
    },
  };
}

test("#35 切走后空闲：可回收的 slot 被删除，重建后行为一致", async () => {
  const { registry, fireIdle } = newReclaimHarness();
  const sub = registry.attach("A");
  registry.hydrate("A", [{ role: "user", content: "hi" }], ["e1"]);
  const beforeKeys = registry.getSnapshot("A").messageKeys;
  const beforeMessages = registry.getSnapshot("A").messages.length;

  sub.dispose();
  assert.equal(registry.debugSlotCount(), 1, "退订本身不应立即删 slot");
  fireIdle();

  assert.deepEqual(registry.debugSlotIds(), [], "空闲到期后应回收");
  assert.equal(registry.getSnapshot("A"), null, "回收后快照为空");

  // 重建：重新 attach + hydrate，内容应与回收前一致（消息不丢）
  const again = registry.attach("A");
  registry.hydrate("A", [{ role: "user", content: "hi" }], ["e1"]);
  const after = registry.getSnapshot("A");
  assert.equal(after.messages.length, beforeMessages, "重建后消息数一致");
  assert.deepEqual(after.messageKeys, beforeKeys, "重建后 key 一致（可稳定渲染）");
  again.dispose();
});

test("#35 有视图附件时不回收（正在看）", async () => {
  const { registry, fireIdle } = newReclaimHarness();
  const sub = registry.attach("A");
  registry.hydrate("A", [{ role: "user", content: "hi" }], ["e1"]);
  fireIdle();
  assert.deepEqual(registry.debugSlotIds(), ["A"], "有人看时不得回收");
  sub.dispose();
});

test("#35 有快照订阅者时不回收", async () => {
  const { registry, fireIdle } = newReclaimHarness();
  const unsub = registry.subscribe("A", () => {});
  registry.hydrate("A", [{ role: "user", content: "hi" }], ["e1"]);
  fireIdle();
  assert.deepEqual(registry.debugSlotIds(), ["A"], "有订阅者时不得回收");
  unsub();
});

test("#35 有未确认的本地记录时不回收（这是最关键的保守条件）", async () => {
  const { registry, fireIdle } = newReclaimHarness();
  registry.hydrate("A", [{ role: "user", content: "已落盘" }], ["e1"]);
  // 乐观气泡：尚未被服务端确认，丢了就真丢
  registry.appendLocal("A", { role: "user", content: "还没落盘" });
  fireIdle();
  assert.deepEqual(registry.debugSlotIds(), ["A"], "存在 pending 记录时不得回收");
  assert.equal(
    registry.getSnapshot("A").messages.length,
    2,
    "乐观消息必须还在",
  );
});

test("#35 在途提交/运行中时不回收", async () => {
  const { registry, fireIdle } = newReclaimHarness({ postPrompt: () => new Promise(() => {}) });
  registry.hydrate("A", [{ role: "user", content: "hi" }], ["e1"]);
  registry.submitPrompt({
    target: { kind: "persisted", sessionId: "A" },
    submissionId: "inflight-1",
    message: "go",
    draftKey: "A",
  });
  fireIdle();
  assert.deepEqual(registry.debugSlotIds(), ["A"], "有在途提交时不得回收");
});

test("#35 只有空 timeline 的 slot 不回收（尚未 hydrate）", async () => {
  const { registry, fireIdle } = newReclaimHarness();
  registry.getSnapshot("A"); // 仅创建
  registry.attach("A").dispose();
  fireIdle();
  assert.deepEqual(registry.debugSlotIds(), ["A"], "未 hydrate 的空 slot 留给下次打开");
});


test("#35 rekey 后回收真实 id 槽位，别名不残留", async () => {
  const h = newReclaimHarness({
    // 新会话一步创建+发送：让 rekey 真正发生（pending id → 真实 id）
    createAndPrompt: async (_cwd, input) => ({
      sessionId: "real-1",
      receipt: { submissionId: input.submissionId, sessionId: "real-1", status: "accepted" },
    }),
  });
  const { registry, fireIdle } = h;
  const created = await registry.submitPrompt({
    target: { kind: "new", intentId: "intent-x", cwd: "/tmp" },
    submissionId: "s-new",
    message: "first",
    draftKey: "new:intent-x",
  });
  assert.equal(created.sessionId, "real-1", "创建成功后应指向真实 id");

  registry.hydrate("real-1", [{ role: "user", content: "hi" }], ["e1"]);
  // 提交会把 agentRunning 置真（乐观）；run 未结束前**不应**回收（保守条件）。
  assert.equal(registry.getRunState("real-1").agentRunning, true);
  // 先 attach：SSE 事件通道由此建立（createAndPrompt 路径本身不连流），
  // 否则下面 emit 的事件不会被应用。
  const watcher = registry.attach("real-1");
  h.emit({ type: "agent_end" });
  watcher.dispose();
  fireIdle();
  assert.deepEqual(registry.debugSlotIds(), ["real-1"], "未确认的乐观记录存在时不得回收");

  // 只结束 run 还不够：乐观记录必须已被服务端确认（否则那是「可能没落盘的消息」，
  // 绝不能丢）——这正是保守条件的意义。
  const watcher2 = registry.attach("real-1");
  // 用新的 entry id 确认：e1 已在 hydrate 时标记为 consumed，再用它会被当重放跳过
  h.emit({ type: "message_end", entryId: "e2", message: { role: "user", content: "first" } });
  watcher2.dispose();
  fireIdle();
  assert.deepEqual(registry.debugSlotIds(), [], "确认落盘 + run 结束后应回收真实 id 槽位");
  // 回收后：pending 别名不得复活出脏状态
  assert.equal(registry.getSnapshot("real-1"), null);
  assert.equal(registry.getSnapshot(pendingSessionId("intent-x")), null, "别名不得残留");
});

test("G1: 迟到的上一轮终止事件不得把新一轮判成空闲", () => {
  const stream = fakeStream();
  const registry = createBrowserSessionRuntimeRegistry({
    async postPrompt() { throw new Error("unused"); },
    createEventStream: () => stream.manager,
    restoreDraft() {},
  });
  const watcher = registry.attach("A");

  // 第 1 轮：开始 → （未收尾）。第 2 轮紧接着开始（上一轮的收尾事件还在路上）。
  registry.applyEvent("A", { type: "agent_start", streamRunSeq: 1 });
  registry.applyEvent("A", { type: "agent_start", streamRunSeq: 2 });
  assert.equal(registry.getRunState("A").agentRunning, true);

  // 上一轮的 agent_end / prompt_done 迟到：必须被忽略，UI 不能误判空闲。
  registry.applyEvent("A", { type: "agent_end", streamRunSeq: 1 });
  assert.equal(registry.getRunState("A").agentRunning, true, "迟到 agent_end 不得结束新一轮");
  registry.applyEvent("A", { type: "prompt_done", streamRunSeq: 1 });
  assert.equal(registry.getRunState("A").agentRunning, true, "迟到 prompt_done 不得结束新一轮");

  // 本轮自己的收尾事件序号相符：照常结束。
  registry.applyEvent("A", { type: "agent_end", streamRunSeq: 2 });
  assert.equal(registry.getRunState("A").agentRunning, false);

  // 老服务端不带序号：退化为原行为（仍然收尾）。
  registry.applyEvent("A", { type: "agent_start", streamRunSeq: 3 });
  registry.applyEvent("A", { type: "agent_end" });
  assert.equal(registry.getRunState("A").agentRunning, false, "无序号事件保持原语义");

  watcher.dispose();
});

// ── #28 C5：弱网自动重连的判据（a213f74 的接线语义） ──────────────────────────

test("C5：只有在跑的会话且页面可见才自动重连 SSE（空闲/后台都不得自连）", async () => {
  const { shouldAutoReconnectEventStream } = await jiti.import("./browser-session-runtime-registry.ts");
  // 跑着 + 可见 → 重连
  assert.equal(shouldAutoReconnectEventStream({ agentRunning: true, visibilityState: "visible" }), true);
  // 空闲（host 已 dispose，常见 404）→ 不重连，避免对空会话反复握手
  assert.equal(shouldAutoReconnectEventStream({ agentRunning: false, visibilityState: "visible" }), false);
  // 页面藏在后台 → 不抢着重连（切回前台由激活路径负责）
  assert.equal(shouldAutoReconnectEventStream({ agentRunning: true, visibilityState: "hidden" }), false);
  // 非浏览器环境（无 document）→ 视为可见
  assert.equal(shouldAutoReconnectEventStream({ agentRunning: true }), true);
  assert.equal(shouldAutoReconnectEventStream({ agentRunning: false }), false);
});

test("C5 接线：registry 建流时用的就是上面这个判据（不是各自内联一份）", async () => {
  const source = readFileSync(
    fileURLToPath(new URL("./browser-session-runtime-registry.ts", import.meta.url)),
    "utf8",
  );
  const wiring = source.slice(source.indexOf("shouldAutoReconnect: () =>"), source.indexOf("shouldAutoReconnect: () =>") + 400);
  assert.ok(
    wiring.includes("shouldAutoReconnectEventStream("),
    "registry 的 shouldAutoReconnect 没有经过可测的纯函数（语义可能再被改坏而无人发现）",
  );
  assert.ok(
    wiring.includes("slot.snapshot.agentRunning"),
    "接线没有把「仍在跑」接进判据",
  );
  assert.ok(
    /visibilityState: typeof document === "undefined" \? undefined : document\.visibilityState/.test(wiring),
    "接线没有把页面可见性接进判据",
  );
});

test("引导投递的确认不被残留提交 key 领走（引导气泡滞留 = 顺序错位根因）", async () => {
  const stream = fakeStream();
  const registry = createBrowserSessionRuntimeRegistry({
    async postPrompt(sessionId, input) {
      return { submissionId: input.submissionId, sessionId, status: "accepted" };
    },
    createEventStream: () => stream.manager,
    restoreDraft() {},
  });
  const SID = "steer-confirm";
  registry.attach(SID);
  const STEER = "【引导】换方向";
  const user = (content) => ({ role: "user", content, timestamp: 1 });
  const userBlocks = (content) => ({ role: "user", content: [{ type: "text", text: content }], timestamp: 2 });
  const assistant = (content) => ({
    role: "assistant", provider: "p", model: "m",
    content: [{ type: "text", text: content }], timestamp: 3,
  });

  // 历史里已有一条同文本 user（用户重复发同样引导时就是这样）。
  stream.emit({ type: "message_end", message: user("旧提问"), entryId: "e-h1" });
  stream.emit({ type: "message_end", message: assistant("旧回答"), entryId: "e-h2" });
  stream.emit({ type: "message_end", message: userBlocks(STEER), entryId: "e-h3" });

  stream.emit({ type: "agent_start" });
  // 提交本轮 prompt，但**不**投递它的 user message_end：submission key 因此残留
  //（SSE 断线丢事件时的真实状态），后面的引导确认会误配到这个 key。
  void registry.submitPrompt({
    target: { kind: "persisted", sessionId: SID },
    submissionId: "sub-1",
    message: "本轮提问",
    draftKey: SID,
  });
  stream.emit({ type: "message_end", message: assistant("STEP1"), entryId: "e-a1" });

  // 用户引导：先乐观气泡，随后 Pi 在 turn 边界投递它。
  registry.appendLocal(SID, { ...user(STEER) });
  stream.emit({ type: "message_start", message: userBlocks(STEER) });
  stream.emit({ type: "message_end", message: userBlocks(STEER) });

  const messages = registry.getSnapshot(SID).messages;
  assert.equal(
    messages.find((m) => m.content === "本轮提问")?.content,
    "本轮提问",
    "别人的乐观气泡不得被引导的确认改写",
  );
  const steerBubbles = messages.filter((m) => JSON.stringify(m.content ?? "").includes(STEER));
  assert.equal(steerBubbles.length, 2, "历史一条 + 本轮一条，不该重复追加");
  assert.equal(
    steerBubbles.at(-1)._duringStreamingStep,
    undefined,
    "本轮引导必须被确认；滞留的乐观气泡会被 compositor 一直排到 live 之后",
  );
});

test("空窗发出的引导：本步记录落位在它之前（不先下后上地跳）", () => {
  const stream = fakeStream();
  const registry = createBrowserSessionRuntimeRegistry({
    async postPrompt(sessionId, input) { return { submissionId: input.submissionId, sessionId, status: "accepted" }; },
    createEventStream: () => stream.manager,
    restoreDraft() {},
  });
  const SID = "steer-gap";
  registry.attach(SID);
  const emit = (e) => stream.emit(e);
  const thinking = (t) => ({ role: "assistant", provider: "p", model: "m", content: [{ type: "thinking", thinking: t }], timestamp: 1 });
  const userMsg = (t) => ({ role: "user", content: [{ type: "text", text: t }], timestamp: 2 });

  emit({ type: "agent_start" });
  emit({ type: "message_end", message: userMsg("第一个问题"), entryId: "e-u1" });
  // 上一步结束：streamState 被清空，但 run 仍在跑（LLM 已调用、下一步还没出首帧）
  emit({ type: "message_end", message: thinking("上一步的思考"), entryId: "e-a1" });
  const gap = registry.getSnapshot(SID);
  assert.equal(gap.agentRunning, true);
  assert.equal(gap.streamState.isStreaming, false, "这里正是空窗");

  registry.appendLocal(SID, { role: "user", content: "【引导】改方向", timestamp: 3 });
  assert.equal(
    registry.getSnapshot(SID).messages.at(-1)._duringStreamingStep,
    true,
    "run 还在跑时发出的引导必须带标记，compositor 才会把它后置到 live 之后",
  );

  emit({ type: "message_end", message: thinking("本步思考"), entryId: "e-a2" });
  const roles = registry.getSnapshot(SID).messages.map((m) => m.role);
  assert.deepEqual(roles, ["user", "assistant", "assistant", "user"], "引导必须留在本步记录之后");
  const last = registry.getSnapshot(SID).messages.at(-1);
  assert.equal(last.role, "user", "引导不能在思考结束的瞬间跳到前面");
});
