/**
 * SdkSessionHost 窄集成：临时目录创建会话、get_state、destroy。
 * 不调用真实模型 API。
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
    host.extensionUi.uiContext.setWidget("w1", ["一", "二"], { placement: "belowEditor" });
    const stateWithWidget = await host.send({ type: "get_state" });
    assert.deepEqual(stateWithWidget.extensionWidgets, [
      { key: "w1", lines: ["一", "二"], placement: "belowEditor" },
    ]);

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

test("Host 把 extension_ui_input 转给 adapter.inputCustom", async () => {
  const src = readFileSync(new URL("./sdk-session-host.ts", import.meta.url), "utf8");
  assert.match(src, /inputCustom/);
  assert.match(src, /extension_ui_input/);
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
      // 忽略 handoff，模拟「命令仍在进行」
      selectLeafExact: () => gate,
      branchFromAssistant: async () => ({ cancelled: false }),
      createSessionFromLeaf: async () => ({ cancelled: false, newSessionId: "x" }),
    },
  }, async (host) => {
    const command = host.send({ type: "select_leaf_exact", entryId: "e1" });
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
      selectLeafExact: async (_sessionId, _entryId, handoff) => {
        // 模拟 Service：离线写前用 Host 提供的显式交接让出 writer
        await handoff();
        assert.equal(running.isAlive(), false, "交接完成后 writer 必须已交出");
        return { cancelled: false };
      },
      branchFromAssistant: async () => ({ cancelled: false }),
      createSessionFromLeaf: async () => ({ cancelled: false, newSessionId: "x" }),
    },
  }, async (host) => {
    running = host;
    const result = await Promise.race([
      host.send({ type: "select_leaf_exact", entryId: "e1" }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("导航命令自等待死锁")), 3_000)),
    ]);
    assert.deepEqual(result, { cancelled: false });
    assert.equal(host.isAlive(), false);
  });
});

test("SdkSessionHost：命令长时间不结束时 destroyAsync 以 busy fail closed", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  await withHost({
    destroyWaitMs: 80,
    navigationActions: {
      selectLeafExact: () => gate,
      branchFromAssistant: async () => ({ cancelled: false }),
      createSessionFromLeaf: async () => ({ cancelled: false, newSessionId: "x" }),
    },
  }, async (host) => {
    const command = host.send({ type: "select_leaf_exact", entryId: "e1" });
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
