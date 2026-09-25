import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { shouldCaptureCustomPanelKey, shouldRouteKeyToExtensionListener, resolveExtensionWidgetKeyAction, isPlainCharacterKey,
  nextWidgetInteractionState, isWidgetInteractionLive, isWidgetLeavingKey, isImeComposing, initialState, WIDGET_INTERACTION_TTL_MS,
  resolveExtensionSurfaceKeyAction, isDomOwnedKeyTarget, isBrowserReservedCtrlChord, BROWSER_RESERVED_CTRL_KEYS, isShellReservedCtrlChord, SHELL_RESERVED_CTRL_KEYS,
  DOM_OWNED_KEY_TARGET_SELECTOR, IME_COMPOSITION_GRACE_MS } = await jiti.import("./extension-panel-keys.ts");

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

// ---------------------------------------------------------------------------
// 窗口 ③：插件界面**显示中**（可见的 custom 面板 / overlay / 扩展对话框）时的按键归属
//
// 优先级表（hooks/useExtensionTerminalInput.ts 的实现必须按这个顺序判定）：
//   1. 事件目标有 DOM 归属者 → 归 DOM（这一条覆盖「输入框聚焦时维持现状」）
//   2. 输入框聚焦且无面板 → 窗口 ②（useExtensionWidgetKeys）
//   3. 面板被收起 → 窗口 ①（白名单）
//   4. 插件界面显示中 → 窗口 ③
// ---------------------------------------------------------------------------

const surfaceKey = (over) => ({
  key: "",
  ctrlKey: false,
  altKey: false,
  metaKey: false,
  shiftKey: false,
  composing: false,
  domOwned: false,
  claimedByPanelWindow: false,
  ...over,
});

test("窗口 ③：事件目标已有 DOM 归属者时不抢（输入框本身 / 面板 keytrap / 按钮）", () => {
  // 这一条同时是「输入框聚焦时维持现状」的实现：输入框聚焦时 keydown 的目标就是那个 textarea。
  assert.equal(resolveExtensionSurfaceKeyAction(surfaceKey({ key: "j", domOwned: true })), "ignore");
  assert.equal(resolveExtensionSurfaceKeyAction(surfaceKey({ key: "ArrowDown", domOwned: true })), "ignore");
  assert.equal(resolveExtensionSurfaceKeyAction(surfaceKey({ key: "Enter", domOwned: true })), "ignore");
  // 没有归属者时同一个键才交给插件
  assert.equal(resolveExtensionSurfaceKeyAction(surfaceKey({ key: "j" })), "route");
  assert.equal(resolveExtensionSurfaceKeyAction(surfaceKey({ key: "ArrowDown" })), "route");
});

test("窗口 ③：输入法合成中不路由（合成提交那一下不能被插件吃掉）", () => {
  assert.equal(resolveExtensionSurfaceKeyAction(surfaceKey({ key: "Enter", composing: true })), "ignore");
  assert.equal(resolveExtensionSurfaceKeyAction(surfaceKey({ key: "Escape", composing: true })), "ignore");
  // 宽限期本身由钩子用 isImeComposing 计算；这里锁住常量存在且非零
  assert.ok(IME_COMPOSITION_GRACE_MS > 0, "合成结束的宽限期必须是正数");
});

test("窗口 ③：白名单键归窗口 ①，不重复发送", () => {
  assert.equal(
    resolveExtensionSurfaceKeyAction(surfaceKey({ key: "Escape", claimedByPanelWindow: true })),
    "ignore",
  );
  assert.equal(
    resolveExtensionSurfaceKeyAction(surfaceKey({ key: "Escape", claimedByPanelWindow: false })),
    "route",
  );
});

test("窗口 ③：Cmd(Meta) 与 Tab 留给浏览器/系统", () => {
  assert.equal(resolveExtensionSurfaceKeyAction(surfaceKey({ key: "c", metaKey: true })), "ignore");
  assert.equal(resolveExtensionSurfaceKeyAction(surfaceKey({ key: "ArrowUp", metaKey: true })), "ignore");
  // Tab 是无障碍的焦点遍历：面板/对话框里的按钮只能靠它到达
  assert.equal(resolveExtensionSurfaceKeyAction(surfaceKey({ key: "Tab" })), "ignore");
  assert.equal(resolveExtensionSurfaceKeyAction(surfaceKey({ key: "Tab", shiftKey: true })), "ignore");
});

test("保留键全表：15 个浏览器 Ctrl 组合在窗口 ① 与窗口 ③ 都不能被拦下", () => {
  const expected = ["a", "c", "v", "x", "z", "y", "p", "s", "f", "n", "t", "w", "r", "l", "o"];
  assert.deepEqual([...BROWSER_RESERVED_CTRL_KEYS].sort(), [...expected].sort());
  for (const letter of expected) {
    assert.equal(isBrowserReservedCtrlChord({ key: letter, ctrlKey: true }), true, "Ctrl+" + letter);
    // 大写也一样（浏览器不区分）
    assert.equal(isBrowserReservedCtrlChord({ key: letter.toUpperCase(), ctrlKey: true }), true, "Ctrl+" + letter.toUpperCase());
    assert.equal(
      shouldRouteKeyToExtensionListener({ key: letter, ctrlKey: true, altKey: false, metaKey: false }),
      false,
      "窗口 ① 拦住了 Ctrl+" + letter,
    );
    assert.equal(
      resolveExtensionSurfaceKeyAction(surfaceKey({ key: letter, ctrlKey: true })),
      "ignore",
      "窗口 ③ 拦住了 Ctrl+" + letter,
    );
  }
  // Ctrl+Space 是输入法切换
  assert.equal(isBrowserReservedCtrlChord({ key: " ", ctrlKey: true }), true);
  assert.equal(resolveExtensionSurfaceKeyAction(surfaceKey({ key: " ", ctrlKey: true })), "ignore");
  // 没被浏览器占用的组合仍然交给插件（窗口 ① 早就这么做了）
  assert.equal(isBrowserReservedCtrlChord({ key: "g", ctrlKey: true }), false);
  assert.equal(resolveExtensionSurfaceKeyAction(surfaceKey({ key: "g", ctrlKey: true })), "route");
  // 壳自己的键位（Ctrl+K 命令面板）两个窗口都不让渡 —— 依据 TUI 的 app 保留键位规则
  assert.deepEqual([...SHELL_RESERVED_CTRL_KEYS], ["k"]);
  assert.equal(isShellReservedCtrlChord({ key: "K", ctrlKey: true }), true);
  assert.equal(isShellReservedCtrlChord({ key: "k", ctrlKey: false }), false, "不带 Ctrl 的 k 是普通字符");
  assert.equal(resolveExtensionSurfaceKeyAction(surfaceKey({ key: "k", ctrlKey: true })), "ignore", "窗口 ③ 抢走了 Ctrl+K");
  assert.equal(
    shouldRouteKeyToExtensionListener({ key: "k", ctrlKey: true, altKey: false, metaKey: false }),
    false,
    "窗口 ① 抢走了 Ctrl+K",
  );
  // Cmd+K（命令面板的另一半）本来就因 Meta 被排除
  assert.equal(resolveExtensionSurfaceKeyAction(surfaceKey({ key: "k", metaKey: true })), "ignore");
});

test("窗口 ③：其余按键交给插件的全局监听器", () => {
  for (const key of ["j", "k", "q", "1", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Enter", "Escape", "Home", "End", "PageUp", "PageDown", "Backspace", " ", "F1", "F12"]) {
    assert.equal(resolveExtensionSurfaceKeyAction(surfaceKey({ key })), "route", key);
  }
  // Alt+字符 与 Shift 组合（Shift+方向键是选区，但在插件界面里也一样交给插件）
  assert.equal(resolveExtensionSurfaceKeyAction(surfaceKey({ key: "x", altKey: true })), "route");
  assert.equal(resolveExtensionSurfaceKeyAction(surfaceKey({ key: "ArrowUp", shiftKey: true })), "route");
});

test("isDomOwnedKeyTarget：可编辑/可交互元素算有归属者，普通容器与空目标不算", () => {
  const node = (tag) => ({
    closest: (selector) => (selector.includes(tag) ? {} : null),
  });
  for (const tag of ["input", "textarea", "button", 'a[href]', "select"]) {
    assert.equal(isDomOwnedKeyTarget(node(tag)), true, tag);
  }
  assert.equal(isDomOwnedKeyTarget({ closest: () => null }), false, "普通容器（面板的 pre/div）");
  assert.equal(isDomOwnedKeyTarget(null), false, "null（document/window 一类目标）");
  assert.equal(isDomOwnedKeyTarget(undefined), false);
  assert.equal(isDomOwnedKeyTarget({}), false, "没有 closest 的目标");
  // 选择器必须覆盖这些角色：对话框/菜单里的按钮与选项
  for (const role of ["button", "menuitem", "option", "tab", "checkbox", "switch", "radio", "listbox"]) {
    assert.ok(DOM_OWNED_KEY_TARGET_SELECTOR.includes(`[role="${role}"]`), "选择器缺 role=" + role);
  }
  assert.ok(DOM_OWNED_KEY_TARGET_SELECTOR.includes("[contenteditable]"), "选择器缺 contenteditable");
});

test("壳自己的模态拥有键盘：插件按键路由必须让位（否则模态关不掉）", () => {
  // 判据是专属标记而不是 role/aria-modal：插件的面板外壳（ExtensionPanelChrome）也用
  // aria-modal，那正是窗口 ③ 的主场景，不能被一并跳过。
  assert.ok(
    DOM_OWNED_KEY_TARGET_SELECTOR.includes('[data-pidance-modal="true"]'),
    "选择器缺壳模态标记",
  );
  assert.equal(isDomOwnedKeyTarget({ closest: (selector) => (selector.includes("data-pidance-modal") ? {} : null) }), true);
  const dialog = readFileSync(new URL("../components/ui/ViewportDialog.tsx", import.meta.url), "utf8");
  assert.ok(
    /role="dialog"\s+aria-modal="true"\s+data-pidance-modal="true"/.test(dialog),
    "ViewportDialog 的面板没打上 data-pidance-modal（选择器就永远匹配不到）",
  );
  // 插件面板外壳不能被算成「壳模态」（它有 aria-modal，但它是插件界面）
  const chrome = readFileSync(new URL("../components/ExtensionPanelChrome.tsx", import.meta.url), "utf8");
  assert.ok(!chrome.includes("data-pidance-modal"), "插件面板外壳不该带壳模态标记");
});

test("isDomOwnedKeyTarget：closest 抛错时按「有归属」处理（拿不准就不抢）", () => {
  assert.equal(
    isDomOwnedKeyTarget({
      closest: () => {
        throw new Error("boom");
      },
    }),
    true,
  );
});
