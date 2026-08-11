/**
 * #20 P1：迁移前浏览器/SSE/树/Extension UI 契约基线。
 *
 * SDK host 切换后这些 type 名与语义不得静默漂移；本文件只做源码/清单契约，
 * 行为细节由 finish-agent-run / extension-ui-bridge / session-service 等测试覆盖。
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const ROOT = new URL("../", import.meta.url);

async function read(rel) {
  return readFile(new URL(rel, ROOT), "utf8");
}

/** 前端 useAgentSession 依赖的 SSE/agent 事件（收尾与提示）。 */
const REQUIRED_AGENT_EVENTS = [
  "agent_start",
  "agent_end",
  "prompt_done",
  "agent_settled",
  "message_update",
  "message_end",
  "turn_start",
  "turn_end",
  "tool_execution_start",
  "tool_execution_end",
  "compaction_start",
  "compaction_end",
  "auto_compaction_start",
  "auto_compaction_end",
  "extension_ui_request",
  "extension_error",
  "prompt_error",
  "leaf_drift",
  "queue_update",
];

/** 浏览器当前会发送的 agent 命令 type（迁移后 host 必须继续支持或显式映射）。 */
const REQUIRED_AGENT_COMMANDS = [
  "prompt",
  "steer",
  "abort",
  "bash",
  "abort_bash",
  "set_model",
  "set_thinking_level",
  "compact",
  "get_commands",
  "extension_ui_response",
  "extension_ui_input",
  "set_session_name",
  "fork",
  "navigate_tree",
  "select_leaf_exact",
  "branch_from_assistant",
  "create_session_from_leaf",
  "set_branch_label",
  "append_activity",
];

test("useAgentSession 处理 REQUIRED_AGENT_EVENTS 中的收尾与 leaf_drift", async () => {
  const src = await read("hooks/useAgentSession.ts");
  for (const type of [
    "agent_end",
    "prompt_done",
    "agent_start",
    "leaf_drift",
    "extension_ui_request",
    "prompt_error",
    "extension_error",
    "queue_update",
    "compaction_start",
    "auto_compaction_start",
  ]) {
    assert.match(src, new RegExp(`["']${type}["']`), `前端应处理事件 ${type}`);
  }
});

test("SdkSessionHost 发出 prompt_done 与 agent_end 后清 sidecar", async () => {
  const src = await read("lib/sdk-session-host.ts");
  assert.match(src, /case "agent_end"/);
  assert.match(src, /type: "prompt_done"/);
  assert.match(src, /clearLeafSidecar/);
});

test("agent 命令清单：前端发送的 type 在 SdkSessionHost.send 中有落点", async () => {
  const host = await read("lib/sdk-session-host.ts");
  for (const type of REQUIRED_AGENT_COMMANDS) {
    assert.ok(
      host.includes(`"${type}"`) || host.includes(`'${type}'`),
      `命令 ${type} 应在 sdk-session-host 中出现`,
    );
  }
});

test("Extension UI 阻塞方法与 FIFO 投影仍由 extension-ui-bridge 拥有", async () => {
  const bridge = await read("lib/extension-ui-bridge.ts");
  for (const method of ["select", "confirm", "input", "editor"]) {
    assert.match(bridge, new RegExp(method));
  }
  assert.match(bridge, /projectBlockingHead|blockingQueue|FIFO|队首/);
});

test("REQUIRED_AGENT_EVENTS 清单保持稳定（防误删）", () => {
  assert.equal(REQUIRED_AGENT_EVENTS.length, 19);
  assert.equal(REQUIRED_AGENT_COMMANDS.length, 19);
  assert.ok(REQUIRED_AGENT_EVENTS.includes("leaf_drift"));
  assert.ok(REQUIRED_AGENT_COMMANDS.includes("append_activity"));
});
