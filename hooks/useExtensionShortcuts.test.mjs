/**
 * 插件快捷键绑定的契约（issue #105）。
 *
 * 纯规则（可用性判定、按键匹配）在 `lib/extension-shortcuts.test.mjs` 里是**行为**测试；
 * 这里只锁钩子里那几件「改了就坏、单测看不出来」的事：只绑可用键、壳优先、命中即拦、
 * 关掉时不挂监听、以及**必须是冒泡阶段**。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const source = readFileSync(fileURLToPath(new URL("./useExtensionShortcuts.ts", import.meta.url)), "utf8");
const handler = source.slice(source.indexOf("const handler = (event: KeyboardEvent) =>"));

test("只绑不可用为假的键（不可用的键在设置清单里可见，但不参与按键）", () => {
  assert.ok(
    source.includes("shortcuts.filter((shortcut) => shortcut.available)"),
    "未按 available 过滤：会让「浏览器保留 / 壳占用 / 与打字冲突」的键也被绑上",
  );
  assert.ok(source.includes("if (bound.length === 0) return;"), "全是不可用键时不该挂监听");
});

test("壳优先：壳自己 preventDefault 过的键直接跳过", () => {
  assert.ok(handler.includes("event.defaultPrevented"), "没让壳先行：同一个键可能被执行两次");
  const skipIndex = handler.indexOf("if (event.defaultPrevented) return;");
  const runIndex = handler.indexOf("onRun(match.key)");
  assert.ok(skipIndex > -1 && runIndex > -1 && skipIndex < runIndex, "顺序反了：先执行再判壳");
});

test("命中即拦：否则浏览器还会执行自己的默认动作", () => {
  const preventIndex = handler.indexOf("event.preventDefault()");
  const runIndex = handler.indexOf("onRun(match.key)");
  assert.ok(preventIndex > -1, "命中后没有 preventDefault");
  assert.ok(preventIndex < runIndex, "应当先拦默认动作，再派发");
});

test("必须在冒泡阶段监听（捕获阶段会抢在壳自己的监听器之前）", () => {
  const added = /window\.addEventListener\("keydown", handler([^)]*)\)/.exec(source);
  assert.ok(added, "没找到 keydown 监听");
  assert.equal(added[1].trim(), "", "带捕获标志就会绕过「壳优先」，两个监听器的注册顺序也会变成决定因素");
});

test("关掉时一次都不挂：只读会话 / 插件界面显示中不参与", () => {
  assert.ok(source.includes("if (!enabled) return;"), "未在 enabled 为假时退出");
});

test("ChatWindow 的接线条件：只读会话与插件界面显示时都不绑", () => {
  const chatWindow = readFileSync(fileURLToPath(new URL("../components/ChatWindow.tsx", import.meta.url)), "utf8");
  assert.ok(chatWindow.includes("useExtensionShortcuts({"), "ChatWindow 没有接线");
  const call = chatWindow.slice(chatWindow.indexOf("useExtensionShortcuts({"));
  const enabled = call.slice(call.indexOf("enabled:"), call.indexOf("enabled:") + 120);
  assert.ok(enabled.includes("!isReadOnly"), "只读会话不该绑（宿主会拒命令，绑了只是白点）");
  assert.ok(enabled.includes("extensionSurfaceActive"), "插件界面显示时按键归面板，快捷键不该抢");
});
