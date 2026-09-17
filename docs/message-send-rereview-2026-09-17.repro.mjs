// Regression guard for #42 (converted from the third-party re-review evidence at
// 2badb50). The original file asserted the *defects*; every assertion below now
// asserts the required behavior, so a failure means a defect came back.
// Run with Node >=22.19 from the repository root:
// node --test docs/message-send-rereview-2026-09-17.repro.mjs
// Temporary agent directories only; no live API, network or real user sessions.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import ts from "typescript";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const upload = await jiti.import("../lib/attachment-upload.ts");
const client = await jiti.import("../lib/agent-client.ts");
const commands = await jiti.import("../lib/agent-commands.ts");
const queue = await jiti.import("../lib/queue-state.ts");
const { mergeFollowUpForSteer } = await jiti.import("../lib/queue-merge.ts");
const { parseFollowUpQueue, normalizeFollowUpItemList } = await jiti.import("../lib/session-queue.ts");
const gc = await jiti.import("../lib/attachment-gc.ts");
const { startSdkSessionHost } = await jiti.import("../lib/sdk-session-host.ts");

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
function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}
function image(id) {
  const part = (kind) => ({ path: `/tmp/pidance-attachments/${id}-${kind}.png`, name: `${id}-${kind}.png`, storedName: `${id}-${kind}.png`, size: 5, mimeType: "image/png" });
  return { mimeType: "image/png", media: { model: part("model"), original: part("original"), preview: part("preview") } };
}
const hookPath = "../hooks/useAgentSession.ts";
const inputPath = "../components/ChatInput.tsx";

test("F1: prompt 请求只发附件引用，服务端必须能解码", async () => {
  const originalFetch = globalThis.fetch;
  let sent;
  globalThis.fetch = async (_url, init) => {
    sent = JSON.parse(init.body);
    return new Response(JSON.stringify({ success: true, data: { status: "accepted", sessionId: "A", submissionId: "sub" } }));
  };
  try {
    await client.submitAgentPrompt("A", { message: "restored draft", images: [image("A")], submissionId: "sub" });
    // 引用而不是内联 base64：恢复的草稿/队列条目只持路径，服务端按路径回读。
    assert.equal(sent.images[0].type, "ref");
    assert.equal(sent.images[0].data, undefined);
    assert.equal(sent.images[0].path, image("A").media.model.path);
    const parsed = commands.parsePromptCommand(sent);
    assert.equal(parsed.images.length, 1);
    assert.equal(parsed.images[0].path, image("A").media.model.path);
    assert.equal(upload.promptImageInputs([image("A")])[0].type, "ref");
  } finally { globalThis.fetch = originalFetch; }
});

test("F2: 取回后重新入队必须保留模型副本，且两张图不能错配", () => {
  const a = image("A"), b = image("B");
  const groups = upload.groupQueueMedia([a, b].flatMap(upload.imageMediaRefs));
  assert.equal(groups.length, 2);
  assert.deepEqual(
    groups.map((group) => [group.model.path, group.original.path]),
    [[a.media.model.path, a.media.original.path], [b.media.model.path, b.media.original.path]],
  );
  // 单张图：模型副本不能因为没有「上一条 original」而被丢掉。
  const one = upload.groupQueueMedia(upload.imageMediaRefs(a));
  assert.equal(one.length, 1);
  assert.equal(one[0].model.path, a.media.model.path);
  // 取回 → 重新入队：模型副本（投递用的那张）必须还在。
  const requeued = upload.imageMediaRefs(upload.attachedImageFromQueueMedia(one[0]));
  const models = requeued.filter((ref) => ref.role === "model");
  assert.equal(models.length, 1);
  assert.equal(models[0].path, a.media.model.path);
});

test("F3: 纯图队列整队引导必须真的发出派发命令", async () => {
  const sent = [];
  const env = {
    isReadOnly: false,
    sessionIdRef: { current: "A" },
    currentQueueSessionIdRef: { current: "A" },
    queueBookRef: { current: { A: { items: [{ id: "q", text: "", state: "waiting", media: upload.imageMediaRefs(image("A")) }], inFlight: [], pending: [], revision: 1, serverRevision: 1 } } },
    queueEntry: queue.queueEntry,
    projection: queue.projection,
    mergeFollowUpForSteer,
    sendAgentCommand: async (_sid, command) => {
      sent.push(command);
      return { ok: true, revision: 2, items: [], inFlight: [] };
    },
    snapshotFromQueuePayload: () => ({ items: [], inFlight: [], revision: 2 }),
    adoptRemoteQueue() {},
    publishQueue() {},
    notifyAutoFollowSend() {},
    ensureEventsConnected() {},
    getOrCreateBrowserSessionRuntimeRegistry: () => ({ appendLocal: () => "key", dropLocal() {} }),
    queueDispatchErrorMessage: () => "rejected",
    addNotice() {},
    opts: { chatInputRef: { current: { prependText() {} } } },
  };
  await callback(hookPath, "handleSendQueueAsSteer", env)();
  assert.equal(sent.length, 1, "纯图队列不得静默什么都不做");
  assert.equal(sent[0].type, "dispatch_follow_up_queue");
});

test("F3 集成：纯图条目的派发必须把图片交给 SDK", async () => {
  await withHost(async (host) => {
    const session = host.runtime.session;
    // 会话忙碌：队列被 hold 住，由用户显式派发（空闲时会自动投递，不在本用例范围）。
    Object.defineProperty(session, "isStreaming", { configurable: true, get: () => true });
    host.promptRunning = true;
    const dir = join(host.agentDir, "pidance-attachments");
    mkdirSync(dir, { recursive: true });
    const modelPath = join(dir, "only.model.png");
    const originalPath = join(dir, "only.png");
    writeFileSync(modelPath, "model-bytes");
    writeFileSync(originalPath, "original-bytes");
    const written = await host.send({
      type: "set_follow_up_queue",
      items: [{ text: "", media: [
        { role: "model", path: modelPath, name: "only.png", mimeType: "image/png", size: 11 },
        { role: "original", path: originalPath, name: "only.png", mimeType: "image/png", size: 14 },
      ] }],
    });
    assert.equal(written.ok, true, JSON.stringify(written));
    const steers = [];
    const original = session.steer;
    session.steer = async (text, images) => { steers.push([text, images]); };
    try {
      const receipt = await host.send({ type: "dispatch_follow_up_queue", expectedRevision: written.revision });
      assert.equal(receipt.ok, true);
      assert.equal(steers.length, 1, "纯图条目必须投递出去");
      assert.equal(steers[0][1].length, 1, "投递载荷必须带上图片");
    } finally { session.steer = original; }
  });
});

test("F4: 召回后在途切走会话，内容必须落进原会话草稿", async () => {
  const gate = deferred();
  const writes = [], drafts = {}, reloads = [], prepends = [];
  const env = {
    isReadOnly: false,
    sessionIdRef: { current: "A" },
    queueBookRef: { current: { A: { items: [{ id: "q", text: "A-only", state: "waiting" }], inFlight: [], pending: [], revision: 1, serverRevision: 1 } } },
    queueEntry: queue.queueEntry,
    projection: queue.projection,
    itemMediaRefs: queue.itemMediaRefs,
    attachmentsFromQueueMedia: () => [],
    getDraft: (sid) => drafts[sid] ?? null,
    setDraft: (sid, draft) => { drafts[sid] = draft; },
    updateLocalFollowUp: async (items, sid) => { writes.push({ items, sid }); await gate.promise; },
    opts: { chatInputRef: { current: {
      prependText: (...args) => prepends.push(args),
      reloadDraft: () => reloads.push(Date.now()),
    } } },
    addNotice() {},
  };
  const flight = callback(hookPath, "handleRecallQueue", env)();
  env.sessionIdRef.current = "B"; // 用户在召回请求在途时切走
  gate.resolve();
  await flight;
  assert.deepEqual(writes, [{ items: [], sid: "A" }]);
  assert.equal(drafts.A.value, "A-only", "清队后内容必须落进原会话草稿");
  assert.deepEqual(reloads, [], "已切走：不得改动当前会话输入框");
  assert.deepEqual(prepends, []);
});

test("F5: 已移除的上传完成后不得再出现，且上传文件必须立即回收", async () => {
  const gate = deferred();
  let pending = [], attached = [];
  const deleted = [];
  const pendingRef = { current: pending };
  const env = {
    draftKeyRef: { current: "A" },
    pendingAttachmentsRef: pendingRef,
    setPendingAttachments: (fn) => { pending = fn(pending); pendingRef.current = pending; },
    setAttachedImages: (fn) => { attached = fn(attached); },
    uploadImageAttachment: () => gate.promise,
    deleteAttachmentMedia: (paths) => { deleted.push(...paths); },
    imageMediaRefs: upload.imageMediaRefs,
    mediaRefPaths: upload.mediaRefPaths,
  };
  const entry = { id: "up", file: {}, previewUrl: "blob:probe", status: "uploading", draftKey: "A" };
  pending = [entry];
  pendingRef.current = pending;
  const start = callback(inputPath, "startAttachmentUpload", env);
  const flight = start(entry);
  // 用户在上传完成前移除了附件（或切走了草稿）。
  pending = [];
  pendingRef.current = pending;
  gate.resolve(image("late"));
  await flight;
  assert.equal(attached.length, 0, "已经移掉的附件不得再出现");
  assert.deepEqual(
    deleted.sort(),
    [image("late").media.model.path, image("late").media.original.path, image("late").media.preview.path].sort(),
    "没人引用的上传文件必须立即回收",
  );

  // 仍在归属内的上传照常附加。
  const gate2 = deferred();
  let pending2 = [], attached2 = [];
  const pendingRef2 = { current: pending2 };
  const env2 = { ...env,
    pendingAttachmentsRef: pendingRef2,
    setPendingAttachments: (fn) => { pending2 = fn(pending2); pendingRef2.current = pending2; },
    setAttachedImages: (fn) => { attached2 = fn(attached2); },
    uploadImageAttachment: () => gate2.promise,
  };
  const entry2 = { id: "up2", file: {}, previewUrl: "blob:probe2", status: "uploading", draftKey: "A" };
  pending2 = [entry2];
  pendingRef2.current = pending2;
  const flight2 = callback(inputPath, "startAttachmentUpload", env2)(entry2);
  gate2.resolve(image("kept"));
  await flight2;
  assert.equal(attached2.length, 1);
  assert.equal(pending2.length, 0);
});

test("F6: GC 不得删除仍被会话文件引用的附件", () => {
  const agentDir = mkdtempSync(join(tmpdir(), "pidance-review-gc-"));
  try {
    mkdirSync(join(agentDir, "pidance-attachments"));
    mkdirSync(join(agentDir, "sessions"));
    const path = join(agentDir, "pidance-attachments", "screen shot.png");
    writeFileSync(path, "bytes");
    utimesSync(path, 1, 1);
    writeFileSync(join(agentDir, "sessions", "s.jsonl"), JSON.stringify({ path, type: "pidance-binary" }) + "\n");
    const result = gc.sweepUnreferencedAttachments({ agentDir, now: Date.now() });
    assert.equal(result.complete, true);
    assert.equal(result.deleted, 0, "被引用的附件不得回收");
    assert.equal(existsSync(path), true);
  } finally { rmSync(agentDir, { recursive: true, force: true }); }
});

async function withHost(run) {
  const cwd = mkdtempSync(join(tmpdir(), "pidance-review-cwd-"));
  const agentDir = mkdtempSync(join(tmpdir(), "pidance-review-agent-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  let host;
  try {
    host = await startSdkSessionHost({ sessionId: "__new__rereview", sessionFile: "", cwd, agentDir, toolNames: [], idleTimeoutMs: 60_000 });
    host.agentDir = agentDir;
    await run(host, agentDir);
  } finally {
    if (host) {
      host.promptRunning = false;
      delete host.runtime.session.isStreaming;
      await host.destroyAsync();
    }
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(cwd, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
  }
}

test("F7: preflight 窗口的 steer 必须转成持久条目，不得挂进没人消费的 SDK 队列", async () => {
  await withHost(async (host) => {
    host.promptRunning = true; // 已有 prompt 在等 preflight
    assert.equal(host.runtime.session.isStreaming, false);
    const receipt = await host.send({ type: "steer", message: "preflight steer", submissionId: "preflight-steer" });
    assert.equal(receipt.status, "queued", "没有可消费的 run：必须转成持久队列");
    assert.equal(host.followUpQueue.length, 1);
    assert.equal(host.followUpQueue[0].text, "preflight steer");
    assert.equal(
      host.runtime.session.getSteeringMessages().includes("preflight steer"),
      false,
      "不得写进没人消费的 SDK 引导队列",
    );
  });
});

test("F8: 活跃 run 中被拒的普通 prompt 不得改动该 run 的状态", async () => {
  await withHost(async (host) => {
    const session = host.runtime.session;
    Object.defineProperty(session, "isStreaming", { configurable: true, get: () => true });
    host.promptRunning = true;
    host.lastStopReason = null;
    const events = [];
    const unsubscribe = host.onEvent((event) => events.push(event));
    try {
      const receipt = await host.send({ type: "prompt", message: "second prompt", submissionId: "second" });
      assert.equal(receipt.status, "rejected");
      assert.equal(receipt.reason, "busy");
      assert.equal(host.lastStopReason, null, "被拒的 prompt 不得把本轮标成 error");
      assert.equal(host.promptRunning, true, "本轮仍在运行");
      assert.equal(session.isStreaming, true);
      assert.equal(host.isFollowUpHeld(), false, "被拒的 prompt 不得冻住队列投递");
      assert.equal(events.some((event) => event.type === "prompt_done"), false, "不得谎报本轮已结束");
    } finally { unsubscribe(); }
  });
});

test("F10: 派发写入的认领必须能被自己的解码器读回来", async () => {
  await withHost(async (host, agentDir) => {
    const session = host.runtime.session;
    Object.defineProperty(session, "isStreaming", { configurable: true, get: () => true });
    const dir = join(agentDir, "pidance-attachments");
    mkdirSync(dir, { recursive: true });
    const refs = [];
    for (let i = 0; i < 17; i++) {
      for (const role of ["model", "original"]) {
        const path = join(dir, `${i}-${role}.png`);
        writeFileSync(path, "bytes");
        refs.push({ role, path, name: `${i}.png`, mimeType: "image/png", size: 5 });
      }
    }
    const written = await host.send({ type: "set_follow_up_queue", items: [
      { text: "first sixteen images", media: refs.slice(0, 32) },
      { text: "seventeenth image", media: refs.slice(32) },
    ] });
    assert.equal(written.ok, true, JSON.stringify(written));
    const gate = deferred();
    const original = session.steer;
    session.steer = () => gate.promise;
    try {
      const flight = host.send({ type: "dispatch_follow_up_queue", expectedRevision: written.revision });
      const prefs = JSON.parse(readFileSync(join(agentDir, "pidance-preferences.json"), "utf8"));
      const raw = prefs.sessionQueue[host.sessionId];
      assert.equal(raw.items.length, 2, "认领必须逐条落盘，不得合并成一条超限条目");
      assert.ok(raw.items.every((item) => item.state === "claimed"));
      assert.ok(raw.items.every((item) => item.media.length <= 32));
      const decoded = parseFollowUpQueue(raw);
      assert.equal(decoded.items.length, 2, "落盘的认领必须能 round-trip 解码（重启后内容不消失）");
      gate.resolve();
      await flight;
    } finally { session.steer = original; gate.resolve(); }
  });
});

test("F11: 冲突时不得覆盖另一个标签页的队列，也不得吞掉本地写入", async () => {
  await withHost(async (host) => {
    Object.defineProperty(host.runtime.session, "isStreaming", { configurable: true, get: () => true });
    const initial = await host.send({ type: "set_follow_up_queue", items: ["x", "other-tab"] });
    assert.equal(initial.revision, 1);
    const env = { ...queue, normalizeFollowUpItemList,
      queueBookRef: { current: { A: { items: [{ id: "x", text: "x", state: "waiting" }], inFlight: [], pending: [], revision: 0, serverRevision: 0 } } },
      currentQueueSessionIdRef: { current: "A" }, sessionIdRef: { current: "A" },
      followUpSyncRef: { current: Promise.resolve() }, publishQueue() {}, t: (key) => key,
      sendAgentCommand: (_sid, command) => host.send(command) };
    env.snapshotFromQueuePayload = callback(hookPath, "snapshotFromQueuePayload", env);
    const update = callback(hookPath, "updateLocalFollowUp", env);
    const first = update(["x", "mine-1"], "A");
    const second = update(["x", "mine-1", "mine-2"], "A");
    const results = await Promise.allSettled([first, second]);
    // 两个本地写入都基于过期版本：都必须失败（内容由调用方退回输入框），
    // 但服务端的队列必须原样保留另一标签页的条目。
    assert.equal(results[0].status, "rejected");
    assert.equal(results[1].status, "rejected");
    assert.deepEqual(host.followUpQueue.map((item) => item.text), ["x", "other-tab"]);
  });
});

test("F9: 同一 submissionId 的并发 steer 只能让 SDK 收到一次", async () => {
  await withHost(async (host) => {
    const session = host.runtime.session;
    Object.defineProperty(session, "isStreaming", { configurable: true, get: () => true });
    const gate = deferred();
    const original = session.steer;
    let calls = 0;
    session.steer = async () => { calls += 1; await gate.promise; };
    try {
      const command = { type: "steer", message: "same submission", submissionId: "same" };
      const a = host.send(command), b = host.send(command);
      gate.resolve();
      const receipts = await Promise.all([a, b]);
      assert.equal(calls, 1, "同一提交不得让 SDK 收到两次");
      assert.ok(receipts.every((receipt) => receipt.status === "accepted"));
    } finally { session.steer = original; gate.resolve(); }
  });
});
