import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { shouldCaptureCustomPanelKey, shouldRouteKeyToExtensionListener, resolveExtensionWidgetKeyAction, isPlainCharacterKey,
  nextWidgetInteractionState, isWidgetInteractionLive, isWidgetLeavingKey, isImeComposing, initialState, WIDGET_INTERACTION_TTL_MS } = await jiti.import("./extension-panel-keys.ts");

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

// ---------------------------------------------------------------------------
// 修复轮（审查阻断项）：本地选择态的迁移与保鲜期
// ---------------------------------------------------------------------------
const routed = (over={}) => ({ action: "route-navigation", key: "ArrowDown", consumed: true, now: 1_000, ...over });

test("阻断项：Esc/Enter 被插件消费也必须清零本地选择态（否则字母键与回车被吞）", () => {
  for (const key of ["Escape", "Enter"]) {
    const next = nextWidgetInteractionState({ interactive: true, lastRoutedAt: 0 }, routed({ key, consumed: true }));
    assert.equal(next.interactive, false, key + " 被消费后本地仍是选择态 = 下一发 j/k/Enter 会被拦下吞掉");
  }
  assert.equal(isWidgetLeavingKey("Escape"), true);
  assert.equal(isWidgetLeavingKey("Enter"), true);
  assert.equal(isWidgetLeavingKey("ArrowDown"), false);
});

test("导航键被消费时保持选择态（不然 j/k 导航只走一步）", () => {
  for (const key of ["ArrowUp", "ArrowDown", "j", "k"]) {
    const next = nextWidgetInteractionState({ interactive: true, lastRoutedAt: 500 }, routed({ key }));
    assert.equal(next.interactive, true, key);
    assert.equal(next.lastRoutedAt, 1_000, key + "：路由时刻要刷新，否则会被保鲜期误判过期");
  }
});

test("激活键按插件是否消费决定选择态", () => {
  const activation = { action: "route-activation", key: "ArrowDown", now: 2_000 };
  assert.equal(nextWidgetInteractionState(initialState(), { ...activation, consumed: true }).interactive, true);
  assert.equal(nextWidgetInteractionState(initialState(), { ...activation, consumed: false }).interactive, false);
});

test("非导航键立刻退出选择态，且不刷新路由时刻", () => {
  const next = nextWidgetInteractionState({ interactive: true, lastRoutedAt: 300 }, routed({ action: "exit-interaction", key: "a", consumed: false, now: 9_000 }));
  assert.equal(next.interactive, false);
  assert.equal(next.lastRoutedAt, 300);
});

test("保鲜期：超过 WIDGET_INTERACTION_TTL_MS 没路由过按键就不算在选择态", () => {
  const state = { interactive: true, lastRoutedAt: 10_000 };
  assert.equal(isWidgetInteractionLive(state, 10_000 + WIDGET_INTERACTION_TTL_MS), true, "刚好到期仍算在内");
  assert.equal(isWidgetInteractionLive(state, 10_001 + WIDGET_INTERACTION_TTL_MS), false, "超期必须视为已离开");
  assert.equal(isWidgetInteractionLive({ interactive: false, lastRoutedAt: 10_000 }, 10_000), false);
});

test("输入法：isComposing / keyCode 229 / 合成结束宽限期都算合成中", () => {
  assert.equal(isImeComposing({ isComposing: true }, 0, 5_000), true);
  assert.equal(isImeComposing({ keyCode: 229 }, 0, 5_000), true, "部分输入法只给 keyCode 229");
  assert.equal(isImeComposing({}, 6_000, 5_000), true, "compositionend 之后仍在宽限期内");
  assert.equal(isImeComposing({}, 6_000, 7_000), false, "宽限期已过");
  assert.equal(isImeComposing({}, 0, 5_000), false);
});
