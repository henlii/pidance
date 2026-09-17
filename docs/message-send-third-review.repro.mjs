// Regression probes for the client queue paths of #42 (third review, G1-G3).
//
// As delivered by the reviewer these probes characterized 40ba79b — they passed
// while the defects were present. They are converted here so that **passing
// means the required behavior holds**; the defect assertions are inverted and
// the environment now supplies the restore path the fix introduced.
// Permanent equivalents live in hooks/useAgentSessionQueue.test.mjs.
// node --test docs/message-send-third-review.repro.mjs
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
  const text = readFileSync(new URL('../hooks/useAgentSession.ts', import.meta.url), 'utf8');
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
test('G1: dispatch conflict adopts the authoritative snapshot and restores the dispatched payload', async () => {
  await withHost(async (host) => {
    await host.send({ type: 'set_follow_up_queue', items: ['x', 'other-tab'] });
    const restored = [];
    const env = environment(host, 0, restored);
    await callback('handleSendQueueAsSteer', env)();
    const entry = queue.queueEntry(env.queueBookRef.current, 'A');
    assert.equal(entry.serverRevision, 1);
    // 权威内容（含另一个标签页的条目）必须一起采纳；不得用本地过期条目配新版本。
    assert.deepEqual(entry.items.map((i) => i.text), ['x', 'other-tab']);
    // 本轮载荷已不在权威队列里：必须退回原会话输入框，不得静默消失。
    assert.equal(restored.length, 1);
    assert.equal(restored[0][0], 'A');
    assert.equal(restored[0][1].text, 'x');
    await env.updateLocalFollowUp([...queue.payloadsForWrite(entry), { text: 'mine' }], 'A');
    assert.deepEqual(host.followUpQueue.map((i) => i.text), ['x', 'other-tab', 'mine']);
  });
});
test('G2: recall during an optimistic enqueue restores everything the user can see', async () => {
  await withHost(async (host) => {
    const initial = await host.send({ type: 'set_follow_up_queue', items: ['x'] });
    const env = environment(host, initial.revision);
    const drafts = {};
    env.getDraft = (sid) => drafts[sid];
    env.setDraft = (sid, value) => { drafts[sid] = value; };
    const enqueue = env.updateLocalFollowUp(['x', 'new-message'], 'A');
    const recall = callback('handleRecallQueue', env)();
    await Promise.all([enqueue, recall]);
    assert.deepEqual(host.followUpQueue, []);
    assert.equal(drafts.A.value.includes('x'), true);
    // 乐观入队里用户刚敲的内容不能被静默丢掉。
    assert.equal(drafts.A.value.includes('new-message'), true);
  });
});

test('G3: rejected enqueue after switching sessions still restores the original session payload', async () => {
  let reject;
  const gate = new Promise((_resolve, r) => { reject = r; });
  const restored = [];
  const env = { ...queue,
    isReadOnly: false, isCompacting: false,
    sessionIdRef: { current: 'A' }, queueBookRef: { current: {} },
    getRuntimeAgentRunning: () => true, notifyAutoFollowSend() {},
    toQueuePayloads: (text) => [{ text }],
    updateLocalFollowUp: () => gate,
    restorePayloadToSession: (...args) => restored.push(args),
    opts: { chatInputRef: null },
    addNotice() {}, ensureEventsConnected() {}, t: (s) => s,
  };
  const flight = callback('handleFollowUp', env)('original-A');
  env.sessionIdRef.current = 'B';
  reject(new Error('queue conflict'));
  await flight;
  // 内容属于会话 A：切走后仍必须退回 A（不是当前会话，也不是丢掉）。
  assert.equal(restored.length, 1);
  assert.equal(restored[0][0], 'A');
  assert.equal(restored[0][1].text, 'original-A');
});
