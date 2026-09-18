/**
 * 「内容归谁」的交错回归（issue #42 第四轮复核 H1–H3）。
 *
 * 判定规则只有一条：**只有从未被队列受理过的载荷**才能在失败时变成可重发的
 * 草稿；队列仍持有的条目、结果未知的写入都不复制成草稿（宁可不恢复，也不要
 * 复制出重复副本）。这里用真实 Host（只走 set/dispatch/recall，不调用模型）
 * 驱动 hook 里的真实回调，每条交错一个用例。
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
const { isDefinitiveRejection } = await jiti.import("../lib/agent-client.ts");
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

/** 从 hook 源码里取出一个模块级函数声明（callback 只处理 useCallback 形式）。 */
function functionSource(name, env) {
  const text = readFileSync(new URL("./useAgentSession.ts", import.meta.url), "utf8");
  const tree = ts.createSourceFile("hook.tsx", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let source;
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name && node.name.getText(tree) === name && node.body) {
      source = node.getText(tree);
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  assert.ok(source, `Missing function: ${name}`);
  const js = ts.transpileModule(`${source}`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  return new Function(...Object.keys(env), `${js}; return ${name};`)(...Object.values(env));
}

/**
 * 真实 Host + 最小 hook 环境。
 *
 * `overrides` 在抽取回调**之前**合并：回调体里的标识符是 new Function 的形参，
 * 抽取之后再改 env 上的属性不会影响已提取的函数。`streaming: false` 用来让
 * 队列条目停留在等待态（不被自动投递认领）。
 */
async function withHost(run, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pidance-hook-queue-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  let host;
  try {
    host = await startSdkSessionHost({ sessionId: "__new__hookqueue", sessionFile: "", cwd: dir, agentDir: dir, toolNames: [], idleTimeoutMs: 60_000 });
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

/** `restored` 收集「归还到草稿/输入框」的调用（会话 id + 载荷），是断言内容归属的出口。 */
function environment(host, revision, restored = [], items = [], overrides = {}) {
  const env = {
    ...queue,
    normalizeFollowUpItemList,
    mergeFollowUpForSteer,
    isDefinitiveRejection,
    isReadOnly: false,
    sessionIdRef: { current: "A" },
    currentQueueSessionIdRef: { current: "A" },
    queueBookRef: { current: { A: { items, inFlight: [], pending: [], revision: 0, serverRevision: revision, admittedAttemptIds: [] } } },
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

/** 归还记录 → 可断言的扁平载荷（正文 + 媒体路径）。 */
function restoredPayloads(restored) {
  return restored.map(([sid, payload]) => ({
    sid,
    text: (payload.text ?? "").trim(),
    media: (payload.media ?? []).map((ref) => ref.path),
  }));
}

/** 模拟「服务端确定拒绝」（4xx）与「结果未知」（网络错误）。 */
function definitiveRejectionError() {
  const error = new Error("bad request");
  error.agentCommandStatus = 400;
  return error;
}

test("H1-a：派发冲突时队列条目留在队列，只有未受理的 extra 回到输入框", async () => {
  await withHost(async (host) => {
    const written = await host.send({ type: "set_follow_up_queue", items: ["x", "other-tab"] });
    const restored = [];
    // 本地基线停在版本 0（另一个标签页已在版本 1 追加了 other-tab）。
    const env = environment(host, 0, restored, written.items);
    await callback("handleSendQueueAsSteer", env)("extra-text");

    const entry = queue.queueEntry(env.queueBookRef.current, "A");
    assert.equal(entry.serverRevision, 1, "必须采纳权威版本");
    assert.deepEqual(
      entry.items.map((item) => item.text),
      ["x", "other-tab"],
      "不得用本地过期条目覆盖权威内容",
    );
    assert.deepEqual(
      restoredPayloads(restored),
      [{ sid: "A", text: "extra-text", media: [] }],
      "冲突后队列条目仍归队列：只能退回从未入队的 extra，不得复制成草稿（H1）",
    );
  });
});

test("H1-b：入队确定拒绝且载荷从未受理 → 退回原会话草稿", async () => {
  await withHost(async (host) => {
    await host.send({ type: "set_follow_up_queue", items: ["x", "other-tab"] });
    const restored = [];
    const env = environment(host, 0, restored, [], {
      sendAgentCommand: async () => {
        throw definitiveRejectionError();
      },
    });
    const payload = { text: "mine", attemptId: queue.newQueueAttemptId() };
    await assert.rejects(env.updateLocalFollowUp([{ text: "mine" }, payload], "A"));
    assert.deepEqual(
      restoredPayloads(restored),
      [{ sid: "A", text: "mine", media: [] }],
      "服务端确定拒绝且从未受理：内容必须回到原会话草稿",
    );
    assert.deepEqual(host.followUpQueue.map((item) => item.text), ["x", "other-tab"]);
  });
});

test("H1-c：入队结果未知 → 留在队列侧待确认，不复制成草稿", async () => {
  await withHost(async (host) => {
    const written = await host.send({ type: "set_follow_up_queue", items: ["x"] });
    const restored = [];
    const env = environment(host, written.revision, restored, written.items, {
      sendAgentCommand: async () => {
        throw new Error("network down");
      },
    });
    const payload = { text: "mine", attemptId: queue.newQueueAttemptId() };
    await assert.rejects(env.updateLocalFollowUp([...queue.payloadsForWrite(queue.queueEntry(env.queueBookRef.current, "A")), payload], "A"));

    assert.deepEqual(restoredPayloads(restored), [], "结果未知不得恢复（否则可能重复发送）");
    const entry = queue.queueEntry(env.queueBookRef.current, "A");
    assert.equal(queue.hasUncertainWrite(entry), true, "内容留在队列侧标记待确认");
    assert.equal(
      queue.queueRows(entry).some((row) => row.text === "mine" && row.state === "unknown"),
      true,
      "待确认条目必须仍对用户可见",
    );
    assert.deepEqual(host.followUpQueue.map((item) => item.text), ["x"], "网络失败：服务端队列保持原样");
  });
});

test("H1-d：冲突但载荷早已被队列受理 → 不恢复（队列里那份就是它的）", async () => {
  await withHost(async (host) => {
    const attemptId = queue.newQueueAttemptId();
    const admitted = await host.send({ type: "set_follow_up_queue", items: [{ text: "mine", attemptId }] });
    const restored = [];
    // 本地基线过期：服务端已经版本 1，本地还以为 0。
    const env = environment(host, 0, restored, admitted.items);
    await assert.rejects(env.updateLocalFollowUp([{ text: "mine", attemptId }], "A"));

    assert.deepEqual(restoredPayloads(restored), [], "已受理的载荷不得再变成草稿副本（H1 核心）");
    assert.deepEqual(host.followUpQueue.map((item) => item.text), ["mine"]);
  });
});

test("H2-a：召回只退回回执确认移交的条目，已认领的跳过", async () => {
  await withHost(async (host) => {
    const written = await host.send({ type: "set_follow_up_queue", items: ["x", "y"] });
    const restored = [];
    const env = environment(host, written.revision, restored, written.items);
    let resolveSteer;
    const gate = new Promise((resolve) => { resolveSteer = resolve; });
    const session = host.runtime.session;
    const originalSteer = session.steer;
    session.steer = () => gate;
    let dispatch;
    try {
      // 另一个视图整队投递：x/y 被认领交给 Pi（steer 挂起，尚未真的投递）。
      dispatch = host.send({ type: "dispatch_follow_up_queue", expectedRevision: written.revision });
      await new Promise((resolve) => setTimeout(resolve, 20));
      env.adoptRemoteQueue("A", env.snapshotFromQueuePayload(host.queueReceiptBase()));
      await callback("handleRecallQueue", env)();

      assert.deepEqual(restoredPayloads(restored), [], "已认领的条目不得退回草稿（H2）");
      assert.deepEqual(
        host.followUpQueue.map((item) => [item.text, item.state]),
        [["x", "claimed"], ["y", "claimed"]],
        "已提交给 Agent 的内容无法撤回",
      );
    } finally {
      resolveSteer();
      if (dispatch) await dispatch;
      session.steer = originalSteer;
    }
  });
});

test("H2-b：召回确认移交后才退回草稿，服务端队列真的被清空", async () => {
  await withHost(async (host) => {
    // Agent 运行中：入队不会被立即自动投递，条目留在等待态（否则会被认领）。
    host.promptRunning = true;
    const written = await host.send({ type: "set_follow_up_queue", items: ["x", "y"] });
    const restored = [];
    const env = environment(host, written.revision, restored, written.items);
    await callback("handleRecallQueue", env)();

    assert.deepEqual(
      restoredPayloads(restored),
      [{ sid: "A", text: "x\n\ny", media: [] }],
      "回执确认移交的两条一起回到原会话草稿",
    );
    assert.deepEqual(host.followUpQueue, [], "队列确实被清空");
    assert.deepEqual(queue.queueEntry(env.queueBookRef.current, "A").items, []);
  }, { streaming: false });
});

test("H2-c：召回落盘失败（确定拒绝）→ 一条也不退回草稿", async () => {
  await withHost(async (host) => {
    const written = await host.send({ type: "set_follow_up_queue", items: ["x"] });
    const restored = [];
    const env = environment(host, written.revision, restored, written.items, {
      sendAgentCommand: async () => {
        throw definitiveRejectionError();
      },
    });
    await callback("handleRecallQueue", env)();
    assert.deepEqual(restoredPayloads(restored), [], "没有确认移交就不能把内容变成可重发副本");
    assert.deepEqual(host.followUpQueue.map((item) => item.text), ["x"], "服务端队列未被动过");
  }, { streaming: false });
});

test("G3：切走会话后入队确定拒绝，内容回到**原会话**草稿", async () => {
  await withHost(async (host) => {
    const restored = [];
    const env = environment(host, 0, restored, [], {
      sendAgentCommand: async () => {
        throw definitiveRejectionError();
      },
    });
    env.sessionIdRef.current = "B";
    env.currentQueueSessionIdRef.current = "B";
    const payload = { text: "original-A", attemptId: queue.newQueueAttemptId() };
    await assert.rejects(env.updateLocalFollowUp([payload], "A"));
    assert.deepEqual(
      restoredPayloads(restored),
      [{ sid: "A", text: "original-A", media: [] }],
      "归属由会话 id 决定，与用户当前看哪个会话无关",
    );
  });
});

test("I7：召回被受理后，更早的 unknown 提交由权威快照解决（不再显示、不再写回）", async () => {
  await withHost(async (host) => {
    host.promptRunning = true;
    const written = await host.send({ type: "set_follow_up_queue", items: ["keep"] });
    const restored = [];
    let calls = 0;
    const env = environment(host, written.revision, restored, written.items, {
      sendAgentCommand: async (_sid, command) => {
        calls += 1;
        // 第一次入队请求在途网络失败：客户端无从判断服务端收没收到（unknown）。
        if (calls === 1) throw new Error("network down");
        return host.send(command);
      },
    });
    await assert.rejects(env.updateLocalFollowUp([
      ...queue.payloadsForWrite(queue.queueEntry(env.queueBookRef.current, "A")),
      { text: "uncertain", attemptId: queue.newQueueAttemptId() },
    ], "A"));
    const before = queue.queueEntry(env.queueBookRef.current, "A");
    assert.equal(queue.hasUncertainWrite(before), true, "网络失败后进入待确认");
    assert.deepEqual(queue.projection(before), ["keep", "uncertain"]);

    await callback("handleRecallQueue", env)();

    const after = queue.queueEntry(env.queueBookRef.current, "A");
    assert.deepEqual(host.followUpQueue, [], "服务端队列确实空了");
    assert.deepEqual(queue.projection(after), [], "投影跟随权威快照，不再显示服务端没有的条目");
    assert.equal(queue.hasUncertainWrite(after), false, "未决提交不得跨权威快照存活");
    assert.deepEqual(
      restoredPayloads(restored).map((payload) => payload.text).sort(),
      ["keep", "uncertain"],
      "回执移交的 keep 与从未受理的 uncertain 都回到草稿（没有静默丢消息）",
    );

    // 再入队：不得把已召回的 keep 或未确认的 uncertain 复活。
    await env.updateLocalFollowUp([{ text: "next", attemptId: queue.newQueueAttemptId() }], "A");
    assert.deepEqual(host.followUpQueue.map((item) => item.text), ["next"]);
  }, { streaming: false });
});

test("I7-b：后续写入被受理时，未确认载荷不再留在队列侧（内容回草稿，不双份）", async () => {
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
    await assert.rejects(env.updateLocalFollowUp([
      ...queue.payloadsForWrite(queue.queueEntry(env.queueBookRef.current, "A")),
      { text: "uncertain", attemptId: queue.newQueueAttemptId() },
    ], "A"));

    // 用户改主意，整包替换为 replacement：这次被受理。
    await env.updateLocalFollowUp([{ text: "replacement", attemptId: queue.newQueueAttemptId() }], "A");

    const entry = queue.queueEntry(env.queueBookRef.current, "A");
    assert.deepEqual(host.followUpQueue.map((item) => item.text), ["replacement"]);
    assert.deepEqual(queue.projection(entry), ["replacement"], "队列侧不得再留着没生效的条目");
    assert.deepEqual(
      restoredPayloads(restored).map((payload) => payload.text),
      ["uncertain"],
      "从未受理的载荷回到草稿，而不是继续显示成排队中",
    );
  }, { streaming: false });
});

test("I7-c：未确认但服务端已受理（回执丢失）的载荷，不得再复制成草稿", async () => {
  await withHost(async (host) => {
    host.promptRunning = true;
    const written = await host.send({ type: "set_follow_up_queue", items: ["keep"] });
    const restored = [];
    let calls = 0;
    const env = environment(host, written.revision, restored, written.items, {
      sendAgentCommand: async (_sid, command) => {
        calls += 1;
        const receipt = await host.send(command);
        // 服务端受理了，但回执在返回途中丢失：客户端只能按 unknown 处理。
        if (calls === 1) throw new Error("response lost");
        return receipt;
      },
    });
    await assert.rejects(env.updateLocalFollowUp([
      ...queue.payloadsForWrite(queue.queueEntry(env.queueBookRef.current, "A")),
      { text: "landed", attemptId: queue.newQueueAttemptId() },
    ], "A"));
    assert.deepEqual(host.followUpQueue.map((item) => item.text), ["keep", "landed"]);

    await callback("handleRecallQueue", env)();

    const entry = queue.queueEntry(env.queueBookRef.current, "A");
    assert.deepEqual(
      restoredPayloads(restored).map((payload) => payload.text).sort(),
      ["keep"],
      "已受理过的 landed 归队列（不能再复制成可重发副本）",
    );
    assert.deepEqual(queue.projection(entry), ["landed"], "它仍在队列里等待处置");
  }, { streaming: false });
});

test("J1：CAS 冲突后更早的 unknown 提交被定论，后续入队不得删掉别的标签页条目", async () => {
  await withHost(async (host) => {
    host.promptRunning = true;
    const written = await host.send({ type: "set_follow_up_queue", items: ["keep"] });
    const restored = [];
    let calls = 0;
    const env = environment(host, written.revision, restored, written.items, {
      sendAgentCommand: async (_sid, command) => {
        calls += 1;
        // 第一次入队请求在途失败：内容从未到达服务端，但客户端只能按 unknown 处理。
        if (calls === 1) throw new Error("network down");
        return host.send(command);
      },
    });
    await assert.rejects(env.updateLocalFollowUp([
      ...queue.payloadsForWrite(queue.queueEntry(env.queueBookRef.current, "A")),
      { text: "uncertain", attemptId: queue.newQueueAttemptId() },
    ], "A"));
    assert.equal(queue.hasUncertainWrite(queue.queueEntry(env.queueBookRef.current, "A")), true);

    // 另一端把队列改成 [keep, other-tab]：本端下一次写入带过期版本，收到 CAS 冲突。
    await host.send({
      type: "set_follow_up_queue",
      items: [...host.followUpQueue.map((entry) => ({ id: entry.id, text: entry.text })), { text: "other-tab", attemptId: "tab-b" }],
      expectedRevision: host.followUpQueueRevision,
    });
    await assert.rejects(env.updateLocalFollowUp([
      ...queue.payloadsForWrite(queue.queueEntry(env.queueBookRef.current, "A")),
      { text: "retry", attemptId: queue.newQueueAttemptId() },
    ], "A"));

    const afterConflict = queue.queueEntry(env.queueBookRef.current, "A");
    assert.equal(afterConflict.serverRevision, host.followUpQueueRevision, "冲突回执即新基线");
    assert.deepEqual(
      queue.projection(afterConflict),
      ["keep", "other-tab"],
      "投影跟随冲突回执里的权威队列，而不是过期 pending",
    );
    assert.equal(queue.hasUncertainWrite(afterConflict), false, "更早的未决提交被冲突回执定论");
    assert.deepEqual(
      restoredPayloads(restored).map((payload) => payload.text).sort(),
      ["retry", "uncertain"],
      "从未被受理的内容回草稿",
    );

    // 用户按屏幕上的队列再入队：不得用旧内容整包覆盖服务端。
    await env.updateLocalFollowUp([
      ...queue.payloadsForWrite(queue.queueEntry(env.queueBookRef.current, "A")),
      { text: "foo", attemptId: queue.newQueueAttemptId() },
    ], "A");
    assert.deepEqual(
      host.followUpQueue.map((entry) => entry.text),
      ["keep", "other-tab", "foo"],
      "另一标签页的条目必须还在",
    );
  }, { streaming: false });
});

test("K2：热 state 投影带上受理令牌，回执丢失但已落地的写入不得再列一遍", async () => {
  await withHost(async (host) => {
    host.promptRunning = true;
    const restored = [];
    let calls = 0;
    const env = environment(host, 0, restored, [], {
      setQueuedMessages() {},
      sendAgentCommand: async (_sid, command) => {
        calls += 1;
        const receipt = await host.send(command);
        // 服务端已经受理，回执在返回途中丢失：客户端只能按 unknown 处理。
        if (calls === 1) throw new Error("response lost");
        return receipt;
      },
    });
    env.normalizeQueuedMessages = functionSource("normalizeQueuedMessages", env);
    env.applyProjectedQueues = callback("applyProjectedQueues", env);

    await assert.rejects(env.updateLocalFollowUp([{ text: "hello", attemptId: "try-a" }], "A"));

    assert.deepEqual(host.followUpQueue.map((item) => item.text), ["hello"], "服务端确实已经受理");
    const before = queue.queueEntry(env.queueBookRef.current, "A");
    assert.equal(queue.hasUncertainWrite(before), true, "客户端只知道结果未知");

    // 热投影（get_state）走一遍：令牌必须跟着快照过来，否则已落地的那次写入会被当成新增。
    env.applyProjectedQueues("A", host.projectState().queuedMessages);
    const after = queue.queueEntry(env.queueBookRef.current, "A");
    assert.deepEqual(
      queue.payloadsForWrite(after).map((payload) => payload.text),
      ["hello"],
      "已落地的写入由权威条目表达，不再列一遍",
    );

    await env.updateLocalFollowUp([
      ...queue.payloadsForWrite(after),
      { text: "next", attemptId: "try-next" },
    ], "A");
    assert.deepEqual(
      host.followUpQueue.map((item) => item.text),
      ["hello", "next"],
      "服务端不得多出一条同文条目",
    );
  }, { streaming: false });
});
