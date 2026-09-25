// Fifth-review characterization. Passing means the residual defect still exists.
// node --test docs/message-send-fifth-review.repro.mjs
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import ts from "typescript";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const queue = await jiti.import("../lib/queue-state.ts");
const { normalizeFollowUpItemList, reconcileFollowUpItems } = await jiti.import("../lib/session-queue.ts");
const { mergeFollowUpForSteer } = await jiti.import("../lib/queue-merge.ts");
const { isDefinitiveRejection } = await jiti.import("../lib/agent-client.ts");
const { startSdkSessionHost } = await jiti.import("../lib/sdk-session-host.ts");
const { parseTypedMessageCommand } = await jiti.import("../lib/agent-commands.ts");

function callback(file, name, env) {
  const text = readFileSync(new URL(file, import.meta.url), "utf8");
  const tree = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let expression;
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(tree) === name && node.initializer
      && ts.isCallExpression(node.initializer)) {
      expression = node.initializer.arguments[0].getText(tree);
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  assert.ok(expression, `Missing callback: ${name}`);
  const js = ts.transpileModule(`const extracted = ${expression};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  return new Function(...Object.keys(env), `${js}; return extracted;`)(...Object.values(env));
}

async function withHost(run, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pidance-fifth-review-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  let host;
  try {
    host = await startSdkSessionHost({
      sessionId: "__new__fifthreview", sessionFile: "", cwd: dir, agentDir: dir, toolNames: [], idleTimeoutMs: 60_000,
    });
    host.agentDir = dir;
    if (options.streaming !== false) {
      Object.defineProperty(host.runtime.session, "isStreaming", { configurable: true, get: () => true });
    }
    await run(host);
  } finally {
    if (host) {
      host.promptRunning = false;
      delete host.runtime.session.isStreaming;
      await host.destroyAsync();
    }
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
}

function environment(host, revision, restored = [], items = [], overrides = {}) {
  const env = {
    ...queue, normalizeFollowUpItemList, mergeFollowUpForSteer, isDefinitiveRejection,
    isReadOnly: false, sessionIdRef: { current: "A" }, currentQueueSessionIdRef: { current: "A" },
    queueBookRef: { current: { A: { items, inFlight: [], pending: [], revision: 0, serverRevision: revision, admittedAttemptIds: [] } } },
    followUpSyncRef: { current: Promise.resolve() }, publishQueue() {}, t: (key) => key,
    sendAgentCommand: (_sid, command) => host.send(command),
    notifyAutoFollowSend() {}, ensureEventsConnected() {},
    getOrCreateBrowserSessionRuntimeRegistry: () => ({ appendLocal: () => "local", dropLocal() {} }),
    queueDispatchErrorMessage: () => "conflict", addNotice() {},
    attachmentsFromQueueMedia: () => [],
    opts: { chatInputRef: { current: { prependText() {}, reloadDraft() {} } } },
    restorePayloadToSession: (...args) => restored.push(args),
    ...overrides,
  };
  env.snapshotFromQueuePayload = callback("../hooks/useAgentSession.ts", "snapshotFromQueuePayload", env);
  env.adoptRemoteQueue = (sid, snapshot) => {
    env.queueBookRef.current = queue.adoptServerSnapshot(env.queueBookRef.current, sid, snapshot);
  };
  env.restorePayloads = callback("../hooks/useAgentSession.ts", "restorePayloads", env);
  env.syncQueueWrite = callback("../hooks/useAgentSession.ts", "syncQueueWrite", env);
  env.updateLocalFollowUp = callback("../hooks/useAgentSession.ts", "updateLocalFollowUp", env);
  return env;
}

test("I1: set_follow_up_queue does not cache successful writes; same submissionId can apply twice", async () => {
  await withHost(async (host) => {
    host.promptRunning = true;
    const first = await host.send({
      type: "set_follow_up_queue",
      items: [{ text: "once", attemptId: "try-once" }],
      submissionId: "same-set",
      expectedRevision: null,
    });
    assert.equal(first.ok, true);
    const second = await host.send({
      type: "set_follow_up_queue",
      items: [{ text: "once", attemptId: "try-once" }, { text: "twice", attemptId: "try-twice" }],
      submissionId: "same-set",
      expectedRevision: first.revision,
    });
    assert.equal(second.ok, true, JSON.stringify(second));
    assert.deepEqual(host.followUpQueue.map((item) => item.text), ["once", "twice"]);
  }, { streaming: false });
});

test("I2: recall captures waiting ids only after earlier writes settle, so a newly admitted item is taken back", async () => {
  await withHost(async (host) => {
    host.promptRunning = true;
    const written = await host.send({ type: "set_follow_up_queue", items: ["x"] });
    const restored = [];
    const env = environment(host, written.revision, restored, written.items);
    const enqueue = env.updateLocalFollowUp([
      ...queue.payloadsForWrite(queue.queueEntry(env.queueBookRef.current, "A")),
      { text: "new-message", attemptId: queue.newQueueAttemptId() },
    ], "A");
    const recall = callback("../hooks/useAgentSession.ts", "handleRecallQueue", env)();
    await Promise.all([enqueue, recall]);
    assert.deepEqual(host.followUpQueue, []);
    assert.equal(JSON.stringify(restored).includes("new-message"), true);
  }, { streaming: false });
});

test("I3: an uncertain write does not block a later enqueue that replaces the whole queue", async () => {
  await withHost(async (host) => {
    host.promptRunning = true;
    const written = await host.send({ type: "set_follow_up_queue", items: ["keep"] });
    const restored = [];
    let calls = 0;
    const env = environment(host, written.revision, restored, written.items, {
      sendAgentCommand: async (_sid, command) => {
        calls += 1;
        if (calls === 1) throw new Error("network down");
        return host.send(command);
      },
    });
    const first = env.updateLocalFollowUp([
      ...queue.payloadsForWrite(queue.queueEntry(env.queueBookRef.current, "A")),
      { text: "uncertain", attemptId: queue.newQueueAttemptId() },
    ], "A");
    const second = env.updateLocalFollowUp([{ text: "replacement", attemptId: queue.newQueueAttemptId() }], "A");
    const results = await Promise.allSettled([first, second]);
    assert.equal(results[0].status, "rejected", String(results[0].reason));
    assert.equal(results[1].status, "fulfilled", String(results[1].reason));
    assert.deepEqual(host.followUpQueue.map((item) => item.text), ["replacement"]);
    assert.deepEqual(restored, [], "uncertain payload was neither restored nor kept");
  }, { streaming: false });
});

test("I4: whole-queue replace still matches same-text items by first-fit, not by id", () => {
  const current = [
    { id: "waiting-id", text: "same", state: "waiting" },
    { id: "unknown-id", text: "same", state: "unknown" },
  ];
  const sameOrder = reconcileFollowUpItems(current, [{ text: "same" }, { text: "same" }]);
  assert.deepEqual(sameOrder.map((item) => [item.id, item.state]), [["waiting-id", "waiting"], ["unknown-id", "unknown"]]);
  const reversedPayloads = reconcileFollowUpItems(current, [{ text: "same" }, { text: "same" }]);
  // Without ids, reversing the intended identity is inexpressible: first payload always takes waiting-id.
  assert.equal(reversedPayloads[0].id, "waiting-id");
  const dropOne = reconcileFollowUpItems(current, [{ text: "same" }]);
  assert.deepEqual(dropOne.map((item) => item.id), ["waiting-id"], "omitting one identical text drops the first match, not a chosen id");
});

test("I7: successful recall after an uncertain enqueue leaves the stale pending projection", async () => {
  await withHost(async (host) => {
    host.promptRunning = true;
    const written = await host.send({ type: "set_follow_up_queue", items: ["keep"] });
    const restored = [];
    let calls = 0;
    const env = environment(host, written.revision, restored, written.items, {
      sendAgentCommand: async (_sid, command) => {
        calls += 1;
        if (calls === 1) throw new Error("network down");
        return host.send(command);
      },
    });
    await Promise.allSettled([env.updateLocalFollowUp([
      ...queue.payloadsForWrite(queue.queueEntry(env.queueBookRef.current, "A")),
      { text: "uncertain", attemptId: queue.newQueueAttemptId() },
    ], "A")]);
    await callback("../hooks/useAgentSession.ts", "handleRecallQueue", env)();
    const entry = queue.queueEntry(env.queueBookRef.current, "A");
    assert.deepEqual(host.followUpQueue, []);
    assert.equal(queue.hasUncertainWrite(entry), true);
    assert.deepEqual(queue.projection(entry), ["keep", "uncertain"]);
  }, { streaming: false });
});

test("I5: route parses recall_follow_up_queue", () => {
  const command = parseTypedMessageCommand({
    type: "recall_follow_up_queue",
    itemIds: ["abc"],
    submissionId: "sub-1",
  });
  assert.equal(command.type, "recall_follow_up_queue");
  assert.deepEqual(command.itemIds, ["abc"]);
});

test("I6: settleSentDraft prefix-strips overlapping later edits", () => {
  const calls = { values: [], images: [], uploads: [], cleared: [] };
  const env = {
    sentDraftRef: { current: { key: "A", value: "hello", imageKeys: ["/a.png"], uploadPaths: [] } },
    draftKeyRef: { current: "A" },
    valueRef: { current: "hellohello" },
    attachedImagesRef: { current: [{ media: { original: { path: "/a.png" } } }] },
    attachedUploadsRef: { current: [] },
    attachmentIdentity: (image) => image.media.original.path,
    getDraft: () => null,
    clearDraft() {},
    clearInput: () => calls.cleared.push("A"),
    setValue: (next) => calls.values.push(next),
    setAttachedImages: (update) => calls.images.push(update([{ media: { original: { path: "/a.png" } } }])),
    setAttachedUploads: (update) => calls.uploads.push(update([])),
  };
  callback("../components/ChatInput.tsx", "settleSentDraft", env)();
  assert.deepEqual(calls.values, ["hello"]);
  assert.deepEqual(calls.cleared, []);
});
