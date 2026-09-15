/**
 * WebExtensionUIAdapter 回归：SDK 扩展常用 API 签名契约。
 * 曾踩坑：theme.fg(name, text) 两参数签名不匹配导致 mcp status 变 "accent"。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

// ---------------------------------------------------------------------------
// Issue #34：活动 custom 面板的可恢复快照
//
// custom 只有 SSE 事件、没有重放。刷新/切回后服务端仍在等输入，但浏览器端
// 既无内容也无输入入口。get_state 必须能带回最后可重放的投影。
// ---------------------------------------------------------------------------

test("#34 custom 面板保存可恢复快照；关闭后清空", async () => {
  const { createWebExtensionUIAdapter } = await jiti.import("./web-extension-ui.ts");
  const events = [];
  const adapter = createWebExtensionUIAdapter((event) => events.push(event));

  assert.equal(adapter.customSnapshot, null, "初始无活动面板");

  const factory = async (tui) => ({
    render: () => ["status: ready", "press q to quit"],
    handleInput: () => {},
  });
  const pending = adapter.uiContext.custom(factory);
  await new Promise((r) => setTimeout(r, 10));

  const snapshot = adapter.customSnapshot;
  assert.ok(snapshot, "活动面板必须有快照");
  assert.ok(typeof snapshot.id === "string" && snapshot.id, "快照必须带 request id");
  assert.deepEqual(snapshot.lines, ["status: ready", "press q to quit"], "快照保存最后渲染行");

  // 渲染行变化后快照跟随（面板内容会随输入更新）
  const emitted = events.filter((e) => e.method === "custom" && !e.closed);
  assert.ok(emitted.length >= 1);

  // Ctrl-C 关闭：快照必须清空，否则刷新后会恢复一个已关闭的面板
  adapter.inputCustom(snapshot.id, "\x03");
  await pending;
  assert.equal(adapter.customSnapshot, null, "面板关闭后不得再恢复");
});

test("#34 host 状态投影包含活动 custom 快照", async () => {
  const hostSrc = readFileSync(new URL("./sdk-session-host.ts", import.meta.url), "utf8");
  assert.match(hostSrc, /activeCustomUi:\s*this\.extensionUi\?\.customSnapshot/, "get_state 必须下发活动 custom 快照");
});

test("#34 dispose 后不得残留可恢复快照", async () => {
  const { createWebExtensionUIAdapter } = await jiti.import("./web-extension-ui.ts");
  const adapter = createWebExtensionUIAdapter(() => {});
  const pending = adapter.uiContext.custom(async () => ({ render: () => ["x"] }));
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(adapter.customSnapshot);
  adapter.dispose();
  await pending.catch(() => {});
  assert.equal(adapter.customSnapshot, null, "dispose 后不得残留（否则会话销毁后仍会恢复旧面板）");
});
