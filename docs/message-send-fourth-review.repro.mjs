// Fourth review: defect-characterization probes. Temporary Host only; no model calls.
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import ts from 'typescript';
import { createJiti } from 'jiti';
const jiti = createJiti(import.meta.url);
const queue = await jiti.import('../lib/queue-state.ts');
const { normalizeFollowUpItemList } = await jiti.import('../lib/session-queue.ts');
const { mergeFollowUpForSteer } = await jiti.import('../lib/queue-merge.ts');
const { startSdkSessionHost } = await jiti.import('../lib/sdk-session-host.ts');
function callback(name, env) {
  const text = readFileSync(new URL(env.__source ?? '../hooks/useAgentSession.ts', import.meta.url), 'utf8');
  const tree = ts.createSourceFile('hook.tsx', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let expression;
  function visit(n) {
    if (ts.isVariableDeclaration(n) && n.name.getText(tree) === name && n.initializer && ts.isCallExpression(n.initializer)) expression = n.initializer.arguments[0].getText(tree);
    ts.forEachChild(n, visit);
  }
  visit(tree);
  assert.ok(expression);
  const js = ts.transpileModule(`const extracted = ${expression};`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  return new Function(...Object.keys(env), `${js}; return extracted;`)(...Object.values(env));
}
async function withHost(run) {
  const dir = mkdtempSync(join(tmpdir(), 'pidance-third-review-'));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  let host;
  try {
    host = await startSdkSessionHost({ sessionId: '__new__thirdreview', sessionFile: '', cwd: dir, agentDir: dir, toolNames: [], idleTimeoutMs: 60000 });
    host.agentDir = dir;
    Object.defineProperty(host.runtime.session, 'isStreaming', { configurable: true, get: () => true });
    await run(host);
  } finally {
    if (host) { host.promptRunning = false; delete host.runtime.session.isStreaming; await host.destroyAsync(); }
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
}
function environment(host, revision, restored = []) {
  const env = { ...queue, normalizeFollowUpItemList, mergeFollowUpForSteer,
    isReadOnly: false,
    sessionIdRef: { current: 'A' }, currentQueueSessionIdRef: { current: 'A' },
    queueBookRef: { current: { A: { items: [{ id: 'x', text: 'x', state: 'waiting' }], inFlight: [], pending: [], revision: 0, serverRevision: revision } } },
    followUpSyncRef: { current: Promise.resolve() }, publishQueue() {}, t: (x) => x,
    sendAgentCommand: (_sid, command) => host.send(command),
    notifyAutoFollowSend() {}, ensureEventsConnected() {},
    getOrCreateBrowserSessionRuntimeRegistry: () => ({ appendLocal: () => 'local', dropLocal() {} }),
    queueDispatchErrorMessage: () => 'conflict', addNotice() {},
    opts: { chatInputRef: { current: { prependText() {}, reloadDraft() {} } } },
    attachmentsFromQueueMedia: () => [],
    restorePayloadToSession: (...args) => restored.push(args),
  };
  env.snapshotFromQueuePayload = callback('snapshotFromQueuePayload', env);
  env.adoptRemoteQueue = (_sid, snapshot) => { env.queueBookRef.current = queue.adoptServerSnapshot(env.queueBookRef.current, 'A', snapshot); };
  env.updateLocalFollowUp = callback('updateLocalFollowUp', env);
  return env;
}

test('H1: revision conflict restores x to draft while x remains queued', async () => {
  await withHost(async (host) => {
    await host.send({ type: 'set_follow_up_queue', items: ['x', 'other'] });
    const restored = [];
    const env = environment(host, 0, restored);
    await callback('handleSendQueueAsSteer', env)();
    assert.ok(host.followUpQueue.some((item) => item.text === 'x'));
    assert.equal(restored[0][1].text, 'x');
  });
});
test('H1b: a definitely rejected recall restores an item which was never removed', async () => {
  await withHost(async (host) => {
    await host.send({ type: 'set_follow_up_queue', items: ['x', 'other'] });
    const restored = [];
    const env = environment(host, 0, restored);
    await callback('handleRecallQueue', env)();
    assert.ok(host.followUpQueue.some((item) => item.text === 'x'));
    assert.equal(restored[0][1].text, 'x');
  });
});
test('H2: successful recall restores a captured item that became claimed before the clear', async () => {
  await withHost(async (host) => {
    const written = await host.send({ type: 'set_follow_up_queue', items: ['x'] });
    const env = environment(host, written.revision);
    const drafts = {};
    env.getDraft = (sid) => drafts[sid];
    env.setDraft = (sid, value) => { drafts[sid] = value; };
    let resolve;
    const gate = new Promise((r) => { resolve = r; });
    const session = host.runtime.session;
    const originalSteer = session.steer;
    session.steer = () => gate;
    let dispatch;
    try {
      const recall = callback('handleRecallQueue', env)();
      // Another view claims x, and the newer state arrives before the queued clear executes.
      dispatch = host.send({ type: 'dispatch_follow_up_queue', expectedRevision: written.revision });
      env.adoptRemoteQueue('A', env.snapshotFromQueuePayload(host.queueReceiptBase()));
      await recall;
      assert.equal(drafts.A.value, 'x');
      assert.ok(host.followUpQueue.some((i) => i.text === 'x' && i.state === 'claimed'));
    } finally {
      resolve();
      if (dispatch) await dispatch;
      session.steer = originalSteer;
    }
  });
});
test('H3: attachment send completion clears the newly selected session draft', async () => {
  let resolve;
  const gate = new Promise((r) => { resolve = r; });
  const cleared = [];
  const draftKeyRef = { current: 'A' };
  const env = {
    __source: '../components/ChatInput.tsx',
    value: 'A-message', attachedImages: [{ mimeType: 'image/png' }], attachedUploads: [],
    hasReadyUploads: false, hasUploading: false, hasFailedAttachments: false, isStreaming: false,
    onAudioUnlock() {}, onBuiltinCommand: null, onPromptWithStreamingBehavior: null,
    draftKeyRef, clearInput: () => cleared.push(draftKeyRef.current),
    composeMessageWithUploads: (s) => s, attachmentBinaryBlocks: () => [], onSend: () => gate,
  };
  const send = callback('handleSend', env)();
  draftKeyRef.current = 'B';
  resolve(true);
  await send;
  assert.deepEqual(cleared, ['B']);
});
