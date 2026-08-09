import { test } from "node:test";
import assert from "node:assert/strict";
import { createJiti } from "jiti";

// ExternalRpcSession 使用 TS parameter property，Node 原生 strip 不支持；
// 与 session-fulltext-search.test.mjs 一致用 jiti 完整 transform 加载。
const { ExternalRpcSession } = createJiti(import.meta.url)("./external-session.ts");

/**
 * setStatus/setWidget 原文存储（含 ANSI 颜色码）：乱码问题在渲染层解决
 * （renderAnsiLine 解析成彩色 span），数据层不洗色。
 */
function makeSession() {
  return new ExternalRpcSession({
    sessionId: "test-ansi-session",
    sessionFile: "/tmp/test-ansi-session.jsonl",
    cwd: "/tmp",
    idleTimeoutMs: 60000,
  });
}

test("setStatus 文本原文存储（含 ANSI 颜色码）", () => {
  const session = makeSession();
  const raw = "\u001b[38;5;94m✗\u001b[39m\u001b[38;5;243m scout:\u001b[39m \u001b[38;5;94mmodel-roles missing\u001b[39m";
  // 触发 handleProcessEvent 的 extension_ui_request 分支
  session["handleProcessEvent"]({
    type: "extension_ui_request",
    method: "setStatus",
    statusKey: "scout",
    statusText: raw,
  });
  const statuses = session["extensionStatuses"];
  // 数据层保留颜色码，供渲染层 parseAnsiLine 解析（颜色不丢失）
  assert.equal(statuses.get("scout"), raw);
});

test("setStatus 空文本删除状态", () => {
  const session = makeSession();
  session["handleProcessEvent"]({
    type: "extension_ui_request",
    method: "setStatus",
    statusKey: "mcp",
    statusText: "\u001b[38;5;66mMCP: 0/1 servers\u001b[39m",
  });
  assert.ok(session["extensionStatuses"].has("mcp"));
  session["handleProcessEvent"]({
    type: "extension_ui_request",
    method: "setStatus",
    statusKey: "mcp",
    statusText: "",
  });
  assert.ok(!session["extensionStatuses"].has("mcp"));
});

test("setWidget lines 原文存储（含 ANSI 颜色码）", () => {
  const session = makeSession();
  session["handleProcessEvent"]({
    type: "extension_ui_request",
    method: "setWidget",
    widgetKey: "w",
    widgetLines: ["\u001b[31mred line\u001b[0m", "plain"],
    widgetPlacement: "aboveEditor",
  });
  const widgets = session["extensionWidgets"];
  const entry = widgets.get("w");
  assert.ok(entry);
  assert.deepEqual(entry.lines, ["\u001b[31mred line\u001b[0m", "plain"]);
  assert.equal(entry.placement, "aboveEditor");
});
