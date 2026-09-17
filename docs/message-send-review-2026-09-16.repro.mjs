// Review evidence: these assertions characterize defects, not desired behavior.
// Run with Node >=22.19: node --test docs/message-send-review-2026-09-16.repro.mjs
// No live SDK session, network request, or user-directory write is performed.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { SdkSessionHost } = await jiti.import("../lib/sdk-session-host.ts");
const queue = await jiti.import("../lib/queue-state.ts");
const { normalizeFollowUpItems } = await jiti.import("../lib/session-queue.ts");
const { mergeFollowUpForSteer } = await jiti.import("../lib/queue-merge.ts");

// Extract the actual callback expression, erase TypeScript, and inject only its
// environment. This exercises source logic without recreating React or a server.
function callback(file, name, dependencies) {
  const source = readFileSync(new URL(file, import.meta.url), "utf8");
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let expression;
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(tree) === name && node.initializer
      && ts.isCallExpression(node.initializer) && node.initializer.expression.getText(tree) === "useCallback") {
      expression = node.initializer.arguments[0].getText(tree);
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  assert.ok(expression, `Missing callback: ${name}`);
  const javascript = ts.transpileModule(`const extracted = ${expression};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  return new Function(...Object.keys(dependencies), `${javascript}\nreturn extracted;`)(...Object.values(dependencies));
}

function hostFixture(items = [], revision = 0) {
  const events = [];
  const session = { isStreaming: true, isCompacting: false };
  const host = Object.create(SdkSessionHost.prototype);
  Object.assign(host, {
    runtime: { session }, _alive: true, promptRunning: false, bashRunning: false,
    activeCommandCount: 0, followUpQueue: [...items], followUpQueueRevision: revision,
    flushingFollowUp: false, followUpFlushBatch: [], followUpFlushCursor: 0,
    followUpFlushConfirmed: false, followUpFlushAsOne: false, followUpFlushOriginal: [],
    releaseStartupHold() {}, resetIdleTimer() {}, persistFollowUpQueue() {},
    isFollowUpHeld() { return false; }, emit(event) { events.push(event); },
  });
  return { host, session, events };
}

function browserFixture(host, items = [], revision = 0) {
  const env = {
    ...queue, normalizeFollowUpItems,
    queueBookRef: { current: { A: { confirmed: [...items], pending: null, revision: 0, syncs: 0 } } },
    currentQueueSessionIdRef: { current: "A" }, sessionIdRef: { current: "A" },
    remoteQueueRevisionRef: { current: new Map([["A", revision]]) },
    followUpSyncRef: { current: Promise.resolve() },
    publishQueue() {}, t: (key) => key,
    sendAgentCommand: (_sid, command) => host.send(command),
  };
  env.observeRemoteQueue = callback("../hooks/useAgentSession.ts", "observeRemoteQueue", env);
  const update = callback("../hooks/useAgentSession.ts", "updateLocalFollowUp", env);
  return { env, update, visible: () => queue.projection(queue.queueEntry(env.queueBookRef.current, "A")) };
}

test("R1: acknowledged enqueue leaves old revision; immediate clear conflicts", async () => {
  const { host } = hostFixture();
  const browser = browserFixture(host);
  await browser.update(["A"]);
  assert.equal(host.followUpQueueRevision, 1);
  assert.equal(browser.env.remoteQueueRevisionRef.current.get("A"), 0);
  await assert.rejects(browser.update([]), /input_queueConflict/);
  assert.deepEqual(host.followUpQueue, ["A"]);
});

test("R2: conflict adopts version but discards items; next write overwrites another tab", async () => {
  const { host } = hostFixture(["x", "other-tab"], 1);
  const browser = browserFixture(host, ["x"], 0);
  await assert.rejects(browser.update(["x", "mine"]), /input_queueConflict/);
  assert.equal(browser.env.remoteQueueRevisionRef.current.get("A"), 1);
  assert.deepEqual(browser.visible(), ["x"]);
  await browser.update([...browser.visible(), "next"]);
  assert.deepEqual(host.followUpQueue, ["x", "next"]);
});

test("R3: delayed steer failure restores A's queue into the now-current session B", async () => {
  let rejectSteer;
  const steerGate = new Promise((_resolve, reject) => { rejectSteer = reject; });
  const writes = [];
  const env = {
    isReadOnly: false, sessionIdRef: { current: "A" },
    queueEntryNow: () => ({ confirmed: ["A-only"], pending: null }),
    projection: queue.projection, mergeFollowUpForSteer,
    notifyAutoFollowSend() {},
    getOrCreateBrowserSessionRuntimeRegistry: () => ({ appendLocal: () => "key", dropLocal() {} }),
    updateLocalFollowUp: async (items) => { writes.push({ sid: env.sessionIdRef.current, items }); },
    sendAgentCommand: () => steerGate,
    isExtensionCommandQueueError: () => false, ensureEventsConnected() {},
    opts: {}, addNotice() {}, console: { error() {} },
  };
  const send = callback("../hooks/useAgentSession.ts", "handleSendQueueAsSteer", env);
  const flight = send();
  await Promise.resolve();
  env.sessionIdRef.current = "B";
  rejectSteer(new Error("network failure"));
  await flight;
  assert.deepEqual(writes, [{ sid: "A", items: [] }, { sid: "B", items: ["A-only"] }]);
});

test("R4: clearing a batch does not cancel its already in-flight prompt", async () => {
  const { host } = hostFixture(["A"]);
  Object.assign(host, { flushingFollowUp: true, followUpFlushBatch: ["A"], isSettled: () => true });
  let acceptPrompt;
  const delivered = [];
  const gate = new Promise((resolve) => { acceptPrompt = resolve; });
  const realSend = host.send.bind(host);
  host.send = async (command) => {
    if (command.type !== "prompt") return realSend(command);
    await gate;
    delivered.push(command.message);
    return { status: "accepted" };
  };
  const flight = host.sendNextFollowUp();
  await realSend({ type: "set_follow_up_queue", items: [], expectedRevision: 0 });
  assert.equal(host.flushingFollowUp, false);
  acceptPrompt();
  await flight;
  assert.deepEqual(host.followUpQueue, []);
  assert.deepEqual(delivered, ["A"]);
});

test("R5: old prompt continuation removes the next item after cursor changes", async () => {
  const { host } = hostFixture(["A", "B"]);
  Object.assign(host, { flushingFollowUp: true, followUpFlushBatch: ["A", "B"], isSettled: () => true });
  let acceptPrompt;
  host.send = () => new Promise((resolve) => { acceptPrompt = resolve; });
  const flight = host.sendNextFollowUp();
  // Same state transition as confirmFollowUpFlush on message_end(user), but
  // suppress starting B so this check isolates the old A continuation.
  host.sendNextFollowUp = async () => {};
  host.confirmFollowUpFlush();
  assert.equal(host.followUpFlushCursor, 1);
  assert.deepEqual(host.followUpQueue, ["B"]);
  acceptPrompt({ status: "accepted" });
  await flight;
  assert.deepEqual(host.followUpQueue, []);
});

test("R5: merged flush removes a newly enqueued identical text outside its snapshot", () => {
  const { host } = hostFixture(["same", "same", "different"]);
  Object.assign(host, { followUpFlushAsOne: true, followUpFlushOriginal: ["same"] });
  host.removeDeliveredFollowUp();
  assert.deepEqual(host.followUpQueue, ["different"]);
});

test("R6: compact-only state routes steer into SDK queue, without a prompt", async () => {
  const { host, session } = hostFixture();
  session.isStreaming = false;
  session.isCompacting = true;
  const calls = [];
  session.steer = async (message) => calls.push(message);
  const result = await host.send({ type: "steer", message: "guide" });
  assert.equal(result, null);
  assert.deepEqual(calls, ["guide"]);
  assert.deepEqual(host.followUpQueue, []);
});

test("R7: explicit steer failure drops optimistic message without restoring draft or notice", async () => {
  const dropped = [];
  const env = {
    isReadOnly: false, sessionIdRef: { current: "A" },
    getOrCreateBrowserSessionRuntimeRegistry: () => ({
      getEventSource: () => ({ readyState: 1 }), appendLocal: () => "optimistic",
      dropLocal: (...args) => dropped.push(args),
    }),
    ensureEventsConnected() {}, notifyAutoFollowSend() {},
    sendAgentCommand: async () => { throw new Error("rejected"); },
    console: { error() {} },
  };
  await callback("../hooks/useAgentSession.ts", "handleSteer", env)("guide");
  assert.deepEqual(dropped, [["A", "optimistic"]]);
});

test("R8: non-streaming client blindly converts any rejected prompt into text queue", async () => {
  const requests = [];
  const queued = [];
  const env = {
    isReadOnly: false, sessionIdRef: { current: "A" }, getRuntimeAgentRunning: () => false,
    isCompacting: false, notifyAutoFollowSend() {},
    sendAgentCommand: async (_sid, command) => { requests.push(command); return { status: "rejected" }; },
    updateLocalFollowUp: async (items) => queued.push(items),
    projection: queue.projection, queueEntryNow: () => ({ confirmed: [], pending: null }),
    ensureEventsConnected() {}, opts: {}, addNotice() {}, t: (key) => key,
    console: { error() {} },
  };
  await callback("../hooks/useAgentSession.ts", "handleFollowUp", env)("no valid model");
  assert.equal(requests[0].type, "prompt");
  assert.deepEqual(queued, [["no valid model"]]);
});

test("R10: image-only follow-up returns before issuing a request", async () => {
  const env = { isReadOnly: false, sessionIdRef: { current: "A" } };
  // Any command, notice, or recovery call would require additional dependencies.
  // Returning with this minimal environment proves none of those paths ran.
  await callback("../hooks/useAgentSession.ts", "handleFollowUp", env)("", [
    { data: "fixture", mimeType: "image/png" },
  ]);
});

test("R9: busy UI without steer/follow-up callbacks routes hotkey fallback into followUp", async () => {
  const calls = [];
  const env = {
    value: "guide", attachedImages: [], hasReadyUploads: false, isStreaming: true,
    onAudioUnlock() {}, clearInput() {},
    onPromptWithStreamingBehavior: (...args) => calls.push(args),
  };
  await callback("../components/ChatInput.tsx", "handleSend", env)();
  assert.deepEqual(calls, [["guide", "followUp", undefined]]);
});
