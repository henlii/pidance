/**
 * 客户端队列路径的「切走后不得丢内容」回归（issue #42 第三轮复核 G1–G3）。
 *
 * 三条都源自同一个缺陷族：失败/召回路径用「用户当前看哪个会话」决定内容归属，
 * 于是切走会话时正文与图片被静默丢弃、或者用本地过期条目盖住服务端权威状态。
 * 这里用真实 Host（set_follow_up_queue/dispatch，不调用模型）驱动，断言的是
 * 修复后的行为：权威快照优先、载荷退回**原会话**。
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import ts from "typescript";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const queue = await jiti.import("../lib/queue-state.ts");
const { normalizeFollowUpItemList } = await jiti.import("../lib/session-queue.ts");
const { mergeFollowUpForSteer } = await jiti.import("../lib/queue-merge.ts");
const { startSdkSessionHost } = await jiti.import("../lib/sdk-session-host.ts");

/** 从 hook 源码里取出一个 useCallback 定义（与 docs 里的复核探针同一手法）。 */
function callback(name, env) {
  const text = readFileSync(new URL("./useAgentSession.ts", import.meta.url), "utf8");
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
  assert.ok(expression, `Missing callback: ${name}`);
  const js = ts.transpileModule(`const extracted = ${expression};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  return new Function(...Object.keys(env), `${js}; return extracted;`)(...Object.values(env));
}

async function withHost(run) {
  const dir = mkdtempSync(join(tmpdir(), "pidance-hook-queue-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  let host;
  try {
    host = await startSdkSessionHost({ sessionId: "__new__hookqueue", sessionFile: "", cwd: dir, agentDir: dir, toolNames: [], idleTimeoutMs: 60_000 });
    host.agentDir = dir;
    Object.defineProperty(host.runtime.session, "isStreaming", { configurable: true, get: () => true });
    await run(host, dir);
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

/** 构造一个最小的 hook 环境：会话 A 已有一批本地条目，服务端版本由调用方给出。 */
function environment(host, revision, restored) {
  const env = { ...queue, normalizeFollowUpItemList, mergeFollowUpForSteer,
    isReadOnly: false,
    sessionIdRef: { current: "A" },
    currentQueueSessionIdRef: { current: "A" },
    queueBookRef: { current: { A: { items: [{ id: "x", text: "x", state: "waiting" }], inFlight: [], pending: [], revision: 0, serverRevision: revision } } },
    followUpSyncRef: { current: Promise.resolve() },
    publishQueue() {},
    t: (key) => key,
    sendAgentCommand: (_sid, command) => host.send(command),
    notifyAutoFollowSend() {},
    ensureEventsConnected() {},
    getOrCreateBrowserSessionRuntimeRegistry: () => ({ appendLocal: () => "local", dropLocal() {} }),
    queueDispatchErrorMessage: () => "conflict",
    addNotice() {},
    attachmentsFromQueueMedia: () => [],
    opts: { chatInputRef: { current: { prependText() {}, reloadDraft() {} } } },
    // 内容归还的出口：断言「退回到哪个会话、退回什么载荷」。
    restorePayloadToSession: (...args) => restored.push(args),
  };
  env.snapshotFromQueuePayload = callback("snapshotFromQueuePayload", env);
  env.adoptRemoteQueue = (sid, snapshot) => {
    env.queueBookRef.current = queue.adoptServerSnapshot(env.queueBookRef.current, sid, snapshot);
  };
  env.updateLocalFollowUp = callback("updateLocalFollowUp", env);
  return env;
}

test("G1: 派发冲突必须采纳权威快照，并把本轮载荷退回原会话", async () => {
  await withHost(async (host) => {
    await host.send({ type: "set_follow_up_queue", items: ["x", "other-tab"] });
    const restored = [];
    // 本地认为服务端还是版本 0（另一个标签页刚在版本 1 追加了 other-tab）。
    const env = environment(host, 0, restored);
    await callback("handleSendQueueAsSteer", env)();

    const entry = queue.queueEntry(env.queueBookRef.current, "A");
    assert.equal(entry.serverRevision, 1, "必须前移到权威版本");
    assert.deepEqual(
      entry.items.map((item) => item.text),
      ["x", "other-tab"],
      "不得用本地过期条目覆盖权威内容（否则下一次写入会删掉别人的消息）",
    );
    assert.equal(restored.length, 1, "冲突导致本轮载荷离开队列：必须退回原会话");
    assert.equal(restored[0][0], "A");
    assert.equal(restored[0][1].text, "x");

    // 后续写入基于新基线：另一标签页的条目必须还在。
    await env.updateLocalFollowUp([...queue.payloadsForWrite(entry), { text: "mine" }], "A");
    assert.deepEqual(host.followUpQueue.map((item) => item.text), ["x", "other-tab", "mine"]);
  });
});

test("G2: 乐观入队在途时召回，必须把用户看到的内容全部退回", async () => {
  await withHost(async (host) => {
    const initial = await host.send({ type: "set_follow_up_queue", items: ["x"] });
    const restored = [];
    const env = environment(host, initial.revision, restored);
    const drafts = {};
    env.getDraft = (sid) => drafts[sid];
    env.setDraft = (sid, value) => { drafts[sid] = value; };

    const enqueue = env.updateLocalFollowUp(["x", "new-message"], "A");
    const recall = callback("handleRecallQueue", env)();
    await Promise.all([enqueue, recall]);

    assert.deepEqual(host.followUpQueue, [], "召回必须真的清空队列");
    assert.equal(drafts.A.value.includes("x"), true);
    assert.equal(
      drafts.A.value.includes("new-message"),
      true,
      "乐观入队里用户刚敲的内容不能被静默丢掉",
    );
  });
});

test("G3: 切走会话后入队失败，内容必须退回原会话（不依赖当前会话）", async () => {
  let reject;
  const gate = new Promise((_resolve, reject_) => { reject = reject_; });
  const restored = [];
  const drafts = {};
  const env = { ...queue,
    isReadOnly: false,
    isCompacting: false,
    sessionIdRef: { current: "A" },
    currentQueueSessionIdRef: { current: "A" },
    queueBookRef: { current: {} },
    getRuntimeAgentRunning: () => true,
    notifyAutoFollowSend() {},
    toQueuePayloads: (text) => [{ text }],
    updateLocalFollowUp: () => gate,
    getDraft: (sid) => drafts[sid],
    setDraft: (sid, value) => { drafts[sid] = value; },
    restorePayloadToSession: (...args) => restored.push(args),
    opts: { chatInputRef: null },
    addNotice() {},
    ensureEventsConnected() {},
    t: (key) => key,
  };
  const flight = callback("handleFollowUp", env)("original-A");
  // 请求在途时用户切到会话 B：内容属于 A，必须落进 A 的草稿。
  env.sessionIdRef.current = "B";
  reject(new Error("queue conflict"));
  await flight;
  assert.equal(restored.length, 1);
  assert.equal(restored[0][0], "A");
  assert.equal(restored[0][1].text, "original-A");
});
