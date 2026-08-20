/**
 * SdkSessionHost 窄集成：临时目录创建会话、get_state、destroy。
 * 不调用真实模型 API。
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { startSdkSessionHost } = await jiti.import("./sdk-session-host.ts");

test("SdkSessionHost：新会话启动、get_state、并发锁与 destroy", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "sdk-host-cwd-"));
  const agentDir = mkdtempSync(join(tmpdir(), "sdk-host-agent-"));
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
    rmSync(cwd, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
  }
});
