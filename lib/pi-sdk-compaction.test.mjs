import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { startSdkSessionHost } = await jiti.import("./sdk-session-host.ts");
const { createSessionManager, openSessionManager } = await jiti.import("./pi-session-io.ts");

function sendEvent(response, event) {
  response.write(`data: ${JSON.stringify(event)}\n\n`);
}

function sendTextResponse(response, responseId, itemId, text) {
  const item = {
    id: itemId,
    type: "message",
    role: "assistant",
    status: "completed",
    phase: "final_answer",
    content: [{ type: "output_text", text, annotations: [] }],
  };
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
}

function sendReadToolCall(response, responseId) {
  const argumentsJson = JSON.stringify({ path: "large.txt" });
  const item = {
    id: "fc_read_large",
    type: "function_call",
    call_id: "call_read_large",
    name: "read",
    arguments: argumentsJson,
    status: "completed",
  };
  sendEvent(response, {
    type: "response.output_item.added",
    output_index: 0,
    item: { ...item, arguments: "", status: "in_progress" },
  });
  sendEvent(response, {
    type: "response.function_call_arguments.delta",
    output_index: 0,
    item_id: item.id,
    delta: argumentsJson,
  });
  sendEvent(response, {
    type: "response.function_call_arguments.done",
    output_index: 0,
    item_id: item.id,
    arguments: argumentsJson,
  });
  sendEvent(response, { type: "response.output_item.done", output_index: 0, item });
  sendEvent(response, {
    type: "response.completed",
    response: { id: responseId, status: "completed", output: [item] },
  });
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

async function waitFor(predicate, message, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("Pi 0.84.4：大工具结果跨阈值时先压缩再继续模型调用", { timeout: 30_000 }, async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-compact-cwd-"));
  const agentDir = mkdtempSync(join(tmpdir(), "pi-compact-agent-"));
  const sessionDir = mkdtempSync(join(tmpdir(), "pi-compact-sessions-"));
  writeFileSync(join(cwd, "large.txt"), "tool-result ".repeat(1800));

  const provider = "compaction-test";
  const modelId = "pidance-compaction-test";
  const requests = [];
  let mainCall = 0;
  const server = createServer(async (request, response) => {
    try {
      let raw = "";
      for await (const chunk of request) raw += chunk;
      const body = JSON.parse(raw);
      const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
      requests.push({
        kind: hasTools ? "main" : "summary",
        hasTools,
        hasToolChoice: Object.hasOwn(body, "tool_choice"),
      });

      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      });
      const responseId = `resp_${requests.length}`;
      sendEvent(response, {
        type: "response.created",
        response: { id: responseId, status: "in_progress", output: [] },
      });
      if (!hasTools) {
        sendTextResponse(
          response,
          responseId,
          `summary_${requests.length}`,
          "## Goal\nContinue the test.\n\n## Progress\nPrior history summarized.",
        );
      } else if (++mainCall === 1) {
        sendReadToolCall(response, responseId);
      } else {
        sendTextResponse(response, responseId, "msg_done", "done after compaction");
      }
      response.end();
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
            name: "Pidance compaction test",
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
      compaction: {
        enabled: true,
        reserveTokens: 1024,
        // toolResult≈5400 tokens；再加当前 user/toolCall 后越过 5410，
        // 使合法 cut point 落在当前 user，旧历史可被压缩。
        keepRecentTokens: 5410,
      },
      retry: { enabled: false },
    }));

    const manager = createSessionManager(cwd, sessionDir);
    manager.appendModelChange(provider, modelId);
    manager.appendMessage({
      role: "user",
      content: `prior ${"history ".repeat(1700)}`,
      timestamp: Date.now() - 2,
    });
    manager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "prior turn complete" }],
      api: "openai-responses",
      provider,
      model: modelId,
      usage: zeroUsage(),
      stopReason: "stop",
      timestamp: Date.now() - 1,
    });
    assert.ok(manager.getSessionFile());
    assert.equal(existsSync(manager.getSessionFile()), true);

    host = await startSdkSessionHost({
      sessionId: manager.getSessionId(),
      sessionFile: manager.getSessionFile(),
      cwd,
      agentDir,
      toolNames: ["read"],
      idleTimeoutMs: 60_000,
    });
    const events = [];
    const unlisten = host.onEvent((event) => {
      if (
        event.type === "compaction_start"
        || event.type === "compaction_end"
        || event.type === "agent_settled"
      ) {
        events.push(event);
      }
    });

    await host.send({ type: "prompt", message: "Read large.txt, then answer done." });
    await waitFor(
      () => events.some((event) => event.type === "agent_settled"),
      "agent did not settle after compaction",
    );
    unlisten();

    assert.deepEqual(requests.map((entry) => entry.kind), ["main", "summary", "main"]);
    assert.deepEqual(requests[1], {
      kind: "summary",
      hasTools: false,
      hasToolChoice: false,
    });
    const compactionEvents = events.filter((event) => event.type.startsWith("compaction_"));
    assert.equal(compactionEvents[0]?.type, "compaction_start");
    assert.equal(compactionEvents[0]?.reason, "threshold");
    assert.equal(compactionEvents[1]?.type, "compaction_end");
    assert.equal(compactionEvents[1]?.reason, "threshold");
    assert.ok(compactionEvents[1]?.result);
    assert.equal(compactionEvents[1]?.aborted, false);
    assert.equal(compactionEvents[1]?.willRetry, false);
    assert.ok(host.sessionFile);
    // settled 且无可投递队列：host 立即释放。会话内容从磁盘快照验证。
    await waitFor(() => !host.isAlive(), "settled host was not disposed");

    const managerView = openSessionManager(host.sessionFile, sessionDir);
    const entries = managerView.getEntries();
    const compactionIndex = entries.findIndex((entry) => entry.type === "compaction");
    const finalMessageIndex = entries.findLastIndex(
      (entry) => entry.type === "message" && entry.message.role === "assistant",
    );
    assert.ok(compactionIndex >= 0);
    assert.ok(finalMessageIndex > compactionIndex);
    assert.ok(host.sessionFile);
    const reopened = openSessionManager(host.sessionFile, sessionDir);
    const context = reopened.buildSessionContext();
    const finalMessage = context.messages.at(-1);
    assert.equal(finalMessage?.role, "assistant");
    assert.equal(finalMessage.content[0]?.text, "done after compaction");
  } finally {
    await host?.destroyAsync();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    rmSync(cwd, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
    rmSync(sessionDir, { recursive: true, force: true });
  }
});

async function withCompactionFixture(name, handleRequest, run, options = {}) {
  const cwd = mkdtempSync(join(tmpdir(), `pi-compact-${name}-cwd-`));
  const agentDir = mkdtempSync(join(tmpdir(), `pi-compact-${name}-agent-`));
  const sessionDir = mkdtempSync(join(tmpdir(), `pi-compact-${name}-sessions-`));
  writeFileSync(join(cwd, "large.txt"), "tool-result ".repeat(1800));
  const provider = `compaction-${name}`;
  const modelId = `pidance-compaction-${name}`;
  const requests = [];
  const server = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
    const entry = { kind: hasTools ? "main" : "summary", hasTools };
    requests.push(entry);
    await handleRequest({ request, response, body, hasTools, requests });
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
            name: name,
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: options.contextWindow ?? 8192,
            maxTokens: 512,
          }],
        },
      },
    }));
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({
      defaultProvider: provider,
      defaultModel: modelId,
      compaction: { enabled: true, reserveTokens: 1024, keepRecentTokens: 5410, ...options.compaction },
      retry: { enabled: false },
    }));
    const manager = createSessionManager(cwd, sessionDir);
    manager.appendModelChange(provider, modelId);
    manager.appendMessage({ role: "user", content: `prior ${"history ".repeat(1700)}`, timestamp: Date.now() - 2 });
    manager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "prior turn complete" }],
      api: "openai-responses",
      provider,
      model: modelId,
      usage: zeroUsage(),
      stopReason: "stop",
      timestamp: Date.now() - 1,
    });
    host = await startSdkSessionHost({
      sessionId: manager.getSessionId(),
      sessionFile: manager.getSessionFile(),
      cwd,
      agentDir,
      toolNames: ["read"],
      idleTimeoutMs: 60_000,
    });
    const events = [];
    const unlisten = host.onEvent((event) => {
      if (
        event.type === "agent_settled"
        || event.type === "compaction_start"
        || event.type === "compaction_end"
        || event.type === "prompt_error"
      ) {
        events.push(event);
      }
    });
    try {
      await run({ host, events, unlisten, requests, sessionFile: host.sessionFile, sessionDir, agentDir, provider, modelId });
    } finally {
      unlisten();
    }
  } finally {
    await host?.destroyAsync();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    rmSync(cwd, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
    rmSync(sessionDir, { recursive: true, force: true });
  }
}

test("Pi 0.84.4：压缩失败后运行收敛，截断摘要不落盘，JSONL 可重开", { timeout: 30_000 }, async () => {
  await withCompactionFixture("fail", async ({ response, hasTools, requests }) => {
    if (!hasTools) {
      response.statusCode = 500;
      response.end("summary truncated");
      return;
    }
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const responseId = `resp_${requests.length}`;
    sendEvent(response, { type: "response.created", response: { id: responseId, status: "in_progress", output: [] } });
    sendReadToolCall(response, responseId);
    response.end();
  }, async ({ host, events, requests, sessionFile, sessionDir }) => {
    const pending = host.send({ type: "prompt", message: "Read large.txt, then answer done." }).catch(() => undefined);
    await waitFor(
      () => requests.some((entry) => entry.kind === "summary"),
      "summary request never happened",
      15_000,
    );
    await waitFor(
      () => events.some((event) => event.type === "compaction_end") || !host.isRunning(),
      "compaction_end never arrived after summary failure",
      15_000,
    );
    await pending;
    const end = events.find((event) => event.type === "compaction_end");
    assert.ok(end, "must observe compaction_end");
    assert.ok(end.errorMessage || end.aborted || end.error, "failure must be visible on compaction_end");
    assert.ok(requests.some((entry) => entry.kind === "summary"));
    const reopened = openSessionManager(sessionFile, sessionDir);
    const compaction = reopened.getEntries().find((entry) => entry.type === "compaction");
    assert.equal(compaction, undefined, "压缩失败/截断摘要不得落盘为 compaction entry");
    assert.ok(reopened.buildSessionContext());
  });
});

test("Pi 0.84.4：压缩中止不落盘，JSONL 可重开", { timeout: 30_000 }, async () => {
  let holdSummary;
  const gate = new Promise((resolve) => { holdSummary = resolve; });
  await withCompactionFixture("abort", async ({ response, hasTools, requests }) => {
    if (!hasTools) {
      await Promise.race([gate, new Promise((resolve) => setTimeout(resolve, 8_000))]);
      try {
        response.statusCode = 499;
        response.end("aborted");
      } catch {
        /* client already aborted */
      }
      return;
    }
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const responseId = `resp_${requests.length}`;
    sendEvent(response, { type: "response.created", response: { id: responseId, status: "in_progress", output: [] } });
    sendReadToolCall(response, responseId);
    response.end();
  }, async ({ host, events, requests, sessionFile, sessionDir }) => {
    const pending = host.send({ type: "prompt", message: "Read large.txt, then answer done." }).catch(() => undefined);
    await waitFor(
      () => events.some((event) => event.type === "compaction_start") || requests.some((entry) => entry.kind === "summary"),
      "compaction never started",
      15_000,
    );
    await host.send({ type: "abort_compaction" }).catch(() => undefined);
    holdSummary?.();
    await waitFor(
      () => events.some((event) => event.type === "compaction_end"),
      "compaction_end never arrived after abort",
      15_000,
    );
    await pending;
    const end = events.find((event) => event.type === "compaction_end");
    assert.ok(end, "abort 后必须收敛到 compaction_end");
    assert.ok(end.aborted === true || end.errorMessage, "abort must surface on compaction_end");
    // compaction_start 可能先于 summary HTTP；abort 在该窗口内合法地阻止 summary，
    // 因此这里只验证事件收敛与不落盘，不把 summary 请求当作 abort 前置条件。
    const reopened = openSessionManager(sessionFile, sessionDir);
    const compaction = reopened.getEntries().find((entry) => entry.type === "compaction");
    assert.equal(compaction, undefined, "中止压缩不得落盘 compaction entry");
    assert.ok(reopened.buildSessionContext());
  });
});

test("Pi 0.84.4：手动压缩走 summary 且 JSONL 可重开", { timeout: 30_000 }, async () => {
  let mainCall = 0;
  await withCompactionFixture("manual", async ({ response, hasTools, requests }) => {
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const responseId = `resp_${requests.length}`;
    sendEvent(response, { type: "response.created", response: { id: responseId, status: "in_progress", output: [] } });
    if (!hasTools) {
      sendTextResponse(
        response,
        responseId,
        `summary_${requests.length}`,
        "## Goal\nContinue.\n\n## Progress\nSummarized.",
      );
    } else if (++mainCall === 1) {
      sendReadToolCall(response, responseId);
    } else {
      sendTextResponse(response, responseId, "msg_done", "manual compact done");
    }
    response.end();
  }, async ({ host, events, unlisten, requests, sessionFile, sessionDir, agentDir }) => {
    const pendingPrompt = host.send({ type: "prompt", message: "Read large.txt, then wait." }).catch(() => undefined);
    await waitFor(() => !host.isRunning(), "setup prompt did not settle", 15_000);
    await pendingPrompt;
    // 新 idle 语义：settled 且无队列时 host 自行释放（不等订阅断开）。
    await waitFor(() => !host.isAlive(), "settled host did not dispose", 15_000);
    events.length = 0;
    requests.length = 0;
    // 写操作（压缩）等价产品 ensureLive 重建：同文件重启 host。
    const headerCwd = openSessionManager(sessionFile).getHeader()?.cwd || agentDir;
    const host2 = await startSdkSessionHost({
      sessionId: host.sessionId,
      sessionFile: host.sessionFile,
      cwd: headerCwd,
      agentDir,
      toolNames: ["read"],
      idleTimeoutMs: 60_000,
    });
    const evs2 = [];
    const unlisten2 = host2.onEvent((event) => {
      if (["compaction_start", "compaction_end"].includes(event.type)) evs2.push(event);
    });
    try {
      const compactPromise = host2.send({ type: "compact" }).catch((error) => {
        // keep original error visibility
        throw error;
      });
      await waitFor(
        () => evs2.some((event) => event.type === "compaction_end"),
        "manual compaction_end never arrived",
        15_000,
      );
      await compactPromise;
      const start = evs2.find((event) => event.type === "compaction_start");
      const end = evs2.find((event) => event.type === "compaction_end");
      assert.ok(start);
      assert.equal(start.reason, "manual");
      assert.ok(end);
      assert.equal(end.reason, "manual");
      assert.equal(end.aborted, false);
      assert.ok(requests.some((entry) => entry.kind === "summary"));
      unlisten2();
      await waitFor(() => !host2.isAlive(), "rebuilt host did not dispose", 15_000);
    } finally {
      await host2.destroyAsync();
    }
    const reopened = openSessionManager(sessionFile, sessionDir);
    assert.ok(reopened.getEntries().some((entry) => entry.type === "compaction"));
    assert.ok(reopened.buildSessionContext());
  }, { compaction: { enabled: false } });
});

test("Pi 0.84.4：上下文窗口过小触发 threshold 压缩且 JSONL 可重开", { timeout: 30_000 }, async () => {
  let mainCall = 0;
  await withCompactionFixture("overflow", async ({ response, hasTools, requests }) => {
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const responseId = `resp_${requests.length}`;
    sendEvent(response, { type: "response.created", response: { id: responseId, status: "in_progress", output: [] } });
    if (!hasTools) {
      sendTextResponse(response, responseId, `summary_${requests.length}`, "## Goal\nContinue.\n\n## Progress\nOverflow summarized.");
    } else if (++mainCall === 1) {
      sendReadToolCall(response, responseId);
    } else {
      sendTextResponse(response, responseId, "msg_done", "done after overflow compact");
    }
    response.end();
  }, async ({ host, events, requests, sessionFile, sessionDir }) => {
    await host.send({ type: "prompt", message: "Read large.txt, then answer done." });
    await waitFor(
      () => events.some((event) => event.type === "compaction_end"),
      "overflow/threshold compaction_end never arrived",
      15_000,
    );
    const start = events.find((event) => event.type === "compaction_start");
    assert.ok(start);
    assert.equal(start.reason, "threshold");
    assert.ok(requests.some((entry) => entry.kind === "summary"));
    const reopened = openSessionManager(sessionFile, sessionDir);
    assert.ok(reopened.getEntries().some((entry) => entry.type === "compaction"));
    assert.ok(reopened.buildSessionContext());
  }, {
    contextWindow: 8192,
    compaction: { enabled: true, reserveTokens: 1024, keepRecentTokens: 5410 },
  });
});

test("Pi 0.84.4：provider context_length_exceeded 触发 overflow compaction", { timeout: 30_000 }, async () => {
  let mainCalls = 0;
  await withCompactionFixture("provider-overflow", async ({ response, hasTools, requests }) => {
    if (hasTools && ++mainCalls === 1) {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "context_length_exceeded: input exceeds the context window" } }));
      return;
    }
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const responseId = `resp_${requests.length}`;
    sendEvent(response, { type: "response.created", response: { id: responseId, status: "in_progress", output: [] } });
    if (!hasTools) {
      sendTextResponse(response, responseId, `summary_${requests.length}`, "## Goal\nContinue.\n\n## Progress\nOverflow recovered.");
    } else {
      sendTextResponse(response, responseId, "overflow_done", "done after overflow recovery");
    }
    response.end();
  }, async ({ host, events, requests, sessionFile, sessionDir }) => {
    await host.send({
      type: "prompt",
      message: `Trigger provider context overflow recovery. ${"context ".repeat(700)}`,
    });
    await waitFor(
      () => events.some((event) => event.type === "agent_settled"),
      "overflow recovery did not settle",
      15_000,
    );
    const start = events.find((event) => event.type === "compaction_start");
    const end = events.find((event) => event.type === "compaction_end");
    assert.ok(start, "provider overflow must emit compaction_start");
    assert.equal(start.reason, "overflow");
    assert.ok(end, "provider overflow must emit compaction_end");
    assert.equal(end.reason, "overflow");
    assert.equal(end.aborted, false);
    assert.equal(end.willRetry, true);
    assert.ok(requests.some((entry) => entry.kind === "summary"));
    assert.ok(requests.filter((entry) => entry.kind === "main").length >= 2);
    const reopened = openSessionManager(sessionFile, sessionDir);
    assert.ok(reopened.getEntries().some((entry) => entry.type === "compaction"));
    assert.ok(reopened.buildSessionContext());
  }, { compaction: { keepRecentTokens: 512 } });
});
