/**
 * SdkSessionHost 窄集成：临时目录创建会话、get_state、destroy。
 * 不调用真实模型 API。
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { startSdkSessionHost } = await jiti.import("./sdk-session-host.ts");
const { createSessionManager, openSessionManager } = await jiti.import("./pi-session-io.ts");
const { updatePidancePref } = await jiti.import("./pidance-prefs-file.ts");
const { listRecoverableFollowUpSessionIds, startLiveSession } = await jiti.import("./live-session-registry.ts");
const { listFreshRunningLeaseSessionIds } = await jiti.import("./session-running-lease.ts");
const { readLeafSidecar } = await jiti.import("./session-leaf-sidecar.ts");
const { createSessionService } = await jiti.import("./session-service.ts");


/** 启动一个只用来占住 pid 的存活进程（构造「其他进程持有租约」）。 */
function spawnSleeper() {
  return spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], { stdio: "ignore" });
}


function sendEvent(response, event) {
  response.write(`data: ${JSON.stringify(event)}\n\n`);
}

function sendTextResponse(response, sequence, text) {
  const responseId = `resp_${sequence}`;
  const item = {
    id: `msg_${sequence}`,
    type: "message",
    role: "assistant",
    status: "completed",
    phase: "final_answer",
    content: [{ type: "output_text", text, annotations: [] }],
  };
  sendEvent(response, {
    type: "response.created",
    response: { id: responseId, status: "in_progress", output: [] },
  });
  sendEvent(response, {
    type: "response.output_item.added",
    output_index: 0,
    item: { ...item, status: "in_progress", content: [] },
  });
  sendEvent(response, {
    type: "response.output_text.delta",
    output_index: 0,
    item_id: item.id,
    content_index: 0,
    delta: text,
  });
  sendEvent(response, { type: "response.output_item.done", output_index: 0, item });
  sendEvent(response, {
    type: "response.completed",
    response: { id: responseId, status: "completed", output: [item] },
  });
  response.end();
}

async function waitFor(predicate, message, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function zeroUsage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

test("SdkSessionHost：新会话启动、get_state、并发锁与 destroy", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "sdk-host-cwd-"));
  const agentDir = mkdtempSync(join(tmpdir(), "sdk-host-agent-"));

  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  let host;
  try {
    host = await startSdkSessionHost({
      sessionId: "__new__test",
      sessionFile: "",
      cwd,
      agentDir,
      toolNames: [], // 无工具，避免扩展噪音
      idleTimeoutMs: 60_000,
    });
    assert.ok(host.isAlive());
    assert.ok(host.sessionId);
    assert.ok(host.sessionFile);
    assert.ok(host.inner?.sessionManager);

    const state = await host.send({ type: "get_state" });
    assert.equal(state.sessionId, host.sessionId);
    assert.equal(state.isStreaming, false);
    assert.equal(state.isPromptRunning, false);
    // 系统提示词：SDK 路径必须投影（可为非空 AGENTS/默认拼装，或空串）
    assert.equal(typeof state.systemPrompt, "string");

    // widget 热 state 投影必须与 SSE setWidget 事件（{key, lines, placement}）对齐；
    // 回归：曾投影为 {key, content}，前端 widget.lines.map 崩溃 → global-error 页。
    // interactive（issue #103）：字符串数组 widget 没有组件实例，投影里必须是 false ——
    // 水合路径不带这个字段的话，刷新后的页面会以为它可以点。
    host.extensionUi.uiContext.setWidget("w1", ["一", "二"], { placement: "belowEditor" });
    const stateWithWidget = await host.send({ type: "get_state" });
    assert.deepEqual(stateWithWidget.extensionWidgets, [
      { key: "w1", lines: ["一", "二"], placement: "belowEditor", interactive: false },
    ]);

    // 页头 / 页脚槽位（issue #98）：与 widget 同一类「插件设一次就不动」的状态，
    // 所以必须进 get_state 快照 —— 只发 SSE 事件的话，页面后加载/刷新后槽位就没了。
    assert.equal(stateWithWidget.extensionHeader, null, "没设过就是 null");
    assert.equal(stateWithWidget.extensionFooter, null);
    host.extensionUi.uiContext.setFooter(() => ({ render: () => ["页脚行"] }));
    host.extensionUi.uiContext.setHeader(() => ({ render: () => ["页头行"] }));
    const stateWithSlots = await host.send({ type: "get_state" });
    assert.deepEqual(stateWithSlots.extensionHeader, ["页头行"]);
    assert.deepEqual(stateWithSlots.extensionFooter, ["页脚行"]);
    host.extensionUi.uiContext.setFooter(undefined);
    assert.equal((await host.send({ type: "get_state" })).extensionFooter, null, "恢复内置后快照要清空");
    host.extensionUi.uiContext.setHeader(undefined);    // 组件实现了 handleMouse 的 widget：投影里 interactive 为 true（前端据此挂点击）
    host.extensionUi.uiContext.setWidget("w2", () => ({
      render: () => ["mouse"],
      handleMouse: () => {},
    }));
    const stateWithInteractiveWidget = await host.send({ type: "get_state" });
    const interactive = stateWithInteractiveWidget.extensionWidgets.find((widget) => widget.key === "w2");
    assert.equal(interactive?.interactive, true, "组件有 handleMouse 时投影必须标成可交互");
    // 宿主按 key 转发鼠标：命中组件返回 true，未挂载的 key 返回 false
    assert.equal(
      await host.send({ type: "extension_ui_widget_mouse", key: "w2", event: { type: "click", button: "left", x: 0, y: 0 } }),
      true,
    );
    assert.equal(
      await host.send({ type: "extension_ui_widget_mouse", key: "nope", event: { type: "click", x: 0, y: 0 } }),
      false,
    );
    // 参数不全时不路由（也不抛）
    assert.equal(await host.send({ type: "extension_ui_widget_mouse", key: "w2" }), false);
    host.extensionUi.uiContext.setWidget("w2", undefined);
    // 前端按可用尺寸上报（issue #70）：两个维度都要落到插件读到的 tui.terminal 上。
    // 行数此前是构造时的常量 40，按 rows 裁切的插件（pi-subagents 的 fleet 详情视口）
    // 会把本可以显示的行真丢掉 —— 裁掉的行不在输出里。
    host.extensionUi.uiContext.setWidget("w-size", (tui) => ({
      render: () => [`size@${tui.terminal.columns}x${tui.terminal.rows}`],
    }));
    await new Promise((resolve) => setImmediate(resolve));
    await host.send({ type: "set_render_size", width: 72, rows: 33 });
    await new Promise((resolve) => setImmediate(resolve));
    const sizeWidget = (await host.send({ type: "get_state" })).extensionWidgets.find((w) => w.key === "w-size");
    assert.deepEqual(sizeWidget?.lines, ["size@72x33"], "插件读到的列数与行数都要是前端上报值");

    // 越界尺寸夹紧（与服务端 RENDER_WIDTH_* / RENDER_ROWS_* 一致）
    await host.send({ type: "set_render_size", width: 5, rows: 5 });
    await new Promise((resolve) => setImmediate(resolve));
    const clamped = (await host.send({ type: "get_state" })).extensionWidgets.find((w) => w.key === "w-size");
    assert.deepEqual(clamped?.lines, ["size@40x10"]);

    // 旧命令名仍接受（改名 set_render_width → set_render_size 之前加载的页面会发它）：
    // 只更新宽度，行数保持当前值，不能回到默认 40。
    await host.send({ type: "set_render_width", width: 90 });
    await new Promise((resolve) => setImmediate(resolve));
    const legacy = (await host.send({ type: "get_state" })).extensionWidgets.find((w) => w.key === "w-size");
    assert.deepEqual(legacy?.lines, ["size@90x10"]);
    host.extensionUi.uiContext.setWidget("w-size", undefined);

    // 插件补全（issue #101）：命令走真实链，门槛（provider 数量 + 触发字符）进 get_state。
    const beforeCompletion = await host.send({ type: "get_state" });
    assert.equal(beforeCompletion.extensionAutocompleteProviderCount, 0, "没注册时门槛是 0");
    assert.deepEqual(beforeCompletion.extensionAutocompleteTriggerCharacters, []);
    assert.deepEqual(
      await host.send({ type: "completion_suggestions", lines: ["@a"], cursorLine: 0, cursorCol: 2 }),
      { result: { kind: "no-provider" } },
      "没注册时明确回 no-provider（客户端根本不发这条请求）",
    );

    host.extensionUi.uiContext.addAutocompleteProvider((current) => ({
      ...current,
      triggerCharacters: ["@"],
      getSuggestions: async (lines) =>
        lines[0] === "@a"
          ? { items: [{ value: "@src/app.ts", label: "app.ts", description: "src" }], prefix: "@a" }
          : null,
    }));
    const withCompletion = await host.send({ type: "get_state" });
    assert.equal(withCompletion.extensionAutocompleteProviderCount, 1);
    assert.deepEqual(withCompletion.extensionAutocompleteTriggerCharacters, ["@"]);

    const suggested = await host.send({ type: "completion_suggestions", lines: ["@a"], cursorLine: 0, cursorCol: 2 });
    assert.equal(suggested.result.kind, "items");
    assert.deepEqual(suggested.result.items, [{ value: "@src/app.ts", label: "app.ts", description: "src" }]);
    // 链把「没有候选」说清楚（null）时是 none，让客户端回退到自己的文件补全
    assert.deepEqual(
      await host.send({ type: "completion_suggestions", lines: ["@zzz"], cursorLine: 0, cursorCol: 4 }),
      { result: { kind: "none" } },
    );
    // 越界的光标是客户端 bug：结构化回绝，不抛（否则整条命令通道 500）
    assert.deepEqual(
      await host.send({ type: "completion_suggestions", lines: ["@a"], cursorLine: 9, cursorCol: 2 }),
      { result: { kind: "invalid-request" } },
    );
    assert.deepEqual(
      await host.send({ type: "completion_suggestions", lines: ["@a"], cursorLine: 0, cursorCol: 99 }),
      { result: { kind: "invalid-request" } },
    );

    // 应用候选：替换区间由插件链决定（这里链底做前缀替换）
    const appliedCompletion = await host.send({
      type: "completion_apply",
      lines: ["@a"],
      cursorLine: 0,
      cursorCol: 2,
      item: { value: "@src/app.ts", label: "app.ts" },
      prefix: "@a",
    });
    assert.deepEqual(appliedCompletion.result, { lines: ["@src/app.ts"], cursorLine: 0, cursorCol: 11 });
    // 形状坏的请求不写文本（返回 null），也不抛
    assert.equal(
      (await host.send({ type: "completion_apply", lines: ["@a"], cursorLine: 0, cursorCol: 2, item: { value: "" }, prefix: "@a" })).result,
      null,
    );

    // 取消挂在**这一次请求**的 signal 上（issue #101 审查重要 1）。
    // 早期实现用一把 host 级共享的锁：另一个标签的补全会 abort 掉这一次，把它打成
    // superseded，本该显示插件候选的一方被换成本地文件列表。
    const completionSignals = [];
    host.extensionUi.uiContext.addAutocompleteProvider((current) => ({
      ...current,
      getSuggestions: (_lines, _cursorLine, _cursorCol, options) =>
        new Promise((_resolve, reject) => {
          completionSignals.push(options.signal);
          options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        }),
    }));
    const controllerA = new AbortController();
    const controllerB = new AbortController();
    const requestA = host.send(
      { type: "completion_suggestions", lines: ["@a"], cursorLine: 0, cursorCol: 2 },
      undefined,
      { signal: controllerA.signal },
    );
    const requestB = host.send(
      { type: "completion_suggestions", lines: ["@a"], cursorLine: 0, cursorCol: 2 },
      undefined,
      { signal: controllerB.signal },
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(completionSignals.length, 2, "两次请求各自问了一次插件");
    assert.equal(completionSignals[0], controllerA.signal, "第一次拿到的是自己的 signal");
    assert.equal(completionSignals[1], controllerB.signal, "第二次也是自己的");
    assert.equal(controllerA.signal.aborted, false, "后一次请求不得取消前一次（多标签互不干扰）");
    // 甲标签放弃：只有甲那次被叫停，乙那次继续等着
    controllerA.abort();
    assert.deepEqual(await requestA, { result: { kind: "error" } }, "被取消的那次按失败结算");
    assert.equal(controllerB.signal.aborted, false, "乙的搜索没有被甲的取消带走");
    controllerB.abort();
    assert.deepEqual(await requestB, { result: { kind: "error" } });

    // agent_end 自动命名：无 session_info 时取第一条用户输入（思维锚 custom 跳过）。
    host.inner.sessionManager.appendMessage({ role: "user", content: "帮我排查会话打开崩溃的问题" });
    host.inner.sessionManager.appendCustomEntry("flash-anchor", {
      phase: "open",
      pendingUserText: "预热占位文本",
    });
    host.handleSessionEvent({ type: "agent_end" });
    assert.equal(host.inner.sessionManager.getSessionName(), "帮我排查会话打开崩溃的问题");
    // 已有名字不被覆盖
    host.inner.sessionManager.appendSessionInfo("用户手动命名");
    host.handleSessionEvent({ type: "agent_end" });
    assert.equal(host.inner.sessionManager.getSessionName(), "用户手动命名");

    await host.destroyAsync();
    assert.equal(host.isAlive(), false);
  } finally {
    try {
      await host?.destroyAsync?.();
    } catch {
      /* ignore */
    }
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(cwd, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
  }
});


test("follow-up 恢复：读取嵌套 prefs，并排除 hold 会话", () => {
  assert.deepEqual(
    listRecoverableFollowUpSessionIds({
      sessionQueue: {
        ready: ["next"],
        held: ["keep"],
        empty: [],
        malformed: [1, null],
      },
      sessionQueueHold: { held: true },
      "sessionQueue.legacy": ["legacy next"],
    }),
    ["legacy", "ready"],
  );
});

test("SdkSessionHost：切走订阅后仍在 settled 自动投递，并由成功 prompt 解除旧 hold", { timeout: 15_000 }, async () => {
  const cwd = mkdtempSync(join(tmpdir(), "sdk-queue-cwd-"));
  const agentDir = mkdtempSync(join(tmpdir(), "sdk-queue-agent-"));
  const sessionDir = mkdtempSync(join(tmpdir(), "sdk-queue-sessions-"));
  const provider = "queue-test";
  const modelId = "queue-model";
  const requests = [];
  let releaseFirst;
  const firstResponseGate = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const server = createServer(async (request, response) => {
    try {
      let raw = "";
      for await (const chunk of request) raw += chunk;
      requests.push(JSON.parse(raw));
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      });
      if (requests.length === 1) await firstResponseGate;
      sendTextResponse(
        response,
        requests.length,
        requests.length === 1 ? "first done" : "follow-up done",
      );
    } catch (error) {
      response.statusCode = 500;
      response.end(error instanceof Error ? error.message : String(error));
    }
  });

  let host;
  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    writeFileSync(join(agentDir, "models.json"), JSON.stringify({
      providers: {
        [provider]: {
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          api: "openai-responses",
          apiKey: "test-key",
          models: [{
            id: modelId,
            name: modelId,
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 8192,
            maxTokens: 512,
          }],
        },
      },
    }));
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({
      defaultProvider: provider,
      defaultModel: modelId,
      retry: { enabled: false },
    }));

    const manager = createSessionManager(cwd, sessionDir);
    manager.appendModelChange(provider, modelId);
    manager.appendMessage({ role: "user", content: "fixture", timestamp: Date.now() - 1 });
    manager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "fixture ready" }],
      api: "openai-responses",
      provider,
      model: modelId,
      usage: zeroUsage(),
      stopReason: "stop",
      timestamp: Date.now(),
    });
    assert.ok(manager.getSessionFile());
    assert.equal(existsSync(manager.getSessionFile()), true);

    host = await startSdkSessionHost({
      sessionId: manager.getSessionId(),
      sessionFile: manager.getSessionFile(),
      cwd,
      agentDir,
      toolNames: [],
      idleTimeoutMs: 500,
    });
    updatePidancePref(`sessionQueueHold.${host.sessionId}`, true, agentDir);

    const unsubscribe = host.onEvent(() => {});
    await host.send({ type: "prompt", message: "first prompt" });
    await waitFor(() => requests.length === 1, "first provider request did not start");
    await host.send({ type: "set_follow_up_queue", items: ["queued prompt"] });
    const queuedState = await host.send({ type: "get_state" });
    assert.deepEqual(queuedState.queuedMessages.followUp, ["queued prompt"]);
    unsubscribe();
    releaseFirst();
    await waitFor(() => !host.isRunning(), "follow-up run did not settle");
    assert.match(JSON.stringify(requests[1].input), /queued prompt/);
    await waitFor(() => !host.isAlive(), "settled host with empty queue was not disposed");
    assert.equal(host.isAlive(), false);

    const prefs = JSON.parse(readFileSync(join(agentDir, "pidance-preferences.json"), "utf8"));
    // 队列持久化带版本号（客户端据此丢弃过期回显）；投递完成后队列为空
    assert.deepEqual(prefs.sessionQueue?.[host.sessionId]?.items, []);
    assert.equal(typeof prefs.sessionQueue?.[host.sessionId]?.revision, "number");
    assert.equal(prefs.sessionQueueHold?.[host.sessionId], undefined);
    const reopened = openSessionManager(host.sessionFile, sessionDir);
    const userTexts = reopened
      .buildSessionContext()
      .messages
      .filter((message) => message.role === "user")
      .map((message) => JSON.stringify(message.content));
    assert.ok(userTexts.some((text) => text.includes("queued prompt")));
  } finally {
    releaseFirst?.();
    await host?.destroyAsync();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    rmSync(cwd, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
    rmSync(sessionDir, { recursive: true, force: true });
  }
});

test("SdkSessionHost：手动压缩中发送文本，压缩完成后自动执行", { timeout: 20_000 }, async () => {
  const cwd = mkdtempSync(join(tmpdir(), "sdk-compact-queue-cwd-"));
  const agentDir = mkdtempSync(join(tmpdir(), "sdk-compact-queue-agent-"));
  const sessionDir = mkdtempSync(join(tmpdir(), "sdk-compact-queue-sessions-"));
  const provider = "compact-queue-test";
  const modelId = "compact-queue-model";
  const requests = [];
  let releaseSummary;
  const summaryGate = new Promise((resolve) => { releaseSummary = resolve; });
  const server = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
    requests.push({ body, hasTools });
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
    });
    if (!hasTools) {
      await summaryGate;
      sendTextResponse(response, requests.length, "## Goal\\nContinue.\\n\\n## Progress\\nCompacted.");
    } else {
      sendTextResponse(response, requests.length, "queued prompt completed");
    }
  });
  let host;
  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    writeFileSync(join(agentDir, "models.json"), JSON.stringify({
      providers: {
        [provider]: {
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          api: "openai-responses",
          apiKey: "test-key",
          models: [{
            id: modelId,
            name: modelId,
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 8192,
            maxTokens: 512,
          }],
        },
      },
    }));
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({
      defaultProvider: provider,
      defaultModel: modelId,
      compaction: { enabled: true, reserveTokens: 1024, keepRecentTokens: 512 },
      retry: { enabled: false },
    }));
    const manager = createSessionManager(cwd, sessionDir);
    manager.appendModelChange(provider, modelId);
    for (let index = 0; index < 8; index += 1) {
      manager.appendMessage({ role: "user", content: `history-${index} ${"context ".repeat(500)}` });
      manager.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: `answer-${index}` }],
        api: "openai-responses",
        provider,
        model: modelId,
        usage: zeroUsage(),
        stopReason: "stop",
      });
    }
    host = await startSdkSessionHost({
      sessionId: manager.getSessionId(),
      sessionFile: manager.getSessionFile(),
      cwd,
      agentDir,
      toolNames: ["read"],
      idleTimeoutMs: 60_000,
    });
    const events = [];
    host.onEvent((event) => {
      if (["compaction_start", "compaction_end", "message_end", "agent_settled", "follow_up_flushed"].includes(event.type)) {
        events.push(event);
      }
    });

    const compactPromise = host.send({ type: "compact" });
    await waitFor(() => events.some((event) => event.type === "compaction_start"), "manual compaction did not start");
    const queued = await host.send({
      type: "prompt",
      submissionId: "queued-during-compaction",
      message: "queued while compaction is running",
    });
    assert.equal(queued.status, "queued");
    assert.equal(queued.action, "queued");
    assert.equal(queued.reason, "compacting");
    assert.equal(queued.queue?.revision, 1);
    assert.deepEqual(queued.queue?.items.map((item) => item.text), ["queued while compaction is running"]);
    assert.equal(queued.queue?.items[0].state, "waiting");
    await waitFor(() => requests.some((entry) => !entry.hasTools), "summary request did not start");
    releaseSummary();
    await compactPromise;
    await waitFor(() => requests.some((entry) => entry.hasTools), "queued prompt did not start after compaction");
    await waitFor(() => events.some((event) => event.type === "agent_settled"), "queued prompt did not settle");
    assert.ok(requests.some((entry) => entry.hasTools && JSON.stringify(entry.body.input).includes("queued while compaction is running")));
    assert.ok(events.some((event) => event.type === "follow_up_flushed"));
    assert.ok(events.some((event) => event.type === "compaction_end" && event.aborted === false));
  } finally {
    releaseSummary?.();
    await host?.destroyAsync();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    rmSync(cwd, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
    rmSync(sessionDir, { recursive: true, force: true });
  }
});

test("SdkSessionHost：custom_panel_bounds 命令把几何落到 overlay 句柄（issue #99）", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "sdk-host-cwd-"));
  const agentDir = mkdtempSync(join(tmpdir(), "sdk-host-agent-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  let host;
  try {
    host = await startSdkSessionHost({
      sessionId: "__new__bounds",
      sessionFile: "",
      cwd,
      agentDir,
      toolNames: [],
      idleTimeoutMs: 60_000,
    });
    let handle = null;
    const pending = host.extensionUi.uiContext.custom(
      () => ({ render: () => ["panel"], handleInput() {} }),
      { overlay: true, onHandle: (h) => { handle = h; } },
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(handle, "onHandle 必须被调用");
    assert.equal(handle.getBounds(), undefined, "还没上报过 → undefined（不编造 0）");

    const frame = (await host.send({ type: "get_state" })).activeCustomUi;
    assert.ok(frame?.id, "活动 custom 面板应该出现在状态投影里");

    await host.send({ type: "custom_panel_bounds", id: frame.id, bounds: { row: 3, col: 5, width: 40, height: 6 } });
    assert.deepEqual(handle.getBounds(), { row: 3, col: 5, width: 40, height: 6 });

    // 坏报文不改已有值（形状校验在适配器里）
    await host.send({ type: "custom_panel_bounds", id: frame.id, bounds: { row: 999 } });
    assert.deepEqual(handle.getBounds(), { row: 3, col: 5, width: 40, height: 6 });

    // 未知 id 是 no-op，不许抛
    await host.send({ type: "custom_panel_bounds", id: "no-such-panel", bounds: { row: 0, col: 0, width: 1, height: 1 } });
    assert.deepEqual(handle.getBounds(), { row: 3, col: 5, width: 40, height: 6 });

    // 面板收尾：hide() 之后不再有 bounds
    handle.hide();
    assert.equal(handle.getBounds(), undefined);
    void pending; // hide() 按 pi-tui 契约不 settle 插件的 await
  } finally {
    await host.destroy();
    process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(agentDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("Host 把 extension_ui_input 转给 adapter.inputCustom", async () => {
  const src = readFileSync(new URL("./sdk-session-host.ts", import.meta.url), "utf8");
  assert.match(src, /inputCustom/);
  assert.match(src, /extension_ui_input/);
});

// TUI 的 handleReloadCommand 先 resetExtensionUI()（含 setHiddenThinkingLabel()）再重载；
// 顺序反了的话重载期间插件看到的仍是旧标签，重载后若插件不再设一次就会一直留着。
test("插件 reload 也要清页头/页脚槽位与失败记忆（issue #98 审查 P2）", () => {
  const src = readFileSync(new URL("./sdk-session-host.ts", import.meta.url), "utf8");
  const reload = src.indexOf("await session.reload();");
  assert.notEqual(reload, -1, "reload 处理里应真的重载会话");
  // 适配器在 reload 时不会被 dispose（那条路走 rebindSession），所以槽位必须显式清：
  // 不清的话旧组件与它的定时器还活着，页面继续画旧页脚（TUI 的 resetExtensionUI 同做）。
  for (const call of [
    "this.extensionUi?.uiContext.setFooter(undefined);",
    "this.extensionUi?.uiContext.setHeader(undefined);",
    "this.extensionUi?.resetSlotFailures();",
  ]) {
    const at = src.indexOf(call);
    assert.notEqual(at, -1, `reload 处理里缺少 ${call}`);
    assert.ok(at < reload, `${call} 必须在 session.reload() 之前`);
  }
});

test("插件 reload 先清折叠行标签，再 session.reload()（issue #96 审查 P2）", () => {
  const src = readFileSync(new URL("./sdk-session-host.ts", import.meta.url), "utf8");
  // 注意断言**调用表达式**而不是只匹配名字：文件里注释也含这个名字，
  // 只匹配名字的话删掉真正的调用测试照样是绿的（反向验证抓到过）。
  const clear = src.indexOf("this.extensionUi?.uiContext.setHiddenThinkingLabel();");
  const reload = src.indexOf("await session.reload();");
  assert.notEqual(clear, -1, "reload 处理里应清掉插件设过的折叠行标签");
  assert.notEqual(reload, -1, "reload 处理里应真的重载会话");
  assert.ok(clear < reload, "清标签必须在 session.reload() 之前（与 TUI 的 resetExtensionUI 同序）");
});

test("Host 对同一 submissionId 缓存 receipt，不重复调 Pi", async () => {
  const src = readFileSync(new URL("./sdk-session-host.ts", import.meta.url), "utf8");
  assert.match(src, /promptReceipts/);
  assert.match(src, /parsePromptCommand/);
  assert.match(src, /cached/);
  // 并发重复：in-flight 单飞必须存在
  assert.match(src, /promptInFlight/);
  assert.match(src, /promptInFlight\.set\(key, flight\)/);
  // teardown 单飞：destroyPromise 共享
  assert.match(src, /destroyPromise/);
  assert.match(src, /if \(this\.destroyPromise\) return this\.destroyPromise/);
});

test("SdkSessionHost：steer 由 host 权威运行态路由，空闲时不会悬挂", { timeout: 20_000 }, async () => {
  const cwd = mkdtempSync(join(tmpdir(), "sdk-steer-cwd-"));
  const agentDir = mkdtempSync(join(tmpdir(), "sdk-steer-agent-"));
  const sessionDir = mkdtempSync(join(tmpdir(), "sdk-steer-sessions-"));
  const provider = "steer-test";
  const modelId = "steer-model";
  const requests = [];
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  let releaseFirst;
  const firstResponseGate = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const server = createServer(async (request, response) => {
    try {
      let raw = "";
      for await (const chunk of request) raw += chunk;
      requests.push(JSON.parse(raw));
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      });
      if (requests.length === 1) await firstResponseGate;
      sendTextResponse(response, requests.length, `response-${requests.length}`);
    } catch (error) {
      response.statusCode = 500;
      response.end(error instanceof Error ? error.message : String(error));
    }
  });

  let host;
  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    writeFileSync(join(agentDir, "models.json"), JSON.stringify({
      providers: {
        [provider]: {
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          api: "openai-responses",
          apiKey: "test-key",
          models: [{
            id: modelId,
            name: modelId,
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 8192,
            maxTokens: 512,
          }],
        },
      },
    }));
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({
      defaultProvider: provider,
      defaultModel: modelId,
      retry: { enabled: false },
    }));

    const manager = createSessionManager(cwd, sessionDir);
    manager.appendModelChange(provider, modelId);
    manager.appendMessage({ role: "user", content: "fixture", timestamp: Date.now() - 1 });
    manager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "fixture ready" }],
      api: "openai-responses",
      provider,
      model: modelId,
      usage: zeroUsage(),
      stopReason: "stop",
      timestamp: Date.now(),
    });

    host = (await startLiveSession(
      manager.getSessionId(),
      manager.getSessionFile(),
      cwd,
      [],
    )).session;

    const first = await host.send({
      type: "prompt",
      submissionId: "steer-first",
      message: "first prompt",
    });
    assert.equal(first.status, "accepted");
    await waitFor(() => requests.length === 1, "first prompt did not start");
    assert.deepEqual(listFreshRunningLeaseSessionIds(agentDir), [manager.getSessionId()]);

    // 实际运行中：steer 必须进入当前 Agent loop，而不是并发启动 prompt。
    await host.send({ type: "steer", message: "steer during run" });
    assert.equal(requests.length, 1, "运行中的 steer 不得启动并发请求");
    releaseFirst();
    await waitFor(() => requests.length === 2, "running steer was not delivered");
    await waitFor(() => !host.isAlive(), "settled host did not release immediately");
    assert.match(JSON.stringify(requests[1].input), /steer during run/);

    // 旧 host 已在上一轮结束时销毁；新的 idle host 收到 steer 时，必须启动一轮 prompt。
    host = (await startLiveSession(
      manager.getSessionId(),
      manager.getSessionFile(),
      cwd,
      [],
    )).session;
    const idleSteer = await host.send({ type: "steer", message: "steer while idle" });
    assert.equal(idleSteer.status, "accepted");
    await waitFor(() => requests.length === 3, "idle steer did not start a prompt");
    await waitFor(() => !host.isAlive(), "idle steer host did not dispose immediately");
    assert.deepEqual(listFreshRunningLeaseSessionIds(agentDir), []);
    assert.match(JSON.stringify(requests[2].input), /steer while idle/);
  } finally {
    releaseFirst?.();
    await host?.destroyAsync();
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    rmSync(cwd, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
    rmSync(sessionDir, { recursive: true, force: true });
  }
});

test("SdkSessionHost：run 期间每条 assistant message_end 携带最新 contextUsage", { timeout: 15_000 }, async () => {
  const cwd = mkdtempSync(join(tmpdir(), "sdk-ctx-cwd-"));
  const agentDir = mkdtempSync(join(tmpdir(), "sdk-ctx-agent-"));
  const sessionDir = mkdtempSync(join(tmpdir(), "sdk-ctx-sessions-"));
  const provider = "ctx-test";
  const modelId = "ctx-model";
  const requests = [];
  const server = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    requests.push(JSON.parse(raw));
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
    });
    sendTextResponse(response, requests.length, "answer ".repeat(40));
  });

  let host;
  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    writeFileSync(join(agentDir, "models.json"), JSON.stringify({
      providers: {
        [provider]: {
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          api: "openai-responses",
          apiKey: "test-key",
          models: [{
            id: modelId,
            name: modelId,
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 8192,
            maxTokens: 512,
          }],
        },
      },
    }));
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({
      defaultProvider: provider,
      defaultModel: modelId,
      retry: { enabled: false },
    }));

    const manager = createSessionManager(cwd, sessionDir);
    manager.appendModelChange(provider, modelId);
    manager.appendMessage({ role: "user", content: "fixture", timestamp: Date.now() - 1 });
    manager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "fixture ready" }],
      api: "openai-responses",
      provider,
      model: modelId,
      usage: zeroUsage(),
      stopReason: "stop",
      timestamp: Date.now(),
    });

    host = await startSdkSessionHost({
      sessionId: manager.getSessionId(),
      sessionFile: manager.getSessionFile(),
      cwd,
      agentDir,
      toolNames: [],
      idleTimeoutMs: 60_000,
    });

    const events = [];
    host.onEvent((event) => events.push(event));
    await host.send({ type: "prompt", message: "hello" });
    await waitFor(() => events.some((event) => event.type === "agent_end"), "run did not finish");

    const assistantEnds = events.filter(
      (event) => event.type === "message_end" && event.message?.role === "assistant",
    );
    assert.ok(assistantEnds.length > 0, "run 中没有 assistant message_end");
    for (const event of assistantEnds) {
      // run 未结束就要有读数：顶栏不再等 agent_end 才更新一次。
      assert.equal(typeof event.contextUsage?.contextWindow, "number");
      assert.equal(typeof event.contextUsage?.tokens, "number");
      assert.ok(event.contextUsage.tokens > 0, "message_end 必须带最新（非空）上下文读数");
    }
    // 0.87.0 起 getContextUsage() 基于 SessionManager 投影（buildSessionProjection）：
    // message_end 事件先于本轮 assistant 入库，读数少这一轮回复的估算。
    // 这里锁「差值 == 本轮回复估算」而不是 `<=`：后者会放过「读数退回上一轮」的滞后回归
    // （那正是本用例要防的）。fixture 回复是 "answer ".repeat(40) = 280 字符 → ceil(280/4) = 70。
    const agentEnd = events.find((event) => event.type === "agent_end");
    assert.ok(agentEnd?.contextUsage, "agent_end 必须带上下文读数");
    const replyChars = "answer ".repeat(40).length;
    assert.equal(
      agentEnd.contextUsage.tokens - assistantEnds.at(-1).contextUsage.tokens,
      Math.ceil(replyChars / 4),
      "message_end 与 agent_end 的差值应等于本轮回复的估算 token（证明不是滞后的上一轮读数）",
    );
  } finally {
    await host?.destroyAsync();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    rmSync(cwd, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
    rmSync(sessionDir, { recursive: true, force: true });
  }
});

test("SdkSessionHost：热 state 下发本 run 的吞吐读数（冷挂载可 seed）", { timeout: 15_000 }, async () => {
  const cwd = mkdtempSync(join(tmpdir(), "sdk-metrics-cwd-"));
  const agentDir = mkdtempSync(join(tmpdir(), "sdk-metrics-agent-"));
  const sessionDir = mkdtempSync(join(tmpdir(), "sdk-metrics-sessions-"));
  let host;
  try {
    const manager = createSessionManager(cwd, sessionDir);
    manager.appendMessage({ role: "user", content: "fixture", timestamp: Date.now() - 1 });
    manager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "fixture ready" }],
      api: "openai-responses",
      provider: "metrics-test",
      model: "metrics-model",
      usage: zeroUsage(),
      stopReason: "stop",
      timestamp: Date.now(),
    });
    host = await startSdkSessionHost({
      sessionId: manager.getSessionId(),
      sessionFile: manager.getSessionFile(),
      cwd,
      agentDir,
      toolNames: [],
      idleTimeoutMs: 60_000,
    });

    // run 之前没有读数（不编造）。
    const before = await host.send({ type: "get_state" });
    assert.deepEqual(before.turnMetrics, {}, "run 之前不应有吞吐读数");

    // 直接驱动事件（与真实 run 的事件序列一致）：首个可见帧 → 消息结束（provider usage）。
    host.handleSessionEvent({ type: "agent_start" });
    await new Promise((resolve) => setTimeout(resolve, 30));
    host.handleSessionEvent({
      type: "message_start",
      message: { role: "assistant", content: [{ type: "text", text: "答" }] },
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    host.handleSessionEvent({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "答".repeat(20) }],
        usage: { output: 20 },
      },
    });

    const after = await host.send({ type: "get_state" });
    assert.equal(typeof after.turnMetrics?.tokensPerSecond, "number", "step 结束后热 state 应给出吞吐");
    assert.ok(after.turnMetrics.tokensPerSecond > 0);
    assert.equal(typeof after.turnMetrics?.ttftMs, "number", "起点已知时应给出首字延迟");
    assert.ok(after.turnMetrics.ttftMs >= 0);

    // 没有 provider output tokens 的 step 不参与（不编造）。
    host.handleSessionEvent({ type: "agent_start" });
    host.handleSessionEvent({
      type: "message_start",
      message: { role: "assistant", content: [{ type: "text", text: "x" }] },
    });
    host.handleSessionEvent({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "x" }] },
    });
    const afterSecondRun = await host.send({ type: "get_state" });
    assert.equal(
      afterSecondRun.turnMetrics?.tokensPerSecond,
      undefined,
      "新 run 里没有 usage 的 step 不得沿用上一轮读数",
    );
  } finally {
    await host?.destroyAsync();
    rmSync(cwd, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
    rmSync(sessionDir, { recursive: true, force: true });
  }
});

test("SdkSessionHost：已投递的队列条目立刻出队；重启后的 host 不得再投递（重复发送回归）", { timeout: 20_000 }, async () => {
  const cwd = mkdtempSync(join(tmpdir(), "sdk-dup-cwd-"));
  const agentDir = mkdtempSync(join(tmpdir(), "sdk-dup-agent-"));
  const sessionDir = mkdtempSync(join(tmpdir(), "sdk-dup-sessions-"));
  const provider = "dup-test";
  const modelId = "dup-model";
  const requests = [];
  const server = createServer(async (request, response) => {
    try {
      let raw = "";
      for await (const chunk of request) raw += chunk;
      requests.push(JSON.parse(raw));
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      sendTextResponse(response, requests.length, `done-${requests.length}`);
    } catch (error) {
      response.statusCode = 500;
      response.end(error instanceof Error ? error.message : String(error));
    }
  });
  let host;
  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    writeFileSync(join(agentDir, "models.json"), JSON.stringify({
      providers: {
        [provider]: {
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          api: "openai-responses",
          apiKey: "test-key",
          models: [{
            id: modelId, name: modelId, reasoning: false, input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 8192, maxTokens: 512,
          }],
        },
      },
    }));
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({
      defaultProvider: provider, defaultModel: modelId, retry: { enabled: false },
    }));

    const manager = createSessionManager(cwd, sessionDir);
    manager.appendModelChange(provider, modelId);
    manager.appendMessage({ role: "user", content: "fixture", timestamp: Date.now() - 1 });
    manager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "fixture ready" }],
      api: "openai-responses", provider, model: modelId,
      usage: zeroUsage(), stopReason: "stop", timestamp: Date.now(),
    });

    host = await startSdkSessionHost({
      sessionId: manager.getSessionId(),
      sessionFile: manager.getSessionFile(),
      cwd, agentDir, toolNames: [], idleTimeoutMs: 500,
    });
    const sessionId = host.sessionId;

    // 排队一条；settle 后由 host 自动投递
    await host.send({ type: "set_follow_up_queue", items: ["只应发送一次"] });
    await waitFor(() => requests.length >= 1, "queued prompt was not flushed");
    await waitFor(() => !host.isRunning(), "flushed run did not settle");

    // 投递受理即出队：持久化队列不得再留该条目（否则下次 settle / 重启会重发）。
    // 空队列 + 未 hold ⇒ host 在 settle 后自行 dispose（队列非空时会继续存活等 flush）。
    const prefs = JSON.parse(readFileSync(join(agentDir, "pidance-preferences.json"), "utf8"));
    assert.deepEqual(prefs.sessionQueue?.[sessionId]?.items, [], "已投递条目仍在持久化队列里");
    await waitFor(() => !host.isAlive(), "队列已空但 host 未按预期 dispose（疑似条目仍留在队列）");

    // 重启 host（真实场景：idle dispose 后重新唤醒）→ 不得从持久化队列重发
    try { await host.destroyAsync(); } catch { /* already disposed */ }
    host = await startSdkSessionHost({
      sessionId,
      sessionFile: manager.getSessionFile(),
      cwd, agentDir, toolNames: [], idleTimeoutMs: 500,
    });
    const requestsBefore = requests.length;
    await host.send({ type: "prompt", message: "second prompt" });
    await waitFor(() => requests.length > requestsBefore, "second prompt was not sent");
    await waitFor(() => !host.isRunning(), "second run did not settle");
    await new Promise((resolve) => setTimeout(resolve, 250));
    // 只数「本次新增的 user 输入」，历史里带同一文本不算重发
    const delivered = requests.filter((request) => {
      const input = Array.isArray(request.input) ? request.input : [];
      const lastUser = [...input].reverse().find((entry) => entry?.role === "user");
      return JSON.stringify(lastUser ?? null).includes("只应发送一次");
    });
    assert.equal(delivered.length, 1, `同一队列条目被重复投递 ${delivered.length} 次`);
  } finally {
    try { await host?.destroyAsync?.(); } catch { /* ignore */ }
    await new Promise((resolve) => server.close(resolve));
  }
});

// ---------------------------------------------------------------------------
// Issue #29：销毁生命周期契约
// - onDestroy 曾经是单槽赋值：registry 清理会被随后连接的 SSE 覆盖
// - destroyAsync 曾经在命令活跃时排一帧就返回，调用方（离线写）却当成 writer 已交出
// ---------------------------------------------------------------------------

/** 共享夹具：临时 cwd/agentDir 上起一个无工具 host（不调用真实模型 API）。 */
async function withHost(options, run) {
  const cwd = mkdtempSync(join(tmpdir(), "sdk-host-cwd-"));
  const agentDir = mkdtempSync(join(tmpdir(), "sdk-host-agent-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  let host;
  try {
    host = await startSdkSessionHost({
      sessionId: "__new__test",
      sessionFile: "",
      cwd,
      agentDir,
      toolNames: [],
      idleTimeoutMs: 60_000,
      ...options,
    });
    return await run(host);
  } finally {
    try { await host?.destroyAsync?.(); } catch { /* ignore */ }
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(cwd, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
  }
}

test("SdkSessionHost：销毁通知支持多订阅与退订（registry 清理不被 SSE 覆盖）", async () => {
  await withHost({}, async (host) => {
    const calls = [];
    host.onDestroy(() => calls.push("registry"));
    const offSse1 = host.onDestroy(() => calls.push("sse1"));
    host.onDestroy(() => calls.push("sse2"));
    offSse1();

    await host.destroyAsync();
    assert.deepEqual(calls, ["registry", "sse2"], "多订阅必须都触发，退订的不得触发");
    assert.equal(host.isAlive(), false);

    // 幂等：重复 destroy 不重复通知
    await host.destroyAsync();
    assert.deepEqual(calls, ["registry", "sse2"]);
  });
});

test("SdkSessionHost：单个销毁订阅者抛错不阻断其它订阅者", async () => {
  await withHost({}, async (host) => {
    const calls = [];
    host.onDestroy(() => {
      calls.push("throwing");
      throw new Error("boom");
    });
    host.onDestroy(() => calls.push("registry"));
    await host.destroyAsync();
    assert.deepEqual(calls, ["throwing", "registry"], "registry 清理必须跑到");
  });
});

test("SdkSessionHost：命令进行中 destroyAsync 等到命令结束才交出 writer", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  await withHost({
    destroyWaitMs: 2_000,
    navigationActions: {
      // 忽略 handoff，模拟「命令仍在进行」。
      // 载体用 create_session_from_leaf：它仍走「交出 writer」的离线交接（树导航命令 #90 已改为
      // 用 Host 自己的 live writer 写，见 lib/sdk-session-host.ts 的 navigateTreeCommand）。
      selectLeafExact: async () => ({ cancelled: false }),
      branchFromAssistant: async () => ({ cancelled: false }),
      createSessionFromLeaf: () => gate,
    },
  }, async (host) => {
    const command = host.send({ type: "create_session_from_leaf", entryId: "e1" });
    let settled = false;
    const destroy = host.destroyAsync().then(() => { settled = true; }, () => { settled = true; });

    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(settled, false, "命令仍在进行时 destroyAsync 不得提前结算");
    assert.equal(host.isAlive(), true, "命令持有 manager 时不得 dispose");

    release({ cancelled: false });
    await command;
    await destroy;
    assert.equal(host.isAlive(), false, "命令结束后必须完成 dispose");
  });
});

test("SdkSessionHost：导航交接不自等待，且交接后 writer 已交出", async () => {
  // 导航回调在 host 创建前定义，用可变引用在 run 里绑定
  let running = null;
  await withHost({
    destroyWaitMs: 2_000,
    navigationActions: {
      selectLeafExact: async () => ({ cancelled: false }),
      branchFromAssistant: async () => ({ cancelled: false }),
      createSessionFromLeaf: async (_sessionId, _entryId, options) => {
        // 模拟 Service：离线写前用 Host 提供的显式交接让出 writer
        await options.handoff();
        assert.equal(running.isAlive(), false, "交接完成后 writer 必须已交出");
        return { cancelled: false, newSessionId: "x" };
      },
    },
  }, async (host) => {
    running = host;
    const result = await Promise.race([
      host.send({ type: "create_session_from_leaf", entryId: "e1" }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("导航命令自等待死锁")), 3_000)),
    ]);
    assert.deepEqual(result, { cancelled: false, newSessionId: "x" });
    assert.equal(host.isAlive(), false);
  });
});

test("SdkSessionHost：命令长时间不结束时 destroyAsync 以 busy fail closed", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  await withHost({
    destroyWaitMs: 80,
    navigationActions: {
      selectLeafExact: async () => ({ cancelled: false }),
      branchFromAssistant: async () => ({ cancelled: false }),
      createSessionFromLeaf: () => gate,
    },
  }, async (host) => {
    const command = host.send({ type: "create_session_from_leaf", entryId: "e1" });
    await assert.rejects(() => host.destroyAsync(), /writer is busy/);
    assert.equal(host.isAlive(), true, "busy 时不得 dispose（否则与命令并发写）");

    release({ cancelled: false });
    await command;
    await host.destroyAsync();
    assert.equal(host.isAlive(), false, "命令结束后的回收必须成功");
  });
});


// ---------------------------------------------------------------------------
// Issue #32：队列格式与恢复契约
//
// 写入方持久化 {items, revision}，而启动恢复扫描只认数组 → 当前格式的队列
// 重启后不会被恢复投递。下面固定「实际 writer 输出 → 恢复扫描」的闭环。
// ---------------------------------------------------------------------------

test("#32 恢复扫描识别写入方的实际格式（不是手写数组）", async () => {
  const { parseFollowUpQueue, hasQueuedFollowUp, serializeFollowUpQueue } =
    await jiti.import("./session-queue.ts");
  const { listRecoverableFollowUpSessionIds } = await jiti.import("./live-session-registry.ts");

  // 真实写入方形状：条目带身份与状态
  const written = serializeFollowUpQueue(parseFollowUpQueue(["待投递"]));
  assert.equal(written.items.length, 1);
  assert.ok(written.items[0].id, "条目必须有稳定身份");
  assert.equal(written.items[0].text, "待投递");
  assert.equal(written.items[0].state, "waiting");
  assert.equal(hasQueuedFollowUp(written), true, "当前格式必须被识别为有待投递内容");

  // 旧格式兼容：确定性 id（同一内容重复解码得到同一身份）
  assert.deepEqual(parseFollowUpQueue(["旧格式"]), parseFollowUpQueue(["旧格式"]));
  assert.equal(parseFollowUpQueue(["旧格式"]).items[0].text, "旧格式");
  assert.equal(hasQueuedFollowUp(["旧格式"]), true);
  // 正文不能充当身份：同文两条是两个条目
  const twins = parseFollowUpQueue(["同文", "同文"]).items;
  assert.equal(twins.length, 2);
  assert.notEqual(twins[0].id, twins[1].id);

  // 在途声明的条目也算「有待投递内容」：重启后必须能水合、能处置
  assert.equal(
    hasQueuedFollowUp({ items: [{ id: "c", text: "已提交未确认", state: "claimed" }] }),
    true,
  );
  // 损坏/空 → 不抛错，按空处理
  assert.deepEqual(parseFollowUpQueue(null), { items: [], revision: 0, admittedAttemptIds: [] });
  assert.deepEqual(parseFollowUpQueue({ items: [1, null, "  "] }), { items: [], revision: 0, admittedAttemptIds: [] });
  assert.deepEqual(parseFollowUpQueue({ items: ["", {}] }), { items: [], revision: 0, admittedAttemptIds: [] });
  assert.equal(hasQueuedFollowUp({ items: [] }), false);

  // 恢复扫描：当前格式（嵌套）与旧格式（扁平）都要命中，hold 会话排除
  assert.deepEqual(
    listRecoverableFollowUpSessionIds({
      sessionQueue: {
        current: { items: [{ id: "i", text: "a", state: "waiting" }], revision: 7 },
        claimed: { items: [{ id: "c", text: "crash", state: "claimed" }], revision: 2 },
        empty: { items: [], revision: 0 },
        held: { items: [{ id: "h", text: "x", state: "waiting" }], revision: 1 },
      },
      sessionQueueHold: { held: true },
      "sessionQueue.legacy": ["legacy"],
    }),
    ["claimed", "current", "legacy"],
  );
});

test("#32 当前格式队列重启后由 host 水合并可投递", async () => {
  const agentDir = mkdtempSync(join(tmpdir(), "sdk-queue-fmt-"));
  const cwd = mkdtempSync(join(tmpdir(), "sdk-queue-fmt-cwd-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  let host;
  try {
    // 真实重启语义：先起一次 host 拿到真实会话，销毁后按其 id 落盘队列，再重启。
    const first = await startSdkSessionHost({
      sessionId: "__new__queue-fmt", sessionFile: "", cwd, agentDir,
      toolNames: [], idleTimeoutMs: 60_000,
    });
    const sessionId = first.sessionId;
    const file = first.sessionFile;
    // Pi 延迟落盘：无 prompt 时文件并不存在。必须显式落盘，否则「重启」时
    // SessionManager.open 会对不存在的路径当作新会话（id 变化），水合自然落空。
    const { materializeSessionFile } = await jiti.import("./pi-session-io.ts");
    materializeSessionFile(first.inner.sessionManager);
    await first.destroyAsync();
    assert.ok(existsSync(file), "会话文件必须真实存在，否则重启语义不成立");

    // 按写入方的真实格式落盘（不是数组）；hold 阻止自动投递，让水合结果可观测
    writeFileSync(
      join(agentDir, "pidance-preferences.json"),
      JSON.stringify({
        sessionQueue: {
          [sessionId]: {
            items: [{ id: "hydrated-1", text: "重启后应恢复", state: "waiting" }],
            revision: 5,
          },
        },
        sessionQueueHold: { [sessionId]: true },
      }),
    );

    host = await startSdkSessionHost({
      sessionId, sessionFile: file, cwd, agentDir, toolNames: [], idleTimeoutMs: 60_000,
    });
    const state = await host.send({ type: "get_state" });
    assert.deepEqual(state.queuedMessages?.followUp, ["重启后应恢复"], "当前格式必须被水合");
    assert.equal(state.queuedMessages?.followUpRevision, 5, "revision 必须保留（CAS 基线）");
    assert.deepEqual(
      state.queuedMessages?.followUpItems.map((item) => ({ id: item.id, state: item.state })),
      [{ id: "hydrated-1", state: "waiting" }],
      "条目身份必须原样保留，状态是 waiting",
    );
  } finally {
    try { await host?.destroyAsync?.(); } catch { /* ignore */ }
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(cwd, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("#32 set_follow_up_queue CAS：过期 revision 被拒并回权威队列", async () => {
  const agentDir = mkdtempSync(join(tmpdir(), "sdk-queue-cas-"));
  const cwd = mkdtempSync(join(tmpdir(), "sdk-queue-cas-cwd-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  let host;
  try {
    const { updatePidancePref } = await jiti.import("./pidance-prefs-file.ts");
    host = await startSdkSessionHost({
      sessionId: "__new__cas", sessionFile: "", cwd, agentDir, toolNames: [], idleTimeoutMs: 60_000,
    });
    // hold 阻止自动投递，让队列断言不被在途状态干扰
    updatePidancePref(`sessionQueueHold.${host.sessionId}`, true, agentDir);
    const first = await host.send({ type: "set_follow_up_queue", items: ["A 入队"] });
    assert.equal(first.ok, true);
    const revisionAfterA = first.revision;
    assert.equal(typeof revisionAfterA, "number");

    // 另一标签页从同一基线（A 之前的 revision）整组替换：必须冲突而不是覆盖
    const conflict = await host.send({
      type: "set_follow_up_queue",
      items: ["B 入队"],
      expectedRevision: revisionAfterA - 1,
    });
    assert.equal(conflict.conflict, true, "过期 revision 必须被拒");
    assert.deepEqual(
      conflict.items.map((item) => item.text),
      ["A 入队"],
      "必须回权威队列，不能覆盖先到者",
    );
    assert.equal(conflict.revision, revisionAfterA);

    // 带正确基线则接受
    const ok = await host.send({
      type: "set_follow_up_queue",
      items: ["A 入队", "B 入队"],
      expectedRevision: revisionAfterA,
    });
    assert.equal(ok.ok, true);
    assert.deepEqual(
      (await host.send({ type: "get_state" })).queuedMessages.followUp,
      ["A 入队", "B 入队"],
    );
  } finally {
    try { await host?.destroyAsync?.(); } catch { /* ignore */ }
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(cwd, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("SdkSessionHost：连接首帧快照带当前流式消息（中途接入的页面立刻看到部分回复）", { timeout: 20_000 }, async () => {
  const cwd = mkdtempSync(join(tmpdir(), "sdk-snapshot-cwd-"));
  const agentDir = mkdtempSync(join(tmpdir(), "sdk-snapshot-agent-"));
  const sessionDir = mkdtempSync(join(tmpdir(), "sdk-snapshot-sessions-"));
  const provider = "snapshot-test";
  const modelId = "snapshot-model";
  // provider 先吐一段 delta 就挂住，测试在这段时间里模拟「新标签接入」。
  let releaseStream;
  const streamGate = new Promise((resolve) => { releaseStream = resolve; });
  const requests = [];
  const server = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    requests.push(JSON.parse(raw));
    const sequence = requests.length;
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
    });
    const item = {
      id: `msg_${sequence}`,
      type: "message",
      role: "assistant",
      status: "completed",
      phase: "final_answer",
      content: [{ type: "output_text", text: "partial then final", annotations: [] }],
    };
    sendEvent(response, {
      type: "response.created",
      response: { id: `resp_${sequence}`, status: "in_progress", output: [] },
    });
    sendEvent(response, {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...item, status: "in_progress", content: [] },
    });
    sendEvent(response, {
      type: "response.output_text.delta",
      output_index: 0,
      item_id: item.id,
      content_index: 0,
      delta: "partial",
    });
    await streamGate;
    sendEvent(response, { type: "response.output_item.done", output_index: 0, item });
    sendEvent(response, {
      type: "response.completed",
      response: { id: `resp_${sequence}`, status: "completed", output: [item] },
    });
    response.end();
  });

  let host;
  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    writeFileSync(join(agentDir, "models.json"), JSON.stringify({
      providers: {
        [provider]: {
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          api: "openai-responses",
          apiKey: "test-key",
          models: [{
            id: modelId,
            name: modelId,
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 8192,
            maxTokens: 512,
          }],
        },
      },
    }));
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({
      defaultProvider: provider,
      defaultModel: modelId,
      retry: { enabled: false },
    }));

    const manager = createSessionManager(cwd, sessionDir);
    manager.appendModelChange(provider, modelId);
    manager.appendMessage({ role: "user", content: "fixture", timestamp: Date.now() - 1 });
    manager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "fixture ready" }],
      api: "openai-responses",
      provider,
      model: modelId,
      usage: zeroUsage(),
      stopReason: "stop",
      timestamp: Date.now(),
    });

    host = await startSdkSessionHost({
      sessionId: manager.getSessionId(),
      sessionFile: manager.getSessionFile(),
      cwd,
      agentDir,
      toolNames: [],
      idleTimeoutMs: 60_000,
    });

    const events = [];
    host.onEvent((event) => events.push(event));
    assert.deepEqual(host.connectionSnapshot(), { isStreaming: false, events: [] }, "空闲会话不得有首帧回放");

    void host.send({ type: "prompt", message: "hello" });
    await waitFor(
      () => events.some((event) => event.type === "message_update" && JSON.stringify(event.message ?? "").includes("partial")),
      "provider delta 未转成 message_update",
    );

    // 此刻等价于「新标签/刷新后重新连上这条 SSE」：只能拿到订阅之后的事件，
    // 已经生成的部分必须由首帧快照补齐。
    const snapshot = host.connectionSnapshot();
    assert.equal(snapshot.isStreaming, true, "流式中途接入必须报告正在流式");
    const replayed = snapshot.events.filter(
      (event) => event.type === "message_start" || event.type === "message_update",
    );
    assert.ok(replayed.length > 0, "快照必须回放当前流式消息");
    assert.ok(
      JSON.stringify(replayed.at(-1).message ?? "").includes("partial"),
      "回放的必须是当前部分回复（不是空壳）",
    );
    assert.equal(typeof replayed.at(-1).streamRunSeq, "number", "回放事件必须带 run 序号，收尾时才不会被当过期帧");

    releaseStream();
    await waitFor(() => events.some((event) => event.type === "agent_end"), "run did not finish");
    assert.deepEqual(
      host.connectionSnapshot(),
      { isStreaming: false, events: [], streamRunSeq: 1 },
      "本轮结束后流式内容必须清空，但仍带本轮序号（重连的客户端据此把 agent_end 收尾）",
    );
  } finally {
    releaseStream();
    await host?.destroyAsync();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    rmSync(cwd, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
    rmSync(sessionDir, { recursive: true, force: true });
  }
});


// ---------------------------------------------------------------------------
// Issue #90：树导航命令必须派发 session_before_tree（可取消）/ session_tree
//
// 这两个命令过去整条走 Service 的离线写（先交出 writer → 开磁盘视图 → 改 leaf + sidecar），
// 于是注册这两个事件的插件看不到任何分支动作。事件只能由本会话自己的 extension runner 派发，
// 而交接会 dispose Host（SDK 在那里 invalidate runner），所以顺序必须是
// before（可取消）→ 写 → tree → 再交出 writer。下面固定这个顺序与「取消 = 零改动」。
// ---------------------------------------------------------------------------

const TREE_SESSION_HEADER = {
  type: "session",
  version: 3,
  id: "s90",
  timestamp: "2026-01-01T00:00:00.000Z",
  cwd: "/tmp",
};

/** 最小会话 fixture：user → assistant → toolResult → user（轮末可验证）。 */
function writeTreeSession(file, entries) {
  writeFileSync(
    file,
    [JSON.stringify(TREE_SESSION_HEADER), ...entries.map((e) => JSON.stringify(e))].join("\n"),
  );
}

const TREE_ENTRIES = [
  { type: "message", id: "u1", parentId: null, message: { role: "user", content: "q1" } },
  { type: "message", id: "a1", parentId: "u1", message: { role: "assistant", content: [{ type: "text", text: "a1" }] } },
  { type: "message", id: "t1", parentId: "a1", message: { role: "toolResult", toolCallId: "c1", content: [] } },
  { type: "message", id: "u2", parentId: "t1", message: { role: "user", content: "q2" } },
];

/** 记录 Tree 事件（含「事件发生时 sidecar 是什么」——用它证明事件与写入的先后）。 */
function stubTreeEvents(host, file, { cancelBefore = false } = {}) {
  const runner = host.session.extensionRunner;
  const originalEmit = runner.emit;
  const originalHasHandlers = runner.hasHandlers;
  const events = [];
  runner.hasHandlers = (type) => type === "session_before_tree" || type === "session_tree";
  // `sessionUsable`：事件送达时本会话的 runner 是否还活着。#90 的要害就在这里 —— 交接会
  // dispose Host（SDK 在 AgentSession.dispose 里 invalidate runner），此时插件拿到的 ctx 全废，
  // 所以两条事件都必须在交出 writer 之前送达。
  const sessionUsable = () => {
    try {
      host.session.extensionRunner.getRegisteredCommands();
      return true;
    } catch {
      return false;
    }
  };
  runner.emit = async (event) => {
    if (event.type === "session_before_tree") {
      events.push({ type: event.type, preparation: event.preparation, sidecar: readLeafSidecar(file), usable: sessionUsable() });
      return cancelBefore ? { cancel: true } : undefined;
    }
    if (event.type === "session_tree") {
      events.push({ type: event.type, newLeafId: event.newLeafId, oldLeafId: event.oldLeafId, sidecar: readLeafSidecar(file), usable: sessionUsable() });
    }
    return undefined;
  };
  return {
    events,
    restore() {
      runner.emit = originalEmit;
      runner.hasHandlers = originalHasHandlers;
    },
  };
}

/**
 * 真实 Service（只用 liveWriter 模式需要的依赖）：Host 通过它写 leaf/sidecar，
 * 与生产同一条契约，避免在测试里手写一遍写入逻辑。
 */
function treeNavigationActions(file) {
  return createSessionService({
    getRpcSession: () => undefined,
    resolveSessionPath: async () => file,
    listAllSessions: async () => [],
    invalidateSessionListCache: () => {},
  });
}

function withTreeSession(run) {
  const dir = mkdtempSync(join(tmpdir(), "sdk-tree-nav-"));
  const file = join(dir, "session.jsonl");
  writeTreeSession(file, TREE_ENTRIES);
  const before = readFileSync(file, "utf8");
  return { dir, file, before, run };
}

test("#90 select_leaf_exact：before 在写之前、tree 在写之后，payload 与 sidecar 都对", async () => {
  const ctx = withTreeSession();
  try {
    await withHost({ sessionFile: ctx.file, sessionId: "s90", cwd: ctx.dir, navigationActions: treeNavigationActions(ctx.file) }, async (host) => {
      const leafBefore = host.session.sessionManager.getLeafId();
      const jsonlBefore = readFileSync(ctx.file, "utf8");
      const stub = stubTreeEvents(host, ctx.file);
      try {
        assert.deepEqual(await host.send({ type: "select_leaf_exact", entryId: "a1" }), { cancelled: false });
      } finally {
        stub.restore();
      }
      assert.deepEqual(stub.events.map((e) => e.type), ["session_before_tree", "session_tree"], "两条事件都要派发，且顺序固定");
      const [before, after] = stub.events;
      assert.equal(before.preparation.targetId, "a1");
      assert.equal(before.preparation.oldLeafId, leafBefore, "旧 leaf 必须是变动前的");
      assert.equal(before.preparation.userWantsSummary, false, "这两个命令不做摘要");
      assert.ok(Array.isArray(before.preparation.entriesToSummarize));
      assert.equal(before.sidecar, null, "before 事件时还没写 sidecar（事件在改动前）");
      assert.equal(after.sidecar, "a1", "tree 事件时 sidecar 已指向新 leaf（事件在改动后）");
      assert.equal(after.newLeafId, "a1");
      assert.equal(after.oldLeafId, leafBefore);
      assert.equal(before.usable, true, "before 事件必须在 runner 还活着时送达（插件要能 veto）");
      assert.equal(after.usable, true, "tree 事件也必须在交出 writer 之前送达，否则插件拿到 stale ctx");
      assert.equal(readLeafSidecar(ctx.file), "a1");
      assert.equal(readFileSync(ctx.file, "utf8"), jsonlBefore, "JSONL 内容不得被这个命令改动");
      assert.equal(host.isAlive(), false, "导航后交出 writer（与旧行为一致）");
    });
  } finally {
    rmSync(ctx.dir, { recursive: true, force: true });
  }
});

test("#90 session_before_tree 返回 cancel：零改动、不派发 session_tree、writer 不交出", async () => {
  const ctx = withTreeSession();
  try {
    await withHost({ sessionFile: ctx.file, sessionId: "s90", cwd: ctx.dir, navigationActions: treeNavigationActions(ctx.file) }, async (host) => {
      const leafBefore = host.session.sessionManager.getLeafId();
      const jsonlBefore = readFileSync(ctx.file, "utf8");
      const stub = stubTreeEvents(host, ctx.file, { cancelBefore: true });
      let result;
      try {
        result = await host.send({ type: "select_leaf_exact", entryId: "a1" });
      } finally {
        stub.restore();
      }
      assert.deepEqual(result, { cancelled: true });
      assert.deepEqual(stub.events.map((e) => e.type), ["session_before_tree"], "取消后不得派发 session_tree");
      assert.equal(readLeafSidecar(ctx.file), null, "取消不得写 sidecar");
      assert.equal(host.session.sessionManager.getLeafId(), leafBefore, "取消不得改 leaf");
      assert.equal(readFileSync(ctx.file, "utf8"), jsonlBefore, "取消不得改 JSONL");
      assert.equal(host.isAlive(), true, "取消不得交出 writer");
    });
  } finally {
    rmSync(ctx.dir, { recursive: true, force: true });
  }
});

test("#90 branch_from_assistant：leaf 落在轮末（t1），事件顺序与 payload 同 select_leaf_exact", async () => {
  const ctx = withTreeSession();
  try {
    await withHost({ sessionFile: ctx.file, sessionId: "s90", cwd: ctx.dir, navigationActions: treeNavigationActions(ctx.file) }, async (host) => {
      const stub = stubTreeEvents(host, ctx.file);
      let result;
      try {
        result = await host.send({ type: "branch_from_assistant", assistantEntryId: "a1" });
      } finally {
        stub.restore();
      }
      assert.deepEqual(result, { cancelled: false });
      assert.deepEqual(stub.events.map((e) => e.type), ["session_before_tree", "session_tree"]);
      assert.equal(
        stub.events[0].preparation.targetId,
        "t1",
        "事件目标是**落地后的 leaf**（本轮的轮末 t1），与 Pi 的 navigateTree(turnEnd) 一致：用被点击的 assistant 会让插件记下的目标与磁盘错一层",
      );
      assert.equal(
        stub.events[0].preparation.commonAncestorId,
        "t1",
        "共同祖先也必须按轮末算（按 assistant 会算成 a1，摘要范围跟着偏）",
      );
      assert.equal(stub.events[0].sidecar, null);
      assert.equal(stub.events[1].newLeafId, "t1", "轮末 = 下一条 user 之前的最后一条 entry");
      assert.equal(stub.events[1].sidecar, "t1");
      assert.equal(stub.events[1].usable, true, "runner 必须仍然可用");
      assert.equal(readLeafSidecar(ctx.file), "t1");
      assert.equal(host.isAlive(), false);
    });
  } finally {
    rmSync(ctx.dir, { recursive: true, force: true });
  }
});

test("#90 真实扩展（agentDir/extensions 加载）能收到两条事件，且 ctx 可用", async () => {
  // 上面几条用桩 runner 固定契约，这一条走**真实扩展加载**：插件经 pi.on 注册，事件必须真的送达
  // 它手里（#90 的验收就是这个）。日志里的 cwd 有值 = 事件送达时 runner 未被 invalidate。
  const root = mkdtempSync(join(tmpdir(), "sdk-tree-ext-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "cwd");
  mkdirSync(join(agentDir, "extensions"), { recursive: true });
  mkdirSync(cwd, { recursive: true });
  const log = join(root, "probe.log");
  writeFileSync(log, "");
  writeFileSync(
    join(agentDir, "extensions", "tree-probe.ts"),
    [
      'import { appendFileSync } from "node:fs";',
      "export default function register(pi) {",
      '  pi.on("session_before_tree", async (event, ctx) => {',
      `    appendFileSync(${JSON.stringify(log)}, "before:" + event.preparation.targetId + ":cwd=" + String(ctx?.cwd) + "\\n");`,
      "  });",
      '  pi.on("session_tree", async (event, ctx) => {',
      `    appendFileSync(${JSON.stringify(log)}, "tree:" + event.newLeafId + ":" + event.oldLeafId + ":cwd=" + String(ctx?.cwd) + "\\n");`,
      "  });",
      "}",
      "",
    ].join("\n"),
  );
  const file = join(root, "session.jsonl");
  writeTreeSession(file, TREE_ENTRIES);
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  let host;
  try {
    host = await startSdkSessionHost({
      sessionId: "s90",
      sessionFile: file,
      cwd,
      agentDir,
      toolNames: [],
      idleTimeoutMs: 60_000,
      navigationActions: treeNavigationActions(file),
    });
    assert.equal(host.session.extensionRunner.hasHandlers("session_before_tree"), true, "扩展必须真的注册上");
    assert.equal(host.session.extensionRunner.hasHandlers("session_tree"), true);
    assert.deepEqual(await host.send({ type: "select_leaf_exact", entryId: "a1" }), { cancelled: false });
    const lines = readFileSync(log, "utf8").trim().split("\n");
    assert.equal(lines.length, 2, `扩展必须收到两条事件，实际：${JSON.stringify(lines)}`);
    assert.match(lines[0], /^before:a1:cwd=.+/, "before 事件必须先到，且 ctx 可用（cwd 有值 = runner 未被 invalidate）");
    assert.match(lines[1], /^tree:a1:/, "tree 事件的 newLeafId 必须是写完的 leaf");
    assert.equal(readLeafSidecar(file), "a1");
  } finally {
    try { await host?.destroyAsync?.(); } catch { /* ignore */ }
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(root, { recursive: true, force: true });
  }
});

test("#90 目标就是当前 leaf：无变化 → 不发事件、不写文件、也不交出 writer（Pi 同款提前返回）", async () => {
  const ctx = withTreeSession();
  try {
    await withHost({ sessionFile: ctx.file, sessionId: "s90", cwd: ctx.dir, navigationActions: treeNavigationActions(ctx.file) }, async (host) => {
      const currentLeaf = host.session.sessionManager.getLeafId();
      const stub = stubTreeEvents(host, ctx.file);
      let result;
      try {
        result = await host.send({ type: "select_leaf_exact", entryId: currentLeaf });
      } finally {
        stub.restore();
      }
      assert.deepEqual(result, { cancelled: false });
      assert.deepEqual(stub.events, [], "无变化不得发事件");
      assert.equal(readLeafSidecar(ctx.file), null);
      assert.equal(host.isAlive(), true, "无变化不需要交出 writer");
    });
  } finally {
    rmSync(ctx.dir, { recursive: true, force: true });
  }
});

test("#90 导航期间 isCompacting 为真：第二次导航被拒、新 prompt 进队列而不是抢同一个 manager", async () => {
  // 父会话在 SDK 里核实：isCompacting = 「三个 abort controller 任一存在」（agent-session.js:928-931），
  // Pi 靠它挡住新 prompt（:876）与第二次导航（:2859），并让 abort() 能取消 before（:2004）。
  // 本命令的 await 留在 live 会话上，不挂这个字段就等于把这层闸门丢掉。
  const ctx = withTreeSession();
  try {
    await withHost({ sessionFile: ctx.file, sessionId: "s90", cwd: ctx.dir, navigationActions: treeNavigationActions(ctx.file) }, async (host) => {
      const runner = host.session.extensionRunner;
      const originalEmit = runner.emit;
      const originalHasHandlers = runner.hasHandlers;
      runner.hasHandlers = (type) => type === "session_before_tree" || type === "session_tree";
      let releaseBefore;
      const hold = new Promise((resolve) => { releaseBefore = resolve; });
      let entered;
      const enteredBefore = new Promise((resolve) => { entered = resolve; });
      const seen = [];
      runner.emit = async (event) => {
        if (event.type !== "session_before_tree") return undefined;
        seen.push({ compacting: host.session.isCompacting, aborted: event.signal?.aborted === true });
        entered();
        await hold;
        return undefined;
      };
      try {
        const first = host.send({ type: "select_leaf_exact", entryId: "a1" });
        await enteredBefore;
        assert.equal(seen[0].compacting, true, "before 期间 isCompacting 必须为真");
        assert.equal(seen[0].aborted, false, "此时还没 abort，signal 要是未中止的");
        await assert.rejects(
          () => host.send({ type: "select_leaf_exact", entryId: "u2" }),
          /Wait for the current compaction or tree navigation to finish/,
          "导航在途时第二次导航必须被拒（Pi 同款闸门）",
        );
        const receipt = await host.send({ type: "prompt", submissionId: "sub-nav-gate", message: "后来的一句话" });
        assert.equal(receipt.status, "queued", "导航期间的新 prompt 必须进产品队列，不能与 branch() 抢同一个 manager");
        const state = await host.send({ type: "get_state" });
        assert.deepEqual(state.queuedMessages.followUp, ["后来的一句话"]);
        releaseBefore();
        assert.deepEqual(await first, { cancelled: false });
      } finally {
        runner.emit = originalEmit;
        runner.hasHandlers = originalHasHandlers;
        releaseBefore?.();
      }
    });
  } finally {
    rmSync(ctx.dir, { recursive: true, force: true });
  }
});

test("#90 branch_from_assistant 已在轮末：不发事件、不写 sidecar、不交接 writer", async () => {
  // 轮末就是当前 leaf 时 Pi 在 emit 之前就 return（agent-session.js:2864）。旧实现会照常发事件、
  // 拆会话——重复点同一条 assistant 的轮末分支是常见操作，不该拆会话。
  const ctx = withTreeSession();
  try {
    // 真实场景：会话曾导航到 t1（sidecar = t1），用户重开页面后又点了一次同一条 assistant。
    // 开盘时 Host 会追加一条 thinking_level_change（叶子随之落到末尾），于是「该轮的轮末」
    // 正好就是当前 leaf —— 此时 Pi 在 emit 之前返回，Pidance 也必须如此。
    writeFileSync(`${ctx.file}.leaf.json`, JSON.stringify({ version: 1, leafId: "t1" }));
    await withHost({ sessionFile: ctx.file, sessionId: "s90", cwd: ctx.dir, navigationActions: treeNavigationActions(ctx.file) }, async (host) => {
      const currentLeaf = host.session.sessionManager.getLeafId();
      assert.ok(currentLeaf && currentLeaf !== "t1", "前提：开盘后叶子已落到末尾追加的 entry 上");
      const stub = stubTreeEvents(host, ctx.file);
      let result;
      try {
        result = await host.send({ type: "branch_from_assistant", assistantEntryId: "a1" });
      } finally {
        stub.restore();
      }
      assert.deepEqual(result, { cancelled: false });
      assert.deepEqual(stub.events, [], "目标就是当前 leaf：不得发事件");
      assert.equal(
        host.session.sessionManager.getLeafId(),
        currentLeaf,
        "无变化不得改 leaf（会话也必须仍然活着，不能顺手拆掉）",
      );
      assert.equal(readLeafSidecar(ctx.file), null, "叶子已在文件末尾：过期 sidecar 必须清掉（不是写冗余指针）");
      assert.equal(host.isAlive(), true, "无变化不需要交出 writer");
    });
  } finally {
    rmSync(ctx.dir, { recursive: true, force: true });
  }
});

test("#90 无 Service 注入（例如队列恢复拉起的 host）：本地路径走同一套判定，不退回 SDK navigateTree", async () => {
  const ctx = withTreeSession();
  try {
    // (1) select_leaf_exact 落在 user entry 上必须是**精确 leaf**：Pi 的 navigateTree 会把
    //     user / custom_message 目标退到 parent，那样命令名就名不副实。
    await withHost({ sessionFile: ctx.file, sessionId: "s90", cwd: ctx.dir }, async (host) => {
      const stub = stubTreeEvents(host, ctx.file);
      let result;
      try {
        result = await host.send({ type: "select_leaf_exact", entryId: "u1" });
      } finally {
        stub.restore();
      }
      assert.deepEqual(result, { cancelled: false });
      assert.deepEqual(stub.events.map((e) => e.type), ["session_before_tree", "session_tree"]);
      assert.equal(stub.events[0].preparation.targetId, "u1", "事件目标就是要落的 entry");
      assert.equal(stub.events[1].newLeafId, "u1", "精确 leaf：user 目标不得像 Pi 那样退到 parent");
      assert.equal(readLeafSidecar(ctx.file), "u1");
      assert.equal(host.isAlive(), false, "与主路径同一终态：交出 writer");
    });
    // (2) branch_from_assistant 在无 Service 时也必须可用（旧实现直接抛 unavailable）。
    //     先清掉上一步的 sidecar，让开盘 leaf 回到文件末尾（真实场景：正常继续对话的会话）。
    rmSync(`${ctx.file}.leaf.json`, { force: true });
    await withHost({ sessionFile: ctx.file, sessionId: "s90", cwd: ctx.dir }, async (host) => {
      const stub = stubTreeEvents(host, ctx.file);
      let result;
      try {
        result = await host.send({ type: "branch_from_assistant", assistantEntryId: "a1" });
      } finally {
        stub.restore();
      }
      assert.deepEqual(result, { cancelled: false }, "无 Service 时分支命令必须可用，不能抛 unavailable");
      assert.deepEqual(stub.events.map((e) => e.type), ["session_before_tree", "session_tree"]);
      assert.equal(stub.events[0].preparation.targetId, "t1", "事件目标是轮末");
      assert.equal(stub.events[1].newLeafId, "t1", "落地 leaf 是轮末");
      assert.equal(readLeafSidecar(ctx.file), "t1");
      assert.equal(host.isAlive(), false);
    });
  } finally {
    rmSync(ctx.dir, { recursive: true, force: true });
  }
});

test("#90 落地已提交后交接撞上 busy：不得把失败抛给调用方（磁盘与内存都已一致）", async () => {
  // destroyExcluding(1) 撞上另一条命令会 busy。叶子与 sidecar 都已经提交，此时把失败抛出去
  // 会让调用方以为导航没生效 —— 必须只记录，不改变返回值。
  const ctx = withTreeSession();
  try {
    let releaseOther;
    const otherGate = new Promise((resolve) => { releaseOther = resolve; });
    const svc = treeNavigationActions(ctx.file);
    await withHost({
      sessionFile: ctx.file,
      sessionId: "s90",
      cwd: ctx.dir,
      destroyWaitMs: 80,
      navigationActions: {
        selectLeafExact: (sessionId, entryId, options) => svc.selectLeafExact(sessionId, entryId, options),
        branchFromAssistant: (sessionId, entryId, options) => svc.branchFromAssistant(sessionId, entryId, options),
        createSessionFromLeaf: () => otherGate,
      },
    }, async (host) => {
      const other = host.send({ type: "create_session_from_leaf", entryId: "e1" });
      assert.deepEqual(
        await host.send({ type: "select_leaf_exact", entryId: "a1" }),
        { cancelled: false },
        "已提交之后不得因交接 busy 报失败",
      );
      assert.equal(readLeafSidecar(ctx.file), "a1", "sidecar 已提交（磁盘提交点在交接之前）");
      releaseOther({ cancelled: false, newSessionId: "x" });
      await other.catch(() => {});
      await host.destroyAsync().catch(() => {});
      assert.equal(host.isAlive(), false, "命令结束后回收仍必须成功");
    });
  } finally {
    rmSync(ctx.dir, { recursive: true, force: true });
  }
});
