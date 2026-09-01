/**
 * WebExtensionUIAdapter 回归：SDK 扩展常用 API 签名契约。
 * 曾踩坑：theme.fg(name, text) 两参数签名不匹配导致 mcp status 变 "accent"。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { createWebExtensionUIAdapter } = await jiti.import("./web-extension-ui.ts");

function makeAdapter() {
  const emitted = [];
  const adapter = createWebExtensionUIAdapter((event) => emitted.push(event));
  return { adapter, emitted };
}

test("theme.fg(name, text) 两参数返回 text 本身（mcp 状态防退化）", () => {
  const { adapter } = makeAdapter();
  const theme = adapter.uiContext.theme;
  assert.equal(theme.fg("accent", "MCP: 2/2 servers"), "MCP: 2/2 servers");
  assert.equal(theme.bold("x"), "x");
  // 未知属性也可调用（扩展可能用 dim/italic 等）
  assert.equal(theme.dim("y"), "y");
});

test("setStatus 事件投影完整文本", () => {
  const { adapter, emitted } = makeAdapter();
  adapter.uiContext.setStatus("mcp", "MCP: 0/1 servers");
  assert.equal(adapter.statuses.get("mcp"), "MCP: 0/1 servers");
  const event = emitted.find((e) => e.method === "setStatus");
  assert.equal(event?.statusText, "MCP: 0/1 servers");
});

test("setWidget 支持 string[] 与 placement", () => {
  const { adapter, emitted } = makeAdapter();
  adapter.uiContext.setWidget("w", ["line1", "line2"], { placement: "belowEditor" });
  const entry = adapter.widgets.get("w");
  assert.deepEqual(entry?.lines, ["line1", "line2"]);
  assert.equal(entry?.placement, "belowEditor");
  const event = emitted.find((e) => e.method === "setWidget");
  assert.deepEqual(event?.widgetLines, ["line1", "line2"]);
  assert.equal(event?.widgetPlacement, "belowEditor");
  // 清空
  adapter.uiContext.setWidget("w", undefined);
  assert.equal(adapter.widgets.has("w"), false);
});

test("custom() 投影 Component.render 行，Ctrl-C 关闭面板", async () => {
  const { adapter, emitted } = makeAdapter();
  const opened = adapter.uiContext.custom(() => ({
    render() {
      return ["/btw overlay"];
    },
    handleInput() {},
  }));
  await new Promise((resolve) => setImmediate(resolve));
  const customEvent = emitted.find((event) => event.method === "custom" && !event.closed);
  assert.deepEqual(customEvent?.lines, ["/btw overlay"]);
  assert.equal(adapter.inputCustom(customEvent.id, "\x03"), true);
  await opened;
  assert.ok(emitted.some((event) => event.method === "custom" && event.closed === true));
});

test("阻塞请求按 id 单次 settle；过期响应忽略", async () => {
  const { adapter } = makeAdapter();
  const p = adapter.uiContext.confirm("title", "msg");
  assert.equal(adapter.pending.size, 1);
  const id = adapter.pendingSnapshot.keys().next().value;
  adapter.respond(id, { confirmed: true });
  const result = await p;
  assert.equal(result, true);
  // 已 settle：再次 respond 返回 false（不重复 resolve）
  assert.equal(adapter.respond(id, { confirmed: false }), false);
});
