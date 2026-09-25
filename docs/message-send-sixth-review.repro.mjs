// Sixth-review characterization for 8786f34. Passing means the residual still exists
// unless the test name says otherwise. node --test docs/message-send-sixth-review.repro.mjs
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

function callback(name, env) {
  const text = readFileSync(new URL("../hooks/useAgentSession.ts", import.meta.url), "utf8");
  const tree = ts.createSourceFile("hook.tsx", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let expression;
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(tree) === name && node.initializer
      && ts.isCallExpression(node.initializer)) {
      expression = node.initializer.arguments[0].getText(tree);
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  assert.ok(expression, name);
  const js = ts.transpileModule(`const extracted = ${expression};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  return new Function(...Object.keys(env), `${js}; return extracted;`)(...Object.values(env));
}

async function withHost(run) {
  const dir = mkdtempSync(join(tmpdir(), "pidance-sixth-review-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  let host;
  try {
    host = await startSdkSessionHost({
      sessionId: "__new__sixth", sessionFile: "", cwd: dir, agentDir: dir, toolNames: [], idleTimeoutMs: 60_000,
    });
    host.promptRunning = true;
    await run(host);
  } finally {
    if (host) {
      host.promptRunning = false;
      await host.destroyAsync();
    }
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
}

function environment(host, revision, restored, items, overrides = {}) {
  const env = {
    ...queue, normalizeFollowUpItemList, mergeFollowUpForSteer, isDefinitiveRejection,
    isReadOnly: false, sessionIdRef: { current: "A" }, currentQueueSessionIdRef: { current: "A" },
    queueBookRef: { current: { A: { items, inFlight: [], pending: [], revision: 0, serverRevision: revision, admittedAttemptIds: [] } } },
    followUpSyncRef: { current: Promise.resolve() }, publishQueue() {}, t: (key) => key,
    sendAgentCommand: (_sid, command) => host.send(command),
    notifyAutoFollowSend() {}, ensureEventsConnected() {}, addNotice() {},
    getOrCreateBrowserSessionRuntimeRegistry: () => ({ appendLocal: () => "local", dropLocal() {} }),
    queueDispatchErrorMessage: () => "conflict", attachmentsFromQueueMedia: () => [],
    opts: { chatInputRef: { current: { prependText() {}, reloadDraft() {} } } },
    restorePayloadToSession: (...args) => restored.push(args),
    ...overrides,
  };
  env.snapshotFromQueuePayload = callback("snapshotFromQueuePayload", env);
  env.adoptRemoteQueue = (sid, snapshot) => {
    env.queueBookRef.current = queue.adoptServerSnapshot(env.queueBookRef.current, sid, snapshot);
  };
  env.restorePayloads = callback("restorePayloads", env);
  env.syncQueueWrite = callback("syncQueueWrite", env);
  env.updateLocalFollowUp = callback("updateLocalFollowUp", env);
  return env;
}

test("J1: after unknown, a conflict adopts the snapshot but stale pending still wins the next successful set", async () => {
  await withHost(async (host) => {
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

    await host.send({
      type: "set_follow_up_queue",
      items: [...host.followUpQueue.map((item) => ({ id: item.id, text: item.text })), { text: "other-tab", attemptId: "tab-b" }],
      expectedRevision: host.followUpQueueRevision,
    });

    await Promise.allSettled([env.updateLocalFollowUp([
      ...queue.payloadsForWrite(queue.queueEntry(env.queueBookRef.current, "A")),
      { text: "retry", attemptId: queue.newQueueAttemptId() },
    ], "A")]);

    const afterConflict = queue.queueEntry(env.queueBookRef.current, "A");
    assert.equal(afterConflict.serverRevision, host.followUpQueueRevision);
    assert.equal(queue.hasUncertainWrite(afterConflict), true, "conflict must not drop the earlier unknown pending");
    assert.deepEqual(queue.projection(afterConflict), ["keep", "uncertain"]);

    await env.updateLocalFollowUp([
      ...queue.payloadsForWrite(afterConflict),
      { text: "foo", attemptId: queue.newQueueAttemptId() },
    ], "A");
    assert.deepEqual(
      host.followUpQueue.map((item) => item.text),
      ["keep", "uncertain", "foo"],
      "stale pending rewritten over the other tab",
    );
  });
});

test("J2: a stale declared id still first-fits another same-text waiting item", () => {
  const next = reconcileFollowUpItems(
    [{ id: "keep", text: "same", state: "waiting" }],
    [{ id: "recalled", text: "same" }],
  );
  assert.deepEqual(next.map((item) => item.id), ["keep"]);
});
