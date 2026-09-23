import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { shouldCaptureCustomPanelKey, shouldRouteKeyToExtensionListener } = await jiti.import("./extension-panel-keys.ts");

test("有选区时 Ctrl/Cmd+C 不转成 TUI 中断", () => {
  assert.equal(shouldCaptureCustomPanelKey({ key: "c", ctrlKey: true, metaKey: false }, "copied"), false);
  assert.equal(shouldCaptureCustomPanelKey({ key: "c", ctrlKey: false, metaKey: true }, "copied"), false);
  assert.equal(shouldCaptureCustomPanelKey({ key: "c", ctrlKey: true, metaKey: false }, ""), true);
});

test("Ctrl/Cmd+A 始终留给浏览器全选", () => {
  assert.equal(shouldCaptureCustomPanelKey({ key: "a", ctrlKey: true, metaKey: false }, ""), false);
  assert.equal(shouldCaptureCustomPanelKey({ key: "ArrowDown", ctrlKey: false, metaKey: false }, "sel"), true);
});

// ---------------------------------------------------------------------------
// 面板收起后路由给插件监听器（ctx.ui.onTerminalInput）的白名单
// ---------------------------------------------------------------------------

const key = (over) => ({ key: "", ctrlKey: false, altKey: false, metaKey: false, ...over });

test("Escape 与 F1–F12 交给插件（前端在这些键上没有必须保留的语义）", () => {
  assert.equal(shouldRouteKeyToExtensionListener(key({ key: "Escape" })), true);
  assert.equal(shouldRouteKeyToExtensionListener(key({ key: "F1" })), true);
  assert.equal(shouldRouteKeyToExtensionListener(key({ key: "F12" })), true);
  assert.equal(shouldRouteKeyToExtensionListener(key({ key: "F13" })), false);
});

test("Ctrl/Alt + 非保留字符键交给插件", () => {
  assert.equal(shouldRouteKeyToExtensionListener(key({ key: "u", ctrlKey: true })), true);
  assert.equal(shouldRouteKeyToExtensionListener(key({ key: "]", ctrlKey: true })), true);
  assert.equal(shouldRouteKeyToExtensionListener(key({ key: "o", altKey: true })), true);
});

test("浏览器保留的 Ctrl 组合与 Cmd 组合不问插件", () => {
  for (const reserved of ["a", "c", "v", "x", "z", "w", "t", "s", "p", "n", "f", "r", "l", "o"]) {
    assert.equal(
      shouldRouteKeyToExtensionListener(key({ key: reserved, ctrlKey: true })),
      false,
      `Ctrl+${reserved}`,
    );
  }
  assert.equal(shouldRouteKeyToExtensionListener(key({ key: "u", metaKey: true })), false);
});

test("方向键/Home/End/翻页/Enter/Tab 留给输入框与滚动", () => {
  for (const kept of ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown", "Enter", "Tab", "Backspace", "Delete"]) {
    assert.equal(
      shouldRouteKeyToExtensionListener(key({ key: kept, ctrlKey: true })),
      false,
      `${kept} 不该被路由`,
    );
  }
});

test("普通可打印字符不路由（否则会抢走打字）", () => {
  assert.equal(shouldRouteKeyToExtensionListener(key({ key: "a" })), false);
  assert.equal(shouldRouteKeyToExtensionListener(key({ key: "1" })), false);
});

test("Ctrl/Alt + 空格留给浏览器（输入法切换）", () => {
  assert.equal(shouldRouteKeyToExtensionListener(key({ key: " ", ctrlKey: true })), false);
});

