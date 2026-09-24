import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { shouldCaptureCustomPanelKey, shouldRouteKeyToExtensionListener, resolveExtensionWidgetKeyAction, isPlainCharacterKey } = await jiti.import("./extension-panel-keys.ts");

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


// ---------------------------------------------------------------------------
// 插件 widget 的按键决策（hooks/useExtensionWidgetKeys 的执行依据）
// ---------------------------------------------------------------------------
const widgetKey = (overrides = {}) => ({
  key: "ArrowDown", ctrlKey: false, altKey: false, metaKey: false, shiftKey: false,
  composing: false, interactive: false, ...overrides,
});

test("未进入选择态：只有 ↓/← 拿去问插件，其余键不动", () => {
  assert.equal(resolveExtensionWidgetKeyAction(widgetKey({ key: "ArrowDown" })), "route-activation");
  assert.equal(resolveExtensionWidgetKeyAction(widgetKey({ key: "ArrowLeft" })), "route-activation");
  assert.equal(resolveExtensionWidgetKeyAction(widgetKey({ key: "ArrowUp" })), "ignore");
  assert.equal(resolveExtensionWidgetKeyAction(widgetKey({ key: "ArrowRight" })), "ignore");
  assert.equal(resolveExtensionWidgetKeyAction(widgetKey({ key: "Enter" })), "ignore");
  assert.equal(resolveExtensionWidgetKeyAction(widgetKey({ key: "Escape" })), "ignore");
  assert.equal(resolveExtensionWidgetKeyAction(widgetKey({ key: "j" })), "ignore");
});

test("选择态内：导航白名单路由，其它键立刻退出且不被吞", () => {
  for (const key of ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "j", "k", "Enter", "Escape"]) {
    assert.equal(resolveExtensionWidgetKeyAction(widgetKey({ key, interactive: true })), "route-navigation", key);
  }
  // 非白名单键：退出选择态，按键还给输入框（不问插件）
  for (const key of ["a", "x", "1", " ", "Backspace", "Tab", "Home"]) {
    assert.equal(resolveExtensionWidgetKeyAction(widgetKey({ key, interactive: true })), "exit-interaction", key);
  }
});

test("修饰键与选区操作不参与：Shift+Enter 是换行、Shift+方向键是选区", () => {
  assert.equal(resolveExtensionWidgetKeyAction(widgetKey({ key: "Enter", shiftKey: true, interactive: true })), "exit-interaction");
  assert.equal(resolveExtensionWidgetKeyAction(widgetKey({ key: "ArrowDown", shiftKey: true })), "ignore");
  assert.equal(resolveExtensionWidgetKeyAction(widgetKey({ key: "ArrowDown", shiftKey: true, interactive: true })), "exit-interaction");
  assert.equal(resolveExtensionWidgetKeyAction(widgetKey({ key: "k", shiftKey: true, interactive: true })), "exit-interaction");
  assert.equal(resolveExtensionWidgetKeyAction(widgetKey({ key: "ArrowDown", ctrlKey: true })), "ignore");
  assert.equal(resolveExtensionWidgetKeyAction(widgetKey({ key: "Enter", metaKey: true, interactive: true })), "ignore");
});

test("输入法合成中一律不参与", () => {
  assert.equal(resolveExtensionWidgetKeyAction(widgetKey({ composing: true })), "ignore");
  assert.equal(resolveExtensionWidgetKeyAction(widgetKey({ composing: true, interactive: true })), "ignore");
});

test("可打印字符的 TUI 字节：j/k 导航要能编码出字符本身", () => {
  assert.equal(isPlainCharacterKey(widgetKey({ key: "j" })), true);
  assert.equal(isPlainCharacterKey(widgetKey({ key: "k" })), true);
  assert.equal(isPlainCharacterKey(widgetKey({ key: "ArrowDown" })), false);
  assert.equal(isPlainCharacterKey(widgetKey({ key: "j", ctrlKey: true })), false);
});
