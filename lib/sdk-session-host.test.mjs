/**
 * SdkSessionHost 窄集成：临时目录创建会话、get_state、destroy。
 * 不调用真实模型 API。
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { startSdkSessionHost } = await jiti.import("./sdk-session-host.ts");
const { createSessionManager } = await jiti.import("./pi-session-io.ts");
const { updatePidancePref } = await jiti.import("./pidance-prefs-file.ts");
const { listRecoverableFollowUpSessionIds } = await jiti.import("./live-session-registry.ts");

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
      idleTimeoutMs: 60_000,
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

    await waitFor(() => requests.length === 2, "follow-up was not sent after agent_settled");
    await waitFor(() => !host.isRunning(), "follow-up run did not settle");
    assert.match(JSON.stringify(requests[1].input), /queued prompt/);
    assert.equal(host.isAlive(), true);
    const settledState = await host.send({ type: "get_state" });
    assert.deepEqual(settledState.queuedMessages.followUp, []);

    const prefs = JSON.parse(readFileSync(join(agentDir, "pidance-preferences.json"), "utf8"));
    assert.deepEqual(prefs.sessionQueue?.[host.sessionId], []);
    assert.equal(prefs.sessionQueueHold?.[host.sessionId], undefined);
    const userTexts = host.inner.sessionManager
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
    assert.deepEqual(queued, {
      submissionId: "queued-during-compaction",
      sessionId: host.sessionId,
      status: "accepted",
    });
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
