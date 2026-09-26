/**
 * 插件快捷键绑定的契约（issue #105）。
 *
 * 命中判定（哪些键算「用户按下了这个快捷键」）已经是**纯函数** `pickBoundShortcut`，
 * 行为测试在 `lib/extension-shortcuts.test.mjs`（被处理过 / 长按重复 / 输入法合成 / 不可用键）。
 * 这里只锁钩子里那几件「改了就坏、纯函数测不出来」的事：调用纯函数而不是自己重写一份判定、
 * 只绑可用键、命中即拦、关掉时不挂监听、以及**必须是冒泡阶段**。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const source = readFileSync(fileURLToPath(new URL("./useExtensionShortcuts.ts", import.meta.url)), "utf8");
const handler = source.slice(source.indexOf("const handler = (event: KeyboardEvent) =>"));

test("命中判定走纯函数：壳优先 / 长按 / 输入法合成这些规则不能在这里重写一份", () => {
  assert.ok(
    source.includes("pickBoundShortcut(bound, event)"),
    "没有调用 pickBoundShortcut：那些规则会散成两处实现（纯函数那份有行为测试，这里没有）",
  );
  assert.ok(
    !source.includes("matchesExtensionShortcut("),
    "钩子里不该自己再匹配一遍键：那会绕过 pickBoundShortcut 的忽略规则",
  );
  const matchIndex = handler.indexOf("pickBoundShortcut(bound, event)");
  const runIndex = handler.indexOf("onRun(match.key)");
  assert.ok(matchIndex > -1 && runIndex > -1 && matchIndex < runIndex, "顺序反了：先执行再判定");
});

test("只绑不可用为假的键（不可用的键在设置清单里可见，但不参与按键）", () => {
  assert.ok(
    source.includes("shortcuts.filter((shortcut) => shortcut.available)"),
    "未按 available 过滤：会让「浏览器保留 / 壳占用 / 与内置冲突 / 与打字冲突」的键也被绑上",
  );
  assert.ok(source.includes("if (bound.length === 0) return;"), "全是不可用键时不该挂监听");
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

test("壳的处理器尊重 defaultPrevented：插件先拦过的键不该被壳再执行一次", () => {
  const shell = readFileSync(fileURLToPath(new URL("./useKeyboardShortcuts.ts", import.meta.url)), "utf8");
  const shellHandler = shell.slice(shell.indexOf("const handler = (e: KeyboardEvent): void =>"));
  const guard = shellHandler.indexOf("if (e.defaultPrevented) return;");
  const newSession = shellHandler.indexOf("onNewSession(activeCwd)");
  assert.ok(guard > -1, "壳的处理器没看 defaultPrevented：两个监听都在冒泡阶段，子组件先注册，插件先拦也会被壳再执行一次");
  assert.ok(newSession > -1 && guard < newSession, "应当先让位，再处理自己的快捷键");
});
