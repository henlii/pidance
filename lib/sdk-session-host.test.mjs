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

    // 同 session 再取锁应失败
    const { tryAcquireSessionLock } = await jiti.import("./session-ownership-lock.ts");
    assert.equal(tryAcquireSessionLock(host.sessionId, agentDir), null);

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
